"""Backtest of the VWAP/EMA pullback scalp, traded with 0DTE options.

The entry/exit rules mirror ScalpCallPut_STRATEGY.ts bar for bar. thinkorswim's
strategy tester only reports P&L on the underlying, so this script re-prices
every trade as a long call (bullish signal) or long put (bearish signal).

Option prices are MODELLED, not historical quotes: Black-Scholes, same-day
expiry, implied volatility taken from the VIX family, plus a fixed slippage and
commission per contract. See README.md for what that does and does not prove.
"""
import argparse
import math
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np
import pandas as pd

DATA = Path(__file__).parent / "data"
ET = "America/New_York"
MINUTES_PER_YEAR = 390 * 252  # trading minutes

# Implied-vol proxy per underlying: (vol index file, multiplier, fallback multiplier on VIX)
VOL_PROXY = {"SPY": ("VIX", 1.0, 1.0), "QQQ": ("VXN", 1.0, 1.25), "IWM": ("VIX", 1.2, 1.2)}
# The VIX family prices 30 calendar days including overnight gaps. In this sample the
# volatility actually realised inside the regular session was 0.6-0.9x the index, so
# same-day options are priced at 0.8x. Raise it and time decay gets worse; lower it and
# the contracts get cheaper. Change with --iv-scale.
IV_SCALE = 0.8


@dataclass(frozen=True)
class Params:
    strategy: str = "pullback"
    fast: int = 9
    slow: int = 21
    atr_len: int = 14
    start: str = "09:45"   # first bar allowed to signal
    end: str = "15:00"     # last bar allowed to signal
    flat: str = "15:50"    # bar on which any open trade is closed
    target_atr: float = 0.5
    stop_atr: float = 2.0
    max_bars: int = 6


@dataclass(frozen=True)
class Costs:
    slippage: float = 0.01      # $ per share, paid on entry and again on exit
    commission: float = 0.65    # $ per contract, per side
    premium_cap: float = 0.45   # most a $50 account can pay for one contract
    dte: int = 0                # trading days until expiry; 0 = expires today
    freeze_iv: bool = False     # stress test: price the exit at the entry's implied volatility


# --------------------------------------------------------------------------- data

def load(symbol, interval):
    df = pd.read_csv(DATA / f"{symbol}_{interval}.csv", parse_dates=["ts_utc"])
    df.index = df.pop("ts_utc").dt.tz_convert(ET)
    return df


def load_underlying(symbol, interval, iv_scale=IV_SCALE):
    df = load(symbol, interval).between_time("09:30", "15:59")
    df = df[df.volume > 0].copy()
    df["date"] = df.index.date
    vol_file, mult, fallback = VOL_PROXY[symbol]
    iv = load(vol_file, interval).close.reindex(df.index, method="ffill") * mult
    if iv.isna().any() or vol_file != "VIX":
        vix = load("VIX", interval).close.reindex(df.index, method="ffill") * fallback
        stale = iv.isna() | (iv.index.to_series().diff().dt.days.fillna(0) < 0)
        iv = iv.where(~stale, vix).fillna(vix)
    df["iv_raw"] = iv / 100.0           # for contracts that live past today
    df["iv"] = df.iv_raw * iv_scale     # for same-day contracts
    return df.dropna(subset=["iv"])


# --------------------------------------------------------------------- indicators

def add_indicators(df, p):
    out = df.copy()
    tp_vol = (out.high + out.low + out.close) / 3 * out.volume
    out["vwap"] = tp_vol.groupby(out.date).cumsum() / out.volume.groupby(out.date).cumsum()
    out["ema_f"] = out.close.ewm(span=p.fast, adjust=False).mean()
    out["ema_s"] = out.close.ewm(span=p.slow, adjust=False).mean()
    prev_close = out.close.shift()
    tr = pd.concat([out.high - out.low, (out.high - prev_close).abs(), (out.low - prev_close).abs()], axis=1).max(axis=1)
    out["atr"] = tr.ewm(alpha=1 / p.atr_len, adjust=False).mean()  # Wilder, as in thinkScript ATR()

    # extras used by the alternative signal rules
    out["rng"] = out.high - out.low
    out["bar_pos"] = ((out.close - out.low) / out.rng.where(out.rng > 0)).fillna(0.5)
    out["vol_avg"] = out.volume.rolling(20).mean().shift()
    out["hh"] = out.high.rolling(30).max().shift()
    out["ll"] = out.low.rolling(30).min().shift()
    mid = out.close.rolling(20).mean()
    sd = out.close.rolling(20).std(ddof=0)
    out["bb_up"], out["bb_dn"] = mid + 2.5 * sd, mid - 2.5 * sd
    delta = out.close.diff()
    gain = delta.clip(lower=0).ewm(alpha=0.5, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=0.5, adjust=False).mean()
    out["rsi2"] = 100 - 100 / (1 + gain / loss.where(loss > 0, 1e-12))
    t = out.index.strftime("%H:%M")
    out["hhmm"] = t
    opening = out[t < "09:45"]
    out["or_high"] = out.date.map(opening.groupby("date").high.max())
    out["or_low"] = out.date.map(opening.groupby("date").low.min())

    window = (t >= p.start) & (t <= p.end)
    call, put = SIGNALS[p.strategy](out)
    out["sig_call"] = (window & call).fillna(False).astype(bool)
    out["sig_put"] = (window & put).fillna(False).astype(bool)
    out["is_flat_bar"] = t >= p.flat
    return out.iloc[p.slow * 3:]  # let the averages warm up


# ----------------------------------------------------------------- signal rules
# Each rule returns (call_signal, put_signal) for the bar that just closed.

def sig_pullback(d):
    """Trend pullback: with the trend, dip to the fast EMA and close back through it."""
    up = (d.close > d.vwap) & (d.ema_f > d.ema_s)
    down = (d.close < d.vwap) & (d.ema_f < d.ema_s)
    return (up & (d.low <= d.ema_f) & (d.close > d.ema_f) & (d.close > d.open),
            down & (d.high >= d.ema_f) & (d.close < d.ema_f) & (d.close < d.open))


def sig_burst(d):
    """Momentum burst: a wide, high-volume bar closing near its extreme, on the VWAP side."""
    big = (d.rng >= 1.5 * d.atr.shift()) & (d.volume >= 1.5 * d.vol_avg)
    return (big & (d.bar_pos >= 0.75) & (d.close > d.open) & (d.close > d.vwap),
            big & (d.bar_pos <= 0.25) & (d.close < d.open) & (d.close < d.vwap))


def sig_breakout(d):
    """30-bar high/low breakout on above-average volume, on the VWAP side."""
    vol = d.volume >= 1.5 * d.vol_avg
    return (vol & (d.close > d.hh) & (d.close > d.vwap), vol & (d.close < d.ll) & (d.close < d.vwap))


def sig_power_hour(d):
    """The same breakout, but only in the last hour when near-the-money contracts are cheap."""
    call, put = sig_breakout(d)
    late = d.hhmm >= "15:00"
    return call & late, put & late


def sig_orb(d):
    """Opening-range breakout: first close outside the 9:30-9:45 range, before 11:30."""
    early = (d.hhmm >= "09:45") & (d.hhmm <= "11:30") & (d.volume >= d.vol_avg)
    return (early & (d.close > d.or_high) & (d.close.shift() <= d.or_high),
            early & (d.close < d.or_low) & (d.close.shift() >= d.or_low))


def sig_band_fade(d):
    """Mean reversion: previous bar closed outside a 2.5 SD band, this bar closes back inside."""
    return ((d.close.shift() < d.bb_dn.shift()) & (d.close > d.bb_dn) & (d.close > d.open),
            (d.close.shift() > d.bb_up.shift()) & (d.close < d.bb_up) & (d.close < d.open))


def sig_rsi2(d):
    """With the trend, buy a 2-period RSI washout once a bar closes back in the trend's favour."""
    up = (d.close > d.vwap) & (d.ema_f > d.ema_s)
    down = (d.close < d.vwap) & (d.ema_f < d.ema_s)
    return (up & (d.rsi2.shift() < 10) & (d.close > d.open), down & (d.rsi2.shift() > 90) & (d.close < d.open))


def sig_exhaustion(d):
    """Fade three straight bars that together travelled at least 2.5 ATR."""
    red = d.close < d.open
    green = d.close > d.open
    drop = d.open.shift(2) - d.close
    return (red & red.shift(1, fill_value=False) & red.shift(2, fill_value=False) & (drop >= 2.5 * d.atr.shift(3)),
            green & green.shift(1, fill_value=False) & green.shift(2, fill_value=False) & (-drop >= 2.5 * d.atr.shift(3)))


SIGNALS = {
    "pullback": sig_pullback, "burst": sig_burst, "breakout": sig_breakout, "power_hour": sig_power_hour,
    "orb": sig_orb, "band_fade": sig_band_fade, "rsi2": sig_rsi2, "exhaustion": sig_exhaustion,
}


# ------------------------------------------------------------------ option model

def _ncdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def bs_price(spot, strike, minutes_left, iv, is_call):
    t = max(minutes_left, 0.0) / MINUTES_PER_YEAR
    if t <= 0 or iv <= 0:
        return max(spot - strike, 0.0) if is_call else max(strike - spot, 0.0)
    sd = iv * math.sqrt(t)
    d1 = (math.log(spot / strike) + 0.5 * sd * sd) / sd
    d2 = d1 - sd
    if is_call:
        return spot * _ncdf(d1) - strike * _ncdf(d2)
    return strike * _ncdf(-d2) - spot * _ncdf(-d1)


def minutes_to_close(ts):
    return (16 * 60) - (ts.hour * 60 + ts.minute + ts.second / 60)


def pick_strike(spot, minutes_left, iv, is_call, cap):
    """Nearest-the-money $1 strike whose ask fits under `cap`; None if nothing sensible."""
    strike = math.ceil(spot) if is_call else math.floor(spot)
    for _ in range(200):
        mid = bs_price(spot, strike, minutes_left, iv, is_call)
        if mid < 0.05:
            return None
        if cap is None or mid <= cap:
            return strike
        strike += 1 if is_call else -1
    return None


# -------------------------------------------------------------------- simulation

def simulate(df, p, costs, cap="default"):
    """Walk the bars with the same state machine the thinkScript uses.

    A signal on bar i enters at the open of bar i+1. While a trade is open no new
    signal is taken. Within a bar the stop is assumed to fill before the target.
    """
    cap = costs.premium_cap if cap == "default" else cap
    bar = pd.Timedelta(df.index[1] - df.index[0])
    o, h, l, c = (df[k].to_numpy() for k in ("open", "high", "low", "close"))
    atr, iv = df.atr.to_numpy(), (df.iv_raw if costs.dte else df.iv).to_numpy()
    extra_min = costs.dte * 390
    sig_call, sig_put, flat = df.sig_call.to_numpy(), df.sig_put.to_numpy(), df.is_flat_bar.to_numpy()
    dates, idx = df.date.to_numpy(), df.index
    trades, i, n = [], 0, len(df)
    while i < n - 1:
        if not (sig_call[i] or sig_put[i]) or dates[i + 1] != dates[i]:
            i += 1
            continue
        is_call = bool(sig_call[i])
        side = 1 if is_call else -1
        e = i + 1
        entry = o[e]
        target = entry + side * p.target_atr * atr[i]
        stop = entry - side * p.stop_atr * atr[i]
        j, bars_in = e, 0
        while True:
            bars_in += 1
            hit_stop = l[j] <= stop if is_call else h[j] >= stop
            hit_target = h[j] >= target if is_call else l[j] <= target
            if hit_stop:
                exit_px, why = (min(o[j], stop) if is_call else max(o[j], stop)), "stop"
                exit_ts = idx[j] + bar / 2
            elif hit_target:
                exit_px, why = (max(o[j], target) if is_call else min(o[j], target)), "target"
                exit_ts = idx[j] + bar / 2
            elif bars_in >= p.max_bars or flat[j] or j == n - 1 or dates[j + 1] != dates[j]:
                exit_px, why, exit_ts = c[j], "time", idx[j] + bar
            else:
                j += 1
                continue
            break

        entry_min = minutes_to_close(idx[e]) + extra_min
        strike = pick_strike(entry, entry_min, iv[i], is_call, cap)
        if strike is not None:
            buy = bs_price(entry, strike, entry_min, iv[i], is_call) + costs.slippage
            exit_iv = iv[i] if costs.freeze_iv else iv[j]
            sell_mid = bs_price(exit_px, strike, minutes_to_close(exit_ts) + extra_min, exit_iv, is_call)
            sell = max(sell_mid - costs.slippage, 0.0)
            gross = (sell_mid - (buy - costs.slippage)) * 100
            net = (sell - buy) * 100 - 2 * costs.commission
            trades.append({
                "entry_time": idx[e], "exit_time": exit_ts, "date": dates[e],
                "side": "CALL" if is_call else "PUT", "strike": strike, "exit_reason": why,
                "und_entry": entry, "und_exit": exit_px, "und_pnl": side * (exit_px - entry),
                "opt_buy": buy, "opt_sell": sell, "opt_gross": gross, "opt_net": net,
                "cost_basis": buy * 100 + costs.commission,
            })
        i = j  # the exit bar itself may carry the next signal, as in the thinkScript
    return pd.DataFrame(trades)


def stats(tr):
    if tr.empty:
        return {"trades": 0}
    wins, losses = tr.opt_net[tr.opt_net > 0], tr.opt_net[tr.opt_net <= 0]
    return {
        "trades": len(tr),
        "und_win%": 100 * (tr.und_pnl > 0).mean(),
        "opt_win%_no_costs": 100 * (tr.opt_gross > 0).mean(),
        "opt_win%_net": 100 * (tr.opt_net > 0).mean(),
        "avg_win$": wins.mean() if len(wins) else 0.0,
        "avg_loss$": losses.mean() if len(losses) else 0.0,
        "expectancy$": tr.opt_net.mean(),
        "total_net$": tr.opt_net.sum(),
        "profit_factor": wins.sum() / -losses.sum() if losses.sum() < 0 else float("inf"),
        "t_stat": tr.opt_net.mean() / (tr.opt_net.std(ddof=1) / math.sqrt(len(tr))) if len(tr) > 2 and tr.opt_net.std() > 0 else 0.0,
    }


def run_account(tr, start_cash=50.0, commission=0.65):
    """$50 cash account: one round trip per day (option proceeds settle T+1), one contract
    until the account can fund more while risking at most half of itself."""
    cash, curve, taken = start_cash, [], 0
    for _, day in tr.sort_values("entry_time").groupby("date"):
        t = day.iloc[0]
        qty = max(1, int(0.5 * cash // t.cost_basis))
        if qty * t.cost_basis > cash:
            curve.append((t.date, cash))
            continue
        cash += qty * t.opt_net
        taken += 1
        curve.append((t.date, cash))
    eq = pd.Series(dict(curve)) if curve else pd.Series(dtype=float)
    peak = eq.cummax().clip(lower=start_cash) if len(eq) else eq
    return {"start$": start_cash, "end$": round(cash, 2), "trades_taken": taken,
            "low$": round(eq.min(), 2) if len(eq) else start_cash,
            "max_drawdown%": round(100 * ((peak - eq) / peak).max(), 1) if len(eq) else 0.0}


def for_one_minute(p):
    """Clock settings for 1-minute bars: trade 9:35-15:50, flat by 15:55."""
    return replace(p, start="09:35", end="15:50", flat="15:55")


def for_hourly(p):
    """Clock settings for hourly bars: signals on the 10:30-13:30 bars, flat by 15:30."""
    return replace(p, start="10:30", end="13:30", flat="14:30")


# ----------------------------------------------------------------------- reports

GRID_TARGET = [0.25, 0.5, 0.75, 1.0, 1.5]
GRID_STOP = [1.0, 1.5, 2.0, 3.0, 4.0]


def fmt(d):
    return {k: (round(v, 2) if isinstance(v, float) else v) for k, v in d.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", default="5m", choices=["1m", "5m", "1h"])
    ap.add_argument("--strategy", default="pullback", choices=sorted(SIGNALS))
    ap.add_argument("--symbols", nargs="+", default=["SPY", "QQQ", "IWM"])
    ap.add_argument("--target-atr", type=float, default=Params.target_atr)
    ap.add_argument("--stop-atr", type=float, default=Params.stop_atr)
    ap.add_argument("--max-bars", type=int, default=Params.max_bars)
    ap.add_argument("--iv-scale", type=float, default=IV_SCALE)
    ap.add_argument("--slippage", type=float, default=Costs.slippage, help="$ per share per side")
    ap.add_argument("--commission", type=float, default=Costs.commission, help="$ per contract per side")
    ap.add_argument("--grid", action="store_true", help="sweep target/stop multiples")
    ap.add_argument("--trades-csv", help="write the trade list here")
    a = ap.parse_args()
    pd.set_option("display.width", 200)

    base = Params(strategy=a.strategy, target_atr=a.target_atr, stop_atr=a.stop_atr, max_bars=a.max_bars)
    if a.interval == "1m":
        base = for_one_minute(base)
    if a.interval == "1h":  # hourly bars: same rules, wider clock window
        base = replace(base, start="10:30", end="14:30", flat="15:30", max_bars=min(a.max_bars, 3))
    costs = Costs(slippage=a.slippage, commission=a.commission)
    frames = {s: add_indicators(load_underlying(s, a.interval, a.iv_scale), base) for s in a.symbols}
    first = min(f.index[0] for f in frames.values()).date()
    last = max(f.index[-1] for f in frames.values()).date()
    days = len({d for f in frames.values() for d in f.date})
    print(f"# {a.interval} bars, {first} -> {last} ({days} trading days), symbols: {', '.join(a.symbols)}")

    if a.grid:
        rows = []
        for tg in GRID_TARGET:
            for st in GRID_STOP:
                p = replace(base, target_atr=tg, stop_atr=st)
                tr = pd.concat([simulate(f, p, costs).assign(symbol=s) for s, f in frames.items()])
                rows.append({"target_atr": tg, "stop_atr": st, **fmt(stats(tr))})
        print(pd.DataFrame(rows).to_string(index=False))
        return

    all_tr = pd.concat([simulate(f, base, costs).assign(symbol=s) for s, f in frames.items()])
    print(f"\n## Rules: target {base.target_atr} ATR, stop {base.stop_atr} ATR, max {base.max_bars} bars")
    rows = [{"symbol": s, **fmt(stats(all_tr[all_tr.symbol == s]))} for s in a.symbols]
    rows.append({"symbol": "ALL", **fmt(stats(all_tr))})
    print(pd.DataFrame(rows).to_string(index=False))
    print("\n## Exit reasons (all symbols)")
    print(all_tr.groupby("exit_reason").opt_net.agg(["count", "mean", "sum"]).round(2).to_string())
    print("\n## Calls vs puts (all symbols)")
    print(all_tr.groupby("side").opt_net.agg(["count", "mean", "sum"]).round(2).to_string())
    print("\n## $50 account, one trade per day")
    acct = [{"symbol": s, **run_account(all_tr[all_tr.symbol == s], commission=costs.commission)} for s in a.symbols]
    print(pd.DataFrame(acct).to_string(index=False))
    print("\n## Same signals with an at-the-money contract (needs more than $50)")
    atm = pd.concat([simulate(f, base, costs, cap=None).assign(symbol=s) for s, f in frames.items()])
    print(pd.DataFrame([fmt({**stats(atm), "avg_contract_cost$": atm.cost_basis.mean()})]).to_string(index=False))
    if a.trades_csv:
        all_tr.to_csv(a.trades_csv, index=False, float_format="%.4f")


if __name__ == "__main__":
    main()

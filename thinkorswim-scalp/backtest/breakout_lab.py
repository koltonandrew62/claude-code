"""Try to make the breakout rule better without fooling ourselves.

Step 1 tests the rule exactly as it stands on 13 stocks and ETFs it was never tuned on.
Step 2 tests a short list of refinements, each with a reason behind it, three ways:
the original training days, the original held-back days, and the 13 new symbols.
A refinement only counts if it helps in all three.
"""
import sys
from dataclasses import replace

import numpy as np
import pandas as pd

import backtest as b

ORIGINAL = ["SPY", "QQQ", "IWM"]
NEW_ETFS = ["DIA", "XLF", "XLK", "XLE", "SMH"]
NEW_STOCKS = ["AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AMD"]
TRAIN_DAYS = 330
LOOKBACKS = [30, 20, 15]          # bars in the "new low" test
VOLUME_MULTS = [1.5, 1.2, 1.0]    # bar volume against its 20-bar average
WINDOWS = {"10:30-13:30": dict(start="10:30", end="13:30", flat="14:30"),
           "09:30-14:30": dict(start="09:30", end="14:30", flat="15:30")}
TARGETS = [99.0, 1.0, 0.5]        # profit target in ATRs; 99 = none
BASE = dict(target_atr=99.0, stop_atr=1.5, max_bars=4)
ETF_COSTS = b.Costs(premium_cap=4.0, dte=5, slippage=0.02)
STOCK_COSTS = b.Costs(premium_cap=4.0, dte=5, slippage=0.03)   # single-stock options have wider quotes


def daily_context(df):
    """Per-bar columns describing the days before today (nothing from today or later)."""
    closes = df.groupby("date").close.last()
    sma20 = closes.rolling(20).mean()
    trend = np.sign(closes - sma20).shift()               # yesterday's close against its 20-day average
    gap = (df.groupby("date").open.first() / closes.shift() - 1)
    df = df.copy()
    df["day_trend"] = df.date.map(trend).fillna(0.0)
    df["today_gap"] = df.date.map(gap).fillna(0.0)
    df["prev_close"] = df.date.map(closes.shift())
    return df


def add_market_break(df, symbol):
    """True on bars where the wider market is also at a 30-bar low: SPY, or QQQ when the chart is SPY."""
    ref = b.load("QQQ" if symbol == "SPY" else "SPY", "1h").between_time("09:30", "15:59")
    df = df.copy()
    for n in LOOKBACKS:
        broke = ref.close < ref.low.rolling(n).min().shift()
        df[f"market_break_{n}"] = broke.reindex(df.index).fillna(False).astype(bool)
    df["market_break"] = df["market_break_30"]
    return df


def load_any(symbol):
    """Hourly bars with an implied-volatility estimate. Symbols without their own volatility
    index use the VIX scaled by how much more the symbol has been moving than SPY."""
    if symbol in b.VOL_PROXY:
        return add_market_break(daily_context(b.load_underlying(symbol, "1h")), symbol)
    df = b.load(symbol, "1h").between_time("09:30", "15:59")
    df = df[df.volume > 0].copy()
    df["date"] = df.index.date
    spy = b.load("SPY", "1h").between_time("09:30", "15:59")
    spy_daily = spy.groupby(spy.index.date).close.last().pct_change()
    own_daily = df.groupby("date").close.last().pct_change()
    ratio = (own_daily.rolling(60, min_periods=20).std() / spy_daily.rolling(60, min_periods=20).std()).shift()
    vix = b.load("VIX", "1h").close.reindex(df.index, method="ffill")
    df["iv_raw"] = vix / 100.0 * df.date.map(ratio).clip(0.8, 6.0)
    df["iv"] = df.iv_raw * b.IV_SCALE
    return add_market_break(daily_context(df.dropna(subset=["iv_raw"])), symbol)


# ------------------------------------------------------------------ refinements
def register():
    base = b.sig_breakout

    def puts_only(d):
        call, put = base(d)
        return call & False, put

    def calls_only(d):
        call, put = base(d)
        return call, put & False

    def with_daily_trend(d):          # only trade breakouts in the direction of the daily trend
        call, put = base(d)
        return call & (d.day_trend > 0), put & (d.day_trend < 0)

    def puts_in_downtrend(d):
        call, put = base(d)
        return call & False, put & (d.day_trend < 0)

    def beyond_yesterday(d):          # the breakout must also clear yesterday's close
        call, put = base(d)
        return call & (d.close > d.prev_close), put & (d.close < d.prev_close)

    def puts_beyond_yesterday(d):
        call, put = base(d)
        return call & False, put & (d.close < d.prev_close)

    def puts_market_confirmed(d):     # the wider market must be breaking down on the same bar
        call, put = base(d)
        return call & False, put & d.market_break

    def strong_volume(d):             # 2x volume instead of 1.5x
        call, put = base(d)
        strong = d.volume >= 2.0 * d.vol_avg
        return call & strong, put & strong

    b.SIGNALS.update({
        "breakout_puts": puts_only, "breakout_calls": calls_only, "breakout_trend": with_daily_trend,
        "breakout_puts_downtrend": puts_in_downtrend, "breakout_beyond_yday": beyond_yesterday,
        "breakout_puts_beyond_yday": puts_beyond_yesterday, "breakout_strong_volume": strong_volume,
        "breakout_puts_confirmed": puts_market_confirmed,
    })


VARIANTS = [
    ("breakout", "As it stands"),
    ("breakout_puts", "Puts only"),
    ("breakout_calls", "Calls only"),
    ("breakout_trend", "With the daily trend only"),
    ("breakout_puts_downtrend", "Puts only, in a daily downtrend"),
    ("breakout_strong_volume", "2x volume instead of 1.5x"),
    ("breakout_puts_confirmed", "Puts only, wider market also at a 30-bar low"),
]


def run(strategy, raw, costs_for):
    p = b.for_hourly(replace(b.Params(), strategy=strategy, **BASE))
    parts = [b.simulate(b.add_indicators(df, p), p, costs_for(s)).assign(symbol=s) for s, df in raw.items()]
    parts = [x for x in parts if not x.empty]
    return pd.concat(parts) if parts else pd.DataFrame()


def summarise(tr):
    if tr.empty:
        return {"n": 0, "win%": 0.0, "avg$": 0.0, "t": 0.0, "total$": 0.0}
    s = b.stats(tr)
    return {"n": s["trades"], "win%": round(s["opt_win%_net"], 1), "avg$": round(s["expectancy$"], 2),
            "t": round(s["t_stat"], 2), "total$": round(tr.opt_net.sum(), 0)}


def main():
    register()
    pd.set_option("display.width", 220)
    orig = {s: load_any(s) for s in ORIGINAL}
    fresh = {s: load_any(s) for s in NEW_ETFS + NEW_STOCKS}
    days = sorted({d for df in orig.values() for d in df.date})
    split = days[TRAIN_DAYS]
    costs_for = lambda s: STOCK_COSTS if s in NEW_STOCKS else ETF_COSTS

    print("# Step 1: the rule as it stands, on symbols it has never seen")
    tr = run("breakout", fresh, costs_for)
    rows = [{"group": "13 new symbols", **summarise(tr)},
            {"group": "  new ETFs", **summarise(tr[tr.symbol.isin(NEW_ETFS)])},
            {"group": "  new stocks", **summarise(tr[tr.symbol.isin(NEW_STOCKS)])},
            {"group": "  calls", **summarise(tr[tr.side == "CALL"])},
            {"group": "  puts", **summarise(tr[tr.side == "PUT"])},
            {"group": "  first 330 days", **summarise(tr[tr.date < split])},
            {"group": "  last 170 days", **summarise(tr[tr.date >= split])}]
    print(pd.DataFrame(rows).to_string(index=False))
    print(tr.groupby("symbol").opt_net.agg(n="count", avg="mean", total="sum").round(1).T.to_string())

    print("\n# Step 2: refinements, each scored three ways")
    out = []
    for key, label in VARIANTS:
        a = run(key, orig, costs_for)
        f = run(key, fresh, costs_for)
        tr_, he_ = (a[a.date < split], a[a.date >= split]) if not a.empty else (a, a)
        st, sh, sf = summarise(tr_), summarise(he_), summarise(f)
        out.append({"variant": label, "train_n": st["n"], "train_win%": st["win%"], "train_avg$": st["avg$"],
                    "held_n": sh["n"], "held_win%": sh["win%"], "held_avg$": sh["avg$"],
                    "new_n": sf["n"], "new_win%": sf["win%"], "new_avg$": sf["avg$"], "new_t": sf["t"]})
    res = pd.DataFrame(out)
    res.to_csv("results/breakout_lab.csv", index=False)
    print(res.to_string(index=False))


def loose_name(n, vol):
    return f"puts_confirmed_{n}_{vol}"


def register_loose():
    """Confirmed-put rules with a shorter lookback and/or a lower volume bar."""
    for n in LOOKBACKS:
        for vol in VOLUME_MULTS:
            def rule(d, n=n, vol=vol):
                new_low = d.close < d.low.rolling(n).min().shift()
                put = new_low & (d.volume >= vol * d.vol_avg) & (d.close < d.vwap) & d[f"market_break_{n}"]
                return put & False, put
            b.SIGNALS[loose_name(n, vol)] = rule


def run_loose(n, vol, window, target, raw, costs_for):
    p = replace(b.Params(), strategy=loose_name(n, vol), target_atr=target, stop_atr=BASE["stop_atr"],
                max_bars=BASE["max_bars"], **WINDOWS[window])
    parts = [b.simulate(b.add_indicators(df, p), p, costs_for(s)).assign(symbol=s) for s, df in raw.items()]
    parts = [x for x in parts if not x.empty]
    return pd.concat(parts) if parts else pd.DataFrame()


def more():
    """Step 3: look for a looser version that trades more often and still wins everywhere."""
    import itertools
    register()
    register_loose()
    pd.set_option("display.width", 240)
    orig = {s: load_any(s) for s in ORIGINAL}
    fresh = {s: load_any(s) for s in NEW_ETFS + NEW_STOCKS}
    days = sorted({d for df in orig.values() for d in df.date})
    split = days[TRAIN_DAYS]
    costs_for = lambda s: STOCK_COSTS if s in NEW_STOCKS else ETF_COSTS
    rows = []
    for n, vol, window, target in itertools.product(LOOKBACKS, VOLUME_MULTS, WINDOWS, TARGETS):
        a = run_loose(n, vol, window, target, orig, costs_for)
        f = run_loose(n, vol, window, target, fresh, costs_for)
        st, sh, sf = summarise(a[a.date < split]), summarise(a[a.date >= split]), summarise(f)
        se = summarise(f[f.symbol.isin(NEW_ETFS)])
        rows.append({"lookback": n, "volume_x": vol, "window": window, "target": target,
                     "train_n": st["n"], "train_win%": st["win%"], "train_avg$": st["avg$"],
                     "held_n": sh["n"], "held_win%": sh["win%"], "held_avg$": sh["avg$"],
                     "new_n": sf["n"], "new_win%": sf["win%"], "new_avg$": sf["avg$"], "new_t": sf["t"],
                     "new_etf_n": se["n"], "new_etf_win%": se["win%"], "new_etf_avg$": se["avg$"]})
    res = pd.DataFrame(rows)
    res["signals"] = res.train_n + res.held_n + res.new_n
    res.to_csv("results/breakout_more.csv", index=False)
    ok = res[(res["train_avg$"] > 0) & (res["held_avg$"] > 0) & (res["new_avg$"] > 0)
             & (res["train_win%"] >= 50) & (res["held_win%"] >= 50) & (res["new_win%"] >= 50)]
    print("# Step 3: looser versions of the improved rule")
    print(f"{len(res)} versions tried. {len(ok)} made money AND won at least half their trades on all three data sets.")
    print("\nThose, most signals first:")
    print(ok.sort_values("signals", ascending=False).to_string(index=False))
    base = res[(res.lookback == 30) & (res.volume_x == 1.5) & (res.window == "10:30-13:30") & (res.target == 99.0)]
    print("\nThe improved rule before loosening:")
    print(base.to_string(index=False))


MY_SYMBOLS = ["QQQ"] + NEW_STOCKS      # what the account actually trades: QQQ and individual stocks
MAX_OPEN = 3                           # positions the account may hold at once


def mine():
    """Step 4: the same search, scored only on QQQ and the eight stocks."""
    import itertools
    register()
    register_loose()
    pd.set_option("display.width", 240)
    raw = {s: load_any(s) for s in MY_SYMBOLS}
    days = sorted({d for df in raw.values() for d in df.date})
    split = days[TRAIN_DAYS]
    costs_for = lambda s: STOCK_COSTS if s in NEW_STOCKS else ETF_COSTS
    rows = []
    for n, vol, window, target in itertools.product(LOOKBACKS, VOLUME_MULTS, WINDOWS, TARGETS):
        t = run_loose(n, vol, window, target, raw, costs_for)
        first, last = summarise(t[t.date < split]), summarise(t[t.date >= split])
        qqq, stocks = summarise(t[t.symbol == "QQQ"]), summarise(t[t.symbol != "QQQ"])
        rows.append({"lookback": n, "volume_x": vol, "window": window, "target": target,
                     "signals": len(t), "per_year": round(len(t) / (len(days) / 252)),
                     "win%": summarise(t)["win%"], "avg$": summarise(t)["avg$"], "t": summarise(t)["t"],
                     "first_n": first["n"], "first_win%": first["win%"], "first_avg$": first["avg$"],
                     "last_n": last["n"], "last_win%": last["win%"], "last_avg$": last["avg$"],
                     "qqq_n": qqq["n"], "qqq_win%": qqq["win%"], "qqq_avg$": qqq["avg$"],
                     "stocks_n": stocks["n"], "stocks_win%": stocks["win%"], "stocks_avg$": stocks["avg$"]})
    res = pd.DataFrame(rows)
    res.to_csv("results/breakout_qqq_stocks.csv", index=False)
    ok = res[(res["first_avg$"] > 0) & (res["last_avg$"] > 0) & (res["first_win%"] >= 50) & (res["last_win%"] >= 50)
             & (res["qqq_avg$"] > 0) & (res["stocks_avg$"] > 0)]
    print("# Step 4: QQQ and eight stocks only")
    print(f"{len(res)} versions tried. {len(ok)} made money on QQQ and on the stocks, and made money while winning at "
          "least half their trades in both the first 330 and the last 170 days.")
    print("\nThose, most signals first:")
    print(ok.sort_values("signals", ascending=False).to_string(index=False))
    base = res[(res.lookback == 30) & (res.volume_x == 1.5) & (res.window == "10:30-13:30") & (res.target == 99.0)]
    print("\nThe improved rule before loosening, on these symbols:")
    print(base.to_string(index=False))
    return res, ok


def walk_multi(tr, days, split, priority):
    """$1,600 account that may hold up to MAX_OPEN positions, QQQ first when signals collide."""
    import account_longer as al
    order = {s: i for i, s in enumerate(priority)}
    tr = tr.assign(rank=tr.symbol.map(order)).sort_values(["entry_time", "rank"])
    cash, ledger, open_until = al.START_CASH, [], []
    settled_day, settled = None, cash
    for t in tr.itertuples():
        if t.date != settled_day:
            settled_day, settled = t.date, cash
        open_until = [x for x in open_until if x > t.entry_time]
        if len(open_until) >= MAX_OPEN:
            continue
        costs = STOCK_COSTS if t.symbol in NEW_STOCKS else ETF_COSTS
        buy, sell = round(t.opt_buy, 2), round(t.opt_sell, 2)
        unit = buy * 100 + 2 * costs.commission
        qty = max(1, int(al.RISK_FRACTION * cash // unit))
        if unit > al.MAX_CONTRACT_FRACTION * cash or qty * unit > settled:
            continue
        settled -= qty * unit
        cash = round(cash + round(((sell - buy) * 100 - 2 * costs.commission) * qty, 2), 2)
        open_until.append(t.exit_time)
        ledger.append({"date": t.date, "entry": t.entry_time.strftime("%H:%M"), "exit": t.exit_time.strftime("%H:%M"),
                       "symbol": t.symbol, "rule": "", "side": t.side, "strike": t.strike, "qty": qty,
                       "buy": buy, "sell": sell, "exit_reason": t.exit_reason,
                       "extra": "First 330 days" if t.date < split else "Last 170 days"})
    return ledger


FINAL = dict(n=30, vol=1.0, window="10:30-13:30", target=0.5)   # the version adopted for QQQ and stocks
PRIORITY = ["QQQ", "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AMD"]


def final_trades(freeze_iv=False, slip_mult=1.0, symbols=MY_SYMBOLS, **override):
    """Trades of the adopted rule. `freeze_iv` prices every exit at the entry's implied volatility."""
    register()
    register_loose()
    cfg = {**FINAL, **override}
    raw = {s: load_any(s) for s in symbols}

    def costs_for(s):
        c = STOCK_COSTS if s in NEW_STOCKS else ETF_COSTS
        return replace(c, slippage=c.slippage * slip_mult, freeze_iv=freeze_iv)

    tr = run_loose(cfg["n"], cfg["vol"], cfg["window"], cfg["target"], raw, costs_for)
    days = sorted({d for df in raw.values() for d in df.date})
    return tr, days


def day_stats(tr):
    daily = tr.groupby("date").opt_net.sum()
    x = tr.opt_net
    return {"trades": len(tr), "days": len(daily), "win%": round(100 * (x > 0).mean(), 1), "avg$": round(x.mean(), 2),
            "avg_win$": round(x[x > 0].mean(), 2), "avg_loss$": round(x[x <= 0].mean(), 2),
            "winning_days%": round(100 * (daily > 0).mean(), 0),
            "day_t": round(daily.mean() / (daily.std() / np.sqrt(len(daily))), 2),
            "total$": round(x.sum(), 0), "best5days$": round(daily.nlargest(5).sum(), 0)}


def stress():
    """Step 5: how much of the result survives harsher assumptions."""
    pd.set_option("display.width", 240)
    rows = []
    for label, kw in (("As modelled", {}),
                      ("Implied volatility held flat during the trade", dict(freeze_iv=True)),
                      ("Slippage doubled", dict(slip_mult=2.0)),
                      ("Volatility flat and slippage doubled", dict(freeze_iv=True, slip_mult=2.0))):
        tr, days = final_trades(**kw)
        split = days[TRAIN_DAYS]
        rows.append({"assumption": label, **day_stats(tr)})
        if not kw:
            for name, part in (("  first 330 days", tr[tr.date < split]), ("  last 170 days", tr[tr.date >= split]),
                               ("  QQQ only", tr[tr.symbol == "QQQ"]), ("  stocks only", tr[tr.symbol != "QQQ"])):
                rows.append({"assumption": name, **day_stats(part)})
    res = pd.DataFrame(rows)
    res.to_csv("results/breakout_stress.csv", index=False)
    print("# Step 5: the adopted rule under harsher assumptions (QQQ and eight stocks)")
    print(res.to_string(index=False))
    prev, _ = final_trades(vol=1.5, target=99.0)
    prev_flat, _ = final_trades(freeze_iv=True, vol=1.5, target=99.0)
    print("\nThe previous improved rule (no target), same symbols:")
    print(pd.DataFrame([{"assumption": "As modelled", **day_stats(prev)},
                        {"assumption": "Implied volatility held flat during the trade", **day_stats(prev_flat)}]).to_string(index=False))


def final_account():
    """Made-up $1,600 account for the adopted rule; writes ../QQQStocksAccount.xlsx."""
    from pathlib import Path

    from openpyxl import Workbook
    from openpyxl.styles import Font

    import account_longer as al
    from account import BLUE, BOLD, FONT, HEAD_FILL, INPUT_FILL, MONEY, PCT

    tr, days = final_trades()
    flat, _ = final_trades(freeze_iv=True)
    split = days[TRAIN_DAYS]
    led_a, led_b = walk_multi(tr, days, split, PRIORITY), walk_multi(flat, days, split, PRIORITY)
    label = "confirmed put breakout, sell at +0.5 ATR or after 4h"
    for row in led_a + led_b:
        row["rule"] = label
    wb = Workbook()
    summary = wb.active
    summary.title = "Summary"
    ws_a, ws_b = wb.create_sheet("Ledger"), wb.create_sheet("Ledger, volatility flat")
    al.write_ledger(ws_a, led_a, "Period")
    al.write_ledger(ws_b, led_b, "Period")
    last = {"B": len(led_a) + 1, "C": len(led_b) + 1}
    sheet = {"B": "Ledger", "C": "Ledger, volatility flat"}
    for col, width in zip("ABCDE", (44, 20, 24, 4, 95)):
        summary.column_dimensions[col].width = width
    summary["A1"] = "Made-up $1,600 account: confirmed put breakouts on QQQ and eight stocks"
    summary["A1"].font = Font(name=FONT, bold=True, size=14)
    summary["A2"] = (f"Simulated trades, not real ones. Hourly bars, {days[0]} to {days[-1]}. "
                     "Option prices are modelled, not historical quotes.")
    for col, text in zip("ABE", ("Inputs", "Value", "Notes")):
        summary[f"{col}3"], summary[f"{col}3"].font, summary[f"{col}3"].fill = text, BOLD, HEAD_FILL
    inputs = [
        ("Starting balance ($)", al.START_CASH, MONEY, "Set by you."),
        ("Commission per contract, per side ($)", 0.65, MONEY, "thinkorswim / Schwab standard option commission. Feeds the Fees column."),
        ("Share of the balance spent per trade", al.RISK_FRACTION, PCT, "Assumption. Always at least one contract, as long as it costs under 25% of the balance."),
        ("Most positions open at once", MAX_OPEN, "0", "Assumption. When more symbols signal together, QQQ is taken first, then the stocks in the order listed below."),
        ("Profit target (ATR of the hourly chart)", FINAL["target"], "0.0", "Sell when price has fallen this far. Otherwise sell at a 1.5 ATR stop or after 4 hourly bars."),
    ]
    for r, (name, value, fmt, note) in enumerate(inputs, start=4):
        summary[f"A{r}"], summary[f"B{r}"], summary[f"E{r}"] = name, value, note
        summary[f"B{r}"].font, summary[f"B{r}"].fill, summary[f"B{r}"].number_format = BLUE, INPUT_FILL, fmt
    for col, text in zip("ABCE", ("Results", "As modelled", "If option volatility stays flat", "Notes")):
        summary[f"{col}11"], summary[f"{col}11"].font, summary[f"{col}11"].fill = text, BOLD, HEAD_FILL
    labels = ["Trades taken", "Winning trades", "Win rate", "Total net P&L ($)", "Average per trade ($)",
              "Average win ($)", "Average loss ($)", "Ending balance ($)", "Return on starting balance",
              "Lowest balance ($)", "Highest balance ($)"]
    for col in "BC":
        for r, (formula, fmt) in enumerate(al.results_block(sheet[col], last[col]), start=12):
            summary[f"{col}{r}"] = formula.replace("{c}", col)
            summary[f"{col}{r}"].number_format = fmt
    for r, name in enumerate(labels, start=12):
        summary[f"A{r}"] = name
    summary["E12"] = "Same signals in both columns. Cash from a sale is not reused until the next day."
    summary["E15"] = ("As modelled, a put is repriced with the volatility index at the moment of sale, which jumps in selloffs. "
                      "The other column assumes the put's volatility does not change. The truth is somewhere between.")
    for col, text in zip("ABC", ("By period (as modelled)", "Trades", "Net P&L ($)")):
        summary[f"{col}25"], summary[f"{col}25"].font, summary[f"{col}25"].fill = text, BOLD, HEAD_FILL
    per, m, sym = f"Ledger!$P$2:$P${last['B']}", f"Ledger!$M$2:$M${last['B']}", f"Ledger!$E$2:$E${last['B']}"
    for r, key in enumerate(("First 330 days", "Last 170 days"), start=26):
        summary[f"A{r}"] = key
        summary[f"B{r}"] = f'=COUNTIFS({per},"{key}")'
        summary[f"C{r}"] = f'=SUMIFS({m},{per},"{key}")'
        summary[f"C{r}"].number_format = MONEY
    for col, text in zip("ABC", ("By symbol (as modelled)", "Trades", "Net P&L ($)")):
        summary[f"{col}29"], summary[f"{col}29"].font, summary[f"{col}29"].fill = text, BOLD, HEAD_FILL
    for r, s_ in enumerate(PRIORITY, start=30):
        summary[f"A{r}"] = s_
        summary[f"B{r}"] = f"=COUNTIFS({sym},A{r})"
        summary[f"C{r}"] = f"=SUMIFS({m},{sym},A{r})"
        summary[f"C{r}"].number_format = MONEY
    notes = [
        "How to read this",
        "Rule: on an hourly chart, buy a put when price closes below its 30-bar low on at least average volume, below VWAP, "
        "while SPY is also below its own 30-bar low on the same bar. Signals on the 10:30 to 13:30 bars only.",
        "Sell when price has fallen 0.5 ATR, or risen 1.5 ATR against you, or after 4 hourly bars.",
        "Contract: a put about 5 trading days from expiry, nearest the money, costing $4.00 or less.",
        "Stock option prices are modelled more roughly than QQQ's: the VIX scaled by how much each stock moves.",
        "Blue cells are inputs or simulated trade data. Black cells are formulas. Rerun backtest/breakout_lab.py final to regenerate.",
    ]
    for r, text in enumerate(notes, start=41):
        summary[f"A{r}"] = text
    summary["A41"].font = BOLD
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if cell.font.name != FONT:
                    f = cell.font
                    cell.font = Font(name=FONT, bold=f.bold, color=f.color, size=f.size)
    out = Path(__file__).parent.parent / "QQQStocksAccount.xlsx"
    wb.save(out)
    print(f"{out.name}: {len(led_a)} of {len(tr)} signals taken", file=sys.stderr)


IMPROVED = "breakout_puts_confirmed"


def improved_trades(symbols=ORIGINAL, strategy=IMPROVED):
    """Trades of the improved rule (puts only, market confirmed), earliest first."""
    register()
    raw = {s: load_any(s) for s in symbols}
    costs_for = lambda s: STOCK_COSTS if s in NEW_STOCKS else ETF_COSTS
    tr = run(strategy, raw, costs_for).sort_values(["entry_time", "symbol"]).reset_index(drop=True)
    days = sorted({d for df in raw.values() for d in df.date})
    return tr, days


def account():
    """Made-up $1,600 account trading the puts-only version; writes ../BreakoutPutsAccount.xlsx."""
    from pathlib import Path

    from openpyxl import Workbook
    from openpyxl.styles import Font

    import account_longer as al
    from account import BLUE, BOLD, FONT, HEAD_FILL, INPUT_FILL, MONEY, PCT

    tr, days = improved_trades()
    label = "breakout, puts only, market confirmed, sell after 4h, expires 5 days out"
    ledger = al.walk_single(tr, ETF_COSTS, label, days)
    wb = Workbook()
    summary = wb.active
    summary.title = "Summary"
    led = wb.create_sheet("Ledger")
    al.write_ledger(led, ledger, "Period")
    last = len(ledger) + 1
    for col, width in zip("ABCDE", (44, 18, 18, 18, 90)):
        summary.column_dimensions[col].width = width
    summary["A1"] = "Made-up $1,600 account: improved breakout rule (puts only, market confirmed)"
    summary["A1"].font = Font(name=FONT, bold=True, size=14)
    summary["A2"] = (f"Simulated trades, not real ones. Hourly bars, {days[0]} to {days[-1]}. "
                     "Option prices are modelled, not historical quotes.")
    for col, text in zip("ABE", ("Inputs", "Value", "Notes")):
        summary[f"{col}3"], summary[f"{col}3"].font, summary[f"{col}3"].fill = text, BOLD, HEAD_FILL
    inputs = [
        ("Starting balance ($)", al.START_CASH, MONEY, "Set by you."),
        ("Commission per contract, per side ($)", 0.65, MONEY, "thinkorswim / Schwab standard option commission. Feeds the Fees column."),
        ("Share of the balance spent per trade", al.RISK_FRACTION, PCT, "Assumption. Always at least one contract, as long as it costs under 25% of the balance."),
        ("Stop (ATR of the hourly chart)", BASE["stop_atr"], "0.0", "Assumption. No profit target: sell at the stop or after 4 hourly bars."),
    ]
    for r, (name, value, fmt, note) in enumerate(inputs, start=4):
        summary[f"A{r}"], summary[f"B{r}"], summary[f"E{r}"] = name, value, note
        summary[f"B{r}"].font, summary[f"B{r}"].fill, summary[f"B{r}"].number_format = BLUE, INPUT_FILL, fmt
    for col, text in zip("AB", ("Results", "Value")):
        summary[f"{col}11"], summary[f"{col}11"].font, summary[f"{col}11"].fill = text, BOLD, HEAD_FILL
    labels = ["Trades taken", "Winning trades", "Win rate", "Total net P&L ($)", "Average per trade ($)",
              "Average win ($)", "Average loss ($)", "Ending balance ($)", "Return on starting balance",
              "Lowest balance ($)", "Highest balance ($)"]
    for r, (name, (formula, fmt)) in enumerate(zip(labels, al.results_block("Ledger", last)), start=12):
        summary[f"A{r}"], summary[f"B{r}"] = name, formula.replace("{c}", "B")
        summary[f"B{r}"].number_format = fmt
    summary["E12"] = "One position at a time across SPY, QQQ and IWM. Cash from a sale is not reused until the next day."

    m, sym, per = f"Ledger!$M$2:$M${last}", f"Ledger!$E$2:$E${last}", f"Ledger!$P$2:$P${last}"
    for col, text in zip("ABCD", ("By ETF", "Trades", "Winning trades", "Net P&L ($)")):
        summary[f"{col}25"], summary[f"{col}25"].font, summary[f"{col}25"].fill = text, BOLD, HEAD_FILL
    for r, s_ in enumerate(ORIGINAL, start=26):
        summary[f"A{r}"] = s_
        summary[f"B{r}"] = f'=COUNTIFS({sym},A{r})'
        summary[f"C{r}"] = f'=COUNTIFS({sym},A{r},{m},">0")'
        summary[f"D{r}"] = f'=SUMIFS({m},{sym},A{r})'
        summary[f"D{r}"].number_format = MONEY
    for col, text in zip("ABCD", ("By period", "Trades", "Winning trades", "Net P&L ($)")):
        summary[f"{col}30"], summary[f"{col}30"].font, summary[f"{col}30"].fill = text, BOLD, HEAD_FILL
    for r, (name, key) in enumerate((("First 330 trading days", "Training"), ("Last 170 trading days", "Held back")), start=31):
        summary[f"A{r}"] = name
        summary[f"B{r}"] = f'=COUNTIFS({per},"{key}")'
        summary[f"C{r}"] = f'=COUNTIFS({per},"{key}",{m},">0")'
        summary[f"D{r}"] = f'=SUMIFS({m},{per},"{key}")'
        summary[f"D{r}"].number_format = MONEY
    summary["A34"] = "Three largest winning trades ($)"
    summary["B34"] = f"=LARGE({m},1)+LARGE({m},2)+LARGE({m},3)"
    summary["B34"].number_format = MONEY
    summary["E34"] = "Compare with Total net P&L above: almost all of the profit is these three trades."
    notes = [
        "How to read this",
        "Rule: on an hourly chart, buy a put when price closes below the 30-bar low on 1.5x volume, below VWAP, "
        "and the wider market (SPY, or QQQ on a SPY chart) is below its own 30-bar low on the same bar.",
        "Sell if price rises 1.5 ATR against you, otherwise after 4 hourly bars.",
        "Calls were dropped because upside breakouts lost money on every set of symbols tested, including ones the rule had never seen.",
        "The market-confirmation idea came from looking at these same two years, so it has not had a clean test.",
        "Blue cells are inputs or simulated trade data. Black cells are formulas. Rerun backtest/breakout_lab.py account to regenerate.",
    ]
    for r, text in enumerate(notes, start=36):
        summary[f"A{r}"] = text
    summary["A36"].font = BOLD
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if cell.font.name != FONT:
                    f = cell.font
                    cell.font = Font(name=FONT, bold=f.bold, color=f.color, size=f.size)
    out = Path(__file__).parent.parent / "BreakoutPutsAccount.xlsx"
    wb.save(out)
    print(f"{out.name}: {len(ledger)} of {len(tr)} signals taken", file=sys.stderr)


if __name__ == "__main__":
    steps = {"account": account, "more": more, "mine": mine, "stress": stress, "final": final_account}
    steps.get((sys.argv[1:] or [""])[0], main)()

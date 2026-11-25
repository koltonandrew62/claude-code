"""Quant model in the spirit of statistical pattern recognition, traded with options.

Every morning, for SPY, QQQ and IWM, the model estimates the chance that the day closes
above its open. It combines two things, both built only from data before that day:

  1. A regression model: many weak signals (gap, recent returns, stretch from average,
     volatility, relative strength between the three ETFs, bonds, calendar) weighted by
     a logistic regression.
  2. Pattern matching: find the most similar past mornings and count how they ended.

The model is refitted at the start of each year on everything before that year, so every
prediction from FIRST_TEST_YEAR on is for a day the model has never seen.

Trades: buy a call (or put) at the open when the estimate is far enough from 50%, sell at
a target, a stop, or the close. Calls and puts are only ever bought, never sold short. Settings are chosen on the validation years and then
checked once on the held-back years.
"""
import itertools
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

import backtest as b

DATA = Path(__file__).parent / "data"
RESULTS = Path(__file__).parent / "results"
SYMBOLS = ["SPY", "QQQ", "IWM"]
IV_PROXY = {"SPY": ("VIX", 1.0), "QQQ": ("VXN", 1.0), "IWM": ("VIX", 1.2)}
FIRST_TEST_YEAR = 2016        # first year predicted out of sample (model trained on 2012-2015)
HELD_BACK_FROM = 2022         # settings are chosen on 2016-2021 and checked on 2022 onward
RIDGE = 10.0
NEIGHBOURS = 100
EXPIRIES = [5, 20]            # trading days to expiry of the contract bought
PREMIUM_CAP = 4.0             # most the contract may cost per share ($400 per contract)
SLIP_IN, SLIP_OUT, COMMISSION = 0.03, 0.02, 0.65

FEATURES = ["gap", "ret1", "oc1", "ret5", "ret20", "z20", "rsi2", "clv", "vix_z", "vix_chg", "vix_term",
            "rel5", "gap_rel", "tlt1", "vol_ratio", "mon", "fri", "month_turn"]
PATTERN = ["gap", "ret1", "ret5", "z20", "rsi2", "vix_z", "vix_chg", "rel5"]   # used to match past mornings


def daily(symbol):
    df = pd.read_csv(DATA / f"{symbol}_1d.csv", parse_dates=["ts_utc"])
    df.index = pd.DatetimeIndex(df.pop("ts_utc").dt.tz_convert(b.ET).dt.date)
    return df[~df.index.duplicated()]


def build_features():
    px = {s: daily(s) for s in SYMBOLS}
    vix, vxn, vix3m, tlt = daily("VIX"), daily("VXN"), daily("VIX3M"), daily("TLT")
    frames = []
    for s, d in px.items():
        f = pd.DataFrame(index=d.index)
        ret = d.close.pct_change()
        sigma = ret.rolling(20).std().shift()            # known at yesterday's close
        prev = d.close.shift()
        f["gap"] = (d.open / prev - 1) / sigma
        f["ret1"] = ret.shift() / sigma
        f["oc1"] = (d.close / d.open - 1).shift() / sigma
        f["ret5"] = (prev / d.close.shift(6) - 1) / (sigma * math.sqrt(5))
        f["ret20"] = (prev / d.close.shift(21) - 1) / (sigma * math.sqrt(20))
        f["z20"] = ((d.close - d.close.rolling(20).mean()) / d.close.rolling(20).std()).shift()
        delta = d.close.diff()
        up = delta.clip(lower=0).ewm(alpha=0.5, adjust=False).mean()
        dn = (-delta.clip(upper=0)).ewm(alpha=0.5, adjust=False).mean()
        f["rsi2"] = ((100 - 100 / (1 + up / dn.where(dn > 0, 1e-12))).shift() - 50) / 50
        rng = (d.high - d.low)
        f["clv"] = (((d.close - d.low) / rng.where(rng > 0)) - 0.5).shift()
        lv = np.log(vix.close.reindex(d.index).ffill())
        f["vix_z"] = ((lv - lv.rolling(252).mean()) / lv.rolling(252).std()).shift()
        f["vix_chg"] = (lv.diff() / lv.diff().rolling(60).std()).shift()
        f["vix_term"] = (vix.close / vix3m.close - 1).reindex(d.index).ffill().shift()
        tr = tlt.close.pct_change().reindex(d.index)
        f["tlt1"] = (tr / tr.rolling(20).std()).shift()
        f["vol_ratio"] = (ret.rolling(20).std() / ret.rolling(100).std()).shift() - 1
        f["mon"] = (d.index.dayofweek == 0).astype(float)
        f["fri"] = (d.index.dayofweek == 4).astype(float)
        dom = pd.Series(d.index.day, index=d.index)
        f["month_turn"] = ((dom >= 28) | (dom <= 3)).astype(float).to_numpy()
        # trade bookkeeping
        f["symbol"], f["open"], f["high"], f["low"], f["close"] = s, d.open, d.high, d.low, d.close
        pc = d.close.shift()
        true_range = pd.concat([d.high - d.low, (d.high - pc).abs(), (d.low - pc).abs()], axis=1).max(axis=1)
        f["atr"] = true_range.ewm(alpha=1 / 14, adjust=False).mean().shift()
        idx_name, mult = IV_PROXY[s]
        vol_idx = vxn if idx_name == "VXN" else vix
        fallback = vix.reindex(d.index).ffill() * (1.25 if idx_name == "VXN" else mult)
        f["iv_open"] = (vol_idx.open.reindex(d.index) * mult).fillna(fallback.open) / 100
        f["iv_close"] = (vol_idx.close.reindex(d.index) * mult).fillna(fallback.close) / 100
        f["up"] = (d.close > d.open).astype(float)
        frames.append(f)
    allf = pd.concat(frames)
    # cross-sectional pieces: each ETF against the average of the three
    for col, new in (("ret5", "rel5"), ("gap", "gap_rel")):
        allf[new] = allf[col] - allf.groupby(level=0)[col].transform("mean")
    allf = allf.replace([np.inf, -np.inf], np.nan).dropna(subset=FEATURES + ["atr", "iv_open", "iv_close"])
    allf[FEATURES[:15]] = allf[FEATURES[:15]].clip(-5, 5)
    return allf.sort_index(kind="stable")


def fit_logistic(x, y, ridge):
    """Ridge-penalised logistic regression by Newton's method. x has an intercept column."""
    w = np.zeros(x.shape[1])
    pen = np.eye(x.shape[1]) * ridge
    pen[0, 0] = 0.0
    for _ in range(50):
        p = 1 / (1 + np.exp(-x @ w))
        step = np.linalg.solve(x.T @ (x * (p * (1 - p))[:, None]) + pen, x.T @ (y - p) - pen @ w)
        w += step
        if np.abs(step).max() < 1e-8:
            break
    return w


def predict(allf):
    """Walk forward one year at a time; returns the frame with out-of-sample probabilities."""
    out, weights = [], {}
    years = sorted(set(allf.index.year))
    for year in [y for y in years if y >= FIRST_TEST_YEAR]:
        train, test = allf[allf.index.year < year], allf[allf.index.year == year]
        mu, sd = train[FEATURES].mean(), train[FEATURES].std().replace(0, 1)
        xtr, xte = ((train[FEATURES] - mu) / sd).to_numpy(), ((test[FEATURES] - mu) / sd).to_numpy()
        w = fit_logistic(np.c_[np.ones(len(xtr)), xtr], train.up.to_numpy(), RIDGE)
        p_model = 1 / (1 + np.exp(-(np.c_[np.ones(len(xte)), xte] @ w)))
        cols = [FEATURES.index(c) for c in PATTERN]
        a, q = xtr[:, cols], xte[:, cols]
        dist = (q ** 2).sum(1)[:, None] + (a ** 2).sum(1)[None, :] - 2 * q @ a.T
        nearest = np.argpartition(dist, NEIGHBOURS, axis=1)[:, :NEIGHBOURS]
        p_pattern = train.up.to_numpy()[nearest].mean(axis=1)
        t = test.copy()
        t["p_model"], t["p_pattern"] = p_model, p_pattern
        t["p_up"] = (p_model + p_pattern) / 2
        out.append(t)
        weights[year] = pd.Series(w, index=["intercept"] + FEATURES)
    return pd.concat(out), pd.DataFrame(weights)


def trades(pred, margin, target_atr, stop_atr, dte=5, source="p_up"):
    """One trade per signal: buy at the open, sell at target, stop or the close."""
    rows = []
    sig = pred[(pred[source] - 0.5).abs() >= margin]
    for day, r in zip(sig.index, sig.itertuples(index=False)):
        is_call = getattr(r, source) > 0.5
        side = 1 if is_call else -1
        target, stop = r.open + side * target_atr * r.atr, r.open - side * stop_atr * r.atr
        hit_stop = r.low <= stop if is_call else r.high >= stop
        hit_target = r.high >= target if is_call else r.low <= target
        if hit_stop:                      # if both were touched, assume the stop came first
            exit_px, why, mins, iv_exit = stop, "stop", 195, (r.iv_open + r.iv_close) / 2
        elif hit_target:
            exit_px, why, mins, iv_exit = target, "target", 195, (r.iv_open + r.iv_close) / 2
        else:
            exit_px, why, mins, iv_exit = r.close, "close", 0, r.iv_close
        left = dte * 390
        strike = b.pick_strike(r.open, left + 390, r.iv_open, is_call, PREMIUM_CAP)
        if strike is None:
            continue
        buy = b.bs_price(r.open, strike, left + 390, r.iv_open, is_call) + SLIP_IN
        sell = max(b.bs_price(exit_px, strike, left + mins, iv_exit, is_call) - SLIP_OUT, 0.0)
        rows.append({"date": day, "symbol": r.symbol, "side": "CALL" if is_call else "PUT", "p_up": getattr(r, source),
                     "strike": strike, "und_entry": r.open, "und_exit": exit_px, "exit_reason": why,
                     "und_pnl": side * (exit_px - r.open), "opt_buy": buy, "opt_sell": sell,
                     "opt_gross": (sell + SLIP_OUT - buy + SLIP_IN) * 100,
                     "opt_net": (sell - buy) * 100 - 2 * COMMISSION, "cost_basis": buy * 100 + COMMISSION})
    return pd.DataFrame(rows)


MARGINS = [0.02, 0.04, 0.06, 0.08]
TARGETS = [0.15, 0.25, 0.4, 99.0]   # in daily ATRs from the open; 99 = no target
STOPS = [0.4, 0.7, 99.0]            # 99 = no stop, sell at the close


def accuracy_table(pred):
    rows = []
    for label, part in (("validation 2016-2021", pred[pred.index.year < HELD_BACK_FROM]),
                        ("held back 2022 on", pred[pred.index.year >= HELD_BACK_FROM])):
        for src in ("p_model", "p_pattern", "p_up"):
            for m in (0.0, 0.04, 0.08):
                sel = part[(part[src] - 0.5).abs() >= m]
                if len(sel):
                    right = ((sel[src] > 0.5) == (sel.up == 1)).mean()
                    rows.append({"period": label, "source": src, "min edge": m, "days": len(sel),
                                 "direction right %": round(100 * right, 1), "days that closed up %": round(100 * sel.up.mean(), 1)})
    return pd.DataFrame(rows)


def main():
    allf = build_features()
    pred, weights = predict(allf)
    pd.set_option("display.width", 220)
    print(f"# {len(allf)} symbol-days {allf.index[0].date()} -> {allf.index[-1].date()}; "
          f"out-of-sample predictions from {pred.index[0].date()}")
    print("\n## How often the direction call was right")
    print(accuracy_table(pred).to_string(index=False))
    rows = []
    for dte, m, tg, st in itertools.product(EXPIRIES, MARGINS, TARGETS, STOPS):
        tr = trades(pred, m, tg, st, dte)
        if tr.empty:
            continue
        val, held = tr[tr.date.dt.year < HELD_BACK_FROM], tr[tr.date.dt.year >= HELD_BACK_FROM]
        sv, sh = b.stats(val), b.stats(held)
        rows.append({"dte": dte, "min_edge": m, "target": tg, "stop": st,
                     "val_n": sv["trades"], "val_win%": sv.get("opt_win%_net", 0), "val_exp$": sv.get("expectancy$", 0), "val_t": sv.get("t_stat", 0),
                     "held_n": sh["trades"], "held_win%": sh.get("opt_win%_net", 0), "held_exp$": sh.get("expectancy$", 0), "held_t": sh.get("t_stat", 0)})
    res = pd.DataFrame(rows).round(2)
    res.to_csv(RESULTS / "quant_grid.csv", index=False)
    print("\n## Settings that won at least 60% of trades on the validation years, best first")
    print(res[res["val_win%"] >= 60].sort_values("val_exp$", ascending=False).head(12).to_string(index=False))
    print(f"\n{(res['val_exp$'] > 0).sum()} of {len(res)} settings were profitable on the validation years; "
          f"{(res['held_exp$'] > 0).sum()} on the held-back years.")
    weights.round(3).to_csv(RESULTS / "quant_weights.csv")
    return pred, res


if __name__ == "__main__":
    main()

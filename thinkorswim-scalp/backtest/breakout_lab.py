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
    broke = ref.close < ref.low.rolling(30).min().shift()
    df = df.copy()
    df["market_break"] = broke.reindex(df.index).fillna(False).astype(bool)
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
    account() if sys.argv[1:] == ["account"] else main()

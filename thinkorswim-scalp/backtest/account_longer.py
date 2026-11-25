"""Run a made-up $1,600 account through two years of hourly bars and write it to a spreadsheet.

Longer holds (1 to 4 hours) with contracts the account can afford. Three accounts:

  Quick target     the breakout rule with a close profit target: wins over 60% of trades.
  Breakout only    the breakout rule with no target: fewer winners, bigger ones.
  Switching rules  changes rule when the one in use stops working, without looking ahead:
                   every week it scores each candidate on the previous LOOKBACK_DAYS trading
                   days and trades the best one, or stays in cash if none made money.

Output: ../LongerHoldAccount.xlsx
"""
import sys
from dataclasses import replace
from pathlib import Path

import pandas as pd
from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Font

import backtest as b
from account import BLUE, BOLD, FONT, HEAD_FILL, INPUT_FILL, MONEY, PCT, RULE_TEXT, header

SYMBOLS = ["SPY", "QQQ", "IWM"]
RULES = ["pullback", "burst", "breakout", "orb", "band_fade", "rsi2", "exhaustion"]
HOLDS = [1, 2, 3, 4]                  # hourly bars; everything is closed by 15:30
CONTRACTS = {"same day": b.Costs(premium_cap=4.0), "5 days out": b.Costs(premium_cap=4.0, dte=5, slippage=0.02)}
STOP_ATR = 1.5
START_CASH = 1600.0
MAX_CONTRACT_FRACTION = 0.25          # one contract may cost at most this share of the balance
RISK_FRACTION = 0.05                  # a trade spends about this share of the balance (never less than 1 contract)
LOOKBACK_DAYS = 60
MIN_LOOKBACK_TRADES = 20
TRAIN_DAYS = 330                      # same split as research.py hourly
SINGLE = ("breakout", 4, "5 days out")  # best training result in research.py hourly
# The setup that won over 60% of trades in both periods of research.py hourly60.
QUICK = dict(strategy="breakout", target_atr=0.5, stop_atr=3.0, max_bars=2)
QUICK_COSTS = b.Costs(premium_cap=4.0, dte=5, slippage=0.02)
QUICK_NAME = "breakout, sell at +0.5 ATR or after 2h, expires 5 days out"
OUT = Path(__file__).parent.parent / "LongerHoldAccount.xlsx"


def candidates():
    raw = {s: b.load_underlying(s, "1h") for s in SYMBOLS}
    out = {}
    for rule in RULES:
        for hold in HOLDS:
            for label, costs in CONTRACTS.items():
                p = b.for_hourly(replace(b.Params(), strategy=rule, target_atr=99.0, stop_atr=STOP_ATR, max_bars=hold))
                tr = pd.concat([b.simulate(b.add_indicators(df, p), p, costs).assign(symbol=s) for s, df in raw.items()])
                out[(rule, hold, label)] = tr.sort_values("entry_time").reset_index(drop=True)
    days = sorted({d for df in raw.values() for d in df.date})
    p = b.for_hourly(replace(b.Params(), **QUICK))
    quick = pd.concat([b.simulate(b.add_indicators(df, p), p, QUICK_COSTS).assign(symbol=s) for s, df in raw.items()])
    return out, days, quick.sort_values("entry_time").reset_index(drop=True)


def name(key):
    rule, hold, label = key
    return f"{rule}, hold {hold}h, expires {label}"


def take(tr, day, cash, costs, label, ledger, extra):
    """Trade one day's signals from `tr`; returns the new balance."""
    settled, busy_until = cash, None
    for t in tr[tr.date == day].itertuples():
        if busy_until is not None and t.entry_time < busy_until:
            continue
        buy, sell = round(t.opt_buy, 2), round(t.opt_sell, 2)
        unit = buy * 100 + 2 * costs.commission
        qty = max(1, int(RISK_FRACTION * cash // unit))
        if unit > MAX_CONTRACT_FRACTION * cash or qty * unit > settled:
            continue
        settled -= qty * unit
        cash = round(cash + round(((sell - buy) * 100 - 2 * costs.commission) * qty, 2), 2)
        busy_until = t.exit_time
        ledger.append({"date": day, "entry": t.entry_time.strftime("%H:%M"), "exit": t.exit_time.strftime("%H:%M"),
                       "symbol": t.symbol, "rule": label, "side": t.side, "strike": t.strike, "qty": qty,
                       "buy": buy, "sell": sell, "exit_reason": t.exit_reason, "extra": extra})
    return cash


def walk(cands, days):
    """Switching account: each week trade the candidate that did best over the lookback."""
    weeks = {}
    for d in days:
        weeks.setdefault(pd.Timestamp(d).to_period("W-FRI").start_time.date(), []).append(d)
    cash, ledger, weekly = START_CASH, [], []
    for w in sorted(weeks):
        wdays = weeks[w]
        first = days.index(wdays[0])
        if first < LOOKBACK_DAYS:
            continue
        lo = days[first - LOOKBACK_DAYS]
        scores = {}
        for key, tr in cands.items():
            past = tr[(tr.date >= lo) & (tr.date < wdays[0])]
            if len(past) >= MIN_LOOKBACK_TRADES:
                scores[key] = past.opt_net.mean()
        best = max(scores, key=scores.get) if scores else None
        trade_it = best is not None and scores[best] > 0
        weekly.append({"week": wdays[0], "candidate": name(best) if best else "none", "score": scores.get(best, 0.0),
                       "decision": "Trade it" if trade_it else "Stay in cash: nothing made money over the lookback"})
        if trade_it:
            for day in wdays:
                cash = take(cands[best], day, cash, CONTRACTS[best[2]], name(best), ledger, wdays[0])
    return ledger, weekly


def walk_single(tr, costs, label, days):
    """Single-rule account: one rule for the whole period."""
    cash, ledger = START_CASH, []
    split = days[TRAIN_DAYS]
    for day in days:
        period = "Training" if day < split else "Held back"
        cash = take(tr, day, cash, costs, label, ledger, period)
    return ledger


def write_ledger(ws, ledger, extra_label):
    header(ws, ["Trade #", "Date", "Entry (ET)", "Exit (ET)", "Symbol", "Rule in use", "Side", "Strike", "Contracts",
                "Buy price ($)", "Sell price ($)", "Fees ($)", "Net P&L ($)", "Balance ($)", "Exit reason", extra_label],
           [8, 12, 10, 10, 8, 40, 7, 8, 10, 10, 10, 9, 12, 13, 11, 12])
    for i, r in enumerate(ledger, start=2):
        values = [i - 1, r["date"], r["entry"], r["exit"], r["symbol"], r["rule"], r["side"], r["strike"], r["qty"],
                  r["buy"], r["sell"]]
        for col, v in enumerate(values, start=1):
            ws.cell(row=i, column=col, value=v).font = BLUE
        ws.cell(row=i, column=2).number_format = "yyyy-mm-dd"
        ws.cell(row=i, column=12, value=f"=2*Summary!$B$5*I{i}")
        ws.cell(row=i, column=13, value=f"=(K{i}-J{i})*100*I{i}-L{i}")
        prev = "Summary!$B$4" if i == 2 else f"N{i - 1}"
        ws.cell(row=i, column=14, value=f"={prev}+M{i}")
        ws.cell(row=i, column=15, value=r["exit_reason"]).font = BLUE
        ws.cell(row=i, column=16, value=r["extra"]).font = BLUE
        if not isinstance(r["extra"], str):
            ws.cell(row=i, column=16).number_format = "yyyy-mm-dd"
        for col in (10, 11, 12, 13, 14):
            ws.cell(row=i, column=col).number_format = MONEY
    ws.auto_filter.ref = f"A1:P{len(ledger) + 1}"


def results_block(sheet, last):
    """Formulas for one account's results, in Summary row order."""
    m, n = f"'{sheet}'!$M$2:$M${last}", f"'{sheet}'!$N$2:$N${last}"
    return [
        (f"=COUNT({m})", "0"), (f'=COUNTIF({m},">0")', "0"), ("=IF({c}12=0,0,{c}13/{c}12)", PCT),
        (f"=SUM({m})", MONEY), ("=IF({c}12=0,0,{c}15/{c}12)", MONEY),
        (f'=IFERROR(AVERAGEIF({m},">0"),0)', MONEY), (f'=IFERROR(AVERAGEIF({m},"<=0"),0)', MONEY),
        (f"='{sheet}'!$N${last}", MONEY), ("=IF($B$4=0,0,{c}15/$B$4)", PCT),
        (f"=MIN($B$4,MIN({n}))", MONEY), (f"=MAX($B$4,MAX({n}))", MONEY),
    ]


def build(switching, weekly, single, quick, days, research):
    wb = Workbook()
    summary = wb.active
    summary.title = "Summary"
    quick_ws, single_ws = wb.create_sheet("Quick target ledger"), wb.create_sheet("Breakout ledger")
    switch_ws, wk, test_ws = wb.create_sheet("Switching ledger"), wb.create_sheet("Weekly"), wb.create_sheet("Rule tests")
    write_ledger(quick_ws, quick, "Period")
    write_ledger(single_ws, single, "Period")
    write_ledger(switch_ws, switching, "Week of")
    last_quick, last_single, last_switch = len(quick) + 1, len(single) + 1, len(switching) + 1

    for col, width in zip("ABCDE", (42, 20, 20, 18, 95)):
        summary.column_dimensions[col].width = width
    summary["A1"] = "Made-up $1,600 options account, longer holds"
    summary["A1"].font = Font(name=FONT, bold=True, size=14)
    summary["A2"] = (f"Simulated trades, not real ones. Hourly bars, {days[0]} to {days[-1]}, SPY / QQQ / IWM options. "
                     "Option prices are modelled, not historical quotes.")
    for col, text in zip("ABE", ("Inputs", "Value", "Notes")):
        summary[f"{col}3"], summary[f"{col}3"].font, summary[f"{col}3"].fill = text, BOLD, HEAD_FILL
    inputs = [
        ("Starting balance ($)", START_CASH, MONEY, "Set by you. All three accounts start here."),
        ("Commission per contract, per side ($)", 0.65, MONEY, "thinkorswim / Schwab standard option commission. Feeds the Fees column."),
        ("Share of the balance spent per trade", RISK_FRACTION, PCT, "Assumption. Always at least one contract, as long as it costs under 25% of the balance."),
        ("Lookback for the switching account (trading days)", LOOKBACK_DAYS, "0", "Assumption. The switching account takes no trades until this much history exists."),
        ("Stop (ATR of the hourly chart)", STOP_ATR, "0.0", "Assumption, for the no-target and switching accounts. The quick-target account uses a 3 ATR stop."),
    ]
    for r, (label, value, fmt, note) in enumerate(inputs, start=4):
        summary[f"A{r}"], summary[f"B{r}"], summary[f"E{r}"] = label, value, note
        summary[f"B{r}"].font, summary[f"B{r}"].fill, summary[f"B{r}"].number_format = BLUE, INPUT_FILL, fmt
    for col, text in zip("ABCDE", ("Results", "Breakout, quick target", "Breakout, no target", "Switching rules", "Notes")):
        summary[f"{col}11"], summary[f"{col}11"].font, summary[f"{col}11"].fill = text, BOLD, HEAD_FILL
    labels = ["Trades taken", "Winning trades", "Win rate", "Total net P&L ($)", "Average per trade ($)",
              "Average win ($)", "Average loss ($)", "Ending balance ($)", "Return on starting balance",
              "Lowest balance ($)", "Highest balance ($)"]
    for col, block in (("B", results_block("Quick target ledger", last_quick)), ("C", results_block("Breakout ledger", last_single)),
                       ("D", results_block("Switching ledger", last_switch))):
        for r, (formula, fmt) in enumerate(block, start=12):
            summary[f"{col}{r}"] = formula.replace("{c}", col)
            summary[f"{col}{r}"].number_format = fmt
    for r, label in enumerate(labels, start=12):
        summary[f"A{r}"] = label
    summary["E12"] = "One position at a time across the three symbols. Cash from a sale is not reused until the next day."
    summary["A23"], summary["D23"] = "Weeks traded / weeks in cash", f'=COUNTIF(Weekly!$D$2:$D${len(weekly) + 1},"Trade it")'
    summary["D24"] = f'=COUNTIF(Weekly!$D$2:$D${len(weekly) + 1},"Stay in cash*")'
    summary["A24"] = "(switching account only)"
    heads = ("By period", "Quick target: training", "Quick target: held back", "No target: training", "No target: held back")
    for col, text in zip("ABCDE", heads):
        summary[f"{col}26"], summary[f"{col}26"].font, summary[f"{col}26"].fill = text, BOLD, HEAD_FILL
    for col, sheet, last, period in (("B", "Quick target ledger", last_quick, "Training"), ("C", "Quick target ledger", last_quick, "Held back"),
                                     ("D", "Breakout ledger", last_single, "Training"), ("E", "Breakout ledger", last_single, "Held back")):
        p, m = f"'{sheet}'!$P$2:$P${last}", f"'{sheet}'!$M$2:$M${last}"
        summary[f"{col}27"] = f'=COUNTIFS({p},"{period}")'
        summary[f"{col}28"] = f'=COUNTIFS({p},"{period}",{m},">0")'
        summary[f"{col}29"] = f"=IF({col}27=0,0,{col}28/{col}27)"
        summary[f"{col}30"] = f'=SUMIFS({m},{p},"{period}")'
        summary[f"{col}31"] = f"=IF({col}27=0,0,{col}30/{col}27)"
        summary[f"{col}29"].number_format = PCT
        summary[f"{col}30"].number_format = summary[f"{col}31"].number_format = MONEY
    for r, label in enumerate(["Trades", "Winning trades", "Win rate", "Net P&L ($)", "Average per trade ($)"], start=27):
        summary[f"A{r}"] = label
    summary["A32"] = ("The breakout rule was found using the Training period, and the held-back days have now been looked at "
                      "several times while choosing settings, so even the Held back columns are no longer a clean test.")
    notes = [
        "How to read this",
        f"Breakout, quick target: {QUICK_NAME}, stop 3 ATR. This is the setup that won over 60% of trades.",
        f"Breakout, no target: {name(SINGLE)}, stop {STOP_ATR} ATR, no target. Fewer winners, bigger ones.",
        "Switching rules: every week, trade whichever rule did best over the lookback, or stay in cash if none made money.",
        "Blue cells are inputs or simulated trade data. Black cells are formulas.",
        "The trade lists were generated with the inputs above. Changing the commission updates fees and balances, "
        "but not which trades were taken; rerun backtest/account_longer.py for that.",
        "Rule tests: every rule and setting scored on 330 training days and 170 held-back days.",
    ]
    for r, text in enumerate(notes, start=34):
        summary[f"A{r}"] = text
    summary["A34"].font = BOLD

    header(wk, ["Week of", "Best rule over the lookback", "Its average per trade over the lookback ($)", "Decision",
                "Trades", "Net P&L ($)"], [12, 42, 20, 50, 9, 13])
    for i, w in enumerate(weekly, start=2):
        wk.cell(row=i, column=1, value=w["week"]).number_format = "yyyy-mm-dd"
        wk.cell(row=i, column=2, value=w["candidate"])
        wk.cell(row=i, column=3, value=round(w["score"], 2)).number_format = MONEY
        wk.cell(row=i, column=4, value=w["decision"])
        for col in (1, 2, 3, 4):
            wk.cell(row=i, column=col).font = BLUE
        wk.cell(row=i, column=5, value=f"=COUNTIFS('Switching ledger'!$P$2:$P${last_switch},A{i})")
        wk.cell(row=i, column=6, value=f"=SUMIFS('Switching ledger'!$M$2:$M${last_switch},'Switching ledger'!$P$2:$P${last_switch},A{i})").number_format = MONEY
    wk["B1"].comment = Comment("Chosen by backtest/account_longer.py from trades that closed before the week began.", "account_longer.py")

    cols = ["strategy", "target", "stop", "hold", "dte", "train_n", "train_win%", "train_exp$", "test_n", "test_win%", "test_exp$"]
    header(test_ws, ["Rule", "Target (ATR, 99 = none)", "Stop (ATR)", "Max hours held", "Days to expiry",
                     "Training trades", "Training win rate", "Training avg per trade ($)", "Held-back trades",
                     "Held-back win rate", "Held-back avg per trade ($)"], [12, 12, 9, 9, 9, 10, 10, 14, 10, 10, 14])
    for i, row in enumerate(research[cols].itertuples(index=False), start=2):
        for col, v in enumerate(row, start=1):
            cell = test_ws.cell(row=i, column=col, value=(v / 100 if col in (7, 10) else v))
            cell.font = BLUE
            cell.number_format = PCT if col in (7, 10) else MONEY if col in (8, 11) else "General"
    test_ws["A1"].comment = Comment(
        "Output of backtest/research.py hourly: first 330 trading days are training, last 170 are held back. "
        "Win rates and averages are after slippage and commission, one contract of $4.00 or less.", "research.py")
    test_ws.auto_filter.ref = f"A1:K{len(research) + 1}"
    r0 = len(research) + 3
    test_ws.cell(row=r0, column=1, value="What triggers a CALL (PUT is the mirror image)").font = BOLD
    for i, rule in enumerate(RULES, start=r0 + 1):
        test_ws.cell(row=i, column=1, value=rule)
        test_ws.cell(row=i, column=2, value=RULE_TEXT[rule])

    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if cell.font.name != FONT:
                    f = cell.font
                    cell.font = Font(name=FONT, bold=f.bold, color=f.color, size=f.size)
    wb.save(OUT)


def main():
    cands, days, quick_trades = candidates()
    switching, weekly = walk(cands, days)
    single = walk_single(cands[SINGLE], CONTRACTS[SINGLE[2]], name(SINGLE), days)
    quick = walk_single(quick_trades, QUICK_COSTS, QUICK_NAME, days)
    research = pd.read_csv(Path(__file__).parent / "results" / "research_1h_longer.csv")
    build(switching, weekly, single, quick, days, research)
    print(f"{OUT.name}: quick target {len(quick)} trades, no target {len(single)} trades, "
          f"switching {len(switching)} trades", file=sys.stderr)


if __name__ == "__main__":
    main()

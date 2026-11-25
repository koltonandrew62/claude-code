"""Run a made-up $50 account through the 1-minute rules and write it to a spreadsheet.

The account trades one rule at a time. After any day that loses money it moves to the
next rule in RULE_ORDER. Nothing here looks ahead: every decision uses only that day's
result. Output: ../ScalpAccount.xlsx
"""
import sys
from dataclasses import replace
from pathlib import Path

import pandas as pd
from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

import backtest as b

SYMBOLS = ["SPY", "QQQ", "IWM"]
RULE_ORDER = ["pullback", "burst", "breakout", "orb", "band_fade", "rsi2", "exhaustion", "power_hour"]
RULE_TEXT = {
    "pullback": "With the trend (above VWAP, EMA9 over EMA21), dip to EMA9 and close back above it",
    "burst": "Wide high-volume bar closing near its extreme, on the VWAP side",
    "breakout": "Close beyond the 30-bar high/low on 1.5x volume, on the VWAP side",
    "orb": "First close outside the 9:30-9:45 opening range, before 11:30",
    "band_fade": "Close back inside a 2.5 SD band after closing outside it",
    "rsi2": "With the trend, RSI(2) washout followed by a bar back in the trend's favour",
    "exhaustion": "Fade three straight bars that travelled at least 2.5 ATR",
    "power_hour": "The breakout rule, last hour only",
}
START_CASH = 50.0
DAILY_LOSS_LIMIT = 25.0
EXITS = dict(target_atr=2.0, stop_atr=1.0, max_bars=5)
OUT = Path(__file__).parent.parent / "ScalpAccount.xlsx"

FONT = "Arial"
BLUE = Font(name=FONT, color="0000FF")
BOLD = Font(name=FONT, bold=True)
HEAD_FILL = PatternFill("solid", fgColor="D9D9D9")
INPUT_FILL = PatternFill("solid", fgColor="FFFF00")
MONEY = '$#,##0.00;[Red]-$#,##0.00;"-"'
PCT = '0.0%;-0.0%;"-"'


def all_trades(costs):
    raw = {s: b.load_underlying(s, "1m") for s in SYMBOLS}
    out = {}
    for rule in RULE_ORDER:
        p = b.for_one_minute(replace(b.Params(), strategy=rule, **EXITS))
        out[rule] = pd.concat([b.simulate(b.add_indicators(df, p), p, costs).assign(symbol=s) for s, df in raw.items()])
    days = sorted({d for df in raw.values() for d in df.date})
    return out, days


def walk(trades, days, costs):
    """Trade day by day; return ledger rows and one summary row per day."""
    cash, rule_i, ledger, daily = START_CASH, 0, [], []
    for day in days:
        rule = RULE_ORDER[rule_i]
        todays = trades[rule]
        todays = todays[todays.date == day].sort_values("entry_time")
        busy_until, day_pnl, stopped = None, 0.0, False
        for t in todays.itertuples():
            if busy_until is not None and t.entry_time < busy_until:
                continue
            if day_pnl <= -DAILY_LOSS_LIMIT:
                stopped = True
                break
            buy, sell = round(t.opt_buy, 2), round(t.opt_sell, 2)
            deposit = 0.0
            if cash < buy * 100 + 2 * costs.commission:
                deposit = START_CASH
            net = round((sell - buy) * 100 - 2 * costs.commission, 2)
            cash = round(cash + deposit + net, 2)
            day_pnl = round(day_pnl + net, 2)
            busy_until = t.exit_time
            ledger.append({
                "date": day, "entry": t.entry_time.strftime("%H:%M"), "exit": t.exit_time.strftime("%H:%M"),
                "symbol": t.symbol, "rule": rule, "side": t.side, "strike": t.strike, "qty": 1,
                "buy": buy, "sell": sell, "deposit": deposit, "exit_reason": t.exit_reason,
                "note": "Balance too low for one contract: added a fresh $50" if deposit else "",
            })
        took = sum(1 for r in ledger if r["date"] == day)
        if took and day_pnl < 0:
            rule_i = (rule_i + 1) % len(RULE_ORDER)
            decision = f"Lost money: switch to {RULE_ORDER[rule_i]}"
        elif took:
            decision = "Made money: keep this rule"
        else:
            decision = "No signals: keep this rule"
        if stopped:
            decision = f"Hit the ${DAILY_LOSS_LIMIT:.0f} daily loss limit and stopped. " + decision
        daily.append({"date": day, "rule": rule, "decision": decision})
    return ledger, daily


def header(ws, labels, widths):
    for c, (label, width) in enumerate(zip(labels, widths), start=1):
        cell = ws.cell(row=1, column=c, value=label)
        cell.font, cell.fill = BOLD, HEAD_FILL
        cell.alignment = Alignment(wrap_text=True, vertical="center")
        ws.column_dimensions[get_column_letter(c)].width = width
    ws.freeze_panes = "A2"


def build(ledger, daily, research, costs):
    wb = Workbook()
    summary = wb.active
    summary.title = "Summary"
    led = wb.create_sheet("Ledger")
    day_ws = wb.create_sheet("Daily")
    rule_ws = wb.create_sheet("Rules")
    test_ws = wb.create_sheet("Rule tests")
    n = len(ledger)
    last = n + 1

    # ---- Ledger
    header(led, ["Trade #", "Date", "Entry (ET)", "Exit (ET)", "Symbol", "Rule", "Side", "Strike", "Contracts",
                 "Buy price ($)", "Sell price ($)", "Fees ($)", "Net P&L ($)", "Deposit ($)", "Balance ($)",
                 "Exit reason", "Note"],
           [8, 12, 10, 10, 8, 12, 7, 8, 10, 10, 10, 9, 12, 11, 12, 11, 48])
    for i, r in enumerate(ledger, start=2):
        values = [i - 1, r["date"], r["entry"], r["exit"], r["symbol"], r["rule"], r["side"], r["strike"], r["qty"],
                  r["buy"], r["sell"]]
        for c, v in enumerate(values, start=1):
            led.cell(row=i, column=c, value=v).font = BLUE
        led.cell(row=i, column=2).number_format = "yyyy-mm-dd"
        led.cell(row=i, column=12, value=f"=2*Summary!$B$5*I{i}")
        led.cell(row=i, column=13, value=f"=(K{i}-J{i})*100*I{i}-L{i}")
        led.cell(row=i, column=14, value=r["deposit"]).font = BLUE
        prev = "Summary!$B$4" if i == 2 else f"O{i - 1}"
        led.cell(row=i, column=15, value=f"={prev}+M{i}+N{i}")
        led.cell(row=i, column=16, value=r["exit_reason"]).font = BLUE
        led.cell(row=i, column=17, value=r["note"])
        for c in (10, 11, 12, 13, 14, 15):
            led.cell(row=i, column=c).number_format = MONEY
    led.auto_filter.ref = f"A1:Q{last}"

    # ---- Summary
    summary.column_dimensions["A"].width = 38
    summary.column_dimensions["B"].width = 16
    summary.column_dimensions["C"].width = 90
    summary["A1"] = "Made-up $50 options scalp account"
    summary["A1"].font = Font(name=FONT, bold=True, size=14)
    summary["A2"] = (f"Simulated trades, not real ones. 1-minute bars, {daily[0]['date']} to {daily[-1]['date']}, "
                     "SPY / QQQ / IWM same-day options. Option prices are modelled, not historical quotes.")
    summary["A3"], summary["B3"], summary["C3"] = "Inputs", "Value", "Notes"
    for c in "ABC":
        summary[f"{c}3"].font, summary[f"{c}3"].fill = BOLD, HEAD_FILL
    rows = [
        ("Starting balance ($)", START_CASH, "Set by you. Also the size of each top-up when the balance cannot buy a contract.", True),
        ("Commission per contract, per side ($)", costs.commission, "thinkorswim / Schwab standard option commission. Feeds the Fees column.", True),
        ("Slippage per share, per side ($)", costs.slippage, "Assumption. Already included in the Buy and Sell prices on the Ledger.", True),
        ("Daily loss limit ($)", DAILY_LOSS_LIMIT, "Assumption. Trading stops for the day once the day is down this much.", True),
    ]
    for r, (label, value, note, is_input) in enumerate(rows, start=4):
        summary[f"A{r}"], summary[f"C{r}"] = label, note
        summary[f"B{r}"] = value
        summary[f"B{r}"].font, summary[f"B{r}"].fill = BLUE, INPUT_FILL
        summary[f"B{r}"].number_format = MONEY
    summary["A9"], summary["B9"] = "Results", "Value"
    for c in "AB":
        summary[f"{c}9"].font, summary[f"{c}9"].fill = BOLD, HEAD_FILL
    L = f"Ledger!$M$2:$M${last}"
    results = [
        ("Trades taken", f"=COUNT({L})", "0"),
        ("Winning trades", f'=COUNTIF({L},">0")', "0"),
        ("Win rate", "=IF(B10=0,0,B11/B10)", PCT),
        ("Total net P&L ($)", f"=SUM({L})", MONEY),
        ("Average per trade ($)", "=IF(B10=0,0,B13/B10)", MONEY),
        ("Average win ($)", f'=IFERROR(AVERAGEIF({L},">0"),0)', MONEY),
        ("Average loss ($)", f'=IFERROR(AVERAGEIF({L},"<=0"),0)', MONEY),
        ("Top-ups added after start ($)", f"=SUM(Ledger!$N$2:$N${last})", MONEY),
        ("Total money put in ($)", "=B4+B17", MONEY),
        ("Ending balance ($)", f"=Ledger!$O${last}", MONEY),
        ("Times the rule was changed", f'=COUNTIF(Daily!$F$2:$F${len(daily) + 1},"*switch to*")', "0"),
    ]
    for r, (label, formula, fmt) in enumerate(results, start=10):
        summary[f"A{r}"], summary[f"B{r}"] = label, formula
        summary[f"B{r}"].number_format = fmt
    summary["C10"] = "One contract per trade, one position at a time across the three symbols."
    summary["C19"] = "Ending balance = total money put in + total net P&L."
    summary["A22"] = "How to read this"
    summary["A22"].font = BOLD
    notes = [
        "Blue cells are inputs or simulated trade data. Black cells are formulas.",
        "The trade list was generated with the inputs above. Changing the commission updates fees and balances, "
        "but not which trades were taken or when top-ups happened; rerun backtest/account.py for that.",
        "Ledger: every trade. Daily: each day's result and the keep/switch decision. Rules: results by rule. "
        "Rule tests: every rule scored on training days and on held-back days.",
    ]
    for r, text in enumerate(notes, start=23):
        summary[f"A{r}"] = text

    # ---- Daily
    header(day_ws, ["Date", "Rule traded", "Trades", "Wins", "Net P&L ($)", "Decision for the next day"],
           [12, 14, 9, 8, 13, 80])
    for i, d in enumerate(daily, start=2):
        day_ws.cell(row=i, column=1, value=d["date"]).number_format = "yyyy-mm-dd"
        day_ws.cell(row=i, column=1).font = BLUE
        day_ws.cell(row=i, column=2, value=d["rule"]).font = BLUE
        day_ws.cell(row=i, column=3, value=f"=COUNTIFS(Ledger!$B$2:$B${last},A{i})")
        day_ws.cell(row=i, column=4, value=f'=COUNTIFS(Ledger!$B$2:$B${last},A{i},Ledger!$M$2:$M${last},">0")')
        day_ws.cell(row=i, column=5, value=f"=SUMIFS(Ledger!$M$2:$M${last},Ledger!$B$2:$B${last},A{i})")
        day_ws.cell(row=i, column=5).number_format = MONEY
        day_ws.cell(row=i, column=6, value=d["decision"])
    day_ws["F1"].comment = Comment("Decision made by backtest/account.py from that day's net P&L only.", "account.py")

    # ---- Rules
    header(rule_ws, ["Rule", "What triggers a CALL (PUT is the mirror image)", "Trades", "Wins", "Win rate",
                     "Net P&L ($)", "Average per trade ($)"], [12, 78, 9, 8, 10, 13, 14])
    for i, rule in enumerate(RULE_ORDER, start=2):
        rule_ws.cell(row=i, column=1, value=rule)
        rule_ws.cell(row=i, column=2, value=RULE_TEXT[rule])
        rule_ws.cell(row=i, column=3, value=f"=COUNTIFS(Ledger!$F$2:$F${last},A{i})")
        rule_ws.cell(row=i, column=4, value=f'=COUNTIFS(Ledger!$F$2:$F${last},A{i},Ledger!$M$2:$M${last},">0")')
        rule_ws.cell(row=i, column=5, value=f"=IF(C{i}=0,0,D{i}/C{i})").number_format = PCT
        rule_ws.cell(row=i, column=6, value=f"=SUMIFS(Ledger!$M$2:$M${last},Ledger!$F$2:$F${last},A{i})").number_format = MONEY
        rule_ws.cell(row=i, column=7, value=f"=IF(C{i}=0,0,F{i}/C{i})").number_format = MONEY
    end = len(RULE_ORDER) + 2
    rule_ws.cell(row=end, column=1, value="Exits used for every rule").font = BOLD
    rule_ws.cell(row=end, column=2, value=f"Target {EXITS['target_atr']} ATR, stop {EXITS['stop_atr']} ATR, "
                 f"closed after {EXITS['max_bars']} one-minute bars at the latest. Order of rules is the switching order.")

    # ---- Rule tests (static output of research.py)
    cols = ["strategy", "target", "stop", "hold", "train_n", "train_win%", "train_exp$", "test_n", "test_win%", "test_exp$"]
    header(test_ws, ["Rule", "Target (ATR, 99 = none)", "Stop (ATR)", "Max bars held", "Training trades",
                     "Training win rate", "Training avg per trade ($)", "Held-back trades", "Held-back win rate",
                     "Held-back avg per trade ($)"], [12, 12, 9, 9, 10, 10, 14, 10, 10, 14])
    for i, row in enumerate(research[cols].itertuples(index=False), start=2):
        for c, v in enumerate(row, start=1):
            cell = test_ws.cell(row=i, column=c, value=(v / 100 if c in (6, 9) else v))
            cell.font = BLUE
            cell.number_format = PCT if c in (6, 9) else MONEY if c in (7, 10) else "General"
    test_ws["A1"].comment = Comment(
        "Output of backtest/research.py: first 14 trading days are training, last 7 are held back. "
        "Win rates and averages are after slippage and commission, on the $0.45-or-less contract.", "research.py")
    test_ws.auto_filter.ref = f"A1:J{len(research) + 1}"

    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if cell.font is None or cell.font.name != FONT:
                    f = cell.font
                    cell.font = Font(name=FONT, bold=f.bold, color=f.color, size=f.size)
    wb.save(OUT)


def main():
    costs = b.Costs()
    trades, days = all_trades(costs)
    ledger, daily = walk(trades, days, costs)
    research = pd.read_csv(Path(__file__).parent / "results" / "research_1m.csv")
    build(ledger, daily, research, costs)
    net = sum(round((r["sell"] - r["buy"]) * 100 - 2 * costs.commission, 2) for r in ledger)
    print(f"{OUT.name}: {len(ledger)} trades over {len(days)} days, net ${net:.2f}, "
          f"top-ups ${sum(r['deposit'] for r in ledger):.0f}", file=sys.stderr)


if __name__ == "__main__":
    main()

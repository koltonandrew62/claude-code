"""What it would take to turn $1,600 into $3.2 million in ten years, and how the tested
strategies measure up.

1. Runs one account that trades every hourly rule and the quant model at the same time.
2. Projects ten years forward by redrawing the simulated trades at random, thousands of
   times, at several bet sizes, and counts how often the goal is reached.

Output: ../TenYearPlan.xlsx
"""
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

import account_longer as al
import backtest as b
import breakout_lab as lab
import quant as q

START, GOAL, YEARS = 1600.0, 3_200_000.0, 10
BUST_BELOW = 300.0            # less than one contract's cost: the account can no longer trade
PATHS = 20000
BET_SIZES = [0.05, 0.10, 0.25, 0.50]
QUANT_SETTING = dict(margin=0.08, target_atr=0.4, stop_atr=99.0, dte=20)   # its least-bad setting on 2016-2021
OUT = Path(__file__).parent.parent / "TenYearPlan.xlsx"


def pools():
    """Simulated trades per strategy over the two years of hourly data."""
    cands, days, _ = al.candidates()
    out = {}
    for rule in al.RULES:
        tr = cands[(rule, 4, "5 days out")].copy()
        tr["when"] = tr.entry_time
        out[rule] = tr
    pred, _ = q.predict(q.build_features())
    qt = q.trades(pred, **QUANT_SETTING)
    qt = qt[(qt.date.dt.date >= days[0]) & (qt.date.dt.date <= days[-1])].copy()
    qt["when"] = qt.date.dt.tz_localize(b.ET) + pd.Timedelta(hours=9, minutes=30)
    out["quant model"] = qt
    for tr in out.values():
        tr["ret"] = tr.opt_net / tr.cost_basis      # return on the money put into the trade
    return out, len(days) / 252


def run_all(pool, bet):
    """One account taking every signal from every strategy, `bet` of the balance per trade."""
    allt = pd.concat([t.assign(strategy=k) for k, t in pool.items()]).sort_values("when")
    cash, rows = START, []
    for t in allt.itertuples():
        if cash < BUST_BELOW:
            break
        qty = max(1, int(bet * cash // t.cost_basis))
        if qty * t.cost_basis > cash:
            continue
        pnl = qty * t.opt_net
        cash += pnl
        rows.append({"strategy": t.strategy, "pnl": pnl, "balance": cash})
    return pd.DataFrame(rows), cash


def project(returns, per_year, bet, rng):
    """Ten-year balances from redrawing `returns` at random, betting `bet` of the balance each time."""
    n = int(round(per_year * YEARS))
    bal = np.full(PATHS, START)
    alive = np.ones(PATHS, bool)
    for _ in range(n):
        r = rng.choice(returns, PATHS)
        bal = np.where(alive, bal * (1 + bet * r), bal)
        alive &= bal >= BUST_BELOW
    return bal


def describe(bal):
    return {"median": float(np.median(bal)), "p10": float(np.percentile(bal, 10)), "p90": float(np.percentile(bal, 90)),
            "reach_goal": float((bal >= GOAL).mean()), "below_start": float((bal < START).mean()),
            "bust": float((bal < BUST_BELOW).mean())}


def main():
    rng = np.random.default_rng(7)
    pool, span_years = pools()
    need = (GOAL / START) ** (1 / YEARS) - 1
    print(f"Goal: ${START:,.0f} -> ${GOAL:,.0f} in {YEARS} years = x{GOAL / START:,.0f}, {100 * need:.1f}% a year")

    per = []
    for k, t in pool.items():
        per.append({"strategy": k, "trades": len(t), "per_year": len(t) / span_years, "win%": 100 * (t.opt_net > 0).mean(),
                    "avg_return_on_premium%": 100 * t.ret.mean(), "avg_$": t.opt_net.mean(), "total_$": t.opt_net.sum()})
    per = pd.DataFrame(per)
    pd.set_option("display.width", 200)
    print("\n## Every strategy over the two years, one contract per signal")
    print(per.round(2).to_string(index=False))

    ledger, end_all = run_all(pool, 0.05)
    print(f"\n## One account using every strategy at once: {len(ledger)} trades, ended at ${end_all:,.2f}")
    print(ledger.groupby("strategy").pnl.agg(["count", "sum"]).round(0).to_string())

    everything = np.concatenate([t.ret.to_numpy() for t in pool.values()])
    brk = pool["breakout"]
    split = al.candidates()[1][al.TRAIN_DAYS]
    held = brk[brk.date >= split].ret.to_numpy()
    scenarios = [
        ("Every strategy together", everything, sum(len(t) for t in pool.values()) / span_years),
        ("Breakout only, exactly as measured over two years", brk.ret.to_numpy(), len(brk) / span_years),
        ("Breakout only, as on the unseen days", held, len(brk) / span_years),
        ("Breakout only, if the real edge is half of what was measured", brk.ret.to_numpy() - brk.ret.mean() / 2, len(brk) / span_years),
        ("Breakout only, if there is no real edge", brk.ret.to_numpy() - brk.ret.mean(), len(brk) / span_years),
    ]
    imp, _ = lab.improved_trades()
    fresh, _ = lab.improved_trades(lab.NEW_ETFS + lab.NEW_STOCKS)
    imp_ret, fresh_ret = (imp.opt_net / imp.cost_basis).to_numpy(), (fresh.opt_net / fresh.cost_basis).to_numpy()
    scenarios += [
        ("Improved breakout (puts, market confirmed), exactly as measured", imp_ret, len(imp) / span_years),
        ("Improved breakout, with the edge seen on 13 symbols it was not found on", fresh_ret, len(imp) / span_years),
        ("Improved breakout, as measured but without its three best trades", np.sort(imp_ret)[:-3], len(imp) / span_years),
    ]
    rows = []
    for label, rets, per_year in scenarios:
        for bet in BET_SIZES:
            rows.append({"scenario": label, "trades_per_year": round(per_year), "avg_return_per_trade": rets.mean(),
                         "bet": bet, **describe(project(rets, per_year, bet, rng))})
    proj = pd.DataFrame(rows)
    show = proj.copy()
    for c in ("reach_goal", "below_start", "bust", "avg_return_per_trade"):
        show[c] = (100 * show[c]).round(1)
    for c in ("median", "p10", "p90"):
        show[c] = show[c].round(0)
    print("\n## Ten-year projection (percent columns are % of 20,000 simulated paths)")
    print(show.to_string(index=False))
    build(per, ledger, end_all, proj, span_years)
    print(f"\nwrote {OUT.name}", file=sys.stderr)


def build(per, ledger, end_all, proj, span_years):
    from openpyxl import Workbook
    from openpyxl.styles import Font
    from account import BLUE, BOLD, FONT, HEAD_FILL, INPUT_FILL, MONEY, PCT, header

    wb = Workbook()
    goal = wb.active
    goal.title = "Goal"
    for col, width in zip("ABCD", (46, 20, 22, 90)):
        goal.column_dimensions[col].width = width
    goal["A1"] = "Turning $1,600 into $3.2 million in ten years: what it takes"
    goal["A1"].font = Font(name=FONT, bold=True, size=14)
    goal["A2"] = "Everything here comes from simulated trades with modelled option prices. It is not a forecast."
    for col, text in zip("ABD", ("Inputs", "Value", "Notes")):
        goal[f"{col}3"], goal[f"{col}3"].font, goal[f"{col}3"].fill = text, BOLD, HEAD_FILL
    inputs = [
        ("Starting balance ($)", START, MONEY, "Set by you."),
        ("Goal ($)", GOAL, MONEY, "Set by you."),
        ("Years", YEARS, "0", "Set by you."),
        ("Best simulated account: ending balance ($)", 2886.60, MONEY,
         "Improved breakout (puts only, market confirmed), from BreakoutPutsAccount.xlsx. Started at $1,600."),
        ("Best simulated account: years covered", round(span_years, 2), "0.00",
         "500 trading days of hourly bars, 2024-11-27 to 2026-11-25."),
    ]
    for r, (label, value, fmt, note) in enumerate(inputs, start=4):
        goal[f"A{r}"], goal[f"B{r}"], goal[f"D{r}"] = label, value, note
        goal[f"B{r}"].font, goal[f"B{r}"].fill, goal[f"B{r}"].number_format = BLUE, INPUT_FILL, fmt
    for col, text in zip("AB", ("What the goal requires", "Value")):
        goal[f"{col}10"], goal[f"{col}10"].font, goal[f"{col}10"].fill = text, BOLD, HEAD_FILL
    calc = [
        ("Times the money must multiply", "=B5/B4", "#,##0"),
        ("Growth needed every year", "=(B5/B4)^(1/B6)-1", PCT),
        ("Growth needed every month", "=(B5/B4)^(1/(B6*12))-1", PCT),
        ("Yearly growth of the best simulated account", "=(B7/B4)^(1/B8)-1", PCT),
        ("Where that rate gets to after the same years ($)", "=B4*(1+B14)^B6", MONEY),
        ("Years needed at that rate to reach the goal", "=LN(B5/B4)/LN(1+B14)", "0.0"),
    ]
    for r, (label, formula, fmt) in enumerate(calc, start=11):
        goal[f"A{r}"], goal[f"B{r}"] = label, formula
        goal[f"B{r}"].number_format = fmt
    goal["D14"] = "Assumes the best two years found in testing repeat forever, which is the optimistic case."
    for col, text in zip("ABC", ("Year", "Balance needed to be on track ($)", "At the best simulated account's rate ($)")):
        goal[f"{col}18"], goal[f"{col}18"].font, goal[f"{col}18"].fill = text, BOLD, HEAD_FILL
    for n in range(0, YEARS + 1):
        r = 19 + n
        goal[f"A{r}"] = n
        goal[f"B{r}"] = f"=$B$4*(1+$B$12)^A{r}"
        goal[f"C{r}"] = f"=$B$4*(1+$B$14)^A{r}"
        goal[f"B{r}"].number_format = goal[f"C{r}"].number_format = MONEY
    goal["D18"] = "The Year column counts whole years from the start; change Years above and extend the rows if needed."

    ev = wb.create_sheet("Every strategy")
    header(ev, ["Strategy", "Signals in two years", "Signals per year", "Win rate", "Average return on the money in each trade",
                "Average per trade ($)", "Total, one contract per signal ($)", "Trades the combined account took",
                "Its result in the combined account ($)"], [16, 12, 12, 10, 18, 14, 18, 16, 18])
    contrib = ledger.groupby("strategy").pnl.agg(["count", "sum"])
    for i, row in enumerate(per.to_dict("records"), start=2):
        vals = [row["strategy"], row["trades"], round(row["per_year"]), row["win%"] / 100, row["avg_return_on_premium%"] / 100,
                round(row["avg_$"], 2), round(row["total_$"], 2),
                int(contrib["count"].get(row["strategy"], 0)), round(float(contrib["sum"].get(row["strategy"], 0.0)), 2)]
        for c, v in enumerate(vals, start=1):
            cell = ev.cell(row=i, column=c, value=v)
            cell.font = BLUE
            cell.number_format = PCT if c in (4, 5) else MONEY if c in (6, 7, 9) else "General"
    last = len(per) + 1
    ev.cell(row=last + 1, column=1, value="All together").font = BOLD
    ev.cell(row=last + 1, column=2, value=f"=SUM(B2:B{last})")
    ev.cell(row=last + 1, column=7, value=f"=SUM(G2:G{last})").number_format = MONEY
    ev.cell(row=last + 1, column=8, value=f"=SUM(H2:H{last})")
    ev.cell(row=last + 1, column=9, value=f"=SUM(I2:I{last})").number_format = MONEY
    ev.cell(row=last + 3, column=1, value="Combined account").font = BOLD
    ev.cell(row=last + 4, column=1, value="Starting balance ($)")
    ev.cell(row=last + 4, column=2, value="=Goal!B4").number_format = MONEY
    ev.cell(row=last + 5, column=1, value="Ending balance ($)")
    ev.cell(row=last + 5, column=2, value=f"=B{last + 4}+I{last + 1}").number_format = MONEY
    notes = [
        "Source: backtest/ten_year.py. Hourly rules use a 1.5 ATR stop, no target, 4-hour limit and a contract 5 trading days from expiry.",
        "The quant model uses its least-bad setting from 2016-2021, over the same two years as the hourly rules.",
        f"The combined account takes every signal from every strategy, about 5% of the balance each (at least one contract), "
        f"and stops when it can no longer afford a contract (under ${BUST_BELOW:.0f}).",
    ]
    for k, text in enumerate(notes):
        ev.cell(row=last + 7 + k, column=1, value=text)

    pj = wb.create_sheet("Projection")
    header(pj, ["Scenario", "Trades per year", "Average return per trade", "Share of balance bet per trade",
                "Middle outcome after ten years ($)", "Unlucky outcome: 1 in 10 do worse ($)",
                "Lucky outcome: 1 in 10 do better ($)", "Paths that reach the goal", "Paths that end below the start",
                "Paths that go bust"], [58, 10, 12, 12, 20, 20, 22, 12, 14, 12])
    for i, row in enumerate(proj.itertuples(index=False), start=2):
        vals = [row.scenario, row.trades_per_year, row.avg_return_per_trade, row.bet, round(row.median, 0), round(row.p10, 0),
                round(row.p90, 0), row.reach_goal, row.below_start, row.bust]
        for c, v in enumerate(vals, start=1):
            cell = pj.cell(row=i, column=c, value=v)
            cell.font = BLUE
            cell.number_format = PCT if c in (3, 4, 8, 9, 10) else '$#,##0' if c in (5, 6, 7) else "General"
    end = len(proj) + 3
    notes = [
        "How these were made",
        f"Source: backtest/ten_year.py. Each row replays ten years {PATHS:,} times, drawing trades at random from the simulated trades of that scenario.",
        f"Each trade risks the stated share of the balance. A path goes bust when it falls below ${BUST_BELOW:.0f}, less than one contract costs.",
        "What is left out, all of which make the real picture worse: taxes on each year's gains, wider fills as positions grow into the "
        "hundreds of contracts, and the fact that the edge was measured on the same two years it was tuned on.",
        "At the start one contract costs about 22% of $1,600, so the 5% and 10% bet sizes are not actually available until the account has grown.",
    ]
    for k, text in enumerate(notes):
        pj.cell(row=end + k, column=1, value=text)
    pj.cell(row=end, column=1).font = BOLD

    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if cell.font.name != FONT:
                    f = cell.font
                    cell.font = Font(name=FONT, bold=f.bold, color=f.color, size=f.size)
    wb.save(OUT)


if __name__ == "__main__":
    main()

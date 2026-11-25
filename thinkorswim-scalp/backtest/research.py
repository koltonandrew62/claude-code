"""Score every candidate rule, tuning on the early days only.

The first training days pick the settings for each rule. The remaining days are held
back and looked at once, to see whether the pick survives data it never saw.

    python3 research.py scalp     1-minute bars, 3-5 bar holds, $50 account
    python3 research.py longer    5-minute bars, 30-minute to 4-hour holds, $1,600 account
    python3 research.py hourly    hourly bars over two years, $1,600 account
"""
import itertools
import sys
from dataclasses import replace

import pandas as pd

import backtest as b

SYMBOLS = ["SPY", "QQQ", "IWM"]
MIN_TRAIN_TRADES = 40

# Each preset: bar size, training days, exit grid, and the contract the account can afford.
PRESETS = {
    # $50 account: 1-minute bars, 3-5 bar holds, contract of $0.45 or less expiring today.
    "scalp": dict(interval="1m", train_days=14, targets=[1.0, 2.0, 99.0], stops=[1.0, 2.0], holds=[3, 5],
                  contracts=[b.Costs()], out="results/research_1m.csv"),
    # $1,600 account: 5-minute bars, 30-minute to 4-hour holds, contract of $4.00 or less
    # (a quarter of the account), expiring today or in 5 trading days.
    "longer": dict(interval="5m", train_days=29, targets=[2.0, 4.0, 99.0], stops=[1.5, 3.0], holds=[6, 12, 24, 48],
                   contracts=[b.Costs(premium_cap=4.0), b.Costs(premium_cap=4.0, dte=5, slippage=0.02)],
                   out="results/research_5m_longer.csv"),
    # Same $1,600 contract choices on two years of hourly bars: 1-hour to rest-of-day holds.
    "hourly": dict(interval="1h", train_days=330, targets=[2.0, 4.0, 99.0], stops=[1.5, 3.0], holds=[1, 2, 3, 4],
                   contracts=[b.Costs(premium_cap=4.0), b.Costs(premium_cap=4.0, dte=5, slippage=0.02)],
                   out="results/research_1h_longer.csv"),
}


def clock(p, interval):
    if interval == "1m":
        return b.for_one_minute(p)
    if interval == "1h":
        return b.for_hourly(p)
    return p


def trades_for(p, costs, raw):
    return pd.concat([b.simulate(b.add_indicators(df, p), p, costs).assign(symbol=s) for s, df in raw.items()])


def main():
    cfg = PRESETS[sys.argv[1] if len(sys.argv) > 1 else "scalp"]
    raw = {s: b.load_underlying(s, cfg["interval"]) for s in SYMBOLS}
    days = sorted({d for df in raw.values() for d in df.date})
    n_train = cfg["train_days"]
    split = days[n_train]
    print(f"# {cfg['interval']} bars, train {days[0]} -> {days[n_train - 1]} ({n_train} days), "
          f"held back {split} -> {days[-1]} ({len(days) - n_train} days)")
    rows = []
    for name in b.SIGNALS:
        for costs in cfg["contracts"]:
            for tg, st, hold in itertools.product(cfg["targets"], cfg["stops"], cfg["holds"]):
                p = clock(replace(b.Params(), strategy=name, target_atr=tg, stop_atr=st, max_bars=hold), cfg["interval"])
                tr = trades_for(p, costs, raw)
                if tr.empty:
                    continue
                train, test = b.stats(tr[tr.date < split]), b.stats(tr[tr.date >= split])
                row = {"strategy": name, "target": tg, "stop": st, "hold": hold}
                if len(cfg["contracts"]) > 1:
                    row["dte"] = costs.dte
                row.update({
                    "train_n": train["trades"], "train_win%": train.get("opt_win%_net", 0.0),
                    "train_exp$": train.get("expectancy$", 0.0), "train_t": train.get("t_stat", 0.0),
                    "test_n": test["trades"], "test_win%": test.get("opt_win%_net", 0.0),
                    "test_exp$": test.get("expectancy$", 0.0), "test_t": test.get("t_stat", 0.0),
                })
                rows.append(row)
    res = pd.DataFrame(rows).round(2)
    res.to_csv(cfg["out"], index=False)
    ok = res[res.train_n >= MIN_TRAIN_TRADES]
    best = ok.loc[ok.groupby("strategy")["train_exp$"].idxmax()].sort_values("train_exp$", ascending=False)
    pd.set_option("display.width", 220)
    print("\n## Best setting per rule, chosen on the training days only")
    print(best.to_string(index=False))
    won_train = res["train_exp$"] > 0
    print(f"\n{won_train.sum()} of {len(res)} settings were profitable in training; "
          f"{(won_train & (res['test_exp$'] > 0)).sum()} of those were also profitable on the held-back days. "
          f"{(res['test_exp$'] > 0).sum()} of {len(res)} were profitable on the held-back days overall.")


if __name__ == "__main__":
    main()

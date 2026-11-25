"""Score every candidate rule on 1-minute bars, tuning on the early days only.

The first TRAIN_DAYS trading days pick the settings for each rule. The remaining days
are held back and looked at once, to see whether the pick survives data it never saw.
"""
import itertools
import sys
from dataclasses import replace

import pandas as pd

import backtest as b

SYMBOLS = ["SPY", "QQQ", "IWM"]
TRAIN_DAYS = 14
TARGETS = [1.0, 2.0, 99.0]   # ATR multiples; 99 = no target, exit on the bar count
STOPS = [1.0, 2.0]
HOLDS = [3, 5]               # the trade is closed after this many 1-minute bars at most
MIN_TRAIN_TRADES = 40


def trades_for(p, costs, raw):
    return pd.concat([b.simulate(b.add_indicators(df, p), p, costs).assign(symbol=s) for s, df in raw.items()])


def main():
    costs = b.Costs()
    raw = {s: b.load_underlying(s, "1m") for s in SYMBOLS}
    days = sorted({d for df in raw.values() for d in df.date})
    split = days[TRAIN_DAYS]
    print(f"# 1m bars, train {days[0]} -> {days[TRAIN_DAYS - 1]} ({TRAIN_DAYS} days), "
          f"held back {split} -> {days[-1]} ({len(days) - TRAIN_DAYS} days)")
    rows = []
    for name in b.SIGNALS:
        for tg, st, hold in itertools.product(TARGETS, STOPS, HOLDS):
            p = b.for_one_minute(replace(b.Params(), strategy=name, target_atr=tg, stop_atr=st, max_bars=hold))
            tr = trades_for(p, costs, raw)
            if tr.empty:
                continue
            train, test = b.stats(tr[tr.date < split]), b.stats(tr[tr.date >= split])
            rows.append({
                "strategy": name, "target": tg, "stop": st, "hold": hold,
                "train_n": train["trades"], "train_win%": train.get("opt_win%_net", 0.0),
                "train_exp$": train.get("expectancy$", 0.0), "train_t": train.get("t_stat", 0.0),
                "test_n": test["trades"], "test_win%": test.get("opt_win%_net", 0.0),
                "test_exp$": test.get("expectancy$", 0.0), "test_t": test.get("t_stat", 0.0),
            })
    res = pd.DataFrame(rows).round(2)
    res.to_csv(sys.argv[1] if len(sys.argv) > 1 else "results/research_1m.csv", index=False)
    ok = res[res.train_n >= MIN_TRAIN_TRADES]
    best = ok.loc[ok.groupby("strategy")["train_exp$"].idxmax()].sort_values("train_exp$", ascending=False)
    pd.set_option("display.width", 200)
    print("\n## Best setting per rule, chosen on the training days only")
    print(best.to_string(index=False))
    print(f"\n{(res['train_exp$'] > 0).sum()} of {len(res)} settings were profitable in training; "
          f"{((res['train_exp$'] > 0) & (res['test_exp$'] > 0)).sum()} of those were also profitable on the held-back days.")


if __name__ == "__main__":
    main()

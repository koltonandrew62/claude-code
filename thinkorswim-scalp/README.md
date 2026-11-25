# ScalpCallPut: a thinkorswim options scalp, and what its backtests say

**Result up front: no version of this strategy made money with options.**
Eight different 1-minute entry rules were tested at 12 exit settings each. None of the 96 was profitable on the days used to tune it.
The made-up $50 account lost $312.30 over 91 trades. Nothing here is a reason to trade it with real money.

## What is in this folder

| File | What it is |
| --- | --- |
| `ScalpCallPut_STRATEGY.ts` | The thinkScript strategy: eight selectable rules, CALL / PUT bubbles, status label |
| `ScalpAccount.xlsx` | The made-up $50 account: every trade, daily results, rule switches |
| `backtest/backtest.py` | Python backtest that re-prices every signal as a same-day option |
| `backtest/research.py` | Scores every rule on training days and on held-back days |
| `backtest/account.py` | Simulates the $50 account and writes the spreadsheet |
| `backtest/fetch_data.py` | Downloads the bars from Yahoo Finance |
| `backtest/data/`, `backtest/results/` | The bars used, and the reports and trade lists |

## The 1-minute strategy

1-minute chart, regular hours, SPY / QQQ / IWM. Signals from 9:35 to 15:50 Eastern, entry at the open of the next bar, one trade at a time.
Exit at +2 ATR (target), -1 ATR (stop), or after 5 one-minute bars at the latest.

The `rule` input picks how a CALL is triggered (a PUT is the mirror image):

| Rule | Trigger |
| --- | --- |
| Breakout (default) | Close beyond the 30-bar high on 1.5x volume, above VWAP |
| Pullback | Above VWAP with EMA(9) over EMA(21), dip to EMA(9) and close back above it |
| Burst | Wide high-volume bar closing near its high, above VWAP |
| PowerHour | The Breakout rule, 15:00 onward only |
| ORB | First close above the 9:30-9:45 range, before 11:30 |
| BandFade | Close back inside a 2.5 SD band after closing below it |
| RSI2 | In an uptrend, RSI(2) under 10 followed by a green bar |
| Exhaustion | Buy after three straight red bars that fell at least 2.5 ATR |

## The callout

Every signal bar gets a green **CALL** bubble below it or a red **PUT** bubble above it.
The label in the top-left corner always shows one of:

- `BUY CALL (enter next bar)` / `BUY PUT (enter next bar)`
- `IN CALL target … stop …` / `IN PUT target … stop …`
- `NO TRADE (waiting for setup)` / `NO TRADE (outside trading window)`

## 1-minute results

Costs: $0.01 per share slippage each way and $0.65 per contract each way.
The contract is the nearest-the-money same-day option costing $0.45 or less, which is all a $50 account can buy.
Data: 21 trading days, 2026-10-28 to 2026-11-25. The first 14 days tuned each rule; the last 7 were held back.

Best setting per rule, picked on the training days only:

| Rule | Training trades | Training win rate | Training avg per trade | Held-back trades | Held-back win rate | Held-back avg per trade |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Exhaustion | 303 | 23.1% | -$2.62 | 163 | 16.6% | -$5.91 |
| Burst | 140 | 25.0% | -$3.11 | 88 | 33.0% | -$1.62 |
| Breakout | 260 | 26.2% | -$3.19 | 149 | 36.2% | -$1.66 |
| Pullback | 1,464 | 23.2% | -$3.56 | 797 | 27.9% | -$4.57 |
| RSI2 | 331 | 21.8% | -$3.58 | 184 | 23.4% | -$5.37 |
| BandFade | 194 | 19.1% | -$4.05 | 95 | 29.5% | -$3.67 |

ORB and PowerHour fired fewer than 40 times in training, too few to rank. ORB's best held-back result was +$1.16 a trade on 19 trades, after losing $2.83 a trade in training; on 43 days of 5-minute bars it lost $5.16 a trade.

- 0 of 96 settings were profitable in training. The best was -$0.91 a trade.
- The highest win rate any setting reached was 53% in training and 60% on held-back days.
- Before costs, no rule showed a directional edge that held in both periods.

The reason is the same for every rule: a 3 to 5 minute move in the underlying is worth a few dollars on a $0.40 contract, and each round trip costs about $3.30.

### The made-up $50 account (`ScalpAccount.xlsx`)

The account trades one rule at a time, one contract per trade, and stops for the day once it is down $25.
After any losing day it switches to the next rule. When the balance could not buy a contract, another $50 was added.

| | |
| --- | ---: |
| Trades | 91 |
| Winning trades | 26 (28.6%) |
| Average win / average loss | $9.82 / -$8.73 |
| Net result | -$312.30 |
| Money put in | $450 ($50 start + 8 top-ups) |
| Ending balance | $137.70 |
| Losing days | 17 of 20 traded |
| Rule changes | 17 |

## Earlier 5-minute version

The first version used the Pullback rule on 5-minute bars with a 0.5 ATR target, 2 ATR stop and 6-bar limit.

Costs: $0.01 per share slippage each way and $0.65 per contract each way.
The "$50 contract" is the nearest-the-money same-day option costing $0.45 or less, which is all a $50 account can buy.

### 5-minute bars, 2026-09-28 to 2026-11-25 (43 trading days)

| Symbol | Trades | Underlying moved the right way | Option win rate, no costs | Option win rate, after costs | Avg win | Avg loss | Avg per trade |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| SPY | 306 | 67.7% | 58.8% | 39.5% | $4.64 | -$13.28 | -$6.19 |
| QQQ | 288 | 67.4% | 56.9% | 46.9% | $4.44 | -$16.87 | -$6.88 |
| IWM | 308 | 72.1% | 63.6% | 38.0% | $2.18 | -$8.88 | -$4.68 |
| All | 902 | 69.1% | 59.9% | 41.4% | $3.80 | -$12.73 | -$5.90 |

$50 account, one trade a day (a cash account's option proceeds settle the next day):

| Symbol | End balance | Trades taken | Note |
| --- | ---: | ---: | --- |
| SPY | $27.81 | 11 | then could not afford a contract |
| QQQ | $12.24 | 1 | first trade hit its stop |
| IWM | $23.14 | 1 | first trade hit its stop |

With an at-the-money contract (about $163 each, so not possible on $50) the same signals won 58.9% after costs and still lost $9.21 per trade.

### Hourly bars, 2024-12-11 to 2026-11-25 (491 trading days)

Same rules on hourly bars as a longer-history check. This is not a scalp timeframe.
670 trades, 30.8% option win rate after costs, -$15.12 per trade. The $50 SPY account ended at $1.23.

### Why a 90% win rate does not help

Win rate is set mostly by how far the target is from the stop.
A 0.15 ATR target with a 4 ATR stop and a 2-hour time limit made the underlying move the right way on **94.5%** of 1,028 trades.
Traded with the $50 contract, those same trades won **6.4%** of the time after costs and lost $4.89 each.
The target is a few cents of option premium, and slippage plus commission is about $3.30 a round trip.

Across every target and stop tested (`backtest/results/grid_5m.txt`) no setting was profitable.

## What this backtest does not cover

- **Ten years.** Free 1-minute history goes back 30 days, 5-minute history 60 days and hourly history about 2 years. A scalp cannot be tested on daily bars, so there is no 10-year run. Nobody can backtest the next ten years; a backtest only uses the past.
- **Real option quotes.** Option prices are modelled with Black-Scholes, same-day expiry, volatility set to 0.8 x VIX (VXN for QQQ, 1.2 x VIX for IWM). Real fills will differ.
- **thinkorswim itself.** The script was written without access to thinkorswim, so it has not been compiled or run there. The Python simulation follows the same rules.

## Running it in thinkorswim

1. Charts > Studies > Edit Studies > Strategies tab > Create. Paste `ScalpCallPut_STRATEGY.ts`, name it, OK.
2. Use a 1-minute chart of SPY, QQQ or IWM and pick a rule in the strategy's settings. Right-click an order arrow > Show Report for the underlying P&L.
3. To test with real historical option prices, use **OnDemand** (top right of the main window). It replays past sessions with the option chain as it traded, on a simulated account. Follow the bubbles and buy the option by hand.
4. For live paper trading, log in to paperMoney and set the balance to $50 from the account adjustment option on the Monitor tab.

## Re-running the backtest

```bash
python3 backtest/fetch_data.py
```

```bash
python3 backtest/research.py
```

```bash
python3 backtest/account.py
```

```bash
python3 backtest/backtest.py --interval 1m --strategy breakout --target-atr 2 --stop-atr 1 --max-bars 5
```

`backtest.py` with no arguments reproduces the 5-minute table; add `--grid` to sweep targets and stops.
Other options: `--iv-scale`, `--slippage`, `--commission`, `--trades-csv`.
Needs Python 3 with pandas, numpy and openpyxl. `fetch_data.py` overwrites `backtest/data/` with the latest bars, so results will change.

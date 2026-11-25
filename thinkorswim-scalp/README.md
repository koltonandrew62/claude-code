# ScalpCallPut: thinkorswim option day-trade signals, and what the backtests say

**Result up front: one setup made money in testing, on a small sample; everything else lost.**

- **Longer holds, $1,600 account:** an hourly breakout rule held up to 4 hours turned $1,600 into $2,664.30 over two years of simulated trades (49 trades, 45% winners). Its three best trades made more than the whole profit, so this is a lead to keep testing, not a proven edge.
- **1-minute scalp, $50 account:** eight rules, 96 settings, none profitable. The account lost $312.30 over 91 trades.
- **Changing rules whenever one loses** made things worse both times.
- No setup came anywhere near a 90% win rate.

All trades are simulated with modelled option prices. Nothing here is a reason to trade real money yet.

## What is in this folder

| File | What it is |
| --- | --- |
| `ScalpCallPut_STRATEGY.ts` | The thinkScript strategy: eight selectable rules, CALL / PUT / SELL bubbles, status labels |
| `LongerHoldAccount.xlsx` | The made-up $1,600 account with longer holds |
| `ScalpAccount.xlsx` | The made-up $50 account with the 1-minute scalp |
| `backtest/backtest.py` | Python backtest that re-prices every signal as an option |
| `backtest/research.py` | Scores every rule on training days and on held-back days |
| `backtest/account_longer.py`, `backtest/account.py` | Simulate the two accounts and write the spreadsheets |
| `backtest/fetch_data.py` | Downloads the bars from Yahoo Finance |
| `backtest/data/`, `backtest/results/` | The bars used, and the reports and trade lists |

## The callouts

- **CALL / PUT:** a green CALL bubble below the signal bar or a red PUT bubble above it. Entry is the open of the next bar.
- **SELL:** a yellow SELL bubble on the bar where the trade should be closed, saying why (stop, target or time).
- **SELL label:** a yellow label appears as soon as price touches the stop or target (`SELL CALL NOW (stop hit)`), and for the whole final bar when the time limit is up (`SELL CALL at the close of this bar (time limit)`).
- **Status label:** `BUY CALL`, `BUY PUT`, `IN CALL - HOLD sell if price falls to … bars left: …`, or `NO TRADE`.
- **Alerts:** a sound on every buy and sell signal.

## Longer holds with a $1,600 account

Hourly chart, SPY / QQQ / IWM. Signals on the 10:30 to 13:30 bars, entry at the open of the next bar, everything closed by 15:30.
The contract costs $4.00 or less (a quarter of the account), expiring the same day or 5 trading days out.
Costs: $0.65 per contract each way, and $0.01 (same-day) or $0.02 (5-day) per share slippage each way.

Data: 500 trading days of hourly bars, 2024-11-27 to 2026-11-25. The first 330 days tuned each rule; the last 170 were held back.
Each rule was tried at 48 settings (holds of 1 to 4 hours, three targets, two stops, two expiries).

Best setting per rule, picked on the training days only:

| Rule | Hold | Expiry | Training trades | Training win rate | Training avg per trade | Held-back trades | Held-back win rate | Held-back avg per trade |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **Breakout** | 4 h | 5 days | 42 | 52.4% | $41.69 | 27 | 40.7% | $24.24 |
| RSI2 | 4 h | same day | 99 | 19.2% | $34.26 | 53 | 13.2% | -$72.92 |
| Burst | 1 h | same day | 59 | 45.8% | $32.16 | 24 | 25.0% | -$43.88 |
| Exhaustion | 1 h | same day | 129 | 38.8% | $7.58 | 84 | 20.2% | -$42.19 |
| ORB | 1 h | 5 days | 232 | 41.0% | -$0.70 | 128 | 41.4% | $0.35 |
| BandFade | 1 h | 5 days | 96 | 27.1% | -$10.63 | 47 | 25.5% | -$21.26 |
| Pullback | 1 h | 5 days | 443 | 35.4% | -$11.78 | 183 | 33.9% | -$7.56 |

Breakout is the only rule whose training pick also made money on the held-back days.
Its setting: close beyond the 30-bar high or low on 1.5x volume on the VWAP side, stop 1.5 ATR, no target, sell after 4 hourly bars.

It was profitable at all 48 of its settings in training and at 42 of 48 on the held-back days. Those settings share the same entry signals, so that is one result seen 48 ways, not 48 confirmations.

Reasons not to trust it yet:

- 27 held-back trades is too few to tell skill from luck; the result is well within what chance produces.
- It was the best of 336 settings, and the best of that many always looks good.
- The profit came from puts. Calls lost money in both periods.
- The same rule on 43 days of 5-minute bars (30-minute to 4-hour holds) made $15.11 a trade in training and lost $1.88 a trade on held-back days.

### The made-up $1,600 account (`LongerHoldAccount.xlsx`)

Each trade spends about 5% of the balance, never less than one contract, and one contract may cost at most 25% of the balance.
One position at a time; cash from a sale is not reused until the next day.

| | Breakout only | Switching rules |
| --- | ---: | ---: |
| Trades | 49 | 51 |
| Winning trades | 22 (44.9%) | 10 (19.6%) |
| Average win / average loss | $135.79 / -$71.23 | $109.00 / -$51.33 |
| Net result | +$1,064.30 | -$1,014.60 |
| Ending balance | $2,664.30 | $585.40 |

- **Breakout only** trades the one rule above for the whole two years. On the held-back days alone: 20 trades, 8 winners, +$355.00. The largest drop from a high was 30.9%. The three best trades made $1,285, more than the total profit.
- **Switching rules** does what you asked: every week it moves to whichever rule did best over the previous 60 trading days, and stays in cash if none made money. It chased rules that had just been lucky and lost 63%.

## The 1-minute scalp with a $50 account

1-minute chart, regular hours, SPY / QQQ / IWM. Signals from 9:35 to 15:50 Eastern, entry at the open of the next bar, one trade at a time.
Exit at +2 ATR (target), -1 ATR (stop), or after 5 one-minute bars at the latest.

The `rule` input picks how a CALL is triggered (a PUT is the mirror image):

| Rule | Trigger |
| --- | --- |
| Breakout | Close beyond the 30-bar high on 1.5x volume, above VWAP |
| Pullback | Above VWAP with EMA(9) over EMA(21), dip to EMA(9) and close back above it |
| Burst | Wide high-volume bar closing near its high, above VWAP |
| PowerHour | The Breakout rule, 15:00 onward only |
| ORB | First close above the 9:30-9:45 range, before 11:30 |
| BandFade | Close back inside a 2.5 SD band after closing below it |
| RSI2 | In an uptrend, RSI(2) under 10 followed by a green bar |
| Exhaustion | Buy after three straight red bars that fell at least 2.5 ATR |

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
- **Real option quotes.** Option prices are modelled with Black-Scholes and volatility from the VIX (VXN for QQQ, 1.2 x VIX for IWM), scaled by 0.8 for same-day contracts. Real fills will differ.
- **thinkorswim itself.** The script was written without access to thinkorswim, so it has not been compiled or run there. The Python simulation follows the same rules.

## Running it in thinkorswim

1. Charts > Studies > Edit Studies > Strategies tab > Create. Paste `ScalpCallPut_STRATEGY.ts`, name it, OK.
2. For the longer-hold setup use a 1-hour chart of SPY, QQQ or IWM; the script's defaults match it. For the 1-minute scalp, use a 1-minute chart and the settings listed at the top of the script.
3. Right-click an order arrow > Show Report for the underlying P&L.
4. To test with real historical option prices, use **OnDemand** (top right of the main window). It replays past sessions with the option chain as it traded, on a simulated account. Follow the bubbles and place the trades by hand.
5. For live paper trading, log in to paperMoney and set the balance to $1,600 from the account adjustment option on the Monitor tab.

## Re-running the backtest

```bash
python3 backtest/fetch_data.py
```

```bash
python3 backtest/research.py hourly
```

```bash
python3 backtest/account_longer.py
```

```bash
python3 backtest/research.py scalp
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

# ScalpCallPut: thinkorswim option day-trade signals, and what the backtests say

**Result up front: the breakout rule got better by dropping calls and waiting for the wider market to confirm. It is still a small-sample result.**

- **Improved breakout (puts only, market confirmed), $1,600 account:** 18 trades in two years, 61% winners, $1,600 to $2,886.60, largest drop 14.4%. Three trades made almost all of that profit.
- **Why puts only:** on 13 stocks and ETFs the rule had never seen, calls lost $35.67 a trade over 149 trades. That is the most reliable finding in this whole project.
- **Original breakout, no target:** 45% winners, $1,600 to $2,664.30.
- **Breakout with a quick target (over 60% winners):** roughly break-even; the account lost $74.20.
- **Quant model (math and pattern matching on 14 years of daily data):** called the day's direction right 52% of the time on unseen years. Buying calls and puts on it lost at every setting.
- **1-minute scalp, $50 account:** eight rules, 96 settings, none profitable. The account lost $312.30 over 91 trades.
- **Changing rules whenever one loses** made things worse both times.
- **Using every strategy at once** took $1,600 to $252 in two years.
- **$1,600 to $3.2 million in ten years** needs 114% growth every year. The best account here grew 35% a year, which reaches about $31,500.

Only calls and puts are ever bought; nothing is sold short. All trades are simulated with modelled option prices. Nothing here is a reason to trade real money yet.

## What is in this folder

| File | What it is |
| --- | --- |
| `ScalpCallPut_STRATEGY.ts` | The thinkScript strategy: eight selectable rules, CALL / PUT / SELL bubbles, status labels |
| `BreakoutPutsAccount.xlsx` | The made-up $1,600 account trading the improved breakout rule |
| `LongerHoldAccount.xlsx` | The made-up $1,600 account with longer holds (three earlier versions) |
| `ScalpAccount.xlsx` | The made-up $50 account with the 1-minute scalp |
| `TenYearPlan.xlsx` | What $1,600 to $3.2 million requires, the every-strategy account, and ten-year projections |
| `backtest/backtest.py` | Python backtest that re-prices every signal as an option |
| `backtest/research.py` | Scores every rule on training days and on held-back days |
| `backtest/quant.py` | The quant model: regression plus pattern matching on daily bars, refitted every year |
| `backtest/ten_year.py` | The every-strategy account and the ten-year projections |
| `backtest/breakout_lab.py` | Tests the breakout rule on new symbols, scores refinements, writes the improved account |
| `backtest/account_longer.py`, `backtest/account.py` | Simulate the two accounts and write the spreadsheets |
| `backtest/fetch_data.py` | Downloads the bars from Yahoo Finance |
| `backtest/data/`, `backtest/results/` | The bars used, and the reports and trade lists |

## Making the breakout better (`backtest/breakout_lab.py`)

Tuning further on SPY, QQQ and IWM would only fit noise, because those results have been looked at many times.
So the rule was first run, unchanged, on 13 symbols it had never seen (DIA, XLF, XLK, XLE, SMH, AAPL, MSFT, NVDA, AMZN, META, GOOGL, TSLA, AMD), same two years of hourly bars.

| On the 13 new symbols | Trades | Win rate | Average per trade |
| --- | ---: | ---: | ---: |
| Rule as it stood | 323 | 32.5% | -$14.06 |
| Its calls | 149 | 25.5% | -$35.67 |
| Its puts | 174 | 38.5% | $4.45 |
| Its puts on the 5 ETFs | 69 | 46.4% | $24.50 |
| Its puts on the 8 stocks | 105 | 33.3% | -$8.73 |

As it stood, the rule did not carry over. The split explains why: after a break to new highs the price did not keep going, while after a break to new lows it did (about 20 to 30 hundredths of a percent further on average, on both the old and the new symbols).

Refinements, each scored on the original training days, the original held-back days, and the 13 new symbols:

| Version | Training | Held back | New symbols |
| --- | ---: | ---: | ---: |
| As it stood | 52.4%, $41.69 | 40.7%, $24.24 | 32.5%, -$14.06 |
| Puts only | 62.5%, $82.29 | 43.5%, $37.35 | 38.5%, $4.45 |
| Calls only | 38.9%, -$12.45 | 25.0%, -$51.12 | 25.5%, -$35.67 |
| With the daily trend only | 48.0%, $10.96 | 40.0%, $11.77 | 30.7%, -$15.04 |
| 2x volume instead of 1.5x | 47.1%, $76.37 | 77.8%, $116.83 | 35.6%, -$9.67 |
| **Puts only, wider market also at a 30-bar low** | 75.0%, $98.41 | 53.3%, $66.49 | 48.7%, $30.65 |

Each cell is win rate, then average per trade. The last row is the improved rule: a put signal only counts when SPY (or QQQ, on a SPY chart) is below its own 30-bar low on the same bar.
Puts taken without that confirmation lost $17.81 a trade on the new symbols.

### The improved rule in a $1,600 account (`BreakoutPutsAccount.xlsx`)

SPY, QQQ and IWM, same account rules as before.

| | As it stood | Puts only | Puts only, market confirmed |
| --- | ---: | ---: | ---: |
| Trades | 49 | 31 | 18 |
| Win rate | 44.9% | 45.2% | 61.1% |
| Net result | +$937.30 | +$1,184.70 | +$1,286.60 |
| Largest drop from a high | 33.7% | 28.3% | 14.4% |
| Net on the last 170 days | +$206 | +$410 | +$550 |

What to keep in mind:

- **Three trades are the profit.** The three largest winners made $1,283 of the $1,286.60. The other 15 trades netted about zero.
- **Nine trades a year.** That is very few to judge anything by.
- **The confirmation idea came from this same data.** Dropping calls was tested on untouched symbols; the market filter was found by studying these two years and has not had a clean test.
- **It is a bet on selloffs.** It makes money when the market breaks down and sits idle otherwise.
- **Small details move the result.** When several ETFs signal in the same hour the account can only take one, and which one it takes changed an eight-ETF version of this account from +$1,268 to -$224. (The "as it stood" figure here differs from the $1,064.30 in `LongerHoldAccount.xlsx` for the same reason.)
- **Stocks are modelled more roughly** than ETFs, using the VIX scaled by how much each stock moves, so the stock rows are less reliable.

## The $3.2 million goal (`TenYearPlan.xlsx`)

Turning $1,600 into $3.2 million in ten years means multiplying it 2,000 times: 113.8% growth every year, or 6.5% every month, for 120 months.

| | Yearly growth | After ten years |
| --- | ---: | ---: |
| What the goal needs | 113.8% | $3,200,000 |
| Best simulated account here (improved breakout) | 34.7% | $31,506 |

At the best account's rate the goal takes about 25 years, and that assumes its best two years repeat forever.

### Using every strategy at once

One account taking every signal from all seven hourly rules and the quant model, about 5% of the balance per trade:

| Strategy | Signals in two years | Win rate | Average per trade | Total, one contract per signal |
| --- | ---: | ---: | ---: | ---: |
| Breakout | 69 | 47.8% | $34.86 | +$2,405 |
| RSI2 | 152 | 30.3% | $9.89 | +$1,503 |
| Burst | 80 | 42.5% | $6.03 | +$483 |
| ORB | 359 | 37.3% | -$12.54 | -$4,502 |
| BandFade | 142 | 26.1% | -$27.50 | -$3,905 |
| Exhaustion | 185 | 29.7% | -$26.97 | -$4,990 |
| Quant model | 122 | 30.3% | -$46.90 | -$5,722 |
| Pullback | 482 | 31.5% | -$20.60 | -$9,929 |

The combined account took 316 trades and fell from $1,600 to $252, at which point it could no longer afford a contract.
Five of the eight strategies lose, and they fire far more often than the three that do not. RSI2 and Burst were positive over the full two years but lost on the held-back days.

### Ten-year projections

Each row replays ten years 20,000 times by drawing at random from the simulated trades, betting a fixed share of the balance on every trade.

| Scenario | Bet per trade | Middle outcome | Paths reaching $3.2 million | Paths going bust |
| --- | ---: | ---: | ---: | ---: |
| Every strategy together | any | bust | 0% | 100% |
| Breakout, edge exactly as measured | 10% | $41,111 | 0% | 0% |
| Breakout, edge exactly as measured | 25% | $1,628,685 | 36.2% | 0.1% |
| Breakout, edge exactly as measured | 50% | $49,676,473 | 76.6% | 4.9% |
| Breakout, edge as on the unseen days | 10% | $7,359 | 0% | 0% |
| Breakout, edge as on the unseen days | 25% | $18,612 | 0.8% | 10.5% |
| Breakout, edge as on the unseen days | 50% | bust | 4.6% | 58.0% |
| Breakout, no real edge | 25% | bust | 0% | 74.2% |
| Improved breakout, edge exactly as measured | 25% | $4,265,584 | 57.5% | 0% |
| Improved breakout, edge as on the 13 other symbols | 25% | $22,045 | 0% | 0.1% |
| Improved breakout, edge as on the 13 other symbols | 50% | $71,198 | 5.7% | 7.3% |

The "exactly as measured" rows are not forecasts. The improved rule's row rests on 31 signals from the same two years the rule was shaped on, and that sample contains no trade that lost its whole premium, so the replay cannot go bust the way a real account can.

The goal only shows up when two things are both assumed: the breakout edge is exactly as large as its best two-year measurement, and a quarter to half of the account is bet on every trade for ten years.
The measurement is far too uncertain for that. With the smaller edge seen on the unseen days, the same bet sizes reach the goal in under 5% of paths and wipe the account out in 10% to 58% of them.

Also left out, all of which make it harder: taxes on each year's gains, worse fills once positions run to hundreds of contracts, and the fact that one contract already costs about 22% of $1,600, so small bet sizes are not available at the start.

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

### Hunting for a win rate over 60%

Same hourly data, with closer profit targets (0.5, 1 or 1.5 ATR), a wide or no stop, and 2 or 4 hour holds: 168 settings.

- 18 settings won at least 60% of trades in training.
- The best of them in training (Burst, 72.9% winners) fell to 45.8% on the held-back days and lost money.
- 6 kept a win rate of 60% or more on the held-back days and made money. All 6 are the Breakout rule with a 0.5 ATR target.

The cleanest of those: Breakout, sell at +0.5 ATR or after 2 hourly bars, 3 ATR stop, contract 5 trading days from expiry.

| | Training | Held back |
| --- | ---: | ---: |
| Signals | 48 | 35 |
| Win rate | 62.5% | 62.9% |
| Average per trade | $11.12 | $8.86 |

Those averages are too small to tell from zero on this many trades, and the account below shows how fragile they are.

### The made-up $1,600 account (`LongerHoldAccount.xlsx`)

Each trade spends about 5% of the balance, never less than one contract, and one contract may cost at most 25% of the balance.
One position at a time; cash from a sale is not reused until the next day. Those rules mean the account takes about two thirds of the signals.

| | Breakout, quick target | Breakout, no target | Switching rules |
| --- | ---: | ---: | ---: |
| Trades | 54 | 49 | 51 |
| Winning trades | 32 (59.3%) | 22 (44.9%) | 10 (19.6%) |
| Average win / average loss | $45.20 / -$69.12 | $135.79 / -$71.23 | $109.00 / -$51.33 |
| Net result | -$74.20 | +$1,064.30 | -$1,014.60 |
| Ending balance | $1,525.80 | $2,664.30 | $585.40 |
| Largest drop from a high | 19.4% | 30.9% | 69.2% |

- **Quick target** is the over-60% setup. Taking only the trades the account could afford, it won 59.3% and lost $74.20. On the held-back days alone: 21 trades, 12 winners, -$238.30. The win rate is high because winners are cut at about $45 while losers run to about $69.
- **No target** lets winners run. On the held-back days alone: 20 trades, 8 winners, +$355.00. The three best trades made $1,284, more than the total profit.
- **Switching rules** moves every week to whichever rule did best over the previous 60 trading days, and stays in cash if none made money. It chased rules that had just been lucky.
- In both breakout accounts the profit came from puts; calls lost money.

The held-back days have now been looked at several times while choosing settings, so they are no longer a clean test of anything here.

## The quant model (`backtest/quant.py`)

Built the way quant funds describe their approach: no chart reading, only statistics on historical data.

- **Inputs:** 18 measurements known at each morning's open for SPY, QQQ and IWM. They cover the overnight gap, returns over 1, 5 and 20 days, distance from the 20-day average, RSI(2), where yesterday closed in its range, VIX level, change and term structure, each ETF's strength against the other two, bonds, and calendar effects.
- **Model:** a logistic regression weighs the inputs, and a pattern matcher finds the 100 most similar past mornings and counts how they ended. The two estimates are averaged.
- **No peeking:** the model is refitted each January on everything before that year, so every prediction from 2016 on is for a day it had never seen.
- **Trade:** buy a call or put at the open when the estimate is far enough from 50%, sell at a target, a stop, or the close. Settings were chosen on 2016-2021 and checked on 2022-2026.

Data: 3,499 trading days per ETF, 2012-12-28 to 2026-11-25.

| | 2016-2021 | 2022-2026 |
| --- | ---: | ---: |
| Direction right, all days | 51.8% | 52.0% |
| Days that closed above the open anyway | 53.3% | 51.8% |
| Direction right, most confident calls | 55.0% of 705 | 49.1% of 346 |
| Option settings that made money (of 96) | 0 | 0 |
| Highest win rate of any setting | 58.3% | 59.6% |
| Best average per trade | -$11.71 | -$18.68 |

The model's direction calls were no better than always guessing "up". A contract held from open to close loses roughly $20 to $30 of time value, and a 52% guess does not cover that.

For scale: the fund this idea comes from was reported to be right about 51% of the time. It made money from millions of tiny, low-cost trades, which a retail options account cannot copy.

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

- **Ten years of intraday trades.** Free 1-minute history goes back 30 days, 5-minute history 60 days and hourly history about 2 years. Only the quant model, which trades once a day on daily bars, covers more than ten years. Nobody can backtest the next ten years; a backtest only uses the past.
- **Real option quotes.** Option prices are modelled with Black-Scholes and volatility from the VIX (VXN for QQQ, 1.2 x VIX for IWM), scaled by 0.8 for same-day contracts. Real fills will differ. For contracts that expire on a later day the model charges a full day of time decay during market hours, which is harsher than real markets, so those results lean pessimistic.
- **thinkorswim itself.** The script was written without access to thinkorswim, so it has not been compiled or run there. The Python simulation follows the same rules.

## Running it in thinkorswim

1. Charts > Studies > Edit Studies > Strategies tab > Create. Paste `ScalpCallPut_STRATEGY.ts`, name it, OK.
2. Use a 1-hour chart of SPY, QQQ or IWM; the script's defaults are the improved breakout (puts only, market confirmed). Set `confirmSymbol` to QQQ on a SPY chart and to SPY on any other chart. For the 1-minute scalp, use a 1-minute chart and the settings listed at the top of the script.
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
python3 backtest/research.py hourly60
```

```bash
python3 backtest/quant.py
```

```bash
python3 backtest/breakout_lab.py
```

```bash
python3 backtest/breakout_lab.py account
```

```bash
python3 backtest/ten_year.py
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

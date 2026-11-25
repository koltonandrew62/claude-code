# ScalpCallPut: a thinkorswim options scalp, and what its backtest says

**Result up front: this strategy loses money when traded with options, and it does not win 90% of trades.**
On the $50 contract it won 41% of trades after costs and lost an average of $5.90 per trade.
Nothing here is a reason to trade it with real money.

## What is in this folder

| File | What it is |
| --- | --- |
| `ScalpCallPut_STRATEGY.ts` | The thinkScript strategy, with CALL / PUT bubbles and a status label |
| `backtest/backtest.py` | Python backtest that re-prices every signal as a same-day option |
| `backtest/fetch_data.py` | Downloads the bars from Yahoo Finance |
| `backtest/data/` | The bars the results below were computed from |
| `backtest/results/` | Reports and the full trade lists |

## The rules

5-minute chart, regular hours, SPY / QQQ / IWM.

- **CALL**: price above session VWAP, EMA(9) above EMA(21), the bar dips to the EMA(9) and closes back above it green.
- **PUT**: the mirror image below VWAP.
- Signals only between 9:45 and 15:00 Eastern. Entry is the open of the next bar.
- Exit at +0.5 ATR (target), -2.0 ATR (stop), after 6 bars, or at 15:50, whichever comes first.
- One trade at a time.

## The callout

Every signal bar gets a green **CALL** bubble below it or a red **PUT** bubble above it.
The label in the top-left corner always shows one of:

- `BUY CALL (enter next bar)` / `BUY PUT (enter next bar)`
- `IN CALL target … stop …` / `IN PUT target … stop …`
- `NO TRADE (waiting for setup)` / `NO TRADE (outside trading window)`

A second label shows the trend filter: calls only, puts only, or stand aside.

## Backtest results

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

Across every target and stop tested (`backtest/results/grid_5m.txt`) no setting was profitable, with or without costs.
With costs set to zero the default rules still lost $2.85 per trade to time decay, so the signal has no measurable edge in this sample.

## What this backtest does not cover

- **Ten years.** Free 5-minute history goes back 60 days and hourly history about 2 years. A 5-minute scalp cannot be tested on daily bars, so there is no 10-year run. Nobody can backtest the next ten years; a backtest only uses the past.
- **Real option quotes.** Option prices are modelled with Black-Scholes, same-day expiry, volatility set to 0.8 x VIX (VXN for QQQ, 1.2 x VIX for IWM). Real fills will differ.
- **thinkorswim itself.** The script was written without access to thinkorswim, so it has not been compiled or run there. The Python simulation follows the same rules.

## Running it in thinkorswim

1. Charts > Studies > Edit Studies > Strategies tab > Create. Paste `ScalpCallPut_STRATEGY.ts`, name it, OK.
2. Use a 5-minute chart of SPY, QQQ or IWM. Right-click an order arrow > Show Report for the underlying P&L.
3. To test with real historical option prices, use **OnDemand** (top right of the main window). It replays past sessions with the option chain as it traded, on a simulated account. Follow the bubbles and buy the option by hand.
4. For live paper trading, log in to paperMoney and set the balance to $50 from the account adjustment option on the Monitor tab.

## Re-running the backtest

```bash
python3 backtest/fetch_data.py
```

```bash
python3 backtest/backtest.py
```

```bash
python3 backtest/backtest.py --grid
```

Options: `--interval 1h`, `--target-atr`, `--stop-atr`, `--max-bars`, `--iv-scale`, `--slippage`, `--commission`, `--trades-csv`.
Needs Python 3 with pandas and numpy. `fetch_data.py` overwrites `backtest/data/` with the latest 60 days.

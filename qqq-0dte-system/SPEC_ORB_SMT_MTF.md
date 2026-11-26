# Opening-range retest in the SMT direction: 15-minute rejection + 5-minute entry

Two thinkorswim studies plus a Python reference backtest that implement **exactly** these rules.
All times are US/Eastern. Charts must show the **extended-hours session** (needed for PMH/PML).
Symbol: QQQ. Comparison symbol for SMT: SPY (an input).
Indicators used: PMH/PML, VWAP, the 15-minute opening range, ATR and RSI only. **No EMA of any kind** (the user removed it).

## Session and time-zone rules (REQUIRED; the user asked for these explicitly)
thinkorswim session functions (SecondsFromTime / SecondsTillTime) work in **US Eastern time**, and every time in this spec is
Eastern. The Python data's time_et column is already Eastern (DST handled: EDT until 2026-10-30, EST from 2026-11-02).
Never convert time zones in the studies, and never use the chart's display time zone.
1. **Every daily value resets at the new day's first pre-market bar, not at midnight and not at the first bar of the chart.**
   new day = (GetYYYYMMDD() != GetYYYYMMDD()[1]) OR (the bar starts at or after 04:00 and the previous bar started before 04:00
   or after 16:00 on an earlier date). Reset on that bar: PMH/PML (QQQ and SPY), OR, VWAP sums, SMT state, break/REJECT state,
   the 5-minute setup and trade state, and the rebuilt 15-minute bar state.
2. **Yesterday's after-hours (16:00..20:00) must never feed today's values.** PMH/PML only take bars that start 04:00..09:29 on
   **today's** date; the OR only 09:30..09:44 today; SMT/break/REJECT/entries only regular-session bars (09:30..15:59) today.
   Post-market bars are ignored by every rule (they may only show the day's final lines).
3. **No carry-over in plots**: until today's first pre-market bar has been seen, today's PMH/PML must not show yesterday's
   values. Draw PMH/PML/OR/VWAP lines only on bars of the day they belong to (NaN elsewhere), so no line runs from yesterday into
   today. Past days are shown by default (input showPastDays, see rule 7).
4. **VWAP resets at the regular-market open**: the cumulative sums start fresh on the 09:30 bar. Only 09:30..15:59 bars are
   included; VWAP is NaN (not plotted, not used) before 09:30 and after 15:59, so pre-market and post-market volume never
   enter it.
5. Use SecondsFromTime(hhmm) >= 0 and SecondsTillTime(hhmm) > 0 windows on bar start times (bars are labeled by their start
   on every timeframe). On the 15-minute chart the 09:30 bar covers 09:30..09:44 and is the whole OR; on the 5-minute chart the
   OR is the 09:30, 09:35 and 09:40 bars.
6. If no pre-market bar exists today (extended hours off), PMH/PML stay NaN, no SMT is computed, and a warning label says
   "Turn on extended-hours trading session". Never fall back to yesterday's values.
7. **Chart settings the studies must work on: 30D:5m (5-minute study) and 30D:15m (15-minute study), extended hours on.**
   That's about 30 days × 192 five-minute bars (≈5,800 bars) or × 64 fifteen-minute bars. So: every day in the 30 days must
   compute independently and correctly (the resets above), signals and bubbles must appear on every past day as well as today
   (input showPastDays, default YES, controls past-day lines and bubbles), and no expensive per-bar fold loops over long
   ranges; use recursive state (x[1]) instead. The first day on the chart may have partial warm-up for ATR/RSI; that's fine.
The Python reference must implement the same resets and windows, and the reviewers must check them line by line.

## Shared definitions
- **Day reset**: see the session rules above (the first bar of the day's pre-market).
- **PMH / PML**: QQQ high / low of today's bars starting 04:00..09:29. **SPY PMH / PML** the same for SPY.
- **VWAP**: session VWAP from the 09:30 bar: cumulative sum((high+low+close)/3 × volume) / cumulative volume,
  reset at the 09:30 bar, regular-session bars only. Not defined before 09:30 or after 15:59.
- **OR (15-minute opening range)**: ORH / ORL = high / low of the regular-session bars starting 09:30..09:44.
- **ATR**: Wilder ATR(14) on the chart's own bars (extended-hours bars included, as thinkorswim computes it).
- **RSI**: Wilder RSI(14) on the chart's own bars.

## SMT bias (evaluated on 15-minute bars in both studies, bar start times 09:30..11:30)
Bearish side (a PMH sweep that fails):
1. Sweep start = the first RTH bar with high > PMH (only bars starting ≤ 11:30).
2. Reclaim = a later bar (or the same bar) whose close < PMH, if its start is within 30 minutes after the sweep start bar's start.
   If 30 minutes pass without a reclaim: if the current bar's high > PMH, it becomes the new sweep start; otherwise the
   sweep resets and waits for the next bar with high > PMH.
3. Only the **first** reclaim of the day on this side is evaluated. At that bar: if SPY's highest high from 09:30 through
   this bar is ≤ SPY PMH, then SPY did not sweep, so **SMT BEAR** is confirmed (bias = PUT). If SPY did sweep, this side
   is finished for the day and has no SMT.
Bullish side: mirror image with PML / lows -> **SMT BULL** (bias = CALL).
**Day bias** = the direction of the first SMT-confirmed side of the day (bearish and bullish can't both set it).
The bias time is the bar where it was confirmed.

## 15-minute rejection (15-minute bars; the 5-minute study rebuilds 15-minute bars from 5-minute bars, see below)
For the bias direction only (PUT bias -> OR low; CALL bias -> OR high):
1. **Break**: the first 15-minute bar starting 09:45..11:45 that closes beyond the level (PUT: close < ORL; CALL: close > ORH).
2. Within the next 4 fifteen-minute bars after the break bar (the break bar itself doesn't count):
   - **Failed** if a bar closes back through the level by more than 0.5 × ATR15 (PUT: close > ORL + 0.5×ATR15;
     CALL: close < ORH − 0.5×ATR15). Then there's no setup that day.
   - **Rejection** if a bar retests and rejects the level: PUT: high ≥ ORL − 0.05 and close < ORL;
     CALL: low ≤ ORH + 0.05 and close > ORH. The first such bar is the **15-minute REJECT bar**.
3. The REJECT bar must close **after** the SMT bias was confirmed (its end time ≥ the bias bar's end time).
4. At most one REJECT per day.
ATR15 = Wilder ATR(14) on 15-minute bars.

## 5-minute entry (5-minute chart), the "exact entry"
- **Rebuilding 15-minute bars on a 5-minute chart**: a 15-minute bar is complete on the 5-minute bar whose start minute
  mod 15 == 10 (for example, the 09:40 bar completes 09:30..09:44). Its high/low = max/min of that bar and the 2 before it,
  its close = that bar's close. ATR15 is computed on these rebuilt bars. The SMT bias in the 5-minute study is evaluated on
  the **rebuilt 15-minute bars** (QQQ and SPY), so it matches the 15-minute study bar for bar. PMH/PML, OR and VWAP
  are the same values on either chart. ATR5 and RSI5 = Wilder(14) on the 5-minute bars.
- **Armed** at the close of the 5-minute bar that completes the 15-minute REJECT bar. It stays armed for 60 minutes
  (12 five-minute bars); no new trigger after the 13:00 bar starts. One entry per day.
- **refExtreme**: PUT: the REJECT 15-minute bar's high. CALL: its low.
- **Running extreme since the REJECT bar began**: PUT: the lowest low LL; CALL: the highest high HH (updated every bar).

### PUT: weak bounce
- **Bounce bar** = an armed 5-minute bar with close > open **or** high > prior bar's high.
- The bounce bar is **weak** if ALL of these hold at its close:
  a) high ≤ ORL + 0.25 × ATR5 (the bounce can't reclaim the broken OR low);
  b) (high − LL) ≤ 0.5 × (refExtreme − LL), and refExtreme − LL > 0 (retraces at most half the move);
  c) RSI5 < 50;
  d) VWAP filter (input, default ON): high < VWAP.
- When a weak bounce bar closes, set **trigger = its low − 0.01**, **stop = its high + 0.05**,
  **target = trigger − 2 × (stop − trigger)**. Draw them as lines and add the bubble "WEAK BOUNCE: PUT entry below <trigger>".
- If a later bar is another bounce bar (before the trigger hits): if it's still weak, it replaces the setup (new trigger,
  stop and target from that bar); if it isn't weak (fails a–d), the setup is **cancelled for the day**.
- **Entry**: the first bar after the weak bounce bar whose low ≤ trigger -> BUY PUT. Fill price = min(open, trigger).
  Bubble: "BUY PUT @ <fill>  stop <stop>  target <target>".
### CALL: shallow pullback (mirror)
- **Pullback bar** = close < open or low < prior low. **Weak** if: low ≥ ORH − 0.25 × ATR5; (HH − low) ≤ 0.5 × (HH − refExtreme)
  with HH − refExtreme > 0; RSI5 > 50; VWAP filter: low > VWAP.
- trigger = high + 0.01, stop = low − 0.05, target = trigger + 2 × (trigger − stop). Entry when high ≥ trigger,
  fill = max(open, trigger).

### Exits (after entry; same in the study and the backtest)
- Stop or target touched (if both in the same bar, count the **stop**), or a time stop 60 minutes after entry, or the 15:50 bar
  -> SELL bubble with the reason ("SELL: target", "SELL: stop", "SELL: time", "SELL: 15:50").

## 15-minute study output (for a 15-minute chart)
Plots: PMH, PML, ORH, ORL, VWAP. Bubbles: "SMT BEAR/BULL" at the bias bar, "15m BREAK" at the break bar,
"15m REJECT: watch 5m for weak bounce (PUT)" or "...pullback (CALL)" at the REJECT bar. Labels: bias, SPY sweep status,
price vs VWAP, and a warning if the chart isn't on 15-minute bars or isn't showing extended hours.

## 5-minute study output (for a 5-minute chart)
The same plots, plus trigger/stop/target lines while a setup is armed. Bubbles: "15m REJECT", "WEAK BOUNCE / PULLBACK",
"BUY PUT/CALL @ ...", "SELL: <reason>". Labels: state (waiting for SMT / waiting for 15m reject / armed / in trade / done),
and the 0DTE contract to use (nearest strike to the fill price, same-day expiry).
Alerts: inputs to enable alerts on BUY and SELL.

## Backtest (Python reference, using 1-minute data)
- 5-minute and 15-minute bars are aggregated from the real 1-minute QQQ/SPY extended-hours bars
  (/home/user/qqq_research/data/QQQ_SPY_1min_ext.csv), aligned to clock times (:00, :05, ...; :00, :15, :30, :45) as thinkorswim does.
- Signals are computed on 5-minute and 15-minute bars exactly as above. Fills and exits use the 1-minute bars inside each
  5-minute bar: the entry is the first 1-minute bar at or after the trigger bar's start whose low ≤ trigger (PUT) or
  high ≥ trigger (CALL); stops and targets are checked minute by minute.
- Option: the ATM 0DTE contract (nearest $1 strike to the fill). Prices come from the same model and fills as smt_orb_backtest.py
  (real 1-minute prices on 2026-11-25; elsewhere Black-Scholes with IV = ratio × causal realized vol; half-spread max($0.01, 1%);
  $0.65 per contract per side). Report 1 contract and the $1,617 / 10% sizing rule; IV multiplier 0.8/1.0/1.25/1.5 and a 2x spread
  stress test; filter variants (VWAP filter on/off). Report every trade and every day's state (why no trade).

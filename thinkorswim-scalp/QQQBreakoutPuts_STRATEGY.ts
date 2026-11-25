# QQQBreakoutPuts  --  confirmed put breakouts with PUT / SELL callouts
#
# Install: Charts > Studies > Edit Studies > Strategies tab > Create...
#          paste this file, name it QQQBreakoutPuts, click OK.
# Chart:   1-HOUR bars, regular hours only, on QQQ or a liquid stock.
#
# Buy a put when ALL of these are true on a bar that started between
# startTime and endTime:
#   1. price closes below the lowest low of the previous breakoutLength bars
#   2. the bar's volume is at least volumeMultiple x its 20-bar average
#   3. price closes below the session VWAP
#   4. the wider market (confirmSymbol) also closes below its own lowest low
#      of the previous breakoutLength bars
# Enter at the open of the next bar.
#
# Sell the put when the FIRST of these happens:
#   - price has fallen targetATR x ATR from your entry   (take the profit)
#   - price has risen stopATR x ATR from your entry      (take the loss)
#   - maxBars bars have passed, or it is the flatTime bar (time is up)
#
# Contract used in the backtest: a put about 5 trading days from expiry,
# nearest the money, costing $4.00 or less.
#
# confirmSymbol: SPY for QQQ and for stocks. Use QQQ if the chart is SPY.
#
# thinkorswim strategies simulate trades on the chart symbol, not on options,
# so the put is drawn as a short sale of the stock. Results and limits of the
# option backtest are in README.md. This script has not been compiled in
# thinkorswim by its author.

input confirmSymbol = "SPY";
input breakoutLength = 30;    # bars in the "new low" test
input volumeMultiple = 1.0;   # bar volume against its 20-bar average
input targetATR = 0.5;        # profit target, in ATRs of the chart
input stopATR = 1.5;          # stop, in ATRs of the chart
input maxBars = 4;            # sell after this many bars at the latest
input startTime = 1030;       # first bar allowed to signal (US/Eastern)
input endTime = 1330;         # last bar allowed to signal
input flatTime = 1430;        # sell anything still open on this bar
input atrLength = 14;
input tradeSize = 100;        # shares shown in the strategy report
input showBubbles = yes;
input showLevels = yes;
input useAlerts = yes;

# ---------------------------------------------------------------- indicators
def rth = SecondsFromTime(0930) >= 0 and SecondsTillTime(1600) > 0;
def newSession = rth and (!rth[1] or GetYYYYMMDD() != GetYYYYMMDD()[1]);
def cumVolume = if newSession then volume else if rth then cumVolume[1] + volume else cumVolume[1];
def cumPV = if newSession then volume * hlc3 else if rth then cumPV[1] + volume * hlc3 else cumPV[1];
def sessionVWAP = if cumVolume > 0 then cumPV / cumVolume else close;

def atrValue = WildersAverage(TrueRange(high, close, low), atrLength);
def volAvg = Average(volume[1], 20);
def priorLow = Lowest(low[1], breakoutLength);

def confirmClose = close(symbol = confirmSymbol);
def confirmPriorLow = Lowest(low(symbol = confirmSymbol)[1], breakoutLength);
def marketBreakDown = confirmClose < confirmPriorLow;

def inWindow = SecondsFromTime(startTime) >= 0 and SecondsTillTime(endTime) >= 0;
def flatBar = SecondsFromTime(flatTime) >= 0 or !rth;

# -------------------------------------------------------------------- signal
def putSetup = inWindow
    and close < priorLow
    and volume >= volumeMultiple * volAvg
    and close < sessionVWAP
    and marketBreakDown;

# ------------------------------------------------------------- position state
# inPut: 1 while holding the put, measured after the current bar has finished.
def inPut;
def tradeEntry;
def entryATR;
def barsHeld;

def enterPut = putSetup[1] and inPut[1] == 0 and rth;
def holdPut = enterPut or inPut[1] == 1;

tradeEntry = if enterPut then open else if inPut[1] == 1 then tradeEntry[1] else 0;
entryATR = if enterPut then atrValue[1] else if inPut[1] == 1 then entryATR[1] else 0;
barsHeld = if enterPut then 1 else if inPut[1] == 1 then barsHeld[1] + 1 else 0;

def putTarget = tradeEntry - targetATR * entryATR;
def putStop = tradeEntry + stopATR * entryATR;

# If a bar touches both levels the stop is assumed to have filled first.
def stopHit = holdPut and high >= putStop;
def targetHit = holdPut and !stopHit and low <= putTarget;
def timeExit = holdPut and !stopHit and !targetHit and (barsHeld >= maxBars or flatBar);
def putExit = stopHit or targetHit or timeExit;

inPut = if holdPut and !putExit then 1 else 0;

def putSignal = putSetup and inPut == 0;

# -------------------------------------------------------------------- orders
# thinkorswim draws each order on the bar after its condition is true.
AddOrder(OrderType.SELL_TO_OPEN, putSignal, open[-1], tradeSize, Color.RED, Color.RED, "PUT");
AddOrder(OrderType.BUY_TO_CLOSE, stopHit, Max(open, putStop), tradeSize, Color.RED, Color.RED, "Stop");
AddOrder(OrderType.BUY_TO_CLOSE, targetHit, Min(open, putTarget), tradeSize, Color.GREEN, Color.GREEN, "Target");
AddOrder(OrderType.BUY_TO_CLOSE, timeExit, close, tradeSize, Color.GRAY, Color.GRAY, "Time exit");

# ------------------------------------------------------------------ callouts
AddChartBubble(showBubbles and putSignal, high, "BUY PUT", Color.RED, yes);
AddChartBubble(showBubbles and putExit, low,
    if targetHit then "SELL PUT (target)" else if stopHit then "SELL PUT (stop)" else "SELL PUT (time)",
    Color.YELLOW, no);

# Yellow label: only on a bar where the put should be sold.
AddLabel(putExit,
    if targetHit then "SELL PUT NOW  (target hit)"
    else if stopHit then "SELL PUT NOW  (stop hit)"
    else "SELL PUT at the close of this bar  (time limit)",
    Color.YELLOW);

# Status label: always shown.
AddLabel(yes,
    if putSignal then "BUY PUT  (enter next bar)"
    else if inPut == 1 then "IN PUT - HOLD   sell if price falls to " + Round(putTarget, 2)
        + " or rises to " + Round(putStop, 2) + "   bars left: " + (maxBars - barsHeld)
    else if putExit then "NO POSITION after this sale"
    else if !inWindow then "NO TRADE  (outside trading window)"
    else "NO TRADE  (waiting for setup)",
    if putSignal or inPut == 1 then Color.RED else Color.GRAY);

AddLabel(yes,
    confirmSymbol + (if marketBreakDown then ": breaking down" else ": not breaking down"),
    if marketBreakDown then Color.DARK_RED else Color.DARK_GRAY);

# --------------------------------------------------------------------- plots
plot VWAPLine = sessionVWAP;
VWAPLine.SetDefaultColor(Color.YELLOW);
VWAPLine.SetLineWeight(2);

plot BreakoutLow = priorLow;
BreakoutLow.SetDefaultColor(Color.MAGENTA);
BreakoutLow.SetStyle(Curve.SHORT_DASH);

plot TargetLevel = if showLevels and inPut == 1 then putTarget else Double.NaN;
TargetLevel.SetDefaultColor(Color.GREEN);
TargetLevel.SetPaintingStrategy(PaintingStrategy.HORIZONTAL);

plot StopLevel = if showLevels and inPut == 1 then putStop else Double.NaN;
StopLevel.SetDefaultColor(Color.RED);
StopLevel.SetPaintingStrategy(PaintingStrategy.HORIZONTAL);

Alert(useAlerts and putSignal, "QQQBreakoutPuts: BUY PUT", Alert.BAR, Sound.Ding);
Alert(useAlerts and putExit, "QQQBreakoutPuts: SELL PUT", Alert.BAR, Sound.Bell);

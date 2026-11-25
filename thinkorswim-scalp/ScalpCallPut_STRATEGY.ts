# ScalpCallPut  --  VWAP / EMA pullback scalp with CALL / PUT callouts
#
# Install: Charts > Studies > Edit Studies > Strategies tab > Create...
#          paste this file, name it ScalpCallPut, click OK.
# Chart:   5-minute bars, regular hours, on a liquid underlying (SPY, QQQ, IWM).
#
# What it does
#   CALL when price is above session VWAP, EMA(9) is above EMA(21), the bar
#        dipped to the EMA(9) and closed back above it as a green bar.
#   PUT  is the mirror image below VWAP.
#   A bubble marks every signal bar, and the label in the top-left corner says
#   what to do right now. Entry is the open of the next bar.
#   Exit: profit target and stop measured in ATR, a bar-count time stop, and a
#   hard flatten before the close.
#
# thinkorswim strategies simulate trades on the chart symbol, not on options.
# The orders below therefore show the underlying move; the option to buy is the
# one named in the bubble (same-day or nearest expiry). See README.md for the
# option backtest and its results.

input startTime = 0945;      # first bar allowed to signal (US/Eastern)
input endTime = 1500;        # last bar allowed to signal
input flatTime = 1550;       # close anything still open on this bar
input fastLength = 9;
input slowLength = 21;
input atrLength = 14;
input targetATR = 0.5;       # profit target, in ATRs of the underlying
input stopATR = 2.0;         # stop, in ATRs of the underlying
input maxBars = 6;           # time stop, in bars
input tradeSize = 100;       # shares shown in the strategy report
input showBubbles = yes;
input showLevels = yes;
input useAlerts = yes;

# ---------------------------------------------------------------- indicators
def rth = SecondsFromTime(0930) >= 0 and SecondsTillTime(1600) > 0;
def newSession = rth and (!rth[1] or GetYYYYMMDD() != GetYYYYMMDD()[1]);
def cumVolume = if newSession then volume else if rth then cumVolume[1] + volume else cumVolume[1];
def cumPV = if newSession then volume * hlc3 else if rth then cumPV[1] + volume * hlc3 else cumPV[1];
def sessionVWAP = if cumVolume > 0 then cumPV / cumVolume else close;

def emaFast = ExpAverage(close, fastLength);
def emaSlow = ExpAverage(close, slowLength);
def atrValue = WildersAverage(TrueRange(high, close, low), atrLength);

def inWindow = SecondsFromTime(startTime) >= 0 and SecondsTillTime(endTime) >= 0;
def flatBar = SecondsFromTime(flatTime) >= 0 or !rth;

# ------------------------------------------------------------------- signals
def trendUp = close > sessionVWAP and emaFast > emaSlow;
def trendDown = close < sessionVWAP and emaFast < emaSlow;
def callSetup = inWindow and trendUp and low <= emaFast and close > emaFast and close > open;
def putSetup = inWindow and trendDown and high >= emaFast and close < emaFast and close < open;

# ------------------------------------------------------------- position state
# position:  1 = holding the call side, -1 = holding the put side, 0 = flat,
#            measured after the current bar has finished.
def position;
def tradeEntry;
def entryATR;
def barsHeld;

def enterCall = callSetup[1] and position[1] == 0 and rth;
def enterPut = putSetup[1] and position[1] == 0 and rth;
def holdCall = enterCall or position[1] == 1;
def holdPut = enterPut or position[1] == -1;

tradeEntry = if enterCall or enterPut then open else if position[1] != 0 then tradeEntry[1] else 0;
entryATR = if enterCall or enterPut then atrValue[1] else if position[1] != 0 then entryATR[1] else 0;
barsHeld = if enterCall or enterPut then 1 else if position[1] != 0 then barsHeld[1] + 1 else 0;

def callTarget = tradeEntry + targetATR * entryATR;
def callStop = tradeEntry - stopATR * entryATR;
def putTarget = tradeEntry - targetATR * entryATR;
def putStop = tradeEntry + stopATR * entryATR;

# If a bar touches both levels the stop is assumed to have filled first.
def callStopHit = holdCall and low <= callStop;
def callTargetHit = holdCall and !callStopHit and high >= callTarget;
def callTimeExit = holdCall and !callStopHit and !callTargetHit and (barsHeld >= maxBars or flatBar);
def putStopHit = holdPut and high >= putStop;
def putTargetHit = holdPut and !putStopHit and low <= putTarget;
def putTimeExit = holdPut and !putStopHit and !putTargetHit and (barsHeld >= maxBars or flatBar);

def callExit = callStopHit or callTargetHit or callTimeExit;
def putExit = putStopHit or putTargetHit or putTimeExit;

position = if holdCall and !callExit then 1 else if holdPut and !putExit then -1 else 0;

def callSignal = callSetup and position == 0;
def putSignal = putSetup and position == 0;

# -------------------------------------------------------------------- orders
# The put side is drawn as a short sale of the underlying, because a strategy
# cannot hold an option. thinkorswim draws each order on the bar after its
# condition is true, at the price given here.
AddOrder(OrderType.BUY_TO_OPEN, callSignal, open[-1], tradeSize, Color.GREEN, Color.GREEN, "CALL");
AddOrder(OrderType.SELL_TO_CLOSE, callStopHit, Min(open, callStop), tradeSize, Color.RED, Color.RED, "Call stop");
AddOrder(OrderType.SELL_TO_CLOSE, callTargetHit, Max(open, callTarget), tradeSize, Color.GREEN, Color.GREEN, "Call target");
AddOrder(OrderType.SELL_TO_CLOSE, callTimeExit, close, tradeSize, Color.GRAY, Color.GRAY, "Call time exit");

AddOrder(OrderType.SELL_TO_OPEN, putSignal, open[-1], tradeSize, Color.RED, Color.RED, "PUT");
AddOrder(OrderType.BUY_TO_CLOSE, putStopHit, Max(open, putStop), tradeSize, Color.RED, Color.RED, "Put stop");
AddOrder(OrderType.BUY_TO_CLOSE, putTargetHit, Min(open, putTarget), tradeSize, Color.GREEN, Color.GREEN, "Put target");
AddOrder(OrderType.BUY_TO_CLOSE, putTimeExit, close, tradeSize, Color.GRAY, Color.GRAY, "Put time exit");

# ------------------------------------------------------------------ callouts
AddChartBubble(showBubbles and callSignal, low, "CALL", Color.GREEN, no);
AddChartBubble(showBubbles and putSignal, high, "PUT", Color.RED, yes);

AddLabel(yes,
    if callSignal then "BUY CALL  (enter next bar)"
    else if putSignal then "BUY PUT  (enter next bar)"
    else if position == 1 then "IN CALL  target " + Round(callTarget, 2) + "  stop " + Round(callStop, 2)
    else if position == -1 then "IN PUT  target " + Round(putTarget, 2) + "  stop " + Round(putStop, 2)
    else if !inWindow then "NO TRADE  (outside trading window)"
    else "NO TRADE  (waiting for setup)",
    if callSignal or position == 1 then Color.GREEN
    else if putSignal or position == -1 then Color.RED
    else Color.GRAY);

AddLabel(yes,
    "Trend: " + (if trendUp then "UP - calls only" else if trendDown then "DOWN - puts only" else "MIXED - stand aside"),
    if trendUp then Color.DARK_GREEN else if trendDown then Color.DARK_RED else Color.DARK_GRAY);

# --------------------------------------------------------------------- plots
plot VWAPLine = sessionVWAP;
VWAPLine.SetDefaultColor(Color.YELLOW);
VWAPLine.SetLineWeight(2);

plot FastEMA = emaFast;
FastEMA.SetDefaultColor(Color.CYAN);

plot SlowEMA = emaSlow;
SlowEMA.SetDefaultColor(Color.MAGENTA);

plot TargetLevel = if showLevels and position == 1 then callTarget else if showLevels and position == -1 then putTarget else Double.NaN;
TargetLevel.SetDefaultColor(Color.GREEN);
TargetLevel.SetPaintingStrategy(PaintingStrategy.HORIZONTAL);

plot StopLevel = if showLevels and position == 1 then callStop else if showLevels and position == -1 then putStop else Double.NaN;
StopLevel.SetDefaultColor(Color.RED);
StopLevel.SetPaintingStrategy(PaintingStrategy.HORIZONTAL);

Alert(useAlerts and callSignal, "ScalpCallPut: BUY CALL", Alert.BAR, Sound.Ding);
Alert(useAlerts and putSignal, "ScalpCallPut: BUY PUT", Alert.BAR, Sound.Ding);

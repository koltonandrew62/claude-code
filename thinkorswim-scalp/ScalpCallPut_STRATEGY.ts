# ScalpCallPut  --  1-minute options scalp with CALL / PUT callouts
#
# Install: Charts > Studies > Edit Studies > Strategies tab > Create...
#          paste this file, name it ScalpCallPut, click OK.
# Chart:   1-minute bars, regular hours, on a liquid underlying (SPY, QQQ, IWM).
#
# What it does
#   Pick one of eight entry rules with the "rule" input. Each rule marks a
#   CALL or a PUT. A bubble marks every signal bar, and the label in the
#   top-left corner says what to do right now. Entry is the open of the next
#   bar. The trade is closed at the target, at the stop, or after maxBars
#   one-minute bars, whichever comes first.
#
#   Pullback    with the trend, dip to EMA(9) and close back through it
#   Burst       wide high-volume bar closing near its extreme, on the VWAP side
#   Breakout    close beyond the 30-bar high/low on 1.5x volume, on the VWAP side
#   PowerHour   the Breakout rule, 15:00 onward only
#   ORB         first close outside the 9:30-9:45 range, before 11:30
#   BandFade    close back inside a 2.5 SD band after closing outside it
#   RSI2        with the trend, RSI(2) washout then a bar back in the trend's favour
#   Exhaustion  fade three straight bars that travelled at least 2.5 ATR
#
# None of these rules was profitable in the option backtest. See README.md.
#
# thinkorswim strategies simulate trades on the chart symbol, not on options.
# The orders below therefore show the underlying move; the option to buy is the
# one named in the bubble (same-day expiry).

input rule = {default Breakout, Pullback, Burst, PowerHour, ORB, BandFade, RSI2, Exhaustion};
input startTime = 0935;      # first bar allowed to signal (US/Eastern)
input endTime = 1550;        # last bar allowed to signal
input flatTime = 1555;       # close anything still open on this bar
input fastLength = 9;
input slowLength = 21;
input atrLength = 14;
input targetATR = 2.0;       # profit target, in ATRs of the underlying
input stopATR = 1.0;         # stop, in ATRs of the underlying
input maxBars = 5;           # time stop, in bars (3 to 5 for this scalp)
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

def barRange = high - low;
def barPos = if barRange > 0 then (close - low) / barRange else 0.5;
def volAvg = Average(volume[1], 20);
def highVolume = volume >= 1.5 * volAvg;
def priorHigh = Highest(high[1], 30);
def priorLow = Lowest(low[1], 30);
def bandMid = Average(close, 20);
def bandSD = StDev(close, 20);
def upperBand = bandMid + 2.5 * bandSD;
def lowerBand = bandMid - 2.5 * bandSD;
def rsiFast = RSI(length = 2);
def inOpeningRange = SecondsFromTime(0930) >= 0 and SecondsTillTime(0945) > 0;
def orHigh = if newSession then high else if inOpeningRange then Max(orHigh[1], high) else orHigh[1];
def orLow = if newSession then low else if inOpeningRange then Min(orLow[1], low) else orLow[1];
def orbWindow = SecondsFromTime(0945) >= 0 and SecondsTillTime(1130) >= 0;
def lastHour = SecondsFromTime(1500) >= 0;
def redBar = close < open;
def greenBar = close > open;
def threeBarDrop = open[2] - close;

def callRule;
def putRule;
switch (rule) {
case Pullback:
    callRule = trendUp and low <= emaFast and close > emaFast and greenBar;
    putRule = trendDown and high >= emaFast and close < emaFast and redBar;
case Burst:
    callRule = barRange >= 1.5 * atrValue[1] and highVolume and barPos >= 0.75 and greenBar and close > sessionVWAP;
    putRule = barRange >= 1.5 * atrValue[1] and highVolume and barPos <= 0.25 and redBar and close < sessionVWAP;
case Breakout:
    callRule = highVolume and close > priorHigh and close > sessionVWAP;
    putRule = highVolume and close < priorLow and close < sessionVWAP;
case PowerHour:
    callRule = lastHour and highVolume and close > priorHigh and close > sessionVWAP;
    putRule = lastHour and highVolume and close < priorLow and close < sessionVWAP;
case ORB:
    callRule = orbWindow and volume >= volAvg and close > orHigh and close[1] <= orHigh;
    putRule = orbWindow and volume >= volAvg and close < orLow and close[1] >= orLow;
case BandFade:
    callRule = close[1] < lowerBand[1] and close > lowerBand and greenBar;
    putRule = close[1] > upperBand[1] and close < upperBand and redBar;
case RSI2:
    callRule = trendUp and rsiFast[1] < 10 and greenBar;
    putRule = trendDown and rsiFast[1] > 90 and redBar;
case Exhaustion:
    callRule = redBar and redBar[1] and redBar[2] and threeBarDrop >= 2.5 * atrValue[3];
    putRule = greenBar and greenBar[1] and greenBar[2] and -threeBarDrop >= 2.5 * atrValue[3];
}

def callSetup = inWindow and callRule;
def putSetup = inWindow and putRule;

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
    "Trend: " + (if trendUp then "UP" else if trendDown then "DOWN" else "MIXED"),
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

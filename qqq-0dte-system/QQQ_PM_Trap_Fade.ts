# QQQ Pre-Market High/Low TRAP FADE  (15-minute rejection candle + optional 5-minute weak-bounce entry)
# -----------------------------------------------------------------------------------------------
# Use on QQQ with EXTENDED HOURS ON.  Built for 30D:15m and 30D:5m charts.
# All times are US Eastern: thinkorswim's SecondsFromTime/SecondsTillTime use Eastern time.
#
# Setup (your example trade):
#  1. Pre-market high (PMH) / low (PML) = today's 04:00-09:29 ET high / low.  VWAP resets at the 09:30 open (RTH bars only).
#  2. A 15-minute candle (starting 09:30 .. lastCandleStart) sweeps the PMH (high > PMH) and CLOSES BACK BELOW it with a long upper
#     wick -> trap -> PUT.  Mirror at the PML -> CALL.
#  3. Confirmation filters (each can be turned off):
#       - $TICK weak: the candle's highest $TICK stayed below +tickThreshold (PUT) / lowest stayed above -tickThreshold (CALL)
#       - SMT: SPY did NOT take its own PMH (PUT) / PML (CALL) during the session so far
#       - Volume (off by default): the sweep candle's volume was below the previous 15-minute candle's
#  4. Entry: at the rejection candle's close (default), or on a 5-minute chart, entryMode = WeakBounce5m waits for a weak bounce
#     (PUT) / shallow pullback (CALL) and gives the exact trigger price.
#  5. Bracket on the QQQ chart: stop = the sweep wick high (PUT) / low (CALL); T1 = VWAP; T2 = PML (PUT) / PMH (CALL).
#     After T1, the stop moves to breakeven (input).  Time exit at exitTime (15:50).  One trade per day.
# Option: the study can't see option prices; the label suggests the ATM strike (nearest $1) and your DTE choice.
# Research tool only.  The 31-day backtest of a similar setup used modeled option prices.  Not a guarantee.

declare upper;

input showPastDays = yes;
input useTickFilter = yes;
input tickSymbol = "$TICK";
input tickThreshold = 800;
input useSmtFilter = yes;
input smtSymbol = "SPY";
input useVolumeFilter = no;
input minWickPct = 0.35;
input lastCandleStart = 1115;
input entryMode = {default AtRejectionClose, WeakBounce5m};
input moveStopToBreakevenAtT1 = yes;
input exitTime = 1550;
input optionDte = 7;
input showDailyEma20 = no;
input alertsOn = yes;

# ---------- chart / session (Eastern time) ----------
def zAgg = GetAggregationPeriod();
def is15 = zAgg == AggregationPeriod.FIFTEEN_MIN;
def is5 = zAgg == AggregationPeriod.FIVE_MIN;

def zYmd = GetYYYYMMDD();
def newDay = IsNaN(zYmd[1]) or zYmd != zYmd[1];
def isPre = SecondsFromTime(0400) >= 0 and SecondsTillTime(0930) > 0;
def isRth = SecondsFromTime(0930) >= 0 and SecondsTillTime(1600) > 0;
def firstRth = isRth and (newDay or !isRth[1]);
def showBar = showPastDays or GetDay() == GetLastDay();
def sawPre = if newDay then isPre else (sawPre[1] or isPre);

# ---------- pre-market high / low: today's 04:00-09:29 only, reset every new day, never yesterday's ----------
def pmHi = if newDay then (if isPre then high else Double.NaN)
    else if isPre then (if IsNaN(pmHi[1]) then high else Max(pmHi[1], high))
    else pmHi[1];
def pmLo = if newDay then (if isPre then low else Double.NaN)
    else if isPre then (if IsNaN(pmLo[1]) then low else Min(pmLo[1], low))
    else pmLo[1];

# ---------- SPY (SMT) pre-market and regular-session extremes ----------
def sHi = high(smtSymbol);
def sLo = low(smtSymbol);
def spyPmHi = if newDay then (if isPre and !IsNaN(sHi) then sHi else Double.NaN)
    else if isPre and !IsNaN(sHi) then (if IsNaN(spyPmHi[1]) then sHi else Max(spyPmHi[1], sHi))
    else spyPmHi[1];
def spyPmLo = if newDay then (if isPre and !IsNaN(sLo) then sLo else Double.NaN)
    else if isPre and !IsNaN(sLo) then (if IsNaN(spyPmLo[1]) then sLo else Min(spyPmLo[1], sLo))
    else spyPmLo[1];
def spyRthHi = if newDay or firstRth then (if isRth and !IsNaN(sHi) then sHi else Double.NaN)
    else if isRth and !IsNaN(sHi) then (if IsNaN(spyRthHi[1]) then sHi else Max(spyRthHi[1], sHi))
    else spyRthHi[1];
def spyRthLo = if newDay or firstRth then (if isRth and !IsNaN(sLo) then sLo else Double.NaN)
    else if isRth and !IsNaN(sLo) then (if IsNaN(spyRthLo[1]) then sLo else Min(spyRthLo[1], sLo))
    else spyRthLo[1];

# ---------- $TICK ----------
def tkHi = high(tickSymbol);
def tkLo = low(tickSymbol);

# ---------- session VWAP: resets at the 09:30 open, regular-session bars only ----------
def zTp = (high + low + close) / 3;
def cumPV = if firstRth then zTp * volume else if isRth then cumPV[1] + zTp * volume else 0;
def cumVol = if firstRth then volume else if isRth then cumVol[1] + volume else 0;
def sVwap = if isRth and cumVol > 0 then cumPV / cumVol else Double.NaN;

# ---------- the 15-minute candle (the chart bar on 15m; rebuilt from three 5-minute bars on 5m) ----------
def m930 = SecondsFromTime(0930) / 60;
def mod15 = m930 - Floor(m930 / 15) * 15;
def candleDone = isRth and (is15 or (is5 and mod15 == 10));
def cHi = if is15 then high else Max(high, Max(high[1], high[2]));
def cLo = if is15 then low else Min(low, Min(low[1], low[2]));
def cOp = if is15 then open else open[2];
def cCl = close;
def cVol = if is15 then volume else volume + volume[1] + volume[2];
def cVolPrev = if is15 then volume[1] else volume[3] + volume[4] + volume[5];
def cTkHi = if is15 then tkHi else Max(tkHi, Max(tkHi[1], tkHi[2]));
def cTkLo = if is15 then tkLo else Min(tkLo, Min(tkLo[1], tkLo[2]));
def cStartMin = if is15 then m930 else m930 - 10;
def lcsMin = Floor(lastCandleStart / 100) * 60 + (lastCandleStart - Floor(lastCandleStart / 100) * 100) - 570;
def inWindow = cStartMin >= 0 and cStartMin <= lcsMin;
def cRange = cHi - cLo;

def volOk = !useVolumeFilter or cStartMin < 15 or cVol < cVolPrev;
def wickPut = cRange > 0 and (cHi - Max(cOp, cCl)) >= minWickPct * cRange;
def wickCall = cRange > 0 and (Min(cOp, cCl) - cLo) >= minWickPct * cRange;
def tickPut = !useTickFilter or IsNaN(cTkHi) or cTkHi < tickThreshold;
def tickCall = !useTickFilter or IsNaN(cTkLo) or cTkLo > -tickThreshold;
def smtPut = !useSmtFilter or (!IsNaN(spyPmHi) and !IsNaN(spyRthHi) and spyRthHi <= spyPmHi);
def smtCall = !useSmtFilter or (!IsNaN(spyPmLo) and !IsNaN(spyRthLo) and spyRthLo >= spyPmLo);

def putRej = candleDone and inWindow and !IsNaN(pmHi) and cHi > pmHi and cCl < pmHi and wickPut and tickPut and smtPut and volOk;
def callRej = candleDone and inWindow and !IsNaN(pmLo) and cLo < pmLo and cCl > pmLo and wickCall and tickCall and smtCall and volOk;

# first rejection of the day only
def rejDir = if newDay then 0 else if rejDir[1] == 0 and putRej then -1 else if rejDir[1] == 0 and callRej then 1 else rejDir[1];
def rejBar = rejDir != 0 and rejDir[1] == 0;
def rejHi = if newDay then Double.NaN else if rejBar then cHi else rejHi[1];
def rejLo = if newDay then Double.NaN else if rejBar then cLo else rejLo[1];

# ---------- optional 5-minute weak bounce / pullback entry ----------
def useBounce = entryMode == entryMode.WeakBounce5m and is5;
def rsiV = RSI(length = 14);
def barsSinceRej = if newDay then 0 else if rejBar then 0 else barsSinceRej[1] + 1;
def cancelB = (rejDir == -1 and high >= rejHi) or (rejDir == 1 and low <= rejLo);
# zTrig: NaN = not armed, 0 = armed (waiting for a weak bounce/pullback), > 0 = the entry trigger price
def zTrig = if newDay then Double.NaN
    else if rejBar and useBounce then 0
    else if IsNaN(zTrig[1]) then Double.NaN
    else if cancelB or barsSinceRej > 12 then Double.NaN
    else if zTrig[1] > 0 and ((rejDir == -1 and low <= zTrig[1]) or (rejDir == 1 and high >= zTrig[1])) then Double.NaN
    else if rejDir == -1 and (close > open or high > high[1]) and high < pmHi and high < rejHi and rsiV < 50 then low - 0.01
    else if rejDir == 1 and (close < open or low < low[1]) and low > pmLo and low > rejLo and rsiV > 50 then high + 0.01
    else zTrig[1];
def zArmed = if IsNaN(zTrig) then 0 else 1;
def weakB = !IsNaN(zTrig) and zTrig > 0 and (IsNaN(zTrig[1]) or zTrig != zTrig[1]);
def bounceEntry = !IsNaN(zTrig[1]) and zTrig[1] > 0 and !cancelB and barsSinceRej <= 12 and
    ((rejDir == -1 and low <= zTrig[1]) or (rejDir == 1 and high >= zTrig[1]));

# ---------- trade ----------
def entryBar = if useBounce then bounceEntry else rejBar;
def entPx = if newDay then Double.NaN
    else if entryBar then (if useBounce then (if rejDir == -1 then Min(open, zTrig[1]) else Max(open, zTrig[1])) else close)
    else entPx[1];
def stopInit = if newDay then Double.NaN else if entryBar then (if rejDir == -1 then rejHi else rejLo) else stopInit[1];
def t1Lv = if newDay then Double.NaN
    else if entryBar then (if rejDir == -1 and sVwap < entPx then sVwap else if rejDir == 1 and sVwap > entPx then sVwap else Double.NaN)
    else t1Lv[1];
def t2Lv = if newDay then Double.NaN else if entryBar then (if rejDir == -1 then pmLo else pmHi) else t2Lv[1];
def zTimeUp = SecondsFromTime(exitTime) >= 0 or (is15 and SecondsFromTime(1545) >= 0);

# phase: 0 = no trade yet, 1 = in trade, 2 = in trade after T1, 3 = done for the day
def zPhase = if newDay then 0
    else if entryBar then 1
    else if zPhase[1] == 1 or zPhase[1] == 2 then
        (if (rejDir == -1 and high >= (if moveStopToBreakevenAtT1 and zPhase[1] == 2 then entPx else stopInit)) or
            (rejDir == 1 and low <= (if moveStopToBreakevenAtT1 and zPhase[1] == 2 then entPx else stopInit)) then 3
         else if (rejDir == -1 and low <= t2Lv) or (rejDir == 1 and high >= t2Lv) then 3
         else if zTimeUp then 3
         else if zPhase[1] == 1 and !IsNaN(t1Lv) and ((rejDir == -1 and low <= t1Lv) or (rejDir == 1 and high >= t1Lv)) then 2
         else zPhase[1])
    else zPhase[1];
def stopNow = if moveStopToBreakevenAtT1 and zPhase[1] == 2 then entPx else stopInit;
def exitBar = zPhase == 3 and (zPhase[1] == 1 or zPhase[1] == 2);
def exitStop = exitBar and ((rejDir == -1 and high >= stopNow) or (rejDir == 1 and low <= stopNow));
def exitT2 = exitBar and !exitStop and ((rejDir == -1 and low <= t2Lv) or (rejDir == 1 and high >= t2Lv));
def exitClock = exitBar and !exitStop and !exitT2;
def t1Bar = zPhase == 2 and zPhase[1] == 1;
def inTradeNow = zPhase == 1 or zPhase == 2;

# ---------- plots (each line only on its own day; nothing after 16:00) ----------
plot zPMH = if showBar and (isPre or isRth) then pmHi else Double.NaN;
zPMH.SetDefaultColor(Color.CYAN);
zPMH.SetPaintingStrategy(PaintingStrategy.HORIZONTAL);
zPMH.SetLineWeight(2);

plot zPML = if showBar and (isPre or isRth) then pmLo else Double.NaN;
zPML.SetDefaultColor(Color.MAGENTA);
zPML.SetPaintingStrategy(PaintingStrategy.HORIZONTAL);
zPML.SetLineWeight(2);

plot zVWAP = if showBar then sVwap else Double.NaN;
zVWAP.SetDefaultColor(Color.ORANGE);
zVWAP.SetLineWeight(2);

plot zEma20D = if showDailyEma20 and showBar and (isPre or isRth) then ExpAverage(close(period = AggregationPeriod.DAY), 20) else Double.NaN;
zEma20D.SetDefaultColor(Color.GRAY);

plot zStop = if showBar and (inTradeNow or exitBar) then stopNow else Double.NaN;
zStop.SetDefaultColor(Color.RED);
zStop.SetPaintingStrategy(PaintingStrategy.DASHES);

plot zT1 = if showBar and (inTradeNow or exitBar) then t1Lv else Double.NaN;
zT1.SetDefaultColor(Color.GREEN);
zT1.SetPaintingStrategy(PaintingStrategy.DASHES);

plot zT2 = if showBar and (inTradeNow or exitBar) then t2Lv else Double.NaN;
zT2.SetDefaultColor(Color.DARK_GREEN);
zT2.SetPaintingStrategy(PaintingStrategy.DASHES);

plot zTrigLine = if showBar and zArmed == 1 then zTrig else Double.NaN;
zTrigLine.SetDefaultColor(Color.YELLOW);
zTrigLine.SetPaintingStrategy(PaintingStrategy.DASHES);

# ---------- bubbles ----------
AddChartBubble(showBar and rejBar and rejDir == -1, cHi,
    "15m TRAP at PMH " + AsDollars(pmHi) + (if useBounce then ": wait for 5m weak bounce" else ": BUY PUT"), Color.RED, yes);
AddChartBubble(showBar and rejBar and rejDir == 1, cLo,
    "15m TRAP at PML " + AsDollars(pmLo) + (if useBounce then ": wait for 5m pullback" else ": BUY CALL"), Color.GREEN, no);

AddChartBubble(showBar and weakB and rejDir == -1, high, "WEAK BOUNCE: PUT entry below " + AsDollars(zTrig), Color.YELLOW, yes);
AddChartBubble(showBar and weakB and rejDir == 1, low, "PULLBACK: CALL entry above " + AsDollars(zTrig), Color.YELLOW, no);

AddChartBubble(showBar and entryBar and rejDir == -1, high,
    "BUY PUT @ " + AsDollars(entPx) + " | " + optionDte + "DTE strike " + Round(entPx, 0) +
    " | stop " + AsDollars(stopInit) + " | T1 VWAP " + AsDollars(t1Lv) + " | T2 PML " + AsDollars(t2Lv), Color.RED, yes);
AddChartBubble(showBar and entryBar and rejDir == 1, low,
    "BUY CALL @ " + AsDollars(entPx) + " | " + optionDte + "DTE strike " + Round(entPx, 0) +
    " | stop " + AsDollars(stopInit) + " | T1 VWAP " + AsDollars(t1Lv) + " | T2 PMH " + AsDollars(t2Lv), Color.GREEN, no);

AddChartBubble(showBar and t1Bar and rejDir == -1, low,
    "T1 VWAP hit: take profit" + (if moveStopToBreakevenAtT1 then ", stop to breakeven" else ""), Color.LIGHT_GREEN, no);
AddChartBubble(showBar and t1Bar and rejDir == 1, high,
    "T1 VWAP hit: take profit" + (if moveStopToBreakevenAtT1 then ", stop to breakeven" else ""), Color.LIGHT_GREEN, yes);
AddChartBubble(showBar and exitStop and rejDir == -1, high, "SELL PUT: stop hit", Color.RED, yes);
AddChartBubble(showBar and exitStop and rejDir == 1, low, "SELL CALL: stop hit", Color.RED, no);
AddChartBubble(showBar and exitT2 and rejDir == -1, low, "SELL PUT: T2 PML hit", Color.GREEN, no);
AddChartBubble(showBar and exitT2 and rejDir == 1, high, "SELL CALL: T2 PMH hit", Color.GREEN, yes);
AddChartBubble(showBar and exitClock, close, "SELL: time exit", Color.GRAY, yes);

# ---------- labels ----------
AddLabel(!is5 and !is15, "Set the chart to 5m or 15m bars", Color.RED);
AddLabel(!sawPre, "Turn ON extended-hours trading session (PMH/PML need pre-market)", Color.RED);
AddLabel(yes, "PMH " + AsDollars(pmHi) + "   PML " + AsDollars(pmLo) + "   VWAP " + AsDollars(sVwap), Color.WHITE);
AddLabel(useSmtFilter, "SPY took PMH: " + (if spyRthHi > spyPmHi then "YES" else "no") + "  PML: " + (if spyRthLo < spyPmLo then "YES" else "no"), Color.GRAY);
AddLabel(useTickFilter, "TICK hi " + Round(tkHi, 0) + "  lo " + Round(tkLo, 0) + "  (weak if < " + tickThreshold + ")", Color.GRAY);
AddLabel(yes,
    if inTradeNow then (if rejDir == -1 then "IN PUT: stop " else "IN CALL: stop ") + AsDollars(stopNow) + "  T1 " + AsDollars(t1Lv) + "  T2 " + AsDollars(t2Lv)
    else if zPhase == 3 then "Done for today"
    else if zArmed == 1 then "15m trap confirmed: waiting for 5m trigger"
    else "Waiting for a PMH/PML trap",
    if inTradeNow then Color.YELLOW else Color.GRAY);

# ---------- alerts ----------
Alert(alertsOn and entryBar and rejDir == -1, "QQQ PMH trap: BUY PUT", Alert.BAR, Sound.Ding);
Alert(alertsOn and entryBar and rejDir == 1, "QQQ PML trap: BUY CALL", Alert.BAR, Sound.Ding);
Alert(alertsOn and exitBar, "QQQ trap trade: SELL", Alert.BAR, Sound.Bell);

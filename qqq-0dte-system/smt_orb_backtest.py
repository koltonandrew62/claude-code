"""
QQQ 0DTE backtest: pre-market high/low fade + SMT divergence (QQQ vs SPY) + 15-min opening-range break & retest.
1-minute bars only. Rules are fixed in advance (no parameter tuning on the results).
"""
import math, json
import numpy as np, pandas as pd
from scipy.optimize import brentq
from scipy.stats import norm

ROOT = '/home/user/qqq_research'
R, START_EQ, COMM = 0.04, 1617.0, 0.65
YEAR_MIN = 252 * 390

# ---------- data ----------
ext = pd.read_csv(f'{ROOT}/data/QQQ_SPY_1min_ext.csv')
ext['tmin'] = ext.time_et.str.slice(0, 2).astype(int) * 60 + ext.time_et.str.slice(3, 5).astype(int)
opt = pd.read_csv(f'{ROOT}/data/opt_1min_2026-11-25.csv')
opt = opt[~opt.interpolated.astype(str).str.lower().eq('true')]
opt['tmin'] = opt.time_et.str.slice(0, 2).astype(int) * 60 + opt.time_et.str.slice(3, 5).astype(int)
REAL = {(r.type, float(r.strike), int(r.tmin)): (float(r.open), float(r.close)) for r in opt.itertuples()}
DAYS = sorted(ext.date.unique())
IS_DAYS = set(DAYS[:20])

def bs(S, K, T, sig, typ):
    if T <= 0 or sig <= 0:
        return max(0.0, S - K) if typ == 'call' else max(0.0, K - S)
    d1 = (math.log(S / K) + (R + 0.5 * sig * sig) * T) / (sig * math.sqrt(T)); d2 = d1 - sig * math.sqrt(T)
    if typ == 'call':
        return S * norm.cdf(d1) - K * math.exp(-R * T) * norm.cdf(d2)
    return K * math.exp(-R * T) * norm.cdf(-d2) - S * norm.cdf(-d1)

def iv_solve(px, S, K, T, typ):
    intrinsic = max(0.0, S - K) if typ == 'call' else max(0.0, K - S)
    if px <= intrinsic + 0.005 or T <= 0:
        return np.nan
    try:
        return brentq(lambda s: bs(S, K, T, s, typ) - px, 0.01, 5.0)
    except ValueError:
        return np.nan

# ---------- per-day frames + causal realized-vol forecast ----------
def day_frames(d):
    q = ext[(ext.symbol == 'QQQ') & (ext.date == d)].set_index('tmin').sort_index()
    s = ext[(ext.symbol == 'SPY') & (ext.date == d)].set_index('tmin').sort_index()
    return q, s

LAMBDA = 0.97          # EWMA per minute
prev_var = None
RVF = {}               # (date, tmin) -> annualized RV forecast, known at the close of that minute
for d in DAYS:
    q, _ = day_frames(d)
    reg = q[(q.index >= 570) & (q.index < 960)]
    lr = np.log(reg.close).diff().fillna(0.0).values
    day_var = np.mean(lr[1:] ** 2)
    v = prev_var if prev_var is not None else day_var  # first day seeds with itself (documented)
    for tm, r in zip(reg.index, lr):
        v = LAMBDA * v + (1 - LAMBDA) * r * r
        RVF[(d, int(tm))] = math.sqrt(v * YEAR_MIN)
    prev_var = day_var

def T_left(tm):
    return max(960 - tm, 0.5) / YEAR_MIN

# ---------- calibrate IV/RV ratio on the real 11-25 chain ----------
D25 = '2026-11-25'
q25, _ = day_frames(D25)
ratios = []
for tm in range(575, 945):
    if tm not in q25.index or (D25, tm - 1) not in RVF:
        continue
    S = float(q25.loc[tm, 'close']); K = float(round(S))
    for typ in ('call', 'put'):
        if (typ, K, tm) in REAL:
            iv = iv_solve(REAL[(typ, K, tm)][1], S, K, T_left(tm + 1), typ)
            if 0.05 < iv < 3:
                ratios.append(iv / RVF[(D25, tm - 1)])
RATIO = float(np.median(ratios))

def model_px(d, tm, S, K, typ, ivm=1.0):
    rv = RVF.get((d, tm - 1), RVF.get((d, tm)))
    return max(0.01, bs(S, K, T_left(tm), RATIO * rv * ivm, typ))

def fill(px, side, spread_mult=1.0):
    hs = max(0.01, 0.01 * px) * spread_mult
    return round(max(0.01, px + hs if side == 'buy' else px - hs), 2)

# ---------- indicators ----------
def atr14(reg):
    tr = pd.concat([reg.high - reg.low, (reg.high - reg.close.shift()).abs(), (reg.low - reg.close.shift()).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / 14, adjust=False).mean()

# ---------- signals ----------
def signals_for_day(d):
    q, s = day_frames(d)
    qpre, spre = q[q.index < 570], s[s.index < 570]
    if len(qpre) < 30 or len(spre) < 30:
        return [], {}
    pmh, pml, spmh, spml = qpre.high.max(), qpre.low.min(), spre.high.max(), spre.low.min()
    reg = q[(q.index >= 570) & (q.index < 960)].copy(); sreg = s[(s.index >= 570) & (s.index < 960)]
    reg['atr'] = atr14(reg)
    orh, orl = reg.loc[570:584].high.max(), reg.loc[570:584].low.min()
    sig = []
    # --- Setup 1: pre-market high/low fade (+ SMT) ---
    for side in ('high', 'low'):
        swept_at, ext_px, done = None, None, False
        for tm in reg.index:
            if tm > 690 or done:           # fades only 09:30-11:30
                break
            b = reg.loc[tm]
            if side == 'high':
                if swept_at is None and b.high > pmh:
                    swept_at, ext_px = tm, b.high
                elif swept_at is not None:
                    ext_px = max(ext_px, b.high)
                    if tm - swept_at > 10:
                        swept_at, ext_px = (tm, b.high) if b.high > pmh else (None, None)
                        continue
                    if b.close < pmh:
                        spy_took = sreg.loc[570:tm].high.max() > spmh
                        sig.append(dict(date=d, tmin=tm, setup='PM_FADE', dir='PUT', smt=not spy_took,
                                        stop=ext_px + 0.05, ref=pmh, atr=b.atr))
                        done = True
            else:
                if swept_at is None and b.low < pml:
                    swept_at, ext_px = tm, b.low
                elif swept_at is not None:
                    ext_px = min(ext_px, b.low)
                    if tm - swept_at > 10:
                        swept_at, ext_px = (tm, b.low) if b.low < pml else (None, None)
                        continue
                    if b.close > pml:
                        spy_took = sreg.loc[570:tm].low.min() < spml
                        sig.append(dict(date=d, tmin=tm, setup='PM_FADE', dir='CALL', smt=not spy_took,
                                        stop=ext_px - 0.05, ref=pml, atr=b.atr))
                        done = True
    # --- Setup 2: 15-min OR break and retest ---
    for dirn in ('CALL', 'PUT'):
        broke_at, done = None, False
        for tm in reg.index:
            if tm < 585 or tm > 720 or done:   # 09:45-12:00
                continue
            b = reg.loc[tm]
            lvl = orh if dirn == 'CALL' else orl
            if broke_at is None:
                if (dirn == 'CALL' and b.close > orh) or (dirn == 'PUT' and b.close < orl):
                    broke_at = tm
                continue
            if tm - broke_at > 30:
                done = True; continue
            if dirn == 'CALL':
                if b.close < orh - 0.5 * b.atr:
                    done = True; continue      # failed break
                if b.low <= orh + 0.05 and b.close > orh:
                    sig.append(dict(date=d, tmin=tm, setup='ORB_RETEST', dir='CALL', smt=None, stop=b.low - 0.05, ref=orh, atr=b.atr)); done = True
            else:
                if b.close > orl + 0.5 * b.atr:
                    done = True; continue
                if b.high >= orl - 0.05 and b.close < orl:
                    sig.append(dict(date=d, tmin=tm, setup='ORB_RETEST', dir='PUT', smt=None, stop=b.high + 0.05, ref=orl, atr=b.atr)); done = True
    info = dict(pmh=pmh, pml=pml, orh=orh, orl=orl)
    return sig, info

ALL = []
for d in DAYS:
    s, _ = signals_for_day(d)
    ALL += s
SIG = pd.DataFrame(ALL).sort_values(['date', 'tmin']).reset_index(drop=True)
# day SMT bias = direction of the first SMT-confirmed fade of the day (known only after it fires)
bias = {}
for r in SIG[(SIG.setup == 'PM_FADE') & (SIG.smt == True)].itertuples():
    bias.setdefault(r.date, (r.dir, r.tmin))

# ---------- trade simulation ----------
def simulate(rows, ivm=1.0, spread_mult=1.0, sizing='fixed1', use_real_1125=True):
    trades, eq, busy_until = [], START_EQ, {}
    for r in rows:
        d, tm0 = r['date'], r['tmin'] + 1          # enter at next bar open
        if busy_until.get(d, -1) >= tm0:
            continue                                 # one position at a time
        q, _ = day_frames(d)
        reg = q[(q.index >= 570) & (q.index < 960)]
        if tm0 not in reg.index or tm0 >= 950:
            continue
        S0 = float(reg.loc[tm0, 'open']); typ = 'call' if r['dir'] == 'CALL' else 'put'
        K = float(round(S0))
        risk = abs(S0 - r['stop'])
        if risk <= 0.02:
            continue
        tgt = S0 + 2 * risk if typ == 'call' else S0 - 2 * risk
        exit_tm, why = None, None
        for tm in reg.loc[tm0:].index:
            b = reg.loc[tm]
            if tm >= 950: exit_tm, why = tm, '15:50'; break
            if typ == 'call':
                if b.low <= r['stop']: exit_tm, why = tm, 'stop'; break
                if b.high >= tgt: exit_tm, why = tm, 'target'; break
            else:
                if b.high >= r['stop']: exit_tm, why = tm, 'stop'; break
                if b.low <= tgt: exit_tm, why = tm, 'target'; break
            if tm - tm0 >= 60: exit_tm, why = tm, 'time'; break
        if exit_tm is None:
            continue
        # underlying exit price (stop/target filled at level; else bar close)
        if why == 'stop': S1 = r['stop']
        elif why == 'target': S1 = tgt
        else: S1 = float(reg.loc[exit_tm, 'close'])
        ex_px_tm = exit_tm + (0 if why in ('stop', 'target') else 1)
        real = use_real_1125 and d == D25
        if real and (typ, K, tm0) in REAL and (typ, K, min(ex_px_tm, 959)) in REAL:
            p0 = REAL[(typ, K, tm0)][0]
            p1 = REAL[(typ, K, min(ex_px_tm, 959))][0 if why in ('time', '15:50') else 1]
            src = 'real'
        else:
            p0 = model_px(d, tm0, S0, K, typ, ivm if d != D25 else 1.0)
            p1 = model_px(d, min(ex_px_tm, 959), S1, K, typ, ivm if d != D25 else 1.0)
            src = 'model'
        buy, sell = fill(p0, 'buy', spread_mult), fill(p1, 'sell', spread_mult)
        if sizing == 'fixed1':
            n = 1
        else:
            n = int(0.10 * eq // (100 * buy))
            if n == 0 and 100 * buy <= 0.20 * eq: n = 1
            if n == 0: continue
        pnl = n * (100 * (sell - buy) - 2 * COMM)
        eq += pnl
        r_mult = ((S1 - S0) if typ == 'call' else (S0 - S1)) / risk
        trades.append(dict(date=d, entry=f'{tm0 // 60:02d}:{tm0 % 60:02d}', exit=f'{exit_tm // 60:02d}:{exit_tm % 60:02d}',
                           setup=r['setup'], dir=r['dir'], smt=r.get('smt'), strike=K, contracts=n, buy=buy, sell=sell,
                           pnl=round(pnl, 2), why=why, R=round(r_mult, 2), src=src, sample='IS' if d in IS_DAYS else 'OOS', equity=round(eq, 2)))
        busy_until[d] = exit_tm
    return pd.DataFrame(trades)

def stats(t):
    if t is None or len(t) == 0:
        return dict(trades=0)
    w = t[t.pnl > 0]; l = t[t.pnl <= 0]
    eqc = START_EQ + t.pnl.cumsum(); dd = (eqc - np.maximum.accumulate(np.r_[START_EQ, eqc.values])[1:]).min()
    return dict(trades=len(t), win_rate=round(len(w) / len(t), 2), avg_win=round(w.pnl.mean(), 2) if len(w) else 0,
                avg_loss=round(l.pnl.mean(), 2) if len(l) else 0, total_pnl=round(t.pnl.sum(), 2),
                expectancy=round(t.pnl.mean(), 2), profit_factor=round(w.pnl.sum() / -l.pnl.sum(), 2) if len(l) and l.pnl.sum() < 0 else None,
                avg_R=round(t.R.mean(), 2), max_dd=round(dd, 2))

recs = SIG.to_dict('records')
VARIANTS = {
    'A  PM fade (no SMT)': [r for r in recs if r['setup'] == 'PM_FADE'],
    'B  PM fade + SMT':     [r for r in recs if r['setup'] == 'PM_FADE' and r['smt']],
    'C  ORB break&retest':  [r for r in recs if r['setup'] == 'ORB_RETEST'],
    'D  ORB retest + SMT bias': [r for r in recs if r['setup'] == 'ORB_RETEST' and r['date'] in bias
                                 and bias[r['date']][0] == r['dir'] and bias[r['date']][1] < r['tmin']],
}
VARIANTS['E  COMBINED (B + C)'] = sorted(VARIANTS['B  PM fade + SMT'] + VARIANTS['C  ORB break&retest'], key=lambda r: (r['date'], r['tmin']))

out = {'ratio_iv_to_rv_1125': round(RATIO, 3), 'n_ratio_pts': len(ratios), 'signals': len(SIG)}
lines = []
for name, rows in VARIANTS.items():
    t = simulate(rows)
    for samp in ('ALL', 'IS', 'OOS'):
        tt = t if samp == 'ALL' else (t[t['sample'] == samp] if len(t) else t)
        lines.append(dict(variant=name, sample=samp, **stats(tt)))
    if len(t): t.to_csv(f'{ROOT}/results/smt_trades_{name[:1]}.csv', index=False)
summary = pd.DataFrame(lines)
summary.to_csv(f'{ROOT}/results/smt_summary.csv', index=False)
# sensitivity for combined
sens = []
for ivm in (0.8, 1.0, 1.25, 1.5):
    for sm in (1.0, 2.0):
        t = simulate(VARIANTS['E  COMBINED (B + C)'], ivm=ivm, spread_mult=sm)
        sens.append(dict(iv_mult=ivm, spread_mult=sm, **stats(t)))
sens = pd.DataFrame(sens); sens.to_csv(f'{ROOT}/results/smt_sensitivity.csv', index=False)
sized = simulate(VARIANTS['E  COMBINED (B + C)'], sizing='pct10')
sized.to_csv(f'{ROOT}/results/smt_trades_E_sized.csv', index=False)
# model vs real on 11-25
mvr = []
t_real = simulate(VARIANTS['E  COMBINED (B + C)'])
t_mod = simulate(VARIANTS['E  COMBINED (B + C)'], use_real_1125=False)
for a, b in zip(t_real[t_real.date == D25].itertuples(), t_mod[t_mod.date == D25].itertuples()):
    mvr.append((a.setup, a.dir, a.entry, a.pnl, b.pnl))
pd.set_option('display.width', 250); pd.set_option('display.max_columns', 30)
print(json.dumps(out))
print(summary.to_string(index=False))
print(sens.to_string(index=False))
print('10%-sizing combined: trades', len(sized), 'end equity', sized.equity.iloc[-1] if len(sized) else START_EQ)
print('11-25 real vs model pnl (setup,dir,entry,real,model):', mvr)
print('signals by setup:', SIG.groupby(['setup', 'dir']).size().to_dict(), 'SMT-confirmed fades:', int(SIG.smt.fillna(False).sum()))

'use strict';
// Signal engine: pure functions that turn raw filings, prices, financials, trials and headlines
// into transparent 0-100 scores. Every score carries the evidence that produced it.

const DAY = 864e5;
const iso = d => new Date(d).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const pct = (x, d = 1) => (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const level = s => (s >= 70 ? 'High' : s >= 40 ? 'Elevated' : s >= 20 ? 'Watch' : 'Low');
const money = v => {
  const a = Math.abs(v);
  return (v < 0 ? '-' : '') + '$' + (a >= 1e12 ? (a / 1e12).toFixed(2) + 'T' : a >= 1e9 ? (a / 1e9).toFixed(1) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(0) + 'M' : a.toFixed(0));
};

const ITEMS = {
  '1.01': 'Material agreement', '1.02': 'Agreement terminated', '1.03': 'Bankruptcy', '2.01': 'Acquisition / disposition completed',
  '2.02': 'Earnings results', '2.05': 'Restructuring', '2.06': 'Impairment', '3.01': 'Listing notice', '4.01': 'Auditor change',
  '4.02': 'Non-reliance on financials', '5.01': 'Change in control', '5.02': 'Executive / director change', '5.03': 'Bylaw amendment',
  '5.07': 'Shareholder vote', '7.01': 'Reg FD disclosure', '8.01': 'Other event',
};

// ---------- Financials (SEC XBRL company facts) ----------

// Collapse XBRL rows into a clean quarterly series; Q4 is derived from the annual figure.
function quarterly(rows) {
  const q = new Map(), yr = new Map();
  for (const r of rows) {
    if (!r.start) continue;
    const d = daysBetween(r.start, r.end);
    const m = d >= 80 && d <= 100 ? q : d >= 350 && d <= 380 ? yr : null;
    if (m && (!m.has(r.end) || r.filed > m.get(r.end).filed)) m.set(r.end, r);
  }
  for (const [end, a] of yr) {
    if (q.has(end)) continue;
    const inside = [...q.values()].filter(x => x.end < end && daysBetween(a.start, x.start) >= -6);
    if (inside.length === 3) q.set(end, { end, val: a.val - inside.reduce((s, x) => s + x.val, 0), filed: a.filed });
  }
  return [...q.values()].sort((a, b) => (a.end < b.end ? -1 : 1)).slice(-13).map(r => ({ end: r.end, val: +r.val.toFixed(4) }));
}

function extractFacts(raw) {
  const g = raw?.facts?.['us-gaap'] || {}, dei = raw?.facts?.dei || {};
  const maxEnd = r => r.reduce((m, x) => (x.end > m ? x.end : m), '');
  const rows = (ns, tags, unit) => tags.map(t => ns[t]?.units?.[unit] || []).filter(r => r.length).sort((a, b) => (maxEnd(a) < maxEnd(b) ? 1 : maxEnd(a) > maxEnd(b) ? -1 : 0))[0] || []; // ties keep tag priority
  const latest = r => (r.length ? r.reduce((a, b) => (b.end > a.end || (b.end === a.end && b.filed > a.filed) ? b : a)) : null);
  const cash = latest(rows(g, ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'], 'USD'));
  const securities = latest(rows(g, ['MarketableSecuritiesCurrent', 'ShortTermInvestments', 'AvailableForSaleSecuritiesDebtSecuritiesCurrent'], 'USD'));
  const debt = latest(rows(g, ['LongTermDebt', 'LongTermDebtNoncurrent'], 'USD'));
  const fresh = x => x && cash && Math.abs(daysBetween(x.end, cash.end)) <= 120;
  const cover = latest(rows(dei, ['EntityCommonStockSharesOutstanding'], 'shares'));
  const diluted = latest(rows(g, ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfSharesOutstandingBasic'], 'shares'));
  return {
    revenueQ: quarterly(rows(g, ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'RevenuesNetOfInterestExpense'], 'USD')),
    netIncomeQ: quarterly(rows(g, ['NetIncomeLoss', 'ProfitLoss'], 'USD')),
    epsQ: quarterly(rows(g, ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted', 'EarningsPerShareBasic'], 'USD/shares')),
    cash: cash ? cash.val + (fresh(securities) ? securities.val : 0) : null,
    debt: fresh(debt) ? debt.val : 0,
    shares: Math.max(cover?.val || 0, diluted?.val || 0) || null,
    publicFloat: latest(rows(dei, ['EntityPublicFloat'], 'USD'))?.val || null,
  };
}

function fundamentals(f, price) {
  if (!f) return null;
  const sum4 = q => (q.length >= 4 ? q.slice(-4).reduce((s, x) => s + x.val, 0) : null);
  const live = !!(price && f.shares);
  const mcap = live ? price * f.shares : f.publicFloat;
  const revTTM = sum4(f.revenueQ), r = f.revenueQ, n = r.length;
  const netCash = (f.cash ?? 0) - (f.debt ?? 0);
  const ev = mcap ? mcap - netCash : null;
  const burn = f.netIncomeQ.length >= 2 ? -mean(f.netIncomeQ.slice(-2).map(x => x.val)) : 0;
  return {
    mcap: mcap || null, mcapStale: !live && !!mcap, ev, revTTM, netIncomeTTM: sum4(f.netIncomeQ), epsTTM: sum4(f.epsQ),
    revGrowth: n >= 5 && r[n - 5].val > 0 ? r[n - 1].val / r[n - 5].val - 1 : null,
    cash: f.cash, debt: f.debt, netCash,
    evSales: ev != null && revTTM > 0 ? ev / revTTM : null,
    runwayMonths: burn > 0 && f.cash ? (f.cash / burn) * 3 : null,
  };
}

// ---------- Price action ----------

function technicals(bars) {
  if (!bars || bars.length < 30) return null;
  const c = bars.map(b => b.c), n = c.length, last = c[n - 1];
  const ret = k => (n > k ? last / c[n - 1 - k] - 1 : null);
  const yr = bars.slice(-252);
  const hi52 = Math.max(...yr.map(b => b.h ?? b.c)), lo52 = Math.min(...yr.map(b => b.l ?? b.c));
  const vol = k => mean(bars.slice(-k).map(b => b.v));
  const rets = c.slice(1).map((x, i) => Math.log(x / c[i]));
  const rv = k => (rets.length >= k ? sd(rets.slice(-k)) : null); // daily sigma
  const rv20 = rv(20);
  let squeeze = null; // where today's 20-day volatility ranks within its own past year (0 = tightest)
  if (rets.length >= 140) {
    const hist = [];
    for (let i = 20; i <= rets.length; i += 5) hist.push(sd(rets.slice(i - 20, i)));
    const recent = hist.slice(-50);
    squeeze = recent.filter(x => x < rv20).length / recent.length;
  }
  const sma = k => (n >= k ? mean(c.slice(-k)) : null);
  let gap = 0;
  for (let i = Math.max(1, n - 5); i < n; i++) { const g = bars[i].o / c[i - 1] - 1; if (Math.abs(g) > Math.abs(gap)) gap = g; }
  return {
    last, chg1d: ret(1), chg5d: ret(5), chg20d: ret(20), chg60d: ret(60), hi52, lo52,
    pos52: hi52 > lo52 ? (last - lo52) / (hi52 - lo52) : null,
    volRatio: vol(120) ? vol(20) / vol(120) : null, avgVol: vol(20),
    rv10: rv(10), rv20, rv60: rv(60), sigma30: rv20 ? rv20 * Math.sqrt(21) : null, squeeze, sma50: sma(50), sma200: sma(200), gap,
  };
}

// ---------- News sentiment (finance lexicon over headlines) ----------

const POS = /\b(beat|beats|tops?|topped|surg\w*|soar\w*|jump\w*|rall(y|ies|ied)|climb\w*|gain\w*|rises?|rising|rose|upgrad\w*|outperform\w*|record|strong\w*|robust|growth|profit\w*|approv\w*|wins?|won|breakthrough|bullish|rais\w+|exceed\w*|boost\w*|positive|expan\w+|launch\w*|rebound\w*|upbeat|buy|accelerat\w*|optimis\w+|success\w*|milestone|buyback)\b/gi;
const NEG = /\b(miss\w*|plung\w*|drop\w*|falls?|falling|fell|slump\w*|tumbl\w*|sinks?|sank|slid\w*|downgrad\w*|underperform\w*|weak\w*|loss(es)?|lawsuit\w*|sued?|probe\w*|investigat\w*|recall\w*|reject\w*|fraud\w*|bearish|cuts?|cutting|warn\w*|declin\w*|layoff\w*|bankrupt\w*|default\w*|halt\w*|delay\w*|fail\w*|sells?|selling|short[- ]seller\w*|concern\w*|crash\w*|slash\w*|subpoena\w*|resign\w*|disappoint\w*|negative|risk\w*|fear\w*|shortfall|setback|dilut\w+|downbeat|struggl\w+)\b/gi;
const TOPICS = {
  'M&A': /\b(takeover|buyout|merger|to (acquire|be acquired)|acquisition (of|by|offer|talks|bid)|agrees? to (acquire|buy|be bought|be acquired|sell itself)|tender offer|go(es|ing)? private|take[- ]private|strategic (alternatives|review)|activist|sale process|explor\w+ (a )?(potential )?sale|suitors?|deal talks|in talks to|unsolicited|hostile bid|bid for|offer to buy)\b/i,
  FDA: /\b(fda|pdufa|phase (1|2|3|i{1,3})|clinical trial|top-?line|nda|bla|snda|approval|approved|complete response|crl|breakthrough therapy|priority review|adcomm|advisory committee)\b/i,
  Earnings: /\b(earnings|eps|revenue|quarterly|q[1-4]|guidance|outlook|forecast|results)\b/i,
  Analyst: /\b(upgrad\w+|downgrad\w+|price target|initiat\w+ coverage|overweight|underweight|buy rating|sell rating|analysts?)\b/i,
  Legal: /\b(lawsuit|sued?|probe|investigation|subpoena|settlement|antitrust|doj|ftc)\b/i,
};
// Auto-generated "fund X bought N shares" posts and quote pages carry no information about the company.
// Law-firm "investor alert" ads are the same kind of noise.
const NOISE = /stock price, news, quote|\bshares (acquired|bought|purchased|sold) by\b|\b(acquires|buys|sells|purchases|trims|boosts|cuts|raises|lowers|reduces|increases|grows|has|takes|holds)\b[^.]{0,60}\b(stake|position|holdings?|shares)\b|\b(stake|position|holdings?) (in|by) |\b(stock|investor|shareholder) alert\b|class action|\bllc investigates\b|law (firm|offices)|\b(lead plaintiff|securities fraud) /i;

function sentiment(items, now = Date.now(), limit = 40) {
  const scored = (items || [])
    .filter(n => now - n.time < 30 * DAY && now >= n.time - DAY && !NOISE.test(n.title))
    .map(n => {
      const p = (n.title.match(POS) || []).length, m = (n.title.match(NEG) || []).length;
      return { ...n, s: p + m ? (p - m) / (p + m) : 0, tags: Object.keys(TOPICS).filter(k => TOPICS[k].test(n.title)) };
    })
    .sort((a, b) => b.time - a.time);
  let w = 0, sw = 0, pos = 0, neg = 0;
  for (const n of scored) {
    const wt = Math.exp(-(now - n.time) / (7 * DAY)); // recent headlines count more
    w += wt; sw += wt * n.s;
    if (n.s > 0) pos++; else if (n.s < 0) neg++;
  }
  const score = w ? Math.round(100 * Math.tanh((2.2 * sw) / w)) : 0;
  const d3 = scored.filter(n => now - n.time < 3 * DAY).length, d21 = scored.filter(n => now - n.time < 21 * DAY).length;
  return {
    score, label: score > 20 ? 'Positive' : score < -20 ? 'Negative' : 'Neutral',
    pos, neg, neu: scored.length - pos - neg, count: scored.length,
    buzz: d21 >= 6 ? d3 / (d21 / 7) : null, // last 3 days vs a normal 3-day stretch
    items: scored.slice(0, limit),
  };
}

// ---------- Earnings ----------

function earnings({ filings, bars, facts, tech, sent, calendar }, now = Date.now()) {
  const today = iso(now), ev = [];
  const add = (w, text, date) => ev.push({ cat: 'Earnings', w, text, date: date || null, url: null });
  let dates = filings.filter(f => f.form === '8-K' && /(^|,)2\.02(,|$)/.test(f.items)).map(f => f.date).sort();
  dates = dates.filter((d, i) => i === dates.length - 1 || daysBetween(d, dates[i + 1]) > 45); // one per quarter

  // Reaction = move from the close before the release to the close after it (covers pre- and post-market reports).
  const history = [];
  if (bars?.length) {
    for (const d of dates.slice(-8)) {
      const i = bars.findIndex(b => b.d >= d);
      if (i > 0 && i + 1 < bars.length) history.push({ date: d, move: bars[i + 1].c / bars[i - 1].c - 1 });
    }
  }

  // Companies report on a stable calendar: next date ~ same quarter last year + 52 weeks.
  const shift = (d, k) => iso(Date.parse(d) + k * DAY);
  let next = dates.length >= 4 ? shift(dates[dates.length - 4], 364) : dates.length ? shift(dates[dates.length - 1], 91) : null;
  if (next && next < today) next = daysBetween(next, today) <= 10 ? today : null;
  const confirmed = calendar?.date >= today; // a real calendar date beats the projection
  if (confirmed) next = calendar.date;
  const daysTo = next ? daysBetween(today, next) : null;

  const e = facts?.epsQ || [], r = facts?.revenueQ || [];
  const epsYoY = e.length >= 5 && Math.abs(e[e.length - 5].val) > 0.01 ? (e[e.length - 1].val - e[e.length - 5].val) / Math.abs(e[e.length - 5].val) : null;
  const growth = k => (r.length >= 5 + k && r[r.length - 5 - k].val > 0 ? r[r.length - 1 - k].val / r[r.length - 5 - k].val - 1 : null);
  const revYoY = growth(0), revPrev = growth(1), accel = revYoY != null && revPrev != null ? revYoY - revPrev : null;

  // Seasonal random walk with drift: year-ago quarter plus the recent average year-over-year change.
  let epsForecast = null, revForecast = null;
  if (e.length >= 5) {
    const d = [];
    for (let i = e.length - 1; i >= 4 && d.length < 4; i--) d.push(e[i].val - e[i - 4].val);
    epsForecast = +(e[e.length - 4].val + mean(d)).toFixed(2);
  }
  if (revYoY != null) revForecast = r[r.length - 4].val * (1 + mean([revYoY, revPrev].filter(x => x != null)));

  const expectedMove = history.length ? mean(history.map(h => Math.abs(h.move))) : tech?.rv20 ? tech.rv20 * 2.5 : null;
  const ups = history.filter(h => h.move > 0).length, upRatio = history.length ? ups / history.length : null;
  const prox = daysTo == null ? 0.1 : daysTo <= 7 ? 1 : daysTo <= 14 ? 0.85 : daysTo <= 30 ? 0.6 : daysTo <= 45 ? 0.4 : 0.2;
  const score = Math.round(100 * (0.6 * prox + 0.4 * Math.min(1, (expectedMove || 0) / 0.12)));

  let lean = 0;
  if (epsYoY != null) lean += epsYoY > 0.1 ? 20 : epsYoY < -0.1 ? -20 : 0;
  if (accel != null) lean += accel > 0.01 ? 15 : accel < -0.01 ? -15 : 0;
  if (history.length >= 4) lean += upRatio >= 0.7 ? 15 : upRatio <= 0.3 ? -15 : 0;
  if (tech?.sma50) lean += tech.last > tech.sma50 ? 10 : -10;
  if (sent) lean += Math.round(sent.score * 0.2);
  lean = clamp(lean, -100, 100);

  if (next) add(Math.round(score * 0.5), `Next earnings expected around ${next}${daysTo ? ` (${plural(daysTo, 'day')})` : ' (due now)'}${confirmed ? ', confirmed on the earnings calendar' : ', based on its reporting pattern'}`);
  if (history.length) add(8, `Typical earnings reaction ±${(expectedMove * 100).toFixed(1)}%; the stock rose after ${ups} of the last ${history.length} reports`);
  if (epsYoY != null && Math.abs(epsYoY) > 0.1) add(8, `EPS ${pct(epsYoY, 0)} year over year last quarter`);
  if (accel != null && Math.abs(accel) > 0.01) add(7, `Revenue growth ${accel > 0 ? 'accelerating' : 'slowing'} (${pct(revYoY)} vs ${pct(revPrev)} the quarter before)`);
  const lastRx = history[history.length - 1];
  if (lastRx && daysBetween(lastRx.date, today) <= 21) add(10, `Reported earnings — stock moved ${pct(lastRx.move)} over the release`, lastRx.date);

  return {
    score, level: level(score), lean, leanLabel: lean >= 25 ? 'Bullish lean' : lean <= -25 ? 'Bearish lean' : 'Neutral lean',
    nextDate: next, dateConfirmed: confirmed, epsConsensus: confirmed ? calendar.epsEstimate ?? null : null, daysTo, expectedMove, upRatio, history, epsYoY, revYoY, revAccel: accel,
    epsQ: e.slice(-8), epsForecast, revForecast, evidence: ev,
  };
}

// ---------- M&A ----------

const TARGET_FORMS = /^(SC 14D9|SC TO-T|DEFM14A|PREM14A|DEFM14C|PREM14C|SC 13E3)/;
const is13D = f => /^(SC 13D|SCHEDULE 13D)/.test(f);
const is13G = f => /^(SC 13G|SCHEDULE 13G)/.test(f);

// Ownership and tender filings ABOUT a company carry that company's own 005- file number; ones it files
// about someone else do not. That separates "is a target" from "is the bidder / holder".
function subjectFilter(filings) {
  const top = arr => {
    const c = {};
    for (const f of arr) if (/^005-/.test(f.file || '')) c[f.file] = (c[f.file] || 0) + 1;
    return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  };
  const own = top(filings.filter(f => is13G(f.form))) || top(filings.filter(f => is13D(f.form)));
  return f => /^005-/.test(f.file || '') && (!own || f.file === own);
}

function merger({ filings, tech, fund, sent, fts, jetEvents }, now = Date.now()) {
  const today = iso(now), ev = [], marks = [], age = d => daysBetween(d, today);
  const add = (w, text, date, url) => ev.push({ cat: 'M&A', w, text, date: date || null, url: url || null });
  const about = subjectFilter(filings);
  const mark = list => list.forEach(f => marks.push({ d: f.date, type: 'ma', label: f.form }));

  const ownership = f => /^(SC TO|SC 14D9|SC 13E3)/.test(f.form);
  const deal = filings.filter(f => age(f.date) <= 270 && TARGET_FORMS.test(f.form) && (!ownership(f) || /^SC 14D9/.test(f.form) || about(f)));
  const pending = deal.length > 0;
  if (pending) { add(60, `${deal[0].form} on file — a transaction for this company has been filed with the SEC`, deal[0].date, deal[0].url); mark(deal); }

  const bidder = filings.filter(f => age(f.date) <= 270 && /^SC TO-T/.test(f.form) && !about(f));
  if (bidder.length) { add(8, 'Running a tender offer for another company (acquirer side)', bidder[0].date, bidder[0].url); mark(bidder.slice(0, 1)); }

  const preTender = filings.filter(f => age(f.date) <= 180 && /^SC TO-C/.test(f.form) && about(f));
  if (preTender.length && !pending) { add(35, 'Pre-tender-offer communication filed about this company', preTender[0].date, preTender[0].url); mark(preTender); }

  const comms = filings.filter(f => age(f.date) <= 180 && /^(425|S-4)/.test(f.form));
  if (comms.length) { add(pending ? 10 : 35, `${plural(comms.length, 'merger communication')} (${comms[0].form}) filed in the last 6 months`, comms[0].date, comms[0].url); mark(comms.slice(0, 3)); }

  const control = filings.find(f => f.form === '8-K' && /(^|,)5\.01(,|$)/.test(f.items) && age(f.date) <= 180);
  if (control) { add(40, 'Change-in-control 8-K (Item 5.01)', control.date, control.url); mark([control]); }

  const d13 = filings.filter(f => is13D(f.form) && about(f) && age(f.date) <= 365);
  const fresh = d13.filter(f => !f.form.endsWith('/A')), amended = d13.filter(f => f.form.endsWith('/A') && age(f.date) <= 180);
  if (fresh.length) {
    add(Math.round((22 + 8 * Math.min(2, fresh.length - 1)) * (age(fresh[0].date) <= 90 ? 1 : 0.6)), `${plural(fresh.length, 'new 13D stake')} in the past year — a holder above 5% with intent to influence`, fresh[0].date, fresh[0].url);
    mark(fresh);
  }
  if (amended.length) { add(Math.min(15, 5 * amended.length), `${plural(amended.length, '13D amendment')} in 6 months — a large holder is actively changing its position`, amended[0].date, amended[0].url); mark(amended.slice(0, 3)); }

  if (fts?.total) add(age(fts.hits[0].date) <= 120 ? 28 : 18, `"Strategic alternatives" language in ${plural(fts.total, 'recent 8-K document')}`, fts.hits[0].date);

  const chatter = (sent?.items || []).filter(n => n.tags.includes('M&A') && now - n.time < 21 * DAY);
  if (chatter.length) add(Math.min(24, 8 * chatter.length), `${plural(chatter.length, 'headline')} with deal or takeover language — "${chatter[0].title.slice(0, 90)}"`, iso(chatter[0].time), chatter[0].link);

  for (const j of jetEvents || []) add(j.w, j.text, j.date);

  if (fund?.mcap) {
    if (fund.mcap > 2e8 && fund.mcap < 1.5e10) add(6, `Digestible size for a buyer (${money(fund.mcap)} market cap)`);
    if (fund.evSales != null && fund.evSales > 0 && fund.evSales < 2) add(5, `Inexpensive on sales (EV/Sales ${fund.evSales.toFixed(1)}x)`);
    if (fund.netCash > 0.25 * fund.mcap) add(5, `Cash-rich: net cash equals ${Math.round((100 * fund.netCash) / fund.mcap)}% of market cap`);
  }
  if (tech) {
    if (tech.last < 0.65 * tech.hi52) add(4, `Trading ${Math.round(100 * (1 - tech.last / tech.hi52))}% below its 52-week high`);
    if (tech.volRatio >= 1.6) add(tech.volRatio >= 2.5 ? 10 : 6, `Volume running ${tech.volRatio.toFixed(1)}x its normal level`);
  }

  let score = clamp(ev.reduce((s, x) => s + x.w, 0), 0, 100);
  if (pending) score = Math.max(score, 92);
  ev.sort((a, b) => b.w - a.w);
  return { score, level: pending ? 'Deal on file' : level(score), pending, evidence: ev, marks };
}

// ---------- FDA ----------

// Likelihood-of-approval base rates by phase (BIO / QLS, Clinical Development Success Rates 2011-2020).
const LOA = { 2: 0.151, 3: 0.524, filed: 0.906 };
const ONCOLOGY = /cancer|carcinoma|tumou?r|lymphoma|leukemia|myeloma|melanoma|glioma|sarcoma|neoplasm|oncolog/i;
const FAVORED = /hemophilia|sickle|thalassemia|rare|orphan|dystrophy|cystic fibrosis|vaccine|enzyme|lysosomal/i;
const CNS = /alzheimer|depress|schizophren|parkinson|bipolar|dementia/i;
const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const isBiotech = sic => /^(283[3-6]|8731)$/.test(String(sic));

function fda({ sic, mcap, trials, approvals, sent }, now = Date.now()) {
  const today = iso(now), list = (trials || []).filter(t => t.date);
  if (!isBiotech(sic) && !list.length) return { applicable: false, score: null, catalysts: [], evidence: [] };
  const ev = [], nApp = (approvals || []).length;
  const add = (w, text, date, url) => ev.push({ cat: 'FDA', w, text, date: date || null, url: url || null });
  const odds = (base, text) => clamp(base * (ONCOLOGY.test(text) ? 0.84 : FAVORED.test(text) ? 1.15 : CNS.test(text) ? 0.88 : 1) * (nApp >= 3 ? 1.08 : nApp === 0 ? 0.93 : 1), 0.03, 0.95);

  const catalysts = list.map(t => {
    const phase = t.phases.includes('PHASE3') ? 3 : 2;
    const date = t.date.length === 7 ? t.date + '-15' : t.date;
    const what = t.drugs[0] || t.title;
    return {
      kind: 'Trial readout', nct: t.nct, label: `${what}${t.conditions[0] ? ' — ' + t.conditions[0] : ''}`, phase, date, days: daysBetween(today, date),
      estimated: t.dateType !== 'ACTUAL', status: t.status, odds: odds(LOA[phase], t.conditions.join(' ') + ' ' + t.title),
      url: `https://clinicaltrials.gov/study/${t.nct}`, done: t.status === 'COMPLETED' && t.hasResults,
    };
  }).filter(c => !c.done && c.days >= -120 && c.days <= 365);

  // PDUFA / FDA decision dates surface in headlines well before any structured feed.
  const fdaNews = (sent?.items || []).filter(n => n.tags.includes('FDA'));
  for (const n of fdaNews) {
    const m = n.title.match(new RegExp(`(?:pdufa|target action|goal|decision)[^.]{0,40}?\\b((?:${MONTHS})[a-z]*\\.? \\d{1,2},? \\d{4})`, 'i'));
    const date = m && Date.parse(m[1]) ? iso(Date.parse(m[1]) + DAY / 2) : null;
    if (date && date >= today && !catalysts.some(c => c.kind === 'FDA decision' && c.date === date)) {
      catalysts.push({ kind: 'FDA decision', label: n.title.slice(0, 110), phase: 'filed', date, days: daysBetween(today, date), estimated: false, status: 'UNDER_REVIEW', odds: odds(LOA.filed, n.title), url: n.link });
    }
  }
  catalysts.sort((a, b) => a.days - b.days);

  const impact = !mcap ? 0.7 : mcap < 2e9 ? 1 : mcap < 1e10 ? 0.8 : mcap < 5e10 ? 0.55 : 0.35; // one drug matters more to a small company
  const weight = c => (c.phase === 2 ? 0.55 : 1) * (c.days <= 30 ? 1 : c.days <= 90 ? 0.85 : c.days <= 180 ? 0.65 : c.days <= 270 ? 0.45 : 0.3);
  const lead = catalysts.slice().sort((a, b) => weight(b) - weight(a))[0];
  let score = lead ? Math.round(100 * weight(lead) * impact) : 8;

  if (lead) add(Math.round(score * 0.6), `${lead.kind}: ${lead.label} (${lead.phase === 'filed' ? 'under FDA review' : 'Phase ' + lead.phase}, ${lead.days < 0 ? 'data due' : 'around ' + lead.date}) — approval odds about ${Math.round(lead.odds * 100)}% from base rates`, null, lead.url);
  const late = catalysts.filter(c => c.phase === 3).length;
  if (late > 1) add(6, `${late} Phase 3 programs with data inside the next 12 months`);
  const review = fdaNews.find(n => /pdufa|priority review|accepts?|under review|\bnda\b|\bbla\b/i.test(n.title) && now - n.time < 21 * DAY);
  if (review) { score = Math.min(100, score + 12); add(12, `Regulatory headline — "${review.title.slice(0, 90)}"`, iso(review.time), review.link); }
  if (nApp) add(3, `${plural(nApp, 'prior FDA approval')} on record${approvals[0].brand ? ` (latest: ${approvals[0].brand})` : ''}`);

  return { applicable: true, score, level: level(score), catalysts: catalysts.slice(0, 12), approvals: nApp, evidence: ev.sort((a, b) => b.w - a.w) };
}

// ---------- Event radar: is something big brewing, whatever it is? ----------

const HOT_ITEMS = {
  '1.03': [30, 'Bankruptcy or receivership (Item 1.03)'], '4.02': [25, 'Prior financials can no longer be relied on (Item 4.02)'],
  '3.01': [15, 'Listing-standard notice (Item 3.01)'], '2.05': [10, 'Restructuring costs (Item 2.05)'],
  '1.02': [8, 'Material agreement terminated (Item 1.02)'], '2.06': [8, 'Material impairment (Item 2.06)'], '4.01': [8, 'Auditor change (Item 4.01)'],
  '5.02': [6, 'Executive or director change (Item 5.02)'], '1.01': [6, 'New material agreement (Item 1.01)'],
};

function eventRadar({ filings, tech, earn, fdaRes, sent }, now = Date.now()) {
  const today = iso(now), ev = [], age = d => daysBetween(d, today);
  const add = (w, text, date, url) => ev.push({ cat: 'Event', w, text, date: date || null, url: url || null });
  if (tech) {
    if (tech.volRatio >= 1.5) add(tech.volRatio >= 2.5 ? 25 : 15, `Volume ${tech.volRatio.toFixed(1)}x normal over the last 20 sessions`);
    if (tech.rv10 && tech.rv60 && tech.rv10 / tech.rv60 >= 1.4) add(15, `Volatility expanding (10-day is ${(tech.rv10 / tech.rv60).toFixed(1)}x the 60-day)`);
    if (tech.squeeze != null && tech.squeeze <= 0.15) add(10, 'Volatility squeeze — price is coiled near its tightest range of the year');
    if (Math.abs(tech.gap) >= 0.06) add(10, `Price gap of ${pct(tech.gap)} in the last 5 sessions`);
  }
  const k8 = filings.filter(f => f.form === '8-K');
  const recent = k8.filter(f => age(f.date) <= 30), base = k8.filter(f => age(f.date) > 30 && age(f.date) <= 365).length / 11;
  if (recent.length >= 3 && recent.length >= 2 * Math.max(base, 0.5)) add(15, `${recent.length} 8-Ks in 30 days vs about ${base.toFixed(1)} a month normally`, recent[0].date, recent[0].url);
  const seen = new Set();
  for (const f of recent) for (const it of f.items.split(',')) {
    if (HOT_ITEMS[it] && !seen.has(it)) { seen.add(it); add(HOT_ITEMS[it][0], HOT_ITEMS[it][1], f.date, f.url); }
  }
  if (earn?.daysTo != null && earn.daysTo <= 30) add(earn.daysTo <= 14 ? 20 : 10, `Earnings in about ${plural(earn.daysTo, 'day')}${earn.expectedMove ? ` (typical move ±${(earn.expectedMove * 100).toFixed(1)}%)` : ''}`);
  const cat = fdaRes?.catalysts?.find(c => c.days <= 90);
  if (cat && fdaRes.score >= 40) add(20, `FDA / trial catalyst inside 90 days: ${cat.label}`);
  if (sent?.buzz >= 2) add(10, `News flow running ${sent.buzz.toFixed(1)}x its normal pace`);
  if (sent && Math.abs(sent.score) >= 50) add(5, `Strongly ${sent.score > 0 ? 'positive' : 'negative'} headline tone`);
  const insider = filings.filter(f => f.form === '4' && age(f.date) <= 30).length;
  if (insider >= 6) add(4, `${insider} insider (Form 4) filings in 30 days`);
  const score = clamp(ev.reduce((s, x) => s + x.w, 0), 0, 100);
  return { score, level: level(score), evidence: ev.sort((a, b) => b.w - a.w) };
}

// ---------- Direction forecast: will the price be higher or lower in h trading days? ----------

const normCdf = x => {
  const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
};

// Technicals and news tilt the odds away from the stock's own baseline; how far they are allowed to tilt
// depends on how often the same technical signal was right on this stock over the past year.
function forecast(bars, sent, av, h = 5) {
  if (!bars || bars.length < 260) return null;
  const c = bars.map(b => b.c), n = c.length, last = c[n - 1];
  const pre = [0];
  for (const x of c) pre.push(pre[pre.length - 1] + x);
  const sma = (i, k) => (pre[i + 1] - pre[i + 1 - k]) / k;
  const ema = k => { const a = 2 / (k + 1), out = [c[0]]; for (let i = 1; i < n; i++) out.push(out[i - 1] + a * (c[i] - out[i - 1])); return out; };
  const e12 = ema(12), e26 = ema(26), macd = e12.map((x, i) => x - e26[i]), sig = [macd[0]];
  for (let i = 1; i < n; i++) sig.push(sig[i - 1] + 0.2 * (macd[i] - sig[i - 1]));
  const rsi = Array(n).fill(50);
  let gain = 0, loss = 0;
  for (let i = 1; i < n; i++) { // Wilder's RSI(14)
    const d = c[i] - c[i - 1], g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= 14) { gain += g / 14; loss += l / 14; } else { gain = (gain * 13 + g) / 14; loss = (loss * 13 + l) / 14; }
    if (i >= 14) rsi[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  const lr = c.map((x, i) => (i ? Math.log(x / c[i - 1]) : 0));
  const vol = i => sd(lr.slice(i - 59, i + 1)) || 0.02; // 60-day daily sigma
  // Each factor is scaled to -1..+1 in units of the stock's own volatility, so quiet and wild stocks compare fairly.
  const feats = i => {
    const s = vol(i), s50 = sma(i, 50), s200 = sma(i, 200);
    return {
      trend: clamp((c[i] / s50 - 1) / (s * 8), -1, 1),
      regime: clamp((s50 / s200 - 1) / (s * 12), -1, 1),
      momentum: clamp(Math.log(c[i] / c[i - 20]) / (s * Math.sqrt(20) * 2), -1, 1),
      rsi: rsi[i] > 70 ? -(rsi[i] - 70) / 30 : rsi[i] < 30 ? (30 - rsi[i]) / 30 : 0, // stretched readings tend to snap back
      macd: clamp((macd[i] - sig[i]) / (c[i] * s), -1, 1),
    };
  };
  const W = { trend: 0.25, regime: 0.15, momentum: 0.25, rsi: 0.15, macd: 0.2 };
  const tech = f => Object.keys(W).reduce((t, k) => t + W[k] * f[k], 0);

  let hits = 0, samples = 0; // walk the past year: how often did this exact signal call the next h days right?
  for (let i = 200; i < n - h; i++) {
    const t = tech(feats(i));
    if (Math.abs(t) < 0.1) continue;
    samples++;
    if (c[i + h] > c[i] === t > 0) hits++;
  }
  const hitRate = samples >= 30 ? hits / samples : null;

  const f = feats(n - 1), t = tech(f), dailySigma = vol(n - 1), sigma = dailySigma * Math.sqrt(h);
  const lex = sent && sent.count >= 3 ? sent.score / 100 : null;
  const news = lex != null && av ? (lex + av.score) / 2 : lex ?? av?.score ?? null;
  const combined = news == null ? t : 0.7 * t + 0.3 * news;
  const reliability = hitRate == null ? 0.4 : clamp((hitRate - 0.5) / 0.1, 0.15, 1);
  const drift = clamp(mean(lr.slice(-250)) * h, -0.25 * sigma, 0.25 * sigma);
  const expRet = drift + combined * 0.6 * reliability * sigma;
  const pUp = clamp(normCdf(expRet / sigma), 0.2, 0.8);
  const s50 = sma(n - 1, 50), s200 = sma(n - 1, 200), r = rsi[n - 1];
  // Volatility with one-off shock days clipped, so a single earnings gap does not pass for the normal daily range.
  const recent = lr.slice(-60), mid = a => a.slice().sort((x, y) => x - y)[a.length >> 1], med = mid(recent);
  const mad = mid(recent.map(x => Math.abs(x - med))) * 1.4826 || dailySigma;
  const robustSigma = sd(recent.map(x => clamp(x, med - 3 * mad, med + 3 * mad)));
  return {
    horizon: h, last, tech: t, pUp, verdict: pUp >= 0.55 ? 'Up' : pUp <= 0.45 ? 'Down' : 'No clear edge',
    expRet, sigma, dailySigma, robustSigma, low: last * Math.exp(expRet - sigma), high: last * Math.exp(expRet + sigma), hitRate, samples,
    factors: [
      { name: 'Price vs 50-day average', v: f.trend, note: `${(Math.abs(last / s50 - 1) * 100).toFixed(1)}% ${last >= s50 ? 'above' : 'below'}` },
      { name: '50-day vs 200-day trend', v: f.regime, note: s50 >= s200 ? 'uptrend' : 'downtrend' },
      { name: '20-day momentum', v: f.momentum, note: pct(last / c[n - 21] - 1) },
      { name: 'RSI (14)', v: f.rsi, note: `${r.toFixed(0)} · ${r > 70 ? 'overbought' : r < 30 ? 'oversold' : 'neutral'}` },
      { name: 'MACD', v: f.macd, note: macd[n - 1] >= sig[n - 1] ? 'above its signal line' : 'below its signal line' },
      { name: 'News sentiment', v: news ?? 0, note: news == null ? 'too few headlines' : `${sent?.label || 'scored'}${av ? ' · two sources' : ''}` },
      { name: 'Long-run drift', v: clamp(drift / (0.25 * sigma), -1, 1), note: `${pct(Math.exp(mean(lr.slice(-250)) * 252) - 1, 0)} a year` },
    ],
  };
}

// ---------- Options: which contracts should gain value over the forecast window? ----------

// Black-Scholes with zero rates. We only ever compare model value to model value, so carry cancels out.
function bs(S, K, T, sigma, call) {
  if (T <= 0 || sigma <= 0) return Math.max(call ? S - K : K - S, 0);
  const v = sigma * Math.sqrt(T), d1 = Math.log(S / K) / v + v / 2, d2 = d1 - v;
  return call ? S * normCdf(d1) - K * normCdf(d2) : K * normCdf(-d2) - S * normCdf(-d1);
}

// For every contract: expected value after the holding period, averaged over the forecast's price
// distribution, versus its value today. Green = expected to be worth more; red = time decay wins.
function markOptions(contracts, fc, exp, now = Date.now()) {
  const S0 = fc.last, daysLeft = Math.max(0.5, (Date.parse(exp + 'T21:00:00Z') - now) / DAY);
  const hold = Math.min((fc.horizon * 7) / 5, daysLeft), tradingDays = (hold * 5) / 7;
  const T = daysLeft / 365, after = (daysLeft - hold) / 365;
  const m = (fc.expRet * tradingDays) / fc.horizon;
  const sane = c => c.iv > 0.01 && c.iv < 5;
  const atmIv = contracts.filter(sane).sort((a, b) => Math.abs(a.strike - S0) - Math.abs(b.strike - S0))[0]?.iv || fc.dailySigma * Math.sqrt(252);
  // Expected volatility over the holding period: half what the option market implies, half what the stock has actually been doing.
  const s = Math.sqrt((0.5 * atmIv ** 2) / 252 + 0.5 * (fc.robustSigma || fc.dailySigma) ** 2) * Math.sqrt(tradingDays);
  const grid = [];
  for (let z = -4; z <= 4.001; z += 0.25) grid.push([z, Math.exp((-z * z) / 2)]);
  const wsum = grid.reduce((a, g) => a + g[1], 0);
  const rows = new Map();
  for (const c of contracts) {
    const iv = sane(c) ? c.iv : atmIv, call = c.type === 'C', today = bs(S0, c.strike, T, iv, call);
    let ev = 0;
    for (const [z, w] of grid) ev += w * bs(S0 * Math.exp(m + s * z), c.strike, after, iv, call);
    const change = today > 0.005 ? ev / wsum / today - 1 : null; // effectively worthless: nothing to gain
    const row = rows.get(c.strike) || { strike: c.strike };
    row[call ? 'call' : 'put'] = {
      mid: c.bid > 0 && c.ask > 0 ? (c.bid + c.ask) / 2 : c.last || null, iv: sane(c) ? c.iv : null, delta: c.delta ?? null,
      vol: c.vol || 0, oi: c.oi || 0, change, up: change != null && change > 0,
    };
    rows.set(c.strike, row);
  }
  return { holdDays: Math.max(1, Math.round(tradingDays)), daysToExpiry: Math.round(daysLeft), atmIv, rows: [...rows.values()].sort((a, b) => a.strike - b.strike) };
}

// ---------- Outlook: one bullish / bearish read built from three separate scores ----------

// Technical (trend, momentum, RSI, MACD), fundamental (earnings growth, beats, revenue growth, analyst
// ratings and targets) and news (headline tone). Each runs -100..+100; whatever is missing is left out
// and the weights are rebalanced, so a stock with no analyst coverage is not penalized for it.
function outlook({ fc, epsYoY, beatRate, revGrowth, analyst, last, sent }) {
  const unit = x => clamp(x, -1, 1), parts = [];
  if (epsYoY != null) parts.push(['Earnings growth', unit(epsYoY / 0.5), `EPS ${pct(epsYoY, 0)} year over year`]);
  if (beatRate != null) parts.push(['Earnings beats', unit((beatRate - 0.5) * 2), `beat estimates in ${Math.round(beatRate * 100)}% of recent quarters`]);
  if (revGrowth != null) parts.push(['Revenue growth', unit(revGrowth / 0.3), `revenue ${pct(revGrowth, 0)} year over year`]);
  const votes = analyst ? analyst.buy + analyst.hold + analyst.sell : 0;
  if (votes >= 3) parts.push(['Analyst ratings', unit((analyst.buy - analyst.sell) / votes), `${analyst.buy} buy, ${analyst.hold} hold, ${analyst.sell} sell`]);
  if (analyst?.target && last) parts.push(['Analyst target', unit((analyst.target / last - 1) / 0.3), `average price target ${pct(analyst.target / last - 1, 0)} from here`]);
  const technical = fc ? Math.round(100 * unit(fc.tech * 1.6)) : null;
  const fundamental = parts.length ? Math.round(100 * mean(parts.map(p => p[1]))) : null;
  const news = sent && sent.count >= 3 ? sent.score : null;
  const W = [[technical, 0.45], [fundamental, 0.35], [news, 0.2]].filter(x => x[0] != null);
  if (!W.length) return null;
  const score = Math.round(W.reduce((s, [v, w]) => s + v * w, 0) / W.reduce((s, [, w]) => s + w, 0));
  return {
    score, label: score >= 40 ? 'Strongly bullish' : score >= 15 ? 'Bullish' : score <= -40 ? 'Strongly bearish' : score <= -15 ? 'Bearish' : 'Neutral',
    technical, fundamental, news, parts: parts.map(([name, v, note]) => ({ name, v, note })),
  };
}

// ---------- Price ranges with a stated confidence ----------

// Width comes from the stock's own record: for each horizon, how far it actually moved relative to its
// volatility at the time, at the 68th and 90th percentiles. So "90%" means a band this wide would have
// held nine times in ten over the history we have. The center is nudged by the outlook score, and only
// slightly: how far a stock can move is far easier to estimate than which way it will go.
function ranges(bars, score = 0, horizons = [5, 21, 63]) {
  if (!bars || bars.length < 260) return null;
  const c = bars.map(b => b.c), n = c.length, last = c[n - 1], lr = c.map((x, i) => (i ? Math.log(x / c[i - 1]) : 0));
  const vol = i => sd(lr.slice(i - 59, i + 1)) || 0.02, drift = mean(lr.slice(-250));
  return horizons.map(h => {
    const z = [];
    for (let i = 60; i < n - h; i += Math.max(1, Math.floor(h / 5))) z.push(Math.abs(Math.log(c[i + h] / c[i])) / (vol(i) * Math.sqrt(h)));
    z.sort((a, b) => a - b);
    const q = p => (z.length >= 20 ? z[Math.min(z.length - 1, Math.floor(p * z.length))] : p > 0.8 ? 1.645 : 1);
    const s = vol(n - 1) * Math.sqrt(h), mid = clamp(drift * h, -0.25 * s, 0.25 * s) + clamp(score / 100, -1, 1) * 0.3 * s;
    const at = k => last * Math.exp(mid + k * s);
    return { days: h, expected: at(0), lo68: at(-q(0.68)), hi68: at(q(0.68)), lo90: at(-q(0.9)), hi90: at(q(0.9)), samples: z.length };
  });
}

// ---------- News: which stocks does a story touch? ----------

// Macro and sector stories rarely name a ticker, so each theme lists the funds and bellwethers that usually move with it.
const THEMES = [
  ['Oil & energy', /\b(oil|crude|opec|brent|wti|natural gas|gasoline)\b/i, ['XLE', 'XOM', 'CVX', 'USO']],
  ['Interest rates & the Fed', /\b(fed|federal reserve|powell|rate cuts?|rate hikes?|interest rates?|treasury yields?|bond yields?|inflation|cpi|jobs report|payrolls)\b/i, ['TLT', 'XLF', 'KRE', 'SPY']],
  ['Chips & AI', /\b(chips?|chipmakers?|semiconductors?|artificial intelligence|\bai\b|gpus?|data cent(er|re)s?)\b/i, ['SMH', 'NVDA', 'AMD', 'AVGO']],
  ['China & tariffs', /\b(tariffs?|trade war|china|chinese|beijing|export controls?)\b/i, ['FXI', 'KWEB', 'BABA']],
  ['Housing', /\b(housing|mortgage rates?|home sales|homebuilders?)\b/i, ['XHB', 'ITB']],
  ['Gold & metals', /\b(gold|silver|copper|precious metals)\b/i, ['GLD', 'GDX', 'SLV']],
  ['Crypto', /\b(bitcoin|crypto|cryptocurrenc(y|ies)|ethereum|stablecoins?)\b/i, ['IBIT', 'COIN', 'MSTR']],
  ['Drug pricing & biotech', /\b(drug pric(e|es|ing)|drugmakers?|medicare|biotechs?|pharma)\b/i, ['XBI', 'IBB', 'XLV']],
  ['Banks', /\b(banks?|lenders?|credit losses|deposits)\b/i, ['XLF', 'KRE', 'JPM']],
  ['Airlines & travel', /\b(airlines?|air travel|cruise lines?)\b/i, ['JETS']],
  ['Retail & the consumer', /\b(retail sales|retailers?|consumer spending|black friday|holiday (sales|shopping)|shoppers)\b/i, ['XRT', 'WMT', 'AMZN']],
  ['Electric vehicles', /\b(electric vehicles?|evs|ev makers?)\b/i, ['TSLA']],
  ['The whole market', /\b(wall street|stock market|stocks (rise|fall|rally|slump|slide|tumble|jump|climb|sink|surge|drop)|s&p 500|nasdaq|dow jones|futures)\b/i, ['SPY', 'QQQ', 'DIA']],
];
const NAME_TAIL = /[\s,.]+(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|nv|sa|ag|se|ab|adr|holdings?|group|platforms|technolog(y|ies)|pharmaceuticals?|therapeutics|biosciences|biopharma|laboratories|international|industries|enterprises|class [a-c])$/i;
// Company names that are also everyday words: these only count when the ticker itself is written out.
const AMBIGUOUS = new Set(['box', 'unity', 'sea', 'path', 'snap', 'zoom', 'beam', 'grab', 'arm', 'match', 'block', 'gap']);

// { AAPL: 'Apple Inc.' } -> [{ t: 'AAPL', re: /\bApple\b/i }]
function aliasIndex(companies) {
  const out = [];
  for (const [t, raw] of Object.entries(companies || {})) {
    let name = String(raw).replace(/\s*[\/\\].*$/, '').replace(/[.,]+$/, '').trim();
    for (let i = 0; i < 4 && NAME_TAIL.test(name); i++) name = name.replace(NAME_TAIL, '').replace(/[.,&\s]+$/, '');
    if (name.length < 4 || AMBIGUOUS.has(name.toLowerCase())) continue;
    out.push({ t, re: new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`, 'i') });
  }
  return out;
}

// Stocks a headline names outright (by ticker or company name), plus up to two themes it belongs to.
function affected(title, aliases, known) {
  const mentions = new Set(), take = t => { if (!known || known.has(t)) mentions.add(t); };
  for (const m of title.matchAll(/\((?:NASDAQ|NYSE|NYSEARCA|NYSEAMERICAN|AMEX|OTCMKTS)\s*:\s*([A-Z][A-Z.\-]{0,5})\)/g)) mentions.add(m[1]);
  for (const m of title.matchAll(/\$([A-Z]{1,5})\b/g)) take(m[1]);
  for (const m of title.matchAll(/\(([A-Z]{2,5})\)/g)) take(m[1]);
  for (const a of aliases || []) if (a.re.test(title)) mentions.add(a.t);
  const themes = THEMES.filter(([, re]) => re.test(title)).slice(0, 2).map(([label, , tickers]) => ({ label, tickers }));
  return { mentions: [...mentions].slice(0, 6), themes };
}

module.exports = { iso, daysBetween, pct, clamp, ITEMS, isBiotech, quarterly, extractFacts, fundamentals, technicals, sentiment, earnings, merger, fda, eventRadar, forecast, bs, markOptions, outlook, ranges, aliasIndex, affected };

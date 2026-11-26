'use strict';
// One ticker in, one fully scored profile out.

const src = require('./sources');
const jets = require('./jets');
const S = require('./signals');

const memo = new Map();
// "VERTEX PHARMACEUTICALS INC / MA" -> "Vertex Pharmaceuticals Inc"
const pretty = n => { const s = String(n).replace(/\s*[\/\\].*$/, ''); return s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\b(Nv|Sa|Ag|Plc|Se|Ab|Asa|Adr|Ii|Iii)\b/g, m => m.toUpperCase()) : s; };
const SKIP = /^(3|4|5|144|424B|S-8|FWP|CORRESP|UPLOAD|ARS|SC 13G|SCHEDULE 13G|13F|11-K|SD|PX14A6G|EFFECT|CERT|8-A)/;

function analyze(ticker) {
  const hit = memo.get(ticker);
  if (hit && Date.now() - hit.t < 10 * 6e4) return hit.p;
  const p = run(ticker);
  memo.set(ticker, { t: Date.now(), p });
  p.catch(() => memo.delete(ticker));
  return p;
}

async function run(ticker) {
  const warnings = [];
  const soft = p => Promise.resolve(p).catch(e => { if (!warnings.includes(e.message)) warnings.push(e.message); return null; });

  const ent = await src.resolve(ticker);
  if (!ent) throw Object.assign(new Error(`No SEC-registered company found for ${ticker}`), { status: 404 });

  const [sub, facts, bars] = await Promise.all([soft(src.submissions(ent.cik)), soft(src.facts(ent.cik)), soft(src.prices(ticker))]);
  const name = sub?.name || ent.name, filings = sub?.filings || [], bio = S.isBiotech(sub?.sic);
  const [newsItems, fts, trials, approvals, hq] = await Promise.all([
    soft(src.news(ticker, name)), soft(src.fullText(ent.cik, 'strategic alternatives')),
    bio ? soft(src.trials(name)) : null, bio ? soft(src.approvals(name)) : null, soft(src.geocode(sub?.address, sub?.place)),
  ]);
  jets.setHQ(ticker, name, sub?.city || '', hq);
  const calendar = await soft(src.earningsCalendar(ticker));

  const tech = S.technicals(bars);
  const fund = S.fundamentals(facts, tech?.last);
  const sent = S.sentiment(newsItems);
  const earn = S.earnings({ filings, bars, facts, tech, sent, calendar });
  const ma = S.merger({ filings, tech, fund, sent, fts, jetEvents: jets.eventsFor(ticker) });
  const fda = S.fda({ sic: sub?.sic, mcap: fund?.mcap, trials, approvals, sent });
  const event = S.eventRadar({ filings, tech, earn, fdaRes: fda, sent });

  const fc = S.forecast(bars, sent);
  const outlook = S.outlook({ fc, epsYoY: earn.epsYoY, revGrowth: fund?.revGrowth ?? earn.revYoY, last: tech?.last, sent });
  const parts = [['M&A', ma.score], ['Earnings', earn.score], ['Event radar', event.score]].concat(fda.applicable ? [['FDA', fda.score]] : []).sort((a, b) => b[1] - a[1]);
  const evidence = [...ma.evidence, ...fda.evidence, ...earn.evidence, ...event.evidence];

  return {
    ticker, name: pretty(name), industry: sub?.industry || '', exchange: sub?.exchange || '', city: sub?.city || '', bio, asOf: Date.now(),
    price: tech, fund, forecast: fc, outlook, ranges: S.ranges(bars, outlook?.score || 0),
    chart: (bars || []).slice(-252).map(b => [b.d, +b.c.toFixed(2)]),
    markers: [...earn.history.map(h => ({ d: h.date, type: 'earn', label: `Earnings ${S.pct(h.move)}` })), ...ma.marks],
    scores: { overall: Math.round(0.65 * parts[0][1] + 0.35 * parts[1][1]), merger: ma.score, fda: fda.applicable ? fda.score : null, earnings: earn.score, event: event.score, sentiment: sent.score },
    driver: parts[0][0],
    thesis: evidence.slice().sort((a, b) => b.w - a.w).slice(0, 4).map(e => ({ cat: e.cat, text: e.text })),
    merger: ma, fda, earnings: earn, event, news: sent,
    filings: filings.filter(f => !SKIP.test(f.form)).slice(0, 25).map(f => ({
      form: f.form, date: f.date, url: f.url,
      label: f.form === '8-K' ? f.items.split(',').filter(i => i && i !== '9.01').map(i => S.ITEMS[i] || `Item ${i}`).join(' · ') : f.desc,
    })),
    warnings,
  };
}

// Direction forecast plus (with an options key) the full chain for one expiration, every strike marked.
async function predict(symbol, exp) {
  const warnings = [];
  const soft = p => Promise.resolve(p).catch(e => { if (!warnings.includes(e.message)) warnings.push(e.message); return null; });
  const [bars, ent] = await Promise.all([src.prices(symbol).catch(e => { throw Object.assign(new Error(e.message), { status: 502 }); }), soft(src.resolve(symbol))]);
  if (!bars || bars.length < 2) throw Object.assign(new Error(`No price history found for ${symbol}`), { status: 404 });
  const name = ent?.name || symbol, last = bars[bars.length - 1].c;
  const [newsItems, av] = await Promise.all([soft(src.news(symbol, name)), soft(src.avSentiment(symbol))]);
  const sent = S.sentiment(newsItems), fc = S.forecast(bars, sent, av), provider = src.optionsProvider();
  const outlook = S.outlook({ fc, last, sent });
  let chain = null;
  if (provider && fc) {
    try {
      const expirations = await src.optionExpirations(symbol);
      if (!expirations.length) throw new Error('No listed options were found for this symbol');
      const week = S.iso(Date.now() + 6 * 864e5);
      const pick = expirations.includes(exp) ? exp : expirations.find(x => x >= week) || expirations[0];
      chain = { provider, expirations, exp: pick, ...S.markOptions(await src.optionChain(symbol, pick), fc, pick) };
    } catch (e) { chain = { provider, error: e.message }; }
  }
  return {
    symbol, name: ent ? pretty(name) : symbol, price: last, chg1d: last / bars[bars.length - 2].c - 1, forecast: fc, outlook, ranges: S.ranges(bars, outlook?.score || 0),
    news: { score: sent.score, label: sent.label, count: sent.count, items: sent.items.slice(0, 6) }, chain, needsKey: !provider, warnings,
  };
}

// Latest market stories, each scored for tone and tagged with the stocks it names and the themes it belongs to.
const companies = require('./companies.json');
const aliases = S.aliasIndex(companies), known = new Set(Object.keys(companies));
async function marketNews() {
  const scored = S.sentiment(await src.marketNews(), Date.now(), 160);
  return { at: Date.now(), items: scored.items.map(n => ({ title: n.title, publisher: n.publisher, link: n.link, time: n.time, s: n.s, tags: n.tags, ...S.affected(n.title, aliases, known) })) };
}

module.exports = { analyze, predict, marketNews, clear: () => memo.clear() };

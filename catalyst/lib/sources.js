'use strict';
// Data sources — all free, no API keys. Each call is throttled per host, cached on disk,
// and falls back to the last good copy if the source is down.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractFacts, iso, clamp } = require('./signals');
const settings = require('./settings');

const CACHE = process.env.CATALYST_CACHE || path.join(__dirname, '..', '.cache');
fs.mkdirSync(CACHE, { recursive: true });

// The SEC asks automated clients to identify themselves: enter your contact in Settings (or set SEC_USER_AGENT).
const secUA = () => (settings.get('secContact') ? `CatalystDesk/1.0 ${settings.get('secContact')}` : process.env.SEC_USER_AGENT || 'CatalystDesk/1.0 (personal research tool)');
const WEB_UA = 'Mozilla/5.0 (compatible; CatalystDesk/1.0)';
const MIN = 6e4, HOUR = 36e5, DAY = 864e5;
const status = {}, inflight = new Map(), slot = {};

async function get(url, { source, ttl, gap = 150, ua, headers, text = false, pick = x => x }) {
  const file = path.join(CACHE, crypto.createHash('sha1').update(url).digest('hex') + '.json');
  let cached;
  try { cached = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (cached && Date.now() - cached.t < ttl) return cached.d;
  if (inflight.has(url)) return inflight.get(url);
  const job = (async () => {
    const host = new URL(url).host, at = Math.max(Date.now(), slot[host] || 0);
    slot[host] = at + gap; // space out requests to each host
    if (at > Date.now()) await new Promise(r => setTimeout(r, at - Date.now()));
    try {
      const res = await fetch(url, { headers: { 'User-Agent': ua || secUA(), Accept: text ? '*/*' : 'application/json', ...headers }, signal: AbortSignal.timeout(20000) });
      let d = null;
      if (res.status !== 404) {
        if (!res.ok) throw new Error(res.status === 429 ? 'is rate limiting requests' : res.status === 401 || res.status === 403 ? 'rejected the request (check the key in Settings)' : `returned HTTP ${res.status}`);
        d = pick(text ? await res.text() : await res.json());
      }
      status[source] = { ok: true, at: Date.now() };
      fs.writeFile(file, JSON.stringify({ t: Date.now(), d }), () => {});
      return d;
    } catch (e) {
      const why = e.name === 'TimeoutError' ? 'timed out' : e instanceof SyntaxError || e instanceof TypeError && e.message !== 'fetch failed' ? 'sent an unexpected response' : e.message === 'fetch failed' ? 'is unreachable' : e.message;
      status[source] = { ok: false, at: Date.now(), error: why };
      if (cached) return cached.d;
      throw new Error(`${source} ${why}`);
    }
  })().finally(() => inflight.delete(url));
  inflight.set(url, job);
  return job;
}

// "VERTEX PHARMACEUTICALS INC / MA" -> "VERTEX PHARMACEUTICALS"
function shortName(name) {
  return String(name || '').replace(/\s*[\/\\].*$/, '').replace(/[.,]/g, '')
    .replace(/\s+(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|llc|lp|sa|nv|ag)\b.*$/i, '').replace(/\s*&\s*$/, '').trim();
}

function resolve(ticker) {
  return get(`https://efts.sec.gov/LATEST/search-index?keysTyped=${encodeURIComponent(ticker)}`, {
    source: 'SEC search', ttl: 30 * DAY,
    pick: d => {
      for (const h of d?.hits?.hits || []) {
        if (String(h._source?.tickers || '').split(/[,\s]+/).includes(ticker)) {
          return { cik: String(h._id).padStart(10, '0'), name: String(h._source.entity || ticker).replace(/\s*\([^)]*\)\s*$/, '') };
        }
      }
      return null;
    },
  });
}

function submissions(cik) {
  return get(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    source: 'SEC filings', ttl: 3 * HOUR,
    pick: d => {
      const r = d.filings.recent, filings = [], floor = iso(Date.now() - 3 * 365 * DAY), recent = iso(Date.now() - 60 * DAY);
      for (let i = 0; i < r.form.length; i++) {
        const form = r.form[i], date = r.filingDate[i];
        if (date < floor || /^(144|3|5)(\/A)?$/.test(form) || (/^4(\/A)?$/.test(form) && date < recent)) continue;
        const acc = r.accessionNumber[i];
        filings.push({
          form, date, items: r.items[i] || '', file: r.fileNumber[i] || '', desc: r.primaryDocDescription[i] || '',
          url: `https://www.sec.gov/Archives/edgar/data/${+d.cik}/${acc.replace(/-/g, '')}/${r.primaryDocument[i] || ''}`,
        });
      }
      const a = d.addresses?.business || {}, words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
      // "ONE APPLE PARK WAY, 4TH FLOOR" -> "1 APPLE PARK WAY": the geocoder wants a plain street address
      const street = ([a.street1, a.street2].find(s => s && !/^c\/o\b/i.test(s)) || '').replace(/,.*$/, '')
        .replace(/^(one|two|three|four|five|six|seven|eight|nine|ten)\b/i, w => words.indexOf(w.toLowerCase())).replace(/\s+(suite|ste|floor|fl|unit|#).*$/i, '');
      const zip = String(a.zipCode || '').slice(0, 5), city = [a.city, a.stateOrCountry].filter(Boolean).join(', ');
      return {
        name: d.name, sic: d.sic, industry: d.sicDescription || '', exchange: (d.exchanges || [])[0] || '',
        address: street && a.city ? `${street}, ${city} ${zip}`.trim() : '', place: a.city ? `${city} ${zip}`.trim() : '', city, filings,
      };
    },
  });
}

const facts = cik => get(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { source: 'SEC financials', ttl: DAY, pick: extractFacts });

// EDGAR full-text search over the company's 8-Ks and their press-release exhibits.
function fullText(cik, phrase, days = 365) {
  const q = new URLSearchParams({ q: `"${phrase}"`, ciks: cik, forms: '8-K', dateRange: 'custom', startdt: iso(Date.now() - days * DAY), enddt: iso(Date.now()) });
  return get(`https://efts.sec.gov/LATEST/search-index?${q}`, {
    source: 'SEC search', ttl: 12 * HOUR,
    pick: d => ({ total: d?.hits?.total?.value || 0, hits: (d?.hits?.hits || []).slice(0, 5).map(h => ({ date: h._source.file_date, form: h._source.form })) }),
  });
}

function prices(ticker) {
  return get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d`, {
    source: 'Prices', ttl: 20 * MIN, gap: 500, ua: WEB_UA,
    pick: d => {
      const r = d?.chart?.result?.[0];
      if (!r?.timestamp) return null;
      const q = r.indicators.quote[0], bars = [];
      r.timestamp.forEach((t, i) => {
        if (q.close[i] != null) bars.push({ d: iso(t * 1000), o: q.open[i] ?? q.close[i], h: q.high[i] ?? q.close[i], l: q.low[i] ?? q.close[i], c: q.close[i], v: q.volume[i] || 0 });
      });
      return bars;
    },
  });
}

const unescapeXml = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').trim();

function parseRss(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const tag = t => { const x = m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return x ? unescapeXml(x[1]) : ''; };
    let title = tag('title');
    const publisher = tag('source'), time = Date.parse(tag('pubDate'));
    if (publisher && title.endsWith(' - ' + publisher)) title = title.slice(0, -publisher.length - 3);
    if (title && time) out.push({ title, publisher, link: tag('link'), time });
  }
  return out.sort((a, b) => b.time - a.time).slice(0, 80);
}

function news(ticker, name) {
  const q = `"${shortName(name)}" (stock OR shares OR ${ticker}) when:21d`;
  return get(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`, { source: 'News', ttl: 20 * MIN, gap: 400, ua: WEB_UA, text: true, pick: parseRss });
}

// Market-wide headlines: Google News' business section plus a few searches for the events this app tracks.
const NEWS_FEEDS = ['https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en']
  .concat(['stock market today', 'merger OR acquisition OR takeover stock', 'FDA approval OR "clinical trial" stock', 'earnings beat OR miss OR guidance stock']
    .map(q => `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:2d')}&hl=en-US&gl=US&ceid=US:en`));
async function marketNews() {
  const lists = await Promise.all(NEWS_FEEDS.map(u => get(u, { source: 'News', ttl: 5 * MIN, gap: 400, ua: WEB_UA, text: true, pick: parseRss }).catch(() => [])));
  const seen = new Set(), out = [];
  for (const n of lists.flat().sort((a, b) => b.time - a.time)) {
    const key = n.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 70);
    if (!seen.has(key)) { seen.add(key); out.push(n); }
  }
  return out;
}

function trials(name) {
  const lead = shortName(name), first = lead.split(' ')[0].toLowerCase();
  const q = new URLSearchParams({
    'query.lead': lead, 'filter.advanced': 'AREA[Phase](PHASE2 OR PHASE3)',
    'filter.overallStatus': 'RECRUITING|ACTIVE_NOT_RECRUITING|NOT_YET_RECRUITING|ENROLLING_BY_INVITATION|COMPLETED',
    sort: 'LastUpdatePostDate:desc', pageSize: '100',
  });
  return get(`https://clinicaltrials.gov/api/v2/studies?${q}`, {
    source: 'ClinicalTrials.gov', ttl: DAY, ua: WEB_UA,
    pick: d => (d.studies || []).map(s => {
      const p = s.protocolSection || {}, st = p.statusModule || {};
      return {
        nct: p.identificationModule?.nctId, title: p.identificationModule?.briefTitle || '', status: st.overallStatus,
        date: st.primaryCompletionDateStruct?.date, dateType: st.primaryCompletionDateStruct?.type,
        phases: p.designModule?.phases || [], sponsor: p.sponsorCollaboratorsModule?.leadSponsor?.name || '',
        conditions: (p.conditionsModule?.conditions || []).slice(0, 3),
        drugs: (p.armsInterventionsModule?.interventions || []).filter(i => /DRUG|BIOLOGICAL|GENETIC/.test(i.type) && !/placebo/i.test(i.name)).map(i => i.name).slice(0, 3),
        hasResults: !!s.hasResults,
      };
    }).filter(t => t.nct && t.sponsor.toLowerCase().startsWith(first)),
  });
}

function approvals(name) {
  const search = encodeURIComponent(`openfda.manufacturer_name:"${shortName(name)}"`);
  return get(`https://api.fda.gov/drug/drugsfda.json?search=${search}&limit=99`, {
    source: 'openFDA', ttl: 7 * DAY,
    pick: d => (d.results || []).map(r => {
      const orig = (r.submissions || []).find(s => s.submission_type === 'ORIG' && s.submission_status === 'AP');
      return orig && { app: r.application_number, brand: r.products?.[0]?.brand_name || '', date: orig.submission_status_date || '' };
    }).filter(Boolean).sort((a, b) => (a.date < b.date ? 1 : -1)),
  });
}

// HQ coordinates: exact street match from the US Census geocoder, else the town from OpenStreetMap.
async function geocode(address, place) {
  let pos = null;
  if (address) {
    const q = new URLSearchParams({ address, benchmark: 'Public_AR_Current', format: 'json' });
    pos = await get(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${q}`, {
      source: 'Geocoder', ttl: 365 * DAY, gap: 300,
      pick: d => { const c = d?.result?.addressMatches?.[0]?.coordinates; return c ? { lat: c.y, lon: c.x } : null; },
    });
  }
  if (!pos && place) {
    const q = new URLSearchParams({ q: place, format: 'jsonv2', limit: '1' });
    pos = await get(`https://nominatim.openstreetmap.org/search?${q}`, {
      source: 'Geocoder', ttl: 365 * DAY, gap: 1100, ua: WEB_UA, // Nominatim allows 1 request a second
      pick: d => (d?.[0] ? { lat: +d[0].lat, lon: +d[0].lon } : null),
    });
  }
  return pos;
}

// Live ADS-B positions from adsb.lol (open data, readsb format).
const ADSB_GAP = +process.env.CATALYST_ADSB_GAP || 2000; // ms between requests; raise it if the feed rate-limits
const pickAircraft = d => (d.ac || []).filter(a => a.lat != null && a.lon != null).map(a => ({
  hex: a.hex, reg: a.r || '', type: a.t || '', flight: (a.flight || '').trim(), ground: a.alt_baro === 'ground',
  alt: a.alt_baro === 'ground' ? 0 : a.alt_baro ?? a.alt_geom ?? null, gs: a.gs ?? null, track: a.track ?? a.true_heading ?? null,
  lat: a.lat, lon: a.lon,
}));
const aircraftByType = type => get(`https://api.adsb.lol/v2/type/${type}`, { source: 'Aircraft', ttl: 3 * MIN, gap: ADSB_GAP, pick: pickAircraft });
const aircraftByReg = reg => get(`https://api.adsb.lol/v2/reg/${encodeURIComponent(reg)}`, { source: 'Aircraft', ttl: 3 * MIN, gap: ADSB_GAP, pick: pickAircraft });

// ---------- Sources that use a key you enter in Settings ----------

const num = v => (v == null || v === '' || Number.isNaN(+v) ? null : +v);
const optionsProvider = () => (settings.get('tradier') ? 'tradier' : settings.get('alphavantage') ? 'alphavantage' : null);
const tradierBase = () => (settings.get('tradierLive') ? 'https://api.tradier.com' : 'https://sandbox.tradier.com');
const tradierAuth = () => ({ Authorization: `Bearer ${settings.get('tradier')}` });
const apiMessage = d => String(d?.Information || d?.Note || d?.['Error Message'] || d?.fault?.faultstring || 'returned no data').slice(0, 160);

// Both providers are reduced to the same shape: { exp, type: 'C' | 'P', strike, bid, ask, last, iv, delta, vol, oi }
function normTradier(d) {
  const o = d?.options?.option;
  return (Array.isArray(o) ? o : o ? [o] : []).map(c => ({
    exp: c.expiration_date, type: c.option_type === 'call' ? 'C' : 'P', strike: +c.strike, bid: num(c.bid), ask: num(c.ask), last: num(c.last),
    iv: num(c.greeks?.mid_iv) || num(c.greeks?.smv_vol), delta: num(c.greeks?.delta), vol: +c.volume || 0, oi: +c.open_interest || 0,
  }));
}
function normAlphaVantage(d) {
  if (!Array.isArray(d?.data)) throw new Error(apiMessage(d));
  return d.data.map(c => ({
    exp: c.expiration, type: c.type === 'call' ? 'C' : 'P', strike: +c.strike, bid: num(c.bid), ask: num(c.ask), last: num(c.last) || num(c.mark),
    iv: num(c.implied_volatility), delta: num(c.delta), vol: +c.volume || 0, oi: +c.open_interest || 0,
  }));
}
// Alpha Vantage returns the whole chain (prior session) in one call; cached hard because the free tier is 25 calls a day.
const avChain = symbol => get(`https://www.alphavantage.co/query?function=HISTORICAL_OPTIONS&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(settings.get('alphavantage'))}`, { source: 'Options', ttl: 6 * HOUR, gap: 1200, ua: WEB_UA, pick: normAlphaVantage });

async function optionExpirations(symbol) {
  const today = iso(Date.now());
  if (optionsProvider() === 'tradier') {
    return get(`${tradierBase()}/v1/markets/options/expirations?symbol=${encodeURIComponent(symbol)}`, {
      source: 'Options', ttl: 6 * HOUR, gap: 600, ua: WEB_UA, headers: tradierAuth(),
      pick: d => [].concat(d?.expirations?.date || []).filter(x => x >= today),
    });
  }
  return [...new Set((await avChain(symbol)).map(c => c.exp))].filter(x => x >= today).sort();
}

async function optionChain(symbol, exp) {
  if (optionsProvider() === 'tradier') {
    const q = new URLSearchParams({ symbol, expiration: exp, greeks: 'true' });
    return get(`${tradierBase()}/v1/markets/options/chains?${q}`, { source: 'Options', ttl: 10 * MIN, gap: 600, ua: WEB_UA, headers: tradierAuth(), pick: normTradier });
  }
  return (await avChain(symbol)).filter(c => c.exp === exp);
}

// Finnhub: the next confirmed earnings date and the analyst EPS estimate.
function earningsCalendar(ticker) {
  const key = settings.get('finnhub');
  if (!key) return Promise.resolve(null);
  const today = iso(Date.now()), q = new URLSearchParams({ symbol: ticker, from: today, to: iso(Date.now() + 120 * DAY) });
  return get(`https://finnhub.io/api/v1/calendar/earnings?${q}`, {
    source: 'Finnhub', ttl: 12 * HOUR, gap: 1100, ua: WEB_UA, headers: { 'X-Finnhub-Token': key },
    pick: d => (d.earningsCalendar || []).filter(e => e.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1)).map(e => ({ date: e.date, epsEstimate: num(e.epsEstimate) }))[0] || null,
  });
}

// Alpha Vantage's own article-level sentiment, as a second opinion for the direction forecast (-1..+1).
function avSentiment(ticker) {
  const key = settings.get('alphavantage');
  if (!key) return Promise.resolve(null);
  return get(`https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${encodeURIComponent(ticker)}&limit=50&apikey=${encodeURIComponent(key)}`, {
    source: 'Alpha Vantage', ttl: 6 * HOUR, gap: 1200, ua: WEB_UA,
    pick: d => {
      if (!Array.isArray(d?.feed)) throw new Error(apiMessage(d));
      let w = 0, s = 0;
      for (const a of d.feed) for (const t of a.ticker_sentiment || []) {
        if (t.ticker === ticker) { const r = +t.relevance_score || 0; w += r; s += r * (+t.ticker_sentiment_score || 0); }
      }
      return w ? { score: clamp(s / w / 0.35, -1, 1), articles: d.feed.length } : null;
    },
  });
}

// One live call per provider so the Settings page can say whether a key works.
async function testProvider(p) {
  const hit = async (url, headers, problem) => {
    const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': WEB_UA, ...headers }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'the key was rejected' : r.status === 429 ? 'rate limit reached' : `HTTP ${r.status}`);
    const bad = problem(await r.json());
    if (bad) throw new Error(bad);
  };
  if (p === 'sec') return hit('https://data.sec.gov/submissions/CIK0000320193.json', { 'User-Agent': secUA() }, j => (j.name ? '' : 'unexpected response'));
  if (!settings.get(p)) throw new Error('no key saved yet');
  if (p === 'tradier') return hit(`${tradierBase()}/v1/markets/options/expirations?symbol=AAPL`, tradierAuth(), j => (j.expirations ? '' : apiMessage(j)));
  if (p === 'alphavantage') return hit(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=IBM&apikey=${encodeURIComponent(settings.get(p))}`, {}, j => (j['Global Quote'] ? '' : apiMessage(j)));
  if (p === 'finnhub') return hit('https://finnhub.io/api/v1/quote?symbol=AAPL', { 'X-Finnhub-Token': settings.get(p) }, j => (typeof j.c === 'number' ? '' : apiMessage(j)));
  throw new Error('unknown provider');
}

module.exports = { status, shortName, parseRss, resolve, submissions, facts, fullText, prices, news, marketNews, trials, approvals, geocode, aircraftByType, aircraftByReg, optionsProvider, normTradier, normAlphaVantage, optionExpirations, optionChain, earningsCalendar, avSentiment, testProvider };

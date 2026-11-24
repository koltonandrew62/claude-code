'use strict';
// Data sources — all free, no API keys. Each call is throttled per host, cached on disk,
// and falls back to the last good copy if the source is down.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractFacts, iso } = require('./signals');

const CACHE = process.env.CATALYST_CACHE || path.join(__dirname, '..', '.cache');
fs.mkdirSync(CACHE, { recursive: true });

// The SEC asks automated clients to identify themselves: set SEC_USER_AGENT="Your Name you@example.com".
const SEC_UA = process.env.SEC_USER_AGENT || 'CatalystDesk/1.0 (personal research tool)';
const WEB_UA = 'Mozilla/5.0 (compatible; CatalystDesk/1.0)';
const MIN = 6e4, HOUR = 36e5, DAY = 864e5;
const status = {}, inflight = new Map(), slot = {};

async function get(url, { source, ttl, gap = 150, ua = SEC_UA, text = false, pick = x => x }) {
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
      const res = await fetch(url, { headers: { 'User-Agent': ua, Accept: text ? '*/*' : 'application/json' }, signal: AbortSignal.timeout(20000) });
      let d = null;
      if (res.status !== 404) {
        if (!res.ok) throw new Error(res.status === 429 ? 'is rate limiting requests' : `returned HTTP ${res.status}`);
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
const pickAircraft = d => (d.ac || []).filter(a => a.lat != null && a.lon != null).map(a => ({
  hex: a.hex, reg: a.r || '', type: a.t || '', flight: (a.flight || '').trim(), ground: a.alt_baro === 'ground',
  alt: a.alt_baro === 'ground' ? 0 : a.alt_baro ?? a.alt_geom ?? null, gs: a.gs ?? null, track: a.track ?? a.true_heading ?? null,
  lat: a.lat, lon: a.lon,
}));
const aircraftByType = type => get(`https://api.adsb.lol/v2/type/${type}`, { source: 'Aircraft', ttl: 3 * MIN, gap: 2000, pick: pickAircraft });
const aircraftByReg = reg => get(`https://api.adsb.lol/v2/reg/${encodeURIComponent(reg)}`, { source: 'Aircraft', ttl: 3 * MIN, gap: 2000, pick: pickAircraft });

module.exports = { status, shortName, parseRss, resolve, submissions, facts, fullText, prices, news, trials, approvals, geocode, aircraftByType, aircraftByReg };

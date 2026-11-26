#!/usr/bin/env node
'use strict';
// Back end for the hosted edition. A hosted page cannot fetch outside data, so this runs the full Catalyst
// engine (SEC filings, clinical trials, FDA approvals, headlines, aircraft positions) for every ticker in
// web/universes.json and writes the results to web/dist/data/, which is published beside the page.
//   node web/feed.js        then publish web/dist

const fs = require('fs');
const path = require('path');
const { analyze } = require('../lib/analyze');
const src = require('../lib/sources');
const S = require('../lib/signals');
const jets = require('../lib/jets');
const universes = require('./universes.json');

const OUT = path.join(__dirname, 'dist', 'data');
const trim = (list, n) => (list || []).slice(0, n).map(e => ({ cat: e.cat, w: e.w, text: e.text, date: e.date, url: e.url }));
const newsLite = n => ({ score: n.score, label: n.label, pos: n.pos, neg: n.neg, neu: n.neu, count: n.count, buzz: n.buzz, items: n.items.slice(0, 8).map(i => ({ title: i.title, publisher: i.publisher, link: i.link, time: i.time, s: i.s, tags: i.tags })) });

async function one(t) {
  try {
    const r = await analyze(t);
    return {
      name: r.name, city: r.city, bio: r.bio, news: newsLite(r.news),
      merger: { score: r.merger.score, level: r.merger.level, pending: r.merger.pending, evidence: trim(r.merger.evidence, 7), marks: r.merger.marks.slice(0, 8) },
      fda: r.fda.applicable ? { applicable: true, score: r.fda.score, level: r.fda.level, approvals: r.fda.approvals, catalysts: r.fda.catalysts.slice(0, 8), evidence: trim(r.fda.evidence, 4) } : null,
      filings: r.filings.slice(0, 15), warnings: r.warnings,
    };
  } catch {
    // ETFs and anything else the SEC does not list as a company: headlines only
    const items = await src.news(t, t).catch(() => null);
    return items ? { name: t, news: newsLite(S.sentiment(items)) } : null;
  }
}

// Company logos. A hosted page cannot load images from other sites, so they are downloaded here and shipped
// inside one data file as data: URIs (which also keeps the publish to a handful of files).
async function logos(tickers) {
  const crypto = require('crypto'), got = {}, seen = {};
  const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
  const grab = async url => {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CatalystDesk/1.0)' }, signal: AbortSignal.timeout(15000) });
    const type = (r.headers.get('content-type') || '').split(';')[0].trim();
    if (!r.ok || !TYPES.includes(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > 200 && buf.length < 60000 ? { type, buf, hash: crypto.createHash('sha1').update(buf).digest('hex') } : null;
  };
  for (const t of tickers) {
    for (const url of [`https://assets.parqet.com/logos/symbol/${encodeURIComponent(t)}`, `https://financialmodelingprep.com/image-stock/${encodeURIComponent(t)}.png`]) {
      const img = await grab(url).catch(() => null);
      if (!img) continue;
      (seen[img.hash] ||= []).push(t);
      got[t] = img;
      break;
    }
    await new Promise(r => setTimeout(r, 150));
  }
  const out = {};
  for (const [t, img] of Object.entries(got)) {
    if (seen[img.hash].length >= 3) continue; // the same picture for several tickers is a placeholder, not a logo
    out[t] = `data:${img.type};base64,${img.buf.toString('base64')}`;
  }
  fs.writeFileSync(path.join(OUT, 'logos.json'), JSON.stringify(out));
  return Object.keys(out).length;
}

(async () => {
  // --jets-only re-sweeps the aircraft feed against the headquarters already on file, leaving feed.json alone
  const jetsOnly = process.argv.includes('--jets-only'), logosOnly = process.argv.includes('--logos-only');
  const tickers = [...new Set(Object.values(universes).flat())], out = {}, queue = jetsOnly || logosOnly ? [] : tickers.slice();
  fs.mkdirSync(OUT, { recursive: true });
  if (!jetsOnly) console.log(`logos: ${await logos(tickers)}/${tickers.length}`);
  if (logosOnly) process.exit(0);
  await Promise.all([1, 2, 3].map(async () => {
    while (queue.length) { const t = queue.shift(), r = await one(t); if (r) out[t] = r; process.stdout.write(`${r ? '.' : 'x'}`); }
  }));
  fs.mkdirSync(OUT, { recursive: true });
  if (!jetsOnly) fs.writeFileSync(path.join(OUT, 'feed.json'), JSON.stringify({ at: Date.now(), tickers: out }));

  // One sweep of the aircraft feed, measured against the headquarters just placed.
  jets.state();
  for (let i = 0; i < 240; i++) { await new Promise(r => setTimeout(r, 2000)); const s = jets.state(); if (!s.refreshing && s.at) break; }
  const st = jets.state(), r3 = x => Math.round(x * 1000) / 1000;
  fs.writeFileSync(path.join(OUT, 'jets.json'), JSON.stringify({
    at: st.at || Date.now(), partial: !!st.paused, radiusKm: st.radiusKm, hqs: st.hqs, near: st.near,
    jets: st.jets.map(a => [r3(a.lat), r3(a.lon), Math.round(a.track || 0), a.ground ? 1 : 0, a.reg, a.type, a.alt, Math.round(a.gs || 0), a.hex]),
  }));
  const failed = Object.entries(src.status).filter(([, v]) => !v.ok).map(([k, v]) => `${k} ${v.error}`);
  console.log(`\nfeed: ${Object.keys(out).length}/${tickers.length} tickers, ${Object.values(out).filter(v => v.fda).length} with FDA data, ${st.jets.length} jets${st.paused ? ' (partial: aircraft feed rate-limited)' : ''}, ${Object.keys(st.hqs).length} HQs${failed.length ? '\nsource problems: ' + failed.join('; ') : ''}`);
  process.exit(0);
})();

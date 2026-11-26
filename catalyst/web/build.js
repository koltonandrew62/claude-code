#!/usr/bin/env node
'use strict';
// Builds the hosted edition (web/dist/index.html): one self-contained page that reads live data through
// the viewer's Robinhood connector instead of the local server. Reuses the styles, charts and signal
// engine from the local app so the two editions cannot drift apart.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const local = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const between = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i + a.length); if (i < 0 || j < 0) throw new Error(`marker not found: ${a} / ${b}`); return s.slice(i + a.length, j); };
const swap = (s, a, b) => { if (!s.includes(a)) throw new Error(`text not found: ${a}`); return s.replace(a, b); };

let shared = '// ---------- Charts ----------' + between(local, '// ---------- Charts ----------', '// ---------- Detail ----------')
  + '// ---------- Direction forecast & options ----------' + between(local, '// ---------- Direction forecast & options ----------', 'function renderOptions() {');
shared = swap(shared, "data via ${ch.provider === 'tradier' ? 'Tradier' : 'Alpha Vantage (prior session)'}", 'live quotes via Robinhood');
shared = swap(shared, 'Technicals and news tilt the odds', 'Technicals tilt the odds');
shared = swap(shared, "'Model estimate for next quarter'", "'Analyst estimate for next quarter'");
shared = swap(shared, "'Quarter ending ' + esc(fDate(x.end, 1))", "'Reported ' + esc(fDate(x.end, 1))");

const fill = (s, tag, text) => { if (!s.includes(tag)) throw new Error(`placeholder missing: ${tag}`); return s.split(tag).join(text); };
let page = fs.readFileSync(path.join(__dirname, 'shell.html'), 'utf8');
page = fill(page, '/*CSS*/', between(local, '<style>', '</style>'));
page = fill(page, '/*SIGNALS*/', fs.readFileSync(path.join(root, 'lib/signals.js'), 'utf8'));
page = fill(page, '/*SHARED*/', shared);
page = fill(page, '/*UNIVERSES*/', JSON.stringify(require('./universes.json')));
if ((page.match(/<\/script>/g) || []).length !== 4) throw new Error('unexpected script terminator inside inlined code');
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist/index.html'), page);
fs.mkdirSync(path.join(__dirname, 'dist/vendor'), { recursive: true });
for (const f of ['leaflet.js', 'leaflet.css', 'topojson-client.min.js', 'countries-110m.json', 'states-10m.json', 'LEAFLET-LICENSE', 'TOPOJSON-LICENSE']) fs.copyFileSync(path.join(root, 'public/vendor', f), path.join(__dirname, 'dist/vendor', f));
console.log(`web/dist/index.html written (${(page.length / 1024).toFixed(0)} KB)`);

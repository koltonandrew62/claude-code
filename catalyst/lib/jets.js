'use strict';
// Jet tracker. Corporate aircraft showing up next to another company's headquarters is a classic
// deal-talk tell. This module keeps a live picture of large business jets, places analyzed
// companies' HQs on the map, and logs when a jet you have tagged to one company lands near another.

const fs = require('fs');
const path = require('path');
const src = require('./sources');
const { iso } = require('./signals');

const DATA = process.env.CATALYST_DATA || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA, { recursive: true });
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return d; } };
const save = (f, d) => fs.writeFile(path.join(DATA, f), JSON.stringify(d), () => {});

// ICAO type codes for the long-range and super-midsize jets corporate flight departments actually fly.
const TYPES = ['GLF4', 'GLF5', 'GLF6', 'GA5C', 'GA6C', 'GA7C', 'GLEX', 'GL5T', 'GL7T', 'CL30', 'CL35', 'CL60', 'C68A', 'C700', 'C750', 'C680', 'C56X', 'FA7X', 'FA8X', 'F900', 'F2TH', 'E55P', 'E545', 'E550', 'G280'];
const NEAR_KM = 40, DAY = 864e5, STALE = 240e3, COOL_DOWN = 10 * 6e4;

const fleet = load('fleet.json', {}); // { N123AB: { ticker: 'ACME' } } — tails you have tagged
const hqs = load('hq.json', {}); // { ACME: { name, city, lat, lon } }
const log = load('jetlog.json', { visits: [], traffic: {} });
let snap = { at: 0, jets: [], near: {}, complete: false }, refreshing = false, progress = 0, pausedUntil = 0;

function km(a, b) {
  const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

function setHQ(ticker, name, city, pos) {
  if (!pos || (hqs[ticker] && hqs[ticker].lat === pos.lat)) return;
  hqs[ticker] = { name, city, lat: pos.lat, lon: pos.lon };
  save('hq.json', hqs);
}

// Which jets are parked (or on short final) within NEAR_KM of a tracked HQ?
function detect(jets, now = Date.now()) {
  const near = {}, list = Object.entries(hqs);
  for (const a of jets) {
    a.owner = fleet[a.reg]?.ticker || null;
    if (!(a.ground || (a.alt != null && a.alt < 3000 && (a.gs ?? 0) < 200))) continue;
    for (const [t, h] of list) {
      const d = Math.round(km(a, h));
      if (d > NEAR_KM) continue;
      (near[t] ||= []).push({ reg: a.reg, hex: a.hex, type: a.type, km: d, owner: a.owner });
      const logged = log.visits.some(v => v.reg === a.reg && v.hq === t && now - v.time < DAY);
      if (a.owner && a.owner !== t && !logged) log.visits.unshift({ time: now, reg: a.reg, type: a.type, owner: a.owner, hq: t, km: d });
    }
  }
  for (const [t] of list) { const s = (log.traffic[t] ||= { n: 0, sum: 0 }); s.n++; s.sum += (near[t] || []).length; }
  log.visits = log.visits.slice(0, 500);
  save('jetlog.json', log);
  return near;
}

async function refresh() {
  refreshing = true; progress = 0;
  const seen = new Map(), scanned = new Set();
  try {
    for (const t of TYPES) {
      try { for (const a of (await src.aircraftByType(t)) || []) seen.set(a.hex, a); scanned.add(t); } catch (e) {
        if (/rate limit/.test(e.message)) { pausedUntil = Date.now() + COOL_DOWN; break; } // back off instead of hammering the feed
      }
      progress++;
      if (!snap.complete) snap = { ...snap, jets: [...seen.values()] }; // show partial results on the first scan
    }
    const known = new Set([...seen.values()].map(a => a.reg));
    for (const reg of Object.keys(fleet)) { // tagged tails of a type outside the list above
      if (known.has(reg)) continue;
      try { for (const a of (await src.aircraftByReg(reg)) || []) seen.set(a.hex, a); } catch {}
    }
    for (const a of snap.jets) if (!scanned.has(a.type) && !seen.has(a.hex)) seen.set(a.hex, a); // keep what an interrupted scan missed
    const jets = [...seen.values()];
    snap = { at: Date.now(), jets, near: detect(jets), complete: true };
  } finally { refreshing = false; }
}

function state() {
  if (!refreshing && Date.now() > pausedUntil && Date.now() - snap.at > STALE) refresh().catch(() => {});
  return { at: snap.at, refreshing, paused: Date.now() < pausedUntil, progress: refreshing ? progress / TYPES.length : 1, jets: snap.jets, near: snap.near, hqs, fleet, visits: log.visits.slice(0, 50), radiusKm: NEAR_KM };
}

// Jet evidence for a ticker's M&A score.
function eventsFor(ticker, now = Date.now()) {
  const out = [];
  for (const v of log.visits) {
    if (now - v.time > 30 * DAY) break;
    if (v.hq === ticker) out.push({ w: 18, date: iso(v.time), text: `Jet ${v.reg}, tagged to ${v.owner}, was on the ground ${v.km} km from headquarters` });
    else if (v.owner === ticker) out.push({ w: 10, date: iso(v.time), text: `Company-tagged jet ${v.reg} was on the ground ${v.km} km from ${v.hq}'s headquarters` });
  }
  const s = log.traffic[ticker], cur = snap.complete ? (snap.near[ticker] || []).length : null;
  if (s && s.n >= 20 && cur != null) {
    const avg = s.sum / s.n;
    if (cur >= avg + 3 && cur >= 2 * avg) out.push({ w: 8, date: iso(now), text: `Unusual business-jet traffic near headquarters: ${cur} on the ground vs ${avg.toFixed(1)} typically` });
  }
  return out.slice(0, 4);
}

function tag(reg, ticker) {
  fleet[reg] = { ticker };
  for (const a of snap.jets) if (a.reg === reg) a.owner = ticker;
  save('fleet.json', fleet);
}
function untag(reg) { delete fleet[reg]; save('fleet.json', fleet); }

module.exports = { TYPES, km, setHQ, detect, state, eventsFor, tag, untag, _state: { fleet, hqs, log } };

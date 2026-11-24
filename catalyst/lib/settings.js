'use strict';
// API keys you enter in the app. Stored only on this computer, in data/settings.json (git-ignored).

const fs = require('fs');
const path = require('path');

const DATA = process.env.CATALYST_DATA || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA, { recursive: true });
const FILE = path.join(DATA, 'settings.json');
const FIELDS = ['secContact', 'tradier', 'tradierLive', 'alphavantage', 'finnhub'];

let cur = {};
try { cur = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}

const get = k => cur[k] || '';

function set(patch) {
  for (const k of FIELDS) {
    if (!(k in patch)) continue;
    const v = String(patch[k] ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200);
    if (v && v !== 'false') cur[k] = v; else delete cur[k];
  }
  fs.writeFileSync(FILE, JSON.stringify(cur), { mode: 0o600 });
}

// What the browser is allowed to see: keys are masked, never sent back in full.
const mask = v => (v ? '••••' + v.slice(-4) : '');
const view = () => ({ secContact: get('secContact'), tradier: mask(get('tradier')), tradierLive: !!get('tradierLive'), alphavantage: mask(get('alphavantage')), finnhub: mask(get('finnhub')) });

module.exports = { get, set, view };

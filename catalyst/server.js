#!/usr/bin/env node
'use strict';
// Catalyst — event radar and screener. Zero dependencies: `node server.js`, then open http://localhost:4173

const http = require('http');
const fs = require('fs');
const path = require('path');
const { analyze, predict, clear } = require('./lib/analyze');
const settings = require('./lib/settings');
const src = require('./lib/sources');
const jets = require('./lib/jets');
const universes = require('./lib/universes');

const PORT = +process.env.PORT || 4173;
const URL_HOME = `http://localhost:${PORT}`;
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const TICKER = /^[A-Z0-9]{1,6}([.-][A-Z]{1,2})?$/;
const TAIL = /^[A-Z0-9][A-Z0-9-]{1,8}$/;

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const fail = (status, message) => Object.assign(new Error(message), { status });
// Foreign listings keep their exchange suffix (7203.T, SAP.DE, 0700.HK); US share classes use a dash (BRK-B).
const FOREIGN = /\.(T|HK|L|DE|F|PA|AS|MI|MC|SW|ST|CO|OL|HE|BR|LS|VI|KS|KQ|TW|SS|SZ|SI|AX|NZ|NS|BO|TO)$/;
const ticker = v => { let t = String(v || '').trim().toUpperCase(); if (!FOREIGN.test(t)) t = t.replace('.', '-'); if (!TICKER.test(t)) throw fail(400, 'Enter a valid ticker symbol'); return t; };
const tail = v => { const t = String(v || '').trim().toUpperCase(); if (!TAIL.test(t)) throw fail(400, 'Enter a valid tail number'); return t; };

function body(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 2048) reject(fail(413, 'Request too large')); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { reject(fail(400, 'Invalid JSON')); } });
  });
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (req.method !== 'GET') { // only this page may change local state
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw fail(403, 'Cross-origin request refused');
    }
    if (u.pathname === '/api/analyze') return json(res, 200, await analyze(ticker(u.searchParams.get('ticker'))));
    if (u.pathname === '/api/predict') { const exp = u.searchParams.get('exp') || ''; return json(res, 200, await predict(ticker(u.searchParams.get('symbol')), /^\d{4}-\d\d-\d\d$/.test(exp) ? exp : '')); }
    if (u.pathname === '/api/settings' && req.method === 'GET') return json(res, 200, settings.view());
    if (u.pathname === '/api/settings' && req.method === 'POST') { settings.set(await body(req)); clear(); return json(res, 200, settings.view()); }
    if (u.pathname === '/api/settings/test' && req.method === 'POST') {
      const { provider } = await body(req);
      try { await src.testProvider(String(provider)); return json(res, 200, { ok: true }); } catch (e) { return json(res, 200, { ok: false, error: e.name === 'TimeoutError' ? 'timed out' : e.message === 'fetch failed' ? 'could not reach the service' : e.message }); }
    }
    if (u.pathname === '/api/universes') return json(res, 200, universes);
    if (u.pathname === '/api/status') return json(res, 200, src.status);
    if (u.pathname === '/api/jets') return json(res, 200, jets.state());
    if (u.pathname === '/api/fleet' && req.method === 'POST') { const b = await body(req); jets.tag(tail(b.reg), ticker(b.ticker)); return json(res, 200, { ok: true }); }
    if (u.pathname === '/api/fleet' && req.method === 'DELETE') { jets.untag(tail(u.searchParams.get('reg'))); return json(res, 200, { ok: true }); }
    if (u.pathname.startsWith('/api/')) throw fail(404, 'Unknown endpoint');

    const file = path.normalize(path.join(PUB, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname)));
    if (!file.startsWith(PUB + path.sep)) throw fail(403, 'Forbidden');
    fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    json(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong on the server' });
    if (!e.status) console.error(e);
  }
}).on('error', e => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.log(`Port ${PORT} is already in use — Catalyst is probably already running at ${URL_HOME}`);
  openBrowser(); // a second double-click on the shortcut just brings the app up again
}).listen(PORT, '127.0.0.1', () => { console.log(`Catalyst is running at ${URL_HOME}`); openBrowser(); });

// `--open` (used by the desktop shortcut) also opens the app in your default browser.
function openBrowser() {
  if (!process.argv.includes('--open')) return;
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', URL_HOME]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [URL_HOME]];
  require('child_process').spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

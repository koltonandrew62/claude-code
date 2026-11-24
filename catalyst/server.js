#!/usr/bin/env node
'use strict';
// Catalyst — event radar and screener. Zero dependencies: `node server.js`, then open http://localhost:4173

const http = require('http');
const fs = require('fs');
const path = require('path');
const { analyze } = require('./lib/analyze');
const src = require('./lib/sources');
const jets = require('./lib/jets');
const universes = require('./lib/universes');

const PORT = +process.env.PORT || 4173;
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const TICKER = /^[A-Z0-9]{1,6}([.-][A-Z]{1,2})?$/;
const TAIL = /^[A-Z0-9][A-Z0-9-]{1,8}$/;

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const fail = (status, message) => Object.assign(new Error(message), { status });
const ticker = v => { const t = String(v || '').trim().toUpperCase().replace('.', '-'); if (!TICKER.test(t)) throw fail(400, 'Enter a valid ticker symbol'); return t; };
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
}).listen(PORT, '127.0.0.1', () => console.log(`Catalyst is running at http://localhost:${PORT}`));

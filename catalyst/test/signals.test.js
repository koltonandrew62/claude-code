'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/signals');
const { parseRss, shortName, normTradier, normAlphaVantage } = require('../lib/sources');

const NOW = Date.parse('2026-11-24T15:00:00Z');
const filing = (form, date, extra = {}) => ({ form, date, items: '', file: '', desc: '', url: 'https://example.test', ...extra });

test('quarterly derives Q4 from the annual figure', () => {
  const q = (start, end, val) => ({ start, end, val, filed: end });
  const rows = [q('2025-01-01', '2025-03-31', 10), q('2025-04-01', '2025-06-30', 12), q('2025-07-01', '2025-09-30', 14), q('2025-01-01', '2025-09-30', 36), q('2025-01-01', '2025-12-31', 50)];
  assert.deepStrictEqual(S.quarterly(rows).map(x => x.val), [10, 12, 14, 14]);
});

test('sentiment scores tone, tags topics and drops fund-holdings noise', () => {
  const n = title => ({ title, publisher: 'Wire', link: 'https://example.test', time: NOW - 36e5 });
  const s = S.sentiment([n('Acme beats estimates and raises guidance'), n('Acme shares plunge after FDA rejects drug'), n('Acme Corp Shares Sold by Example Advisors LLC'), n('Acme agrees to be acquired in $4B takeover')], NOW);
  assert.strictEqual(s.count, 3);
  assert.strictEqual(s.pos, 1);
  assert.strictEqual(s.neg, 1);
  assert.ok(s.items.find(x => /takeover/.test(x.title)).tags.includes('M&A'));
  assert.ok(s.items.find(x => /FDA/.test(x.title)).tags.includes('FDA'));
  assert.deepStrictEqual(S.sentiment([n('2 Growth Stocks to Buy in December')], NOW).items[0].tags, []);
});

test('earnings projects the next report date and measures past reactions', () => {
  const dates = ['2025-11-04', '2026-02-10', '2026-05-05', '2026-08-04', '2026-11-03'];
  const filings = dates.map(d => filing('8-K', d, { items: '2.02,9.01' })).reverse();
  const bars = [['2026-10-30', 100], ['2026-11-02', 100], ['2026-11-03', 104], ['2026-11-04', 110], ['2026-11-05', 111]].map(([d, c]) => ({ d, o: c, h: c, l: c, c, v: 1 }));
  const e = S.earnings({ filings, bars, facts: null, tech: null, sent: null }, NOW);
  assert.strictEqual(e.nextDate, '2027-02-09'); // Feb 10 report + 52 weeks
  assert.strictEqual(e.history.length, 1);
  assert.ok(Math.abs(e.history[0].move - 0.1) < 1e-9); // close before (100) -> close after (110)
});

test('merger separates filings about the company from filings it made about others', () => {
  const own = { file: '005-11111' };
  const base = [filing('SC 13G/A', '2026-02-10', own), filing('SC 13G', '2025-02-10', own)];
  const asHolder = S.merger({ filings: [filing('SC 13D', '2026-10-01'), ...base] }, NOW);
  assert.strictEqual(asHolder.score, 0);
  const asTarget = S.merger({ filings: [filing('SCHEDULE 13D', '2026-10-01', own), ...base] }, NOW);
  assert.ok(asTarget.score >= 20 && !asTarget.pending);
  const deal = S.merger({ filings: [filing('SC 14D9', '2026-11-01', own), ...base] }, NOW);
  assert.ok(deal.pending && deal.score >= 92);
  const bidder = S.merger({ filings: [filing('SC TO-T', '2026-11-01'), ...base] }, NOW);
  assert.ok(!bidder.pending);
});

test('fda scores a near-term Phase 3 readout and ignores non-drug companies', () => {
  const trial = { nct: 'NCT00000001', title: 'Study of drug X', status: 'ACTIVE_NOT_RECRUITING', date: '2026-12-10', dateType: 'ESTIMATED', phases: ['PHASE3'], conditions: ['Cystic Fibrosis'], drugs: ['Drug X'], hasResults: false };
  const f = S.fda({ sic: '2834', mcap: 8e8, trials: [trial], approvals: [], sent: null }, NOW);
  assert.ok(f.applicable && f.score >= 90);
  assert.ok(f.catalysts[0].odds > 0.5 && f.catalysts[0].odds < 0.65);
  assert.strictEqual(S.fda({ sic: '7372', mcap: 8e8, trials: null, approvals: null, sent: null }, NOW).applicable, false);
});

test('source helpers clean company names and parse RSS', () => {
  assert.strictEqual(shortName('VERTEX PHARMACEUTICALS INC / MA'), 'VERTEX PHARMACEUTICALS');
  assert.strictEqual(shortName('Eli Lilly & Co'), 'Eli Lilly');
  const items = parseRss('<rss><item><title>Acme &amp; Co soars - Wire</title><link>https://example.test/a</link><pubDate>Mon, 23 Nov 2026 10:00:00 GMT</pubDate><source url="https://example.test">Wire</source></item></rss>');
  assert.deepStrictEqual(items.map(i => [i.title, i.publisher]), [['Acme & Co soars', 'Wire']]);
});

test('forecast leans up in an uptrend, down in a downtrend, and abstains without history', () => {
  const series = drift => {
    let p = 100;
    return Array.from({ length: 400 }, (_, i) => { p *= 1 + drift + 0.01 * Math.sin(i * 1.7); return { d: S.iso(NOW - (400 - i) * 864e5), o: p, h: p, l: p, c: p, v: 1e6 }; });
  };
  const up = S.forecast(series(0.002), null), down = S.forecast(series(-0.002), null);
  assert.ok(up.pUp > 0.55 && up.verdict === 'Up' && up.high > up.low);
  assert.ok(down.pUp < 0.45 && down.verdict === 'Down');
  assert.strictEqual(S.forecast(series(0.002).slice(0, 100), null), null);
});

test('options marking: a bullish forecast turns the at-the-money call green and put red; no edge leaves both red', () => {
  const contracts = [90, 100, 110].flatMap(strike => ['C', 'P'].map(type => ({ exp: '2026-12-18', type, strike, bid: 1, ask: 1.2, last: 1.1, iv: 0.4, delta: 0.5, vol: 10, oi: 100 })));
  const base = { last: 100, horizon: 5, dailySigma: 0.02 };
  const bull = S.markOptions(contracts, { ...base, expRet: 0.03 }, '2026-12-18', NOW).rows.find(r => r.strike === 100);
  assert.ok(bull.call.up && bull.call.change > 0 && !bull.put.up);
  assert.strictEqual(bull.call.mid, 1.1);
  const flat = S.markOptions(contracts, { ...base, expRet: 0 }, '2026-12-18', NOW);
  const atm = flat.rows.find(r => r.strike === 100);
  assert.ok(!atm.call.up && !atm.put.up); // implied vol above realized: time decay wins on both sides
  assert.deepStrictEqual(flat.rows.map(r => r.strike), [90, 100, 110]);
  assert.ok(Math.abs(S.bs(100, 100, 1, 0.2, true) - 7.966) < 0.01); // textbook Black-Scholes value at zero rates
});

test('outlook blends technical, fundamental and news scores and rebalances when one is missing', () => {
  const fc = { tech: 0.5 }, bullish = { count: 10, score: 60 };
  const full = S.outlook({ fc, epsYoY: 0.4, beatRate: 0.75, analyst: { buy: 18, hold: 4, sell: 1, target: 130 }, last: 100, sent: bullish });
  assert.strictEqual(full.technical, 80);
  assert.ok(full.fundamental > 50 && full.news === 60 && full.score > 60 && full.label === 'Strongly bullish');
  const techOnly = S.outlook({ fc: { tech: -0.5 }, last: 100, sent: null });
  assert.deepStrictEqual([techOnly.score, techOnly.fundamental, techOnly.news, techOnly.label], [-80, null, null, 'Strongly bearish']);
  assert.strictEqual(S.outlook({ fc: null, last: 100, sent: null }), null);
});

test('price ranges nest, widen with the horizon, and lean with the outlook score', () => {
  let p = 100, seed = 42;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647; // fixed-seed random walk, so the test is repeatable
  const bars = Array.from({ length: 500 }, (_, i) => { p *= 1 + (rnd() - 0.5) * 0.04; return { d: S.iso(NOW - (500 - i) * 864e5), o: p, h: p, l: p, c: p, v: 1 }; });
  const flat = S.ranges(bars, 0), bull = S.ranges(bars, 100);
  for (const r of flat) assert.ok(r.lo90 <= r.lo68 && r.lo68 < r.expected && r.expected < r.hi68 && r.hi68 <= r.hi90);
  assert.ok(flat[2].hi90 / flat[2].lo90 > flat[0].hi90 / flat[0].lo90); // three months is wider than one week
  assert.ok(bull[1].expected > flat[1].expected);
  assert.deepStrictEqual(flat.map(r => r.days), [5, 21, 63]);
  assert.strictEqual(S.ranges(bars.slice(0, 100)), null);
});

test('option chain normalizers accept Tradier and Alpha Vantage payloads', () => {
  const t = normTradier({ options: { option: [{ expiration_date: '2026-12-18', option_type: 'put', strike: 16, bid: 0.1, ask: 0.2, last: null, volume: 3, open_interest: 10, greeks: { delta: -0.2, mid_iv: 0.38 } }] } });
  assert.deepStrictEqual(t[0], { exp: '2026-12-18', type: 'P', strike: 16, bid: 0.1, ask: 0.2, last: null, iv: 0.38, delta: -0.2, vol: 3, oi: 10 });
  const a = normAlphaVantage({ data: [{ expiration: '2026-12-18', strike: '50.00', type: 'call', last: '1.10', mark: '1.15', bid: '1.10', ask: '1.20', volume: '5', open_interest: '7', implied_volatility: '0.31', delta: '0.52' }] });
  assert.deepStrictEqual(a[0], { exp: '2026-12-18', type: 'C', strike: 50, bid: 1.1, ask: 1.2, last: 1.1, iv: 0.31, delta: 0.52, vol: 5, oi: 7 });
  assert.throws(() => normAlphaVantage({ Information: 'rate limit reached' }), /rate limit/);
});

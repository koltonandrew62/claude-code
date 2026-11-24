'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/signals');
const { parseRss, shortName } = require('../lib/sources');

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

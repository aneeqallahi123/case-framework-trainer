// Run with: node --test tests/analytics.test.js
// Loads the pure analytics block straight out of index.html so the tests cover the shipped code.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/\/\* ANALYTICS:BEGIN[^\n]*\n([\s\S]*?)\/\* ANALYTICS:END \*\//);
assert.ok(m, 'analytics block markers not found in index.html');
const A = new Function(m[1] + '\nreturn {normLevel,normLevels,dedupeReruns,startOfWeek,startOfMonth,periodStats,compareStats,weeklySeries,reviewPeriods,verdict,buildActionPlan,weekSummaryLine,READY_PCT};')();

const CRITS = ['Structure', 'MECE', 'Succinct', 'Relevant'];
const DAY = 86400000;
// Wednesday 2026-10-14 12:00 local
const NOW = new Date(2026, 9, 14, 12).getTime();
const at = (daysAgo, extra) => Object.assign({ ts: NOW - daysAgo * DAY, id: 'c' + daysAgo, title: 'Case ' + daysAgo, type: 'growth', pct: 50, levels: { Structure: 1, MECE: 1, Succinct: 1, Relevant: 1 } }, extra);

test('normLevel handles server strings, local numbers and junk', () => {
  assert.strictEqual(A.normLevel('strong'), 2);
  assert.strictEqual(A.normLevel('ok'), 1);
  assert.strictEqual(A.normLevel('weak'), 0);
  assert.strictEqual(A.normLevel(2), 2);
  assert.strictEqual(A.normLevel('constructor'), null);
  assert.strictEqual(A.normLevel(null), null);
  assert.deepStrictEqual(A.normLevels({ MECE: 'strong', Structure: 0, X: 'bogus' }), { MECE: 2, Structure: 0 });
});

test('string levels no longer produce NaN criterion averages', () => {
  const h = [at(1, { levels: A.normLevels({ Structure: 'strong', MECE: 'weak' }) })];
  const s = A.periodStats(h, 0, NOW + 1, CRITS);
  assert.strictEqual(s.crit.Structure, 100);
  assert.strictEqual(s.crit.MECE, 0);
  assert.strictEqual(s.crit.Succinct, null);
});

test('dedupeReruns keeps only the latest run of the same case within the window', () => {
  const t = NOW;
  const out = A.dedupeReruns([{ ts: t, id: 'a', pct: 25 }, { ts: t + 60000, id: 'a', pct: 63 }, { ts: t + 3 * 3600000, id: 'a', pct: 75 }, { ts: t + 3 * 3600000 + 1000, id: 'b', pct: 50 }]);
  assert.deepStrictEqual(out.map(x => x.pct), [63, 75, 50]);
});

test('weeks start on Monday and months on the 1st', () => {
  assert.strictEqual(new Date(A.startOfWeek(NOW)).getDay(), 1);
  assert.strictEqual(new Date(A.startOfWeek(NOW)).getDate(), 12);
  const sunday = new Date(2026, 9, 11, 23, 59).getTime();
  assert.strictEqual(new Date(A.startOfWeek(sunday)).getDate(), 5);
  assert.strictEqual(new Date(A.startOfMonth(NOW)).getDate(), 1);
  assert.strictEqual(new Date(A.startOfMonth(NOW, 1)).getMonth(), 8);
});

test('last week vs the week before, with the boundary exact', () => {
  const P = A.reviewPeriods(NOW); // lastWeek = Mon 5 Oct .. Mon 12 Oct (exclusive)
  const h = [
    { ts: new Date(2026, 9, 5, 0, 0).getTime(), id: 'a', pct: 75, type: 'growth', levels: {} },  // first instant of last week
    { ts: new Date(2026, 9, 11, 23, 59).getTime(), id: 'b', pct: 63, type: 'growth', levels: {} },
    { ts: new Date(2026, 9, 12, 0, 0).getTime(), id: 'c', pct: 100, type: 'growth', levels: {} }, // this week
    { ts: new Date(2026, 9, 4, 23, 59).getTime(), id: 'd', pct: 38, type: 'growth', levels: {} }, // week before
  ];
  const lw = A.periodStats(h, ...P.lastWeek, CRITS), wb = A.periodStats(h, ...P.weekBefore, CRITS);
  assert.strictEqual(lw.drills, 2);
  assert.strictEqual(lw.avg, 69);
  assert.strictEqual(wb.drills, 1);
  const v = A.verdict(lw, wb, 'last week', 'the week before');
  assert.strictEqual(v.tone, 'up');
  assert.match(v.text, /up 31 points/);
});

test('month-to-date compares against the same elapsed span of the previous month', () => {
  const P = A.reviewPeriods(NOW); // Oct 1 .. Oct 14 12:00 vs Sep 1 .. Sep 14 12:00
  assert.strictEqual(new Date(P.prevMonth[0]).getMonth(), 8);
  assert.ok(P.prevMonth[1] <= P.month[0]);
  const early = new Date(2026, 8, 10).getTime(), late = new Date(2026, 8, 25).getTime();
  const s = A.periodStats([{ ts: early, pct: 50, levels: {} }, { ts: late, pct: 100, levels: {} }], ...P.prevMonth, CRITS);
  assert.strictEqual(s.drills, 1);
});

test('month-to-date window is clamped when this month is longer than the last', () => {
  const now = new Date(2026, 2, 31, 12).getTime(); // 31 Mar vs a 28-day February
  const P = A.reviewPeriods(now);
  assert.strictEqual(P.prevMonth[1], A.startOfMonth(now));
});

test('verdict covers empty and first-period cases', () => {
  const empty = A.periodStats([], 0, 1, CRITS);
  assert.strictEqual(A.verdict(empty, empty, 'last week', 'the week before').tone, 'none');
  const one = A.periodStats([{ ts: 0, pct: 50, levels: {} }], -1, 1, CRITS);
  assert.match(A.verdict(one, empty, 'last week', 'the week before').text, /Nothing the week before/);
  assert.match(A.verdict(empty, one, 'last week', 'the week before').text, /No drills last week/);
  const flat = A.verdict(one, one, 'x', 'y');
  assert.strictEqual(flat.tone, 'flat');
});

test('weeklySeries returns one bucket per week, oldest first, with gaps as null', () => {
  const h = [at(1), at(22)];
  const s = A.weeklySeries(h, 4, NOW);
  assert.strictEqual(s.length, 4);
  assert.ok(s[0].start < s[3].start);
  assert.deepStrictEqual(s.map(x => x.n), [1, 0, 0, 1]);
  assert.strictEqual(s[1].avg, null);
});

test('empty history yields no plan and no summary line', () => {
  assert.deepStrictEqual(A.buildActionPlan([], { now: NOW, crits: CRITS }), []);
  assert.strictEqual(A.weekSummaryLine([], NOW, CRITS), '');
});

test('action plan: ranked, capped at 10, themed and explainable', () => {
  const types = ['growth', 'pricing', 'ma', 'sizing', 'operations'];
  const h = [];
  for (let i = 1; i <= 12; i++) h.push(at(i, { pct: 25, type: i % 2 ? 'growth' : 'pricing', levels: { Structure: 2, MECE: 0, Succinct: 1, Relevant: 0 } }));
  const plan = A.buildActionPlan(h, { now: NOW, crits: CRITS, types, typeLabel: t => t, weakAdvice: { MECE: 'Cover every dimension.' } });
  assert.ok(plan.length > 0 && plan.length <= 10);
  assert.deepStrictEqual(plan.map(p => p.rank), plan.map((_, i) => i + 1));
  for (let i = 1; i < plan.length; i++) assert.ok(plan[i - 1].score >= plan[i].score);
  assert.strictEqual(new Set(plan.map(p => p.key)).size, plan.length);
  assert.ok(plan.some(p => p.key === 'crit:MECE' && p.next === 'Cover every dimension.'));
  assert.ok(!plan.some(p => p.key === 'crit:Structure'), 'a strong criterion should not be flagged');
  assert.ok(plan.some(p => p.key === 'new:ma' && p.action.type === 'ma'));
  plan.forEach(p => { assert.ok(p.title && p.why && p.next); });
});

test('action plan: a lapse in practice and a new account both surface the right item', () => {
  const lapsed = A.buildActionPlan([at(9, { pct: 88 })], { now: NOW, crits: CRITS, types: [] });
  assert.ok(lapsed.some(p => p.key === 'consistency'));
  assert.ok(lapsed.some(p => p.key === 'baseline'));
});

test('action plan: only the latest attempt of a case decides whether to retry it', () => {
  const h = [at(10, { id: 'x', pct: 13 }), at(2, { id: 'x', pct: 88 }), at(3, { id: 'y', pct: 25 })];
  const plan = A.buildActionPlan(h, { now: NOW, crits: CRITS, types: [] });
  assert.ok(!plan.some(p => p.key === 'retry:x'));
  assert.ok(plan.some(p => p.key === 'retry:y' && p.action.caseId === 'y'));
});

test('slipping criterion is flagged when it drops 10+ points vs the prior fortnight', () => {
  const good = { Structure: 2, MECE: 2, Succinct: 2, Relevant: 2 }, bad = { Structure: 2, MECE: 0, Succinct: 2, Relevant: 2 };
  const h = [at(20, { levels: good }), at(18, { levels: good }), at(5, { levels: bad }), at(3, { levels: bad })];
  const plan = A.buildActionPlan(h, { now: NOW, crits: CRITS, types: [] });
  assert.ok(plan.some(p => p.key === 'slip:MECE'));
});

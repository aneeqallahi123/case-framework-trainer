// Run with: node --test tests/scoring.test.js
// Loads the pure scoring block straight out of index.html so the tests cover the shipped code.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/\/\* SCORING:BEGIN[^\n]*\n([\s\S]*?)\/\* SCORING:END \*\//);
assert.ok(m, 'scoring block markers not found in index.html');
const { reviewFramework, parseStructure, applyJudgement } = new Function(m[1] + '\nreturn {reviewFramework,parseStructure,applyJudgement};')();

const CASE = { type: 'growth', meceDimensions: [], caseKeywords: ['acme'] };

// n buckets of k short points each. Every bullet is "acme <unique-token>" so Relevant is strong,
// buckets share no words (MECE strong) and nothing runs long (Succinct strong).
function framework(n, k) {
  let id = 0;
  return Array.from({ length: n }, (_, i) => ({
    header: 'zbucket' + i,
    bullets: Array.from({ length: k }, () => 'acme zq' + id++ + 'x')
  }));
}
const level = (r, name) => r.crits.find(c => c.name === name).level;
const longPoint = words => Array.from({ length: words }, (_, i) => 'w' + i).join(' ');

test('a well-formed framework scores strong on every criterion', () => {
  const r = reviewFramework(framework(4, 4), CASE, {});
  assert.deepStrictEqual(r.crits.map(c => c.level), ['strong', 'strong', 'strong', 'strong']);
  assert.strictEqual(r.pct, 100);
  assert.match(r.overall, /Interview-ready/);
});

test('Succinct: all three tiers are reachable (strong, ok, weak)', () => {
  const withLong = n => { const f = framework(4, 4); for (let i = 0; i < n; i++) f[0].bullets[i] = longPoint(15); return f; };
  assert.strictEqual(level(reviewFramework(withLong(0), CASE, {}), 'Succinct'), 'strong');
  assert.strictEqual(level(reviewFramework(withLong(1), CASE, {}), 'Succinct'), 'strong');
  assert.strictEqual(level(reviewFramework(withLong(2), CASE, {}), 'Succinct'), 'ok');
  assert.strictEqual(level(reviewFramework(withLong(3), CASE, {}), 'Succinct'), 'weak');
});

test('Succinct: "under 12 words" means a 12-word point runs long', () => {
  const f = framework(4, 4);
  f[0].bullets[0] = longPoint(11);
  assert.strictEqual(reviewFramework(f, CASE, {}).crits[2].notes.some(n => /run long/.test(n)), false);
  f[0].bullets[0] = longPoint(12);
  assert.strictEqual(reviewFramework(f, CASE, {}).crits[2].notes.some(n => /run long/.test(n)), true);
});

test('Succinct: clamps the ok tier so a misconfigured threshold cannot hide it', () => {
  const f = framework(4, 4);
  f[0].bullets[0] = longPoint(15);
  f[0].bullets[1] = longPoint(15);
  // maxLongPointsBeforeOk >= maxLongPointsBeforeWeak would make "ok" unreachable if used literally
  const cfg = { Succinct: { maxLongPointsBeforeOk: 3, maxLongPointsBeforeWeak: 3 } };
  assert.strictEqual(level(reviewFramework(f, CASE, cfg), 'Succinct'), 'ok');
});

test('Structure: half or more buckets under the minimum is weak, fewer is ok', () => {
  assert.strictEqual(level(reviewFramework(framework(3, 1), CASE, {}), 'Structure'), 'weak');
  const f = framework(4, 4);
  f[0].bullets = f[0].bullets.slice(0, 2);
  assert.strictEqual(level(reviewFramework(f, CASE, {}), 'Structure'), 'ok');
  f[1].bullets = f[1].bullets.slice(0, 2);
  assert.strictEqual(level(reviewFramework(f, CASE, {}), 'Structure'), 'weak');
});

test('Structure: an overloaded bucket stays ok, an out-of-range bucket count keeps its tier', () => {
  const f = framework(4, 4);
  f[0].bullets = framework(1, 6)[0].bullets;
  assert.strictEqual(level(reviewFramework(f, CASE, {}), 'Structure'), 'ok');
  assert.strictEqual(level(reviewFramework(framework(2, 4), CASE, {}), 'Structure'), 'weak');
  assert.strictEqual(level(reviewFramework(framework(6, 4), CASE, {}), 'Structure'), 'ok');
});

test('overall message follows the prompt cutoffs: 87% ready, 50% solid, below that incomplete', () => {
  const long = f => { for (let i = 0; i < 3; i++) f[0].bullets[i] = longPoint(15); return f; };
  const generic = f => f.map(b => ({ header: b.header, bullets: b.bullets.map(x => x.replace('acme ', '')) }));
  // 7/8: only Succinct drops to ok
  const f7 = framework(4, 4); f7[0].bullets[0] = longPoint(15); f7[0].bullets[1] = longPoint(15);
  const r7 = reviewFramework(f7, CASE, {});
  assert.strictEqual(r7.pct, 88);
  assert.match(r7.overall, /Interview-ready/);
  // 4/8: Succinct weak + Relevant weak
  const r4 = reviewFramework(long(generic(framework(4, 4))), CASE, {});
  assert.deepStrictEqual(r4.crits.map(c => c.level), ['strong', 'strong', 'weak', 'weak']);
  assert.strictEqual(r4.pct, 50);
  assert.match(r4.overall, /Solid/);
  // 3/8: Structure ok (overloaded bucket), MECE strong, Succinct weak, Relevant weak
  const f3 = long(generic(framework(4, 4)));
  f3[1].bullets = Array.from({ length: 6 }, (_, i) => 'zq' + (900 + i) + 'x');
  const r3 = reviewFramework(f3, CASE, {});
  assert.deepStrictEqual(r3.crits.map(c => c.level), ['ok', 'strong', 'weak', 'weak']);
  assert.strictEqual(r3.pct, 38);
  assert.match(r3.overall, /Incomplete/);
});

test('disabled criteria are left out of the review and the score', () => {
  const f = framework(4, 4);
  for (let i = 0; i < 3; i++) f[0].bullets[i] = longPoint(15); // Succinct weak
  const all = reviewFramework(f, CASE, {});
  assert.strictEqual(all.crits.length, 4);
  assert.strictEqual(all.pct, 75);
  const noSuccinct = reviewFramework(f, CASE, {}, { enabled: ['Structure', 'MECE', 'Relevant'] });
  assert.deepStrictEqual(noSuccinct.crits.map(c => c.name), ['Structure', 'MECE', 'Relevant']);
  assert.strictEqual(noSuccinct.pct, 100);
});

test('weights scale each criterion in the score', () => {
  const f = framework(4, 4);
  for (let i = 0; i < 3; i++) f[0].bullets[i] = longPoint(15); // Succinct weak, others strong
  const equal = reviewFramework(f, CASE, {}, { weights: { Structure: 2, MECE: 2, Succinct: 2, Relevant: 2 } });
  assert.strictEqual(equal.pct, 75);
  const heavy = reviewFramework(f, CASE, {}, { weights: { Structure: 1, MECE: 1, Succinct: 3, Relevant: 1 } });
  assert.strictEqual(heavy.pct, 50); // 6 of 12
  const light = reviewFramework(f, CASE, {}, { weights: { Structure: 1, MECE: 1, Succinct: 0, Relevant: 1 } });
  assert.strictEqual(light.pct, 100);
});

test('no enabled criteria yields a zero score instead of NaN', () => {
  const r = reviewFramework(framework(4, 4), CASE, {}, { enabled: [] });
  assert.strictEqual(r.crits.length, 0);
  assert.strictEqual(r.pct, 0);
});

test('parseStructure still reads # bucket / - point text', () => {
  const s = parseStructure('# Revenue\n- price\n- volume\n# Cost\n- labor');
  assert.deepStrictEqual(s, [{ header: 'Revenue', bullets: ['price', 'volume'] }, { header: 'Cost', bullets: ['labor'] }]);
});

const verdict = (level, extra) => Object.assign({ level, reason: 'because ' + level, evidence: '' }, extra);

test('applyJudgement replaces MECE and Relevant with the judge\'s verdicts, keeps rule levels, and rescores', () => {
  const f = framework(4, 4);
  for (let i = 0; i < 3; i++) f[0].bullets[i] = longPoint(15); // Succinct weak by rule
  const rules = reviewFramework(f, CASE, {});
  assert.deepStrictEqual(rules.crits.map(c => c.level), ['strong', 'strong', 'weak', 'strong']);
  const r = applyJudgement(rules, { criteria: { MECE: verdict('weak', { evidence: 'acme zq0x' }), Relevant: verdict('ok') }, topPriority: 'Fix overlap' }, {});
  assert.deepStrictEqual(r.crits.map(c => [c.name, c.level]), [['Structure', 'strong'], ['MECE', 'weak'], ['Succinct', 'weak'], ['Relevant', 'ok']]);
  assert.strictEqual(r.pct, 38); // 2 + 0 + 0 + 1 of 8
  assert.match(r.overall, /Incomplete/);
  assert.strictEqual(r.rubricVersion, 3);
  assert.deepStrictEqual(r.crits[1].notes, ['because weak', 'You said: \u201Cacme zq0x\u201D']);
  assert.strictEqual(r.crits[1].judged, true);
  assert.strictEqual(r.crits[0].judged, undefined);
  assert.strictEqual(r.coach.topPriority, 'Fix overlap');
});

test('applyJudgement leaves criteria the judge did not (validly) score on their rule level', () => {
  const rules = reviewFramework(framework(4, 4), CASE, {});
  const r = applyJudgement(rules, { criteria: { MECE: verdict('amazing'), Relevant: verdict('weak') } }, {});
  assert.strictEqual(level(r, 'MECE'), 'strong');
  assert.strictEqual(level(r, 'Relevant'), 'weak');
  assert.strictEqual(r.crits.find(c => c.name === 'MECE').judged, undefined);
  assert.strictEqual(r.rubricVersion, 3);
});

test('applyJudgement with nothing usable is just the rule-based review at version 2 with no coach notes', () => {
  const rules = reviewFramework(framework(4, 4), CASE, {});
  for (const j of [null, undefined, {}, { criteria: {} }]) {
    const r = applyJudgement(rules, j, {});
    assert.strictEqual(r.pct, rules.pct);
    assert.strictEqual(r.rubricVersion, 2);
    assert.strictEqual(r.coach, null);
  }
});

test('applyJudgement respects enabled criteria and weights', () => {
  const rules = reviewFramework(framework(4, 4), CASE, {});
  const j = { criteria: { MECE: verdict('weak'), Relevant: verdict('strong') } };
  const noMece = applyJudgement(rules, j, { enabled: ['Structure', 'Succinct', 'Relevant'] });
  assert.deepStrictEqual(noMece.crits.map(c => c.name), ['Structure', 'Succinct', 'Relevant']);
  assert.strictEqual(noMece.pct, 100);
  const heavyMece = applyJudgement(rules, j, { weights: { Structure: 1, MECE: 3, Succinct: 1, Relevant: 1 } });
  assert.strictEqual(heavyMece.pct, 50); // Structure 1x2 + MECE 3x0 + Succinct 1x2 + Relevant 1x2 = 6 of 12
});

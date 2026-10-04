// Run with: node --test tests/solved-framework.test.js
// Covers the solved-framework schema, the 15 expert cases, and the creator form parser.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { SHAPES, validateSolvedFramework } = require('../backend/src/lib/solvedFramework');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const block = name => {
  const m = html.match(new RegExp('/\\* ' + name + ':BEGIN[^\\n]*\\n([\\s\\S]*?)/\\* ' + name + ':END \\*/'));
  assert.ok(m, name + ' block markers not found in index.html');
  return m[1];
};
const { classifyQuestion, checkSummary } = new Function(block('SCORING') + '\nreturn {classifyQuestion,checkSummary};')();
const { parseBucketText, parseClarifyingText, buildFrameworkFromForm, frameworkPlain, expertFrameworkHtml, escapeHtml, SHAPE_LABELS } =
  new Function(block('FWFORM') + '\nreturn {parseBucketText,parseClarifyingText,buildFrameworkFromForm,frameworkPlain,expertFrameworkHtml,escapeHtml,SHAPE_LABELS};')();

const entries = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'backend', 'src', 'data', 'expert-cases.json'), 'utf8'));
const byId = id => entries.find(e => e.case.id === id).case;

const good = () => ({
  version: 1, shape: 'gate', purpose: 'To decide X, I would look at three areas:',
  buckets: [
    { question: 'Is the market attractive?', points: ['How big is it?'], hypothesis: 'I expect it is small.' },
    { question: 'Can we win?', points: ['What do we have?', 'What are we missing?'] }
  ],
  start: { text: 'Start with area 1 and ask for market size.', bucket: 1 }
});

test('validator accepts a well-formed record and trims it', () => {
  const r = validateSolvedFramework(Object.assign(good(), { purpose: '  To decide X  ' }));
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.strictEqual(r.value.purpose, 'To decide X');
  assert.strictEqual(r.value.start.bucket, 1);
});

test('validator rejects bad shapes, empty fields and out-of-range start buckets, naming each problem', () => {
  const bad = Object.assign(good(), { shape: 'strategy', purpose: ' ', start: { text: 'x', bucket: 5 } });
  bad.buckets = [{ question: 'Only one', points: [] }];
  const r = validateSolvedFramework(bad);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /shape/.test(e)));
  assert.ok(r.errors.some(e => /purpose/.test(e)));
  assert.ok(r.errors.some(e => /2-6 buckets/.test(e)));
  assert.ok(r.errors.some(e => /start.bucket/.test(e)));
  for (const x of [null, 'text', [], { text: 'legacy free text' }]) assert.strictEqual(validateSolvedFramework(x).ok, false);
});

test('validator drops unknown fields instead of storing them', () => {
  const r = validateSolvedFramework(Object.assign(good(), { admin: true, buckets: good().buckets.map(b => Object.assign({ secret: 1 }, b)) }));
  assert.ok(r.ok);
  assert.strictEqual(r.value.admin, undefined);
  assert.strictEqual(r.value.buckets[0].secret, undefined);
});

test('all 15 expert records are valid, with distinct origin markers and ids', () => {
  assert.strictEqual(entries.length, 15);
  const origins = new Set(), ids = new Set();
  for (const { case: c, framework } of entries) {
    const r = validateSolvedFramework(framework);
    assert.ok(r.ok, c.id + ': ' + JSON.stringify(r.errors));
    assert.ok(SHAPES.includes(framework.shape));
    assert.ok(framework.origin, c.id + ' missing origin');
    origins.add(framework.origin); ids.add(c.id);
  }
  assert.strictEqual(origins.size, 15);
  assert.strictEqual(ids.size, 15);
});

test('expert cases match the bank case shape the drill reads', () => {
  const bank = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'backend', 'src', 'data', 'case-bank.json'), 'utf8'));
  const types = new Set(bank.map(c => c.type));
  for (const { case: c, framework } of entries) {
    assert.deepStrictEqual(Object.keys(c).sort(), ['caseKeywords', 'clarifiers', 'facts', 'id', 'meceDimensions', 'prompt', 'source', 'title', 'type']);
    assert.ok(types.has(c.type), c.id + ' has unknown type ' + c.type);
    assert.ok(c.prompt.length > 80);
    assert.strictEqual(c.clarifiers.length, framework.clarifying.length, c.id);
    c.clarifiers.forEach((cl, i) => {
      assert.strictEqual(cl.answer, framework.clarifying[i].answer);
      assert.ok(cl.keywords.length >= 3 && cl.keywords.every(k => k === k.toLowerCase()), c.id + ' clarifier ' + i);
    });
    assert.ok(c.caseKeywords.every(k => k === k.toLowerCase()));
    assert.ok(c.meceDimensions.length >= 4);
  }
});

test('the five answer shapes are all represented', () => {
  const counts = {};
  entries.forEach(e => { counts[e.framework.shape] = (counts[e.framework.shape] || 0) + 1; });
  assert.deepStrictEqual(counts, { gate: 6, diagnosis: 4, selection: 2, calculate: 2, open_ended: 1 });
});

test('clarifier keywords route real questions to the casebook answers', () => {
  const ans = (id, q) => classifyQuestion(q, byId(id)).answer;
  assert.match(ans('ex03', 'What is the objective here?'), /meet sales commitments/);
  assert.match(ans('ex07', 'Is there a deadline or payback period for the investment?'), /breakeven in at most three years/);
  assert.match(ans('ex15', 'Who are the competitors?'), /Zonko/);
  assert.match(ans('ex08', 'How many kegs are in a BBL?'), /two kegs or fourteen/);
  assert.match(ans('ex12', 'What does PharmaCo do today?'), /small molecule/);
  assert.match(ans('ex10', 'Has Opus Two shortlisted any regions?'), /explore these locations later/);
});

test('a question about one topic does not return an unrelated casebook answer', () => {
  const a = classifyQuestion('Why is the plant unprofitable?', byId('ex14')).answer;
  assert.doesNotMatch(a, /bundled acquisition/);
  const b = classifyQuestion('What would you do about it?', byId('ex14'));
  assert.strictEqual(b.good, false);
});

test('fact checks fire on the seeded prompt figures', () => {
  const flags = checkSummary('They have a twenty... actually a budget of $50 million available.', byId('ex08'));
  assert.ok(flags.some(f => /20 million/.test(f.text)));
  assert.strictEqual(checkSummary('The budget available is $20 million.', byId('ex08')).length, 0);
});

test('bucket text parser reads # / - / > lines', () => {
  const r = parseBucketText('# One?\n- a\n- b\n> I expect x.\n> and y.\n# Two?\n- c');
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.buckets, [
    { question: 'One?', points: ['a', 'b'], hypothesis: 'I expect x. and y.' },
    { question: 'Two?', points: ['c'] }
  ]);
});

test('bucket text parser reports stray lines and a missing first bucket', () => {
  assert.match(parseBucketText('- orphan').errors[0], /Line 1/);
  assert.match(parseBucketText('# One?\nstray words').errors[0], /Line 2/);
});

test('clarifying parser reads Q:/A: pairs and flags broken ones', () => {
  const r = parseClarifyingText('Q: What is the goal?\nA: Grow revenue.\n\nQ: Timeline?\nA: Months\nnot years.\n\nbroken');
  assert.deepStrictEqual(r.pairs, [
    { question: 'What is the goal?', answer: 'Grow revenue.' },
    { question: 'Timeline?', answer: 'Months not years.' }
  ]);
  assert.strictEqual(r.errors.length, 1);
});

test('form values build a record that passes server validation', () => {
  const built = buildFrameworkFromForm({
    shape: 'diagnosis', typeLine: ' ', purpose: 'To find why X fell, I would trace three steps:',
    buckets: '# Is it us?\n- Peers?\n- Method?\n# Who?\n- Segments?', start: 'Start with peers.', startBucket: '1', clarifying: ''
  });
  assert.deepStrictEqual(built.errors, []);
  assert.strictEqual(built.framework.caseTypeLine, undefined);
  assert.ok(validateSolvedFramework(built.framework).ok);
  const empty = buildFrameworkFromForm({ shape: '', purpose: '', buckets: '', start: '', startBucket: '', clarifying: '' });
  assert.strictEqual(validateSolvedFramework(empty.framework).ok, false);
});

test('frameworkPlain renders structured and legacy rows for admin review', () => {
  const text = frameworkPlain(entries[0].framework);
  assert.match(text, /^Shape: gate/);
  assert.match(text, /1\. Will the merged platform earn more revenue\?/);
  assert.match(text, /> I expect/);
  assert.match(text, /Where I'd start \(bucket 1\)/);
  assert.strictEqual(frameworkPlain({ text: 'old free text' }), 'old free text');
  assert.strictEqual(frameworkPlain(null), '');
});

test('the draft playbook only cites real exemplar cases and stays marked as a draft', () => {
  const pb = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'backend', 'src', 'data', 'expert-playbook.json'), 'utf8'));
  assert.strictEqual(pb.status, 'draft');
  assert.deepStrictEqual(Object.keys(pb.shapes).sort(), SHAPES.slice().sort());
  const ids = new Set(entries.map(e => e.case.id));
  for (const [shape, s] of Object.entries(pb.shapes)) {
    assert.ok(s.examples.length >= 1 && s.reasoningChecks.length >= 2, shape);
    s.examples.forEach(id => {
      assert.ok(ids.has(id), id);
      assert.strictEqual(entries.find(e => e.case.id === id).framework.shape, shape, id + ' is not a ' + shape + ' case');
    });
  }
  assert.strictEqual(pb.observed.totalBuckets, entries.reduce((n, e) => n + e.framework.buckets.length, 0));
});

test('every answer shape has a student-facing label', () => {
  for (const shape of SHAPES) assert.ok(SHAPE_LABELS[shape], shape);
  assert.deepStrictEqual(Object.keys(SHAPE_LABELS).sort(), SHAPES.slice().sort());
});

test('escapeHtml neutralizes markup, quotes and non-strings', () => {
  assert.strictEqual(escapeHtml('<img src=x onerror="a()">&\''), '&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;');
  assert.strictEqual(escapeHtml(null), '');
  assert.strictEqual(escapeHtml(5), '5');
});

test('expert framework view shows purpose, numbered question buckets, hypotheses, the starting bucket and the clarifying Q&A', () => {
  const e = entries.find(x => x.case.id === 'ex07').framework; // starts at bucket 3
  const html = expertFrameworkHtml(e);
  assert.ok(html.includes(escapeHtml(e.purpose)));
  e.buckets.forEach((b, i) => {
    assert.ok(html.includes(escapeHtml(b.question)), 'bucket ' + (i + 1));
    b.points.forEach(p => assert.ok(html.includes(escapeHtml(p))));
    if (b.hypothesis) assert.ok(html.includes('<b>Hypothesis:</b> ' + escapeHtml(b.hypothesis)));
  });
  assert.strictEqual((html.match(/Start here/g) || []).length, 1);
  assert.ok(html.indexOf('Start here') > html.indexOf(escapeHtml(e.buckets[2].question)));
  assert.ok(html.indexOf('Start here') < html.indexOf(escapeHtml(e.buckets[3].question)));
  assert.ok(html.includes('Where to start'));
  assert.ok(html.includes('Clarifying questions and answers'));
  e.clarifying.forEach(c => assert.ok(html.includes(escapeHtml(c.answer))));
});

test('expert framework view escapes author-supplied text and omits empty sections', () => {
  const html = expertFrameworkHtml({
    purpose: '<script>alert(1)</script>', start: { text: 'Start with <b>x</b>' },
    buckets: [{ question: 'Q <i>1</i>?', points: ['p & q'] }, { question: 'Q2?', points: ['r'] }]
  });
  assert.ok(!html.includes('<script>') && !html.includes('<i>1</i>') && !html.includes('<b>x</b>'));
  assert.ok(html.includes('p &amp; q'));
  assert.ok(!html.includes('Start here'));
  assert.ok(!html.includes('Hypothesis'));
  assert.ok(!html.includes('Clarifying questions'));
});

test('every expert framework renders without throwing and lists all of its buckets', () => {
  for (const e of entries) {
    const html = expertFrameworkHtml(e.framework);
    assert.strictEqual((html.match(/class="ai-bucket"/g) || []).length, e.framework.buckets.length, e.case.id);
  }
});

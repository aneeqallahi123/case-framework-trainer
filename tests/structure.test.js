// Run with: node --test tests/structure.test.js
// Covers the code-enforced grounding guarantees of the transcript -> issue tree pipeline,
// using a fake model so no API key is needed.
const test = require('node:test');
const assert = require('node:assert');
const { quoteIsGrounded } = require('../backend/src/lib/json');
const { runStructure, validateAndCleanTree, metricIsGrounded } = require('../backend/src/lib/structure');

const T = 'So first I will look at revenue and within that price sensitivity and average price per category, ' +
  'then costs, specifically labor costs in the stores, which are up 12 percent from last year.';

const leaves = node => (node.children || []).flatMap(c => (c.pointId ? [c] : leaves(c)));

// Fake model: stage 1 prompt contains "Extract the", stage 2 contains "Organize ONLY".
const fake = (points, tree) => async prompt => {
  const parsed = prompt.includes('Organize ONLY') ? { tree, hypothesis: 'h' } : { points };
  return { raw: JSON.stringify(parsed), parsed };
};
const quiet = fn => async (...a) => { const w = console.warn; console.warn = () => {}; try { return await fn(...a); } finally { console.warn = w; } };

test('quoteIsGrounded: exact, drifted and fabricated quotes', () => {
  assert.ok(quoteIsGrounded('price sensitivity', T));
  assert.ok(quoteIsGrounded('labor costs in the stores', T));
  assert.ok(quoteIsGrounded('look at revenue and within the price sensitivity', T)); // one word swapped
  assert.ok(!quoteIsGrounded('price elasticity', T));
  assert.ok(!quoteIsGrounded('revenue price category labor stores year', T)); // real words, scattered across the transcript (old matcher accepted this)
  assert.ok(!quoteIsGrounded('', T));
  assert.ok(!quoteIsGrounded('ab', T));
  assert.ok(!quoteIsGrounded('customer churn rate', T)); // short, not present
});

test('metricIsGrounded', () => {
  assert.ok(metricIsGrounded(null, T));
  assert.ok(metricIsGrounded({ value: '12', unit: 'percent' }, T));
  assert.ok(!metricIsGrounded({ value: '40', unit: 'percent' }, T));
});

test('ungrounded extracted points are dropped before structuring', quiet(async () => {
  const pts = [
    { id: 'p1', text: 'Price sensitivity', quote: 'price sensitivity', metric: null },
    { id: 'p2', text: 'Customer churn', quote: 'customer churn is rising fast', metric: null }
  ];
  const tree = { label: 'Root', children: [{ label: 'Revenue', pointId: null, children: [{ label: 'x', pointId: 'p1', children: [] }] }] };
  const { tree: out } = await runStructure({ transcript: T }, fake(pts, tree));
  assert.deepStrictEqual(leaves(out).map(l => l.pointId), ['p1']);
}));

test('model cannot reword leaf labels or invent metrics; invented metrics on extraction are dropped', quiet(async () => {
  const pts = [
    { id: 'p1', text: 'Labor costs', quote: 'labor costs in the stores', metric: { before: '', after: '40', unit: 'percent' } },
    { id: 'p2', text: 'Labor costs growth', quote: 'up 12 percent', metric: { value: '12', unit: 'percent' } }
  ];
  const tree = { label: 'Root', children: [
    { label: 'Costs', pointId: null, metric: { value: '99' }, children: [
      { label: 'Wage inflation drivers', pointId: 'p1', metric: { value: '77' }, children: [] },
      { label: 'Labor costs growth', pointId: 'p2', metric: { value: '5' }, children: [] }
    ] }
  ] };
  const { tree: out } = await runStructure({ transcript: T }, fake(pts, tree));
  const [a, b] = leaves(out);
  assert.strictEqual(a.label, 'Labor costs');
  assert.strictEqual(a.metric, null);          // "40" never said
  assert.strictEqual(b.metric.value, '12');    // restored from point, not the model's "5"
  assert.strictEqual(out.children[0].metric, null);
}));

test('unknown and duplicate pointIds are removed; empty invented groups are pruned', quiet(async () => {
  const pts = [{ id: 'p1', text: 'Price sensitivity', quote: 'price sensitivity', metric: null }];
  const tree = { label: 'Root', children: [
    { label: 'Revenue', pointId: null, children: [
      { label: 'Price sensitivity', pointId: 'p1', children: [] },
      { label: 'Price sensitivity again', pointId: 'p1', children: [] },
      { label: 'Competitor pricing', pointId: 'p9', children: [] }
    ] },
    { label: 'Market Dynamics', pointId: null, children: [{ label: 'Invented', pointId: 'p7', children: [] }] }
  ] };
  const { tree: out } = await runStructure({ transcript: T }, fake(pts, tree));
  assert.deepStrictEqual(out.children.map(c => c.label), ['Revenue']);
  assert.strictEqual(leaves(out).length, 1);
}));

test('points the model forgot to place are surfaced; null tree falls back to flat tree', quiet(async () => {
  const pts = [
    { id: 'p1', text: 'Price sensitivity', quote: 'price sensitivity', metric: null },
    { id: 'p2', text: 'Labor costs', quote: 'labor costs in the stores', metric: null }
  ];
  const partial = { label: 'Root', children: [{ label: 'Price sensitivity', pointId: 'p1', children: [] }] };
  const r1 = await runStructure({ transcript: T }, fake(pts, partial));
  assert.deepStrictEqual(leaves(r1.tree).map(l => l.pointId).sort(), ['p1', 'p2']);
  const r2 = await runStructure({ transcript: T, caseTitle: 'Case' }, fake(pts, null));
  assert.strictEqual(r2.tree.label, 'Case');
  assert.deepStrictEqual(leaves(r2.tree).map(l => l.pointId).sort(), ['p1', 'p2']);
}));

test('no grounded points -> error stage "empty"', quiet(async () => {
  const pts = [{ id: 'p1', text: 'Made up', quote: 'something never said at all here', metric: null }];
  await assert.rejects(runStructure({ transcript: T }, fake(pts, {})), e => e.stage === 'empty');
}));

test('validateAndCleanTree: leaf children are discarded', () => {
  const m = new Map([['p1', { id: 'p1', text: 'A', quote: 'a', metric: null }]]);
  const out = validateAndCleanTree({ label: 'R', children: [{ label: 'A', pointId: 'p1', children: [{ label: 'sneaky', pointId: null, children: [] }] }] }, m, new Set());
  assert.deepStrictEqual(out.children[0].children, []);
});

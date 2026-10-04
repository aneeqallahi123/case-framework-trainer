// Builds test frameworks from an expert solution so an admin can check the judge before (and after) editing
// the prompt. For each case: the expert's own structure, a generic version (right shape, no case content) and an
// overlapping version (points repeated across buckets). Pure functions; the admin route runs them through the judge.
const GENERIC_BUCKETS = ['Market', 'Competition', 'Financials', 'Risks', 'Operations', 'Customers'];
const GENERIC_POINTS = [
  'Size of the opportunity', 'Key industry trends', 'Main competitors', 'Revenue and cost drivers',
  'Potential risks', 'Customer needs', 'Internal capabilities', 'Implementation challenges'
];

const toText = buckets => buckets.map(b => ['# ' + b.question, ...b.points.map(p => '- ' + p)].join('\n')).join('\n');

// Expectations are deliberately lenient: they catch a prompt edit that breaks calibration, not model noise.
//   gold:    neither dimension is weak
//   generic: Relevant must not be strong
//   overlap: MECE must not be strong
function buildSamples(framework) {
  const gold = framework.buckets.map(b => ({ question: b.question, points: b.points.slice() }));

  const generic = gold.map((b, i) => ({
    question: GENERIC_BUCKETS[i % GENERIC_BUCKETS.length],
    points: b.points.map((_, j) => GENERIC_POINTS[(i * 3 + j) % GENERIC_POINTS.length])
  }));

  // Every bucket repeats the previous bucket's points, so the buckets overlap heavily.
  const overlap = gold.map((b, i) => ({
    question: b.question,
    points: b.points.concat(gold[(i + gold.length - 1) % gold.length].points)
  }));

  return [
    { variant: 'gold', structText: toText(gold), expect: { MECE: { not: 'weak' }, Relevant: { not: 'weak' } } },
    { variant: 'generic', structText: toText(generic), expect: { Relevant: { not: 'strong' } } },
    { variant: 'overlap', structText: toText(overlap), expect: { MECE: { not: 'strong' } } }
  ];
}

// Compares the judge's levels to a sample's expectations. Returns [{criterion, level, wanted, pass}].
function checkExpectations(sample, judgement) {
  return Object.entries(sample.expect).map(([criterion, rule]) => {
    const level = judgement && judgement.criteria && judgement.criteria[criterion] ? judgement.criteria[criterion].level : null;
    return { criterion, level, wanted: 'not ' + rule.not, pass: level !== null && level !== rule.not };
  });
}

module.exports = { buildSamples, checkExpectations, toText };

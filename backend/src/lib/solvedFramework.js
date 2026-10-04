// Structured record for an expert-solved framework, stored in solved_frameworks.framework.
//
// {
//   version: 1,
//   shape: 'gate' | 'diagnosis' | 'selection' | 'calculate' | 'open_ended',
//   caseTypeLine: 'Strategic decision (market entry) with ...',      // optional
//   purpose: 'To decide whether ..., I would look at four areas:',
//   buckets: [{ question, points: [string], hypothesis?: string }],  // 2-6 buckets
//   start: { text: string, bucket?: 1-based bucket number },
//   clarifying: [{ question, answer }],                              // optional
//   origin?: string                                                  // seed marker, ignored by readers
// }
//
// Answer shapes describe what kind of answer the case needs, not its industry:
//   gate       several things must all be true for "yes" (go/no-go)
//   diagnosis  trace a metric back to its cause
//   selection  score candidate options against criteria
//   calculate  the numbers decide (investment, pricing)
//   open_ended strategy with no single yes/no
const SHAPES = ['gate', 'diagnosis', 'selection', 'calculate', 'open_ended'];

const MAX_TEXT = 1200;
const isText = (v, max = MAX_TEXT) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

// Returns { ok: true, value } with trimmed strings, or { ok: false, errors: [...] }.
function validateSolvedFramework(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['Framework must be an object'] };
  }

  if (input.version !== undefined && input.version !== 1) errors.push('Unsupported framework version');
  if (!SHAPES.includes(input.shape)) errors.push(`shape must be one of: ${SHAPES.join(', ')}`);
  if (!isText(input.purpose)) errors.push('purpose is required (one line on what the structure will answer)');
  if (input.caseTypeLine !== undefined && !isText(input.caseTypeLine)) errors.push('caseTypeLine must be text');
  if (input.origin !== undefined && !isText(input.origin, 200)) errors.push('origin must be short text');

  const buckets = [];
  if (!Array.isArray(input.buckets) || input.buckets.length < 2 || input.buckets.length > 6) {
    errors.push('buckets must be a list of 2-6 buckets');
  } else {
    input.buckets.forEach((b, i) => {
      const n = i + 1;
      if (!b || typeof b !== 'object') { errors.push(`bucket ${n} must be an object`); return; }
      if (!isText(b.question, 300)) errors.push(`bucket ${n} needs a question`);
      if (!Array.isArray(b.points) || b.points.length < 1 || b.points.length > 8 || !b.points.every(p => isText(p, 400))) {
        errors.push(`bucket ${n} needs 1-8 points`);
      }
      if (b.hypothesis !== undefined && !isText(b.hypothesis, 400)) errors.push(`bucket ${n} hypothesis must be text`);
      if (isText(b.question, 300) && Array.isArray(b.points)) {
        const out = { question: b.question.trim(), points: b.points.filter(p => typeof p === 'string').map(p => p.trim()) };
        if (isText(b.hypothesis, 400)) out.hypothesis = b.hypothesis.trim();
        buckets.push(out);
      }
    });
  }

  let start = null;
  if (!input.start || typeof input.start !== 'object' || !isText(input.start.text)) {
    errors.push('start.text is required (where you would start, and why)');
  } else {
    start = { text: input.start.text.trim() };
    if (input.start.bucket !== undefined) {
      const k = input.start.bucket;
      if (!Number.isInteger(k) || k < 1 || k > (Array.isArray(input.buckets) ? input.buckets.length : 0)) {
        errors.push('start.bucket must be the 1-based number of one of the buckets');
      } else {
        start.bucket = k;
      }
    }
  }

  const clarifying = [];
  if (input.clarifying !== undefined) {
    if (!Array.isArray(input.clarifying) || input.clarifying.length > 10) {
      errors.push('clarifying must be a list of up to 10 question/answer pairs');
    } else {
      input.clarifying.forEach((c, i) => {
        if (!c || !isText(c.question, 400) || !isText(c.answer)) errors.push(`clarifying item ${i + 1} needs a question and an answer`);
        else clarifying.push({ question: c.question.trim(), answer: c.answer.trim() });
      });
    }
  }

  if (errors.length) return { ok: false, errors };

  const value = { version: 1, shape: input.shape, purpose: input.purpose.trim(), buckets, start };
  if (isText(input.caseTypeLine)) value.caseTypeLine = input.caseTypeLine.trim();
  if (clarifying.length) value.clarifying = clarifying;
  if (isText(input.origin, 200)) value.origin = input.origin.trim();
  return { ok: true, value };
}

module.exports = { SHAPES, validateSolvedFramework };

// Orchestrates one judge call: load the live rubric, system prompt and expert frameworks, build the prompt,
// reuse a stored result when the same input was already judged, otherwise call the model and validate its reply.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { buildSystem, buildUserMessage, validateJudgement, protectedTexts } = require('./prompt');
const { parseJsonReply } = require('../lib/json');
const { validateSolvedFramework } = require('../lib/solvedFramework');
const { modelName, callAnthropic } = require('./model');

const DEFAULT_SYSTEM_PROMPT = 'You are an expert case interview evaluator.';
const MAX_EXEMPLARS = () => Math.max(1, parseInt(process.env.JUDGE_MAX_EXEMPLARS || '40', 10) || 40);

// Running totals since boot, exposed to admins to decide whether prompt caching pays for itself.
const stats = { calls: 0, leaksBlocked: 0, resultCacheHits: 0, skipped: 0, errors: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, since: new Date().toISOString() };

function loadPlaybook() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'expert-playbook.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

// The draft playbook is the assistant's reading of the 15 solutions, not the consultant's words, so it only
// reaches the model once reviewed (status "reviewed") or when explicitly opted in.
function shouldUsePlaybook(playbook) {
  return !!playbook && (playbook.status === 'reviewed' || process.env.JUDGE_USE_DRAFT_PLAYBOOK === 'true');
}

async function loadContext(pool, { excludeCaseId } = {}) {
  const [prompt, criteria, frameworks] = await Promise.all([
    pool.query("SELECT value FROM system_config WHERE key = 'system_prompt'"),
    pool.query('SELECT name, description, enabled, weight, config FROM marking_criteria ORDER BY id'),
    pool.query(
      `SELECT DISTINCT ON (sf.case_id) sf.case_id, sf.framework, c.title
       FROM solved_frameworks sf JOIN cases c ON c.id = sf.case_id
       WHERE sf.status = 'approved' AND sf.framework ? 'shape'
       ORDER BY sf.case_id, sf.id DESC`
    )
  ]);
  const exemplars = [];
  for (const row of frameworks.rows) {
    if (row.case_id === excludeCaseId) continue;
    const checked = validateSolvedFramework(row.framework);
    if (checked.ok) exemplars.push({ caseId: row.case_id, title: row.title, framework: checked.value });
  }
  return {
    systemPrompt: (prompt.rows[0] && prompt.rows[0].value) || DEFAULT_SYSTEM_PROMPT,
    criteria: criteria.rows,
    exemplars: exemplars.slice(0, MAX_EXEMPLARS())
  };
}

// Too little to judge: the client falls back to the rule-based review and no model call is made.
function isTooShort(structText) {
  const text = String(structText || '');
  const bullets = text.split('\n').filter(l => /^\s*[-*•]/.test(l)).length;
  const words = (text.match(/[A-Za-z0-9']+/g) || []).length;
  return bullets < 2 || words < 8;
}

function sha(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function addUsage(usage) {
  stats.inputTokens += usage.input_tokens || 0;
  stats.cacheReadTokens += usage.cache_read_input_tokens || 0;
  stats.cacheWriteTokens += usage.cache_creation_input_tokens || 0;
  stats.outputTokens += usage.output_tokens || 0;
}

// input: { caseId, structText, transcript, ruleResults:[{name, level, notes}] }
// options: { callModel, excludeCaseId (leave-one-out), noCache (skip the stored-result lookup and write) }
async function judge({ pool, input, callModel = callAnthropic, excludeCaseId, noCache = false }) {
  const caseRow = await pool.query('SELECT data FROM cases WHERE id = $1', [input.caseId]);
  if (!caseRow.rows.length) { const e = new Error('Case not found'); e.status = 404; throw e; }

  if (isTooShort(input.structText)) { stats.skipped++; return { skipped: 'too_short' }; }

  const ctx = await loadContext(pool, { excludeCaseId });
  const playbook = loadPlaybook();
  const built = buildSystem({ ...ctx, playbook, usePlaybook: shouldUsePlaybook(playbook) });
  const hasExpert = ctx.exemplars.some(x => x.caseId === input.caseId);
  const user = buildUserMessage({
    caseRow: caseRow.rows[0].data, structText: input.structText, transcript: input.transcript,
    ruleResults: input.ruleResults, expertCaseId: hasExpert ? input.caseId : null
  });
  const key = sha([built.system, user, modelName()]);

  if (!noCache) {
    const hit = await pool.query('SELECT result FROM judge_cache WHERE key = $1', [key]);
    if (hit.rows.length) { stats.resultCacheHits++; return { ...hit.rows[0].result, cached: true }; }
  }

  const started = Date.now();
  stats.calls++;
  let reply;
  try {
    reply = await callModel({ system: built.system, user });
    const judgement = validateJudgement(parseJsonReply(reply.text), {
      judged: built.judged, groundingText: `${input.structText || ''}\n${input.transcript || ''}`,
      protectedTexts: protectedTexts(ctx.exemplars)
    });
    if (!Object.keys(judgement.criteria).length) throw new Error('Judge reply had no usable verdicts');

    stats.leaksBlocked += judgement.leaksBlocked;
    const result = { judgement, judged: built.judged, model: reply.model || modelName(), evidenceDropped: judgement.evidenceDropped, leaksBlocked: judgement.leaksBlocked };
    if (reply.usage) addUsage(reply.usage);
    console.log('judge_usage ' + JSON.stringify({
      ms: Date.now() - started, model: result.model, input: reply.usage?.input_tokens, cacheRead: reply.usage?.cache_read_input_tokens,
      cacheWrite: reply.usage?.cache_creation_input_tokens, output: reply.usage?.output_tokens, exemplars: built.exemplarCount
    }));
    if (!noCache) {
      await pool.query(
        'INSERT INTO judge_cache (key, result) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET result = EXCLUDED.result, created_at = NOW()',
        [key, JSON.stringify(result)]
      );
    }
    return { ...result, cached: false, usage: reply.usage || null };
  } catch (err) {
    stats.errors++;
    if (reply && reply.usage) addUsage(reply.usage);
    throw err;
  }
}

module.exports = { judge, loadContext, loadPlaybook, shouldUsePlaybook, isTooShort, stats, DEFAULT_SYSTEM_PROMPT };

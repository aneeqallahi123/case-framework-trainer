// The one place the judge talks to the Anthropic API.
//
// Prompt caching: the system block is the stable prefix (instructions, rubric, expert frameworks), and all
// per-student content goes in the user message after it. cache_control is OFF by default because a cold write
// costs 1.25x with no read at low traffic; set JUDGE_PROMPT_CACHE=true once the measured hit rate justifies it
// (see GET /api/admin/judge-stats). JUDGE_CACHE_TTL=1h switches to the 1-hour cache.
let client = null;

function modelName() {
  return process.env.JUDGE_MODEL || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
}

function cacheControl() {
  if (process.env.JUDGE_PROMPT_CACHE !== 'true') return null;
  return process.env.JUDGE_CACHE_TTL === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

function getClient() {
  if (client) return client;
  const Anthropic = require('@anthropic-ai/sdk');
  const opts = { apiKey: process.env.ANTHROPIC_API_KEY };
  if (process.env.ANTHROPIC_WORKSPACE_ID) opts.defaultHeaders = { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID };
  client = new Anthropic(opts);
  return client;
}

// Request body for the judge call. Exposed separately so tests can assert how the prompt is laid out.
function buildRequest({ system, user, maxTokens }) {
  const model = modelName();
  const block = { type: 'text', text: system };
  const cc = cacheControl();
  if (cc) block.cache_control = cc;
  const body = { model, max_tokens: maxTokens || 700, system: [block], messages: [{ role: 'user', content: user }] };
  // Sampling parameters are rejected by newer models, so pin them only where they are accepted.
  if (/^claude-haiku/.test(model)) body.temperature = 0;
  return body;
}

// Returns { text, usage, model }. Throws on API errors, refusals and empty replies.
async function callAnthropic({ system, user, maxTokens }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('ANTHROPIC_API_KEY not configured');
    err.status = 503;
    throw err;
  }
  const body = buildRequest({ system, user, maxTokens });
  const res = await getClient().messages.create(body, { timeout: 25000, maxRetries: 1 });
  if (res.stop_reason === 'refusal') throw new Error('Model declined to judge this framework');
  const text = (res.content || []).find(b => b.type === 'text')?.text || '';
  if (!text.trim()) throw new Error('Empty judge reply');
  return { text, usage: res.usage || {}, model: body.model };
}

// Exact prompt size (for the admin preview). Returns null if counting is unavailable.
async function countPromptTokens(system) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const r = await getClient().messages.countTokens({ model: modelName(), system, messages: [{ role: 'user', content: 'x' }] });
    return r.input_tokens;
  } catch (e) {
    return null;
  }
}

module.exports = { modelName, cacheControl, buildRequest, callAnthropic, countPromptTokens };

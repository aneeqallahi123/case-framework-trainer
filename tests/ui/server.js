// Starts the real app on :3001 against a scratch Postgres with a fake model (no network), for tests/ui/browser.test.js.
//   UI_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/ui node tests/ui/server.js
// A framework containing the text FAILME makes the fake model throw, to exercise the fallback.
const path = require('path');
const root = path.join(__dirname, '..', '..', 'backend', 'src');
if (!process.env.UI_DATABASE_URL) { console.error('Set UI_DATABASE_URL to an empty scratch database'); process.exit(1); }
Object.assign(process.env, { DATABASE_URL: process.env.UI_DATABASE_URL, JWT_SECRET: 'ui-secret-ui-secret-ui-secret-123456', PORT: '3001', NODE_ENV: 'development', SEED_EXPERT_CASES: 'true', EXPERT_DISPLAY_NAME: 'Test Expert', ANTHROPIC_API_KEY: 'unused', JUDGE_RATE_PER_HOUR: '200', ADMIN_PASSWORD_ANEEQ: process.env.UI_ADMIN_PASSWORD || 'ui-admin-password-1' });
const model = require(path.join(root, 'judge', 'model'));
model.callAnthropic = async req => {
  if (req.user.includes('FAILME')) throw new Error('simulated outage');
  return { model: 'fake', usage: { input_tokens: 5, output_tokens: 5 }, text: JSON.stringify({
    criteria: { MECE: { level: 'ok', reason: 'Two areas overlap in meaning: <b>pricing</b> and competition.', evidence: 'who are the main rivals' }, Relevant: { level: 'weak', reason: 'These areas could fit almost any case.', evidence: '' } },
    doneWell: 'Clear, separate market and competition areas.', topPriority: 'Tie each area to the three-year breakeven the client gave.', consultantWouldAdd: 'A test of the financial hurdle.', coaching: 'Say where you would start and why.' }) };
};
require(path.join(root, 'index.js'));

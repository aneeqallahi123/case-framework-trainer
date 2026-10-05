// End-to-end: real Express app, real Postgres, fake model (no network).
// Skipped unless E2E_DATABASE_URL points at an empty scratch database, e.g.
//   E2E_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/t node --test tests/e2e-community-judge.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const DB = process.env.E2E_DATABASE_URL;
const skip = DB ? false : 'set E2E_DATABASE_URL to run';
const root = path.join(__dirname, '..', 'backend', 'src');

let base, pool, seedAdmins, modelCalls = [];
const ADMIN_PW = 'e2e-admin-password-1';
const fakeJudgeReply = () => JSON.stringify({
  criteria: {
    MECE: { level: 'strong', reason: 'Distinct areas.', evidence: 'how big is the market' },
    Relevant: { level: 'ok', reason: 'Partly tailored.', evidence: '' }
  },
  doneWell: 'Clear buckets.', topPriority: 'Tie each bucket to the client goal.', consultantWouldAdd: '', coaching: ''
});

const api = async (method, url, token, body) => {
  const res = await fetch(base + url, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, json };
};
const signup = async name => {
  const r = await api('POST', '/api/auth/signup', null, { email: name + '@e2e.test', password: 'password123', firstName: name });
  assert.ok(r.json.token, JSON.stringify(r.json));
  return r.json.token;
};
const STRUCT = '# Market size\n- how big is the market\n- how fast is it growing\n# Competition\n- who are the main rivals\n- how do they price';

test.before(async () => {
  if (skip) return;
  Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-1', PORT: '3077', NODE_ENV: 'development', SEED_EXPERT_CASES: 'true', ADMIN_PASSWORD_ANEEQ: ADMIN_PW, EXPERT_DISPLAY_NAME: 'E2E Expert', ANTHROPIC_API_KEY: 'unused' });
  // Replace the model call before the service module loads, so the real route and service run against a fake.
  const model = require(path.join(root, 'judge', 'model'));
  model.callAnthropic = async req => { modelCalls.push(req); return { text: fakeJudgeReply(), usage: { input_tokens: 1, output_tokens: 1 }, model: 'fake' }; };
  ({ pool, seedAdmins } = require(path.join(root, 'db')));
  require(path.join(root, 'index.js'));
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch('http://localhost:3077/health')).ok) break; } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  base = 'http://localhost:3077';
});

test.after(async () => { if (!skip) { await pool.end(); setTimeout(() => process.exit(0), 50).unref(); } });

test('seed: expert cases, one expert creator, 15 approved frameworks', { skip }, async () => {
  const q = async (s, p) => (await pool.query(s, p)).rows;
  assert.strictEqual((await q("SELECT COUNT(*)::int n FROM cases WHERE id LIKE 'ex%'"))[0].n, 15);
  const sf = await q("SELECT u.email, u.role, u.first_name, COUNT(*)::int n FROM solved_frameworks f JOIN users u ON u.id = f.creator_id WHERE f.status = 'approved' GROUP BY 1,2,3");
  assert.deepStrictEqual(sf, [{ email: 'expert@caseroom.app', role: 'creator', first_name: 'E2E Expert', n: 15 }]);
});

test('judge: unauthenticated is rejected, bad input is a 400 with fallback, unknown case is a 404', { skip }, async () => {
  assert.strictEqual((await api('POST', '/api/judge', null, {})).status, 401);
  const t = await signup('judgeuser1');
  const bad = await api('POST', '/api/judge', t, { caseId: 5 });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.json.fallback, true);
  assert.strictEqual((await api('POST', '/api/judge', t, { caseId: 'nope', structText: STRUCT })).status, 404);
});

test('judge: returns verdicts, serves an identical retry from the stored result, skips tiny frameworks', { skip }, async () => {
  const t = await signup('judgeuser2');
  const before = modelCalls.length;
  const body = { caseId: 'ex07', structText: STRUCT, transcript: 'market size and competition', ruleResults: [{ name: 'Structure', level: 'weak', notes: ['Only 2 buckets'] }] };
  const a = await api('POST', '/api/judge', t, body);
  assert.strictEqual(a.status, 200);
  assert.strictEqual(a.json.cached, false);
  assert.strictEqual(a.json.judgement.criteria.MECE.level, 'strong');
  assert.strictEqual(a.json.judgement.criteria.MECE.evidence, 'how big is the market');
  const b = await api('POST', '/api/judge', t, body);
  assert.strictEqual(b.json.cached, true);
  assert.strictEqual(modelCalls.length, before + 1);
  const req = modelCalls[modelCalls.length - 1];
  assert.match(req.system, /### ex07:/);
  assert.match(req.user, /- Structure: weak \(Only 2 buckets\)/);
  const tiny = await api('POST', '/api/judge', t, { caseId: 'ex07', structText: '# one' });
  assert.deepStrictEqual(tiny.json, { skipped: 'too_short' });
  assert.strictEqual(modelCalls.length, before + 1);
});

test('drills: rubric version and coach notes are stored with the result', { skip }, async () => {
  const t = await signup('drilluser');
  const saved = await api('POST', '/api/drills', t, { caseId: 'ex02', caseTitle: 'x', score: 80, levels: { MECE: 'strong' }, bullets: 4, aiFeedback: JSON.stringify({ doneWell: 'ok' }), rubricVersion: 3 });
  assert.strictEqual(saved.status, 200);
  const list = await api('GET', '/api/drills', t);
  assert.strictEqual(list.json[0].rubric_version, 3);
  assert.strictEqual(JSON.parse(list.json[0].ai_feedback).doneWell, 'ok');
  const legacy = await api('POST', '/api/drills', t, { caseId: 'ex03', caseTitle: 'y', score: 50, levels: {}, bullets: 1 });
  assert.strictEqual(legacy.json.rubric_version, 1);
});

test('community: expert list never contains framework bodies and reflects what the viewer has unlocked', { skip }, async () => {
  const t = await signup('lister');
  const r = await api('GET', '/api/community/experts', t);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.length, 15);
  assert.ok(r.json.every(e => e.unlocked === false && e.expert.name === 'E2E Expert' && !('framework' in e) && !('buckets' in e)));
  assert.strictEqual(r.json.find(e => e.caseId === 'ex07').shape, 'gate');
});

test('community: gating is enforced by the server for detail, comments, votes and the generic post routes', { skip }, async () => {
  const locked = await signup('locked'), unlocked = await signup('unlocked');
  const list = (await api('GET', '/api/community/experts', locked)).json;
  const entry = list.find(e => e.caseId === 'ex07');

  const denied = await api('GET', '/api/community/experts/' + entry.id, locked);
  assert.strictEqual(denied.status, 403);
  assert.strictEqual(denied.json.locked, true);
  assert.ok(!('framework' in denied.json) && !('comments' in denied.json));

  // unlock by saving a drill on that case
  await api('POST', '/api/drills', unlocked, { caseId: 'ex07', caseTitle: 'Jane', score: 60, levels: {}, bullets: 3 });
  const ok = await api('GET', '/api/community/experts/' + entry.id, unlocked);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.framework.shape, 'gate');
  assert.strictEqual(ok.json.framework.buckets.length, 4);
  assert.strictEqual(ok.json.expert.name, 'E2E Expert');
  assert.strictEqual(ok.json.kind, 'expert');
  const postId = ok.json.id;

  // a user with a drill on a different case stays locked out
  const other = await signup('othercase');
  await api('POST', '/api/drills', other, { caseId: 'ex02', caseTitle: 'x', score: 10, levels: {}, bullets: 1 });
  assert.strictEqual((await api('GET', '/api/community/experts/' + entry.id, other)).status, 403);

  // the generic post routes cannot be used to get around the gate
  assert.strictEqual((await api('GET', '/api/community/posts/' + postId, locked)).status, 403);
  assert.strictEqual((await api('POST', '/api/community/posts/' + postId + '/comments', locked, { body: 'sneaky' })).status, 403);
  assert.strictEqual((await api('POST', '/api/community/posts/' + postId + '/vote', locked)).status, 403);

  // the unlocked user can discuss, and the locked one still cannot see or vote on comments
  const c = await api('POST', '/api/community/posts/' + postId + '/comments', unlocked, { body: 'Great hypothesis on bucket 1' });
  assert.strictEqual(c.status, 201);
  assert.strictEqual((await api('POST', '/api/community/comments/' + c.json.id + '/vote', locked)).status, 403);
  assert.strictEqual((await api('POST', '/api/community/comments/' + c.json.id + '/vote', unlocked)).status, 200);
  const reread = await api('GET', '/api/community/experts/' + entry.id, unlocked);
  assert.strictEqual(reread.json.comments.length, 1);
  assert.strictEqual(reread.json.id, postId, 'the discussion thread is created once');

  // expert entries cannot be deleted through the student post route
  assert.strictEqual((await api('DELETE', '/api/community/posts/' + postId, unlocked)).status, 403);
});

test('community: expert entries stay out of the student feed, member counts and public profiles', { skip }, async () => {
  const viewer = await signup('feedviewer');
  const feed = await api('GET', '/api/community/posts', viewer);
  assert.ok(feed.json.every(p => p.caseId && !String(p.caseId).startsWith('ex') || p.note !== ''), 'feed holds student posts only');
  assert.strictEqual(feed.json.length, 0);
  const members = (await api('GET', '/api/community/members', viewer)).json.members;
  const expert = members.find(m => m.name === 'E2E Expert');
  assert.strictEqual(expert.solvedCount, 15);
  assert.strictEqual(expert.postCount, 0);
  assert.strictEqual(expert.commentCount, 0);
  const profile = (await api('GET', '/api/community/members/' + expert.id, viewer)).json;
  assert.strictEqual(profile.solvedCount, 15);
  assert.strictEqual(profile.posts.length, 0);
  const unlockedUser = members.find(m => m.name === 'unlocked');
  assert.strictEqual(unlockedUser.commentCount, 0, 'comments on expert entries are not counted publicly');
  const up = (await api('GET', '/api/community/members/' + unlockedUser.id, viewer)).json;
  assert.strictEqual(up.comments.length, 0, 'and are not shown on public profiles');
});

test('student posts still work as before', { skip }, async () => {
  const a = await signup('poster'), b = await signup('replier');
  const post = await api('POST', '/api/community/posts', a, { caseId: 'ex01', note: 'Stuck on bucket 2' });
  assert.strictEqual(post.status, 201);
  assert.strictEqual((await api('GET', '/api/community/posts', b)).json.length, 1);
  assert.strictEqual((await api('POST', '/api/community/posts/' + post.json.id + '/comments', b, { body: 'Try splitting it' })).status, 201);
  const detail = await api('GET', '/api/community/posts/' + post.json.id, b);
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.json.comments.length, 1);
});

test('creator submissions are validated and show up for the admin with their structure', { skip }, async () => {
  const login = await api('POST', '/api/auth/login', null, { email: 'aneeq@caseroom.app', password: ADMIN_PW });
  const admin = login.json.token;
  assert.strictEqual((await api('POST', '/api/creator/solved-frameworks', admin, { caseId: 'ex01', framework: { text: 'free text' } })).status, 400);
  const admin1 = await api('GET', '/api/admin/judge-preview', admin);
  assert.strictEqual(admin1.status, 200);
  assert.strictEqual(admin1.json.exemplarCount, 15);
  assert.deepStrictEqual(admin1.json.judged, ['MECE', 'Relevant']);
  assert.strictEqual(admin1.json.cacheableOnHaiku, true);
  assert.strictEqual(admin1.json.settings.promptCaching, false);
});

test('admin: prompt history records saves and the first save keeps the original', { skip }, async () => {
  const admin = (await api('POST', '/api/auth/login', null, { email: 'aneeq@caseroom.app', password: ADMIN_PW })).json.token;
  const original = (await api('GET', '/api/admin/system-config/system-prompt', admin)).json.systemPrompt;
  assert.ok(original.length > 50);
  assert.strictEqual((await api('PUT', '/api/admin/system-config/system-prompt', admin, { systemPrompt: original + '\nExtra line.' })).status, 200);
  const hist = (await api('GET', '/api/admin/system-config/system-prompt/history', admin)).json;
  assert.strictEqual(hist.length, 2);
  const first = (await api('GET', '/api/admin/system-config/system-prompt/history/' + hist[1].id, admin)).json.systemPrompt;
  assert.strictEqual(first, original);
  const latest = (await api('GET', '/api/admin/system-config/system-prompt/history/' + hist[0].id, admin)).json.systemPrompt;
  assert.ok(latest.endsWith('Extra line.'));
  // the edited prompt changes the judge's system block, so previously stored results are not reused
  const t = await signup('afteredit');
  const before = modelCalls.length;
  await api('POST', '/api/judge', t, { caseId: 'ex07', structText: STRUCT, transcript: 'market size and competition', ruleResults: [{ name: 'Structure', level: 'weak', notes: ['Only 2 buckets'] }] });
  assert.strictEqual(modelCalls.length, before + 1);
  assert.match(modelCalls[modelCalls.length - 1].system, /Extra line\./);
});

test('admin: the planted-flaw test needs explicit confirmation and runs three variants per case', { skip }, async () => {
  const admin = (await api('POST', '/api/auth/login', null, { email: 'aneeq@caseroom.app', password: ADMIN_PW })).json.token;
  assert.strictEqual((await api('POST', '/api/admin/judge-test', admin, {})).status, 400);
  const before = modelCalls.length;
  const r = await api('POST', '/api/admin/judge-test', admin, { confirm: true, cases: 2 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.total, 6);
  assert.strictEqual(modelCalls.length - before, 6);
  // each test leaves out that case's own expert framework from the prompt (leave-one-out)
  const ids = [...new Set(r.json.results.map(x => x.caseId))];
  const reqs = modelCalls.slice(before);
  ids.forEach(id => reqs.filter(q => q.user.includes('Case: ' + r.json.results.find(x => x.caseId === id).title)).forEach(q => assert.doesNotMatch(q.system, new RegExp('### ' + id + ':'))));
  // the fake always answers MECE strong / Relevant ok, so only the "overlap" variant's MECE expectation fails
  assert.deepStrictEqual(r.json.results.filter(x => !x.pass).map(x => x.variant), ['overlap', 'overlap']);
  const stats = (await api('GET', '/api/admin/judge-stats', admin)).json;
  assert.ok(stats.modelCalls >= 7);
});

// ---------------------------------------------------------------------------------------------------------------
// Authentication: environment-managed admin passwords, session versioning, password change, brute-force limits
// ---------------------------------------------------------------------------------------------------------------
const login = (email, password) => api('POST', '/api/auth/login', null, { email, password });
const me = token => api('GET', '/api/auth/me', token);

test('auth: the seed admin signs in with the environment password and the old published default is refused', { skip }, async () => {
  assert.strictEqual((await login('aneeq@caseroom.app', ADMIN_PW)).status, 200);
  assert.strictEqual((await login('aneeq@caseroom.app', 'CaseFramework1')).status, 401);
  const q = await pool.query("SELECT email FROM users WHERE email = 'chohan@caseroom.app'");
  assert.strictEqual(q.rows.length, 0, 'an admin whose variable is not set is not created with a built-in password');
});

test('auth: changing your password ends the old session and every other one, and returns a working new token', { skip }, async () => {
  const signupRes = await api('POST', '/api/auth/signup', null, { email: 'pwuser@e2e.test', password: 'password123', firstName: 'pw' });
  const old = signupRes.json.token;
  assert.strictEqual((await me(old)).status, 200);

  assert.strictEqual((await api('PATCH', '/api/auth/password', null, { currentPassword: 'a', newPassword: 'b' })).status, 401);
  const wrong = await api('PATCH', '/api/auth/password', old, { currentPassword: 'not-it-at-all', newPassword: 'brand-new-pass-1' });
  assert.strictEqual(wrong.status, 400);
  assert.match(wrong.json.error, /Current password is incorrect/);
  assert.strictEqual((await api('PATCH', '/api/auth/password', old, { currentPassword: 'password123', newPassword: 'short' })).status, 400);
  assert.strictEqual((await api('PATCH', '/api/auth/password', old, { currentPassword: 'password123', newPassword: 'password123' })).status, 400);
  assert.strictEqual((await api('PATCH', '/api/auth/password', old, { currentPassword: 'password123' })).status, 400);
  assert.strictEqual((await me(old)).status, 200, 'rejected attempts leave the session alone');

  const changed = await api('PATCH', '/api/auth/password', old, { currentPassword: 'password123', newPassword: 'brand-new-pass-1' });
  assert.strictEqual(changed.status, 200);
  assert.ok(changed.json.token && changed.json.token !== old);
  assert.strictEqual((await me(old)).status, 401, 'the previous token no longer works');
  assert.strictEqual((await me(changed.json.token)).status, 200, 'the fresh token does');
  assert.strictEqual((await login('pwuser@e2e.test', 'password123')).status, 401);
  const relogin = await login('pwuser@e2e.test', 'brand-new-pass-1');
  assert.strictEqual(relogin.status, 200);
  assert.strictEqual((await me(relogin.json.token)).status, 200);
  assert.strictEqual((await me(changed.json.token)).status, 200, 'logging in again does not end the other session');
});

test('auth: admin and creator accounts need a 12-character password', { skip }, async () => {
  const admin = (await login('aneeq@caseroom.app', ADMIN_PW)).json.token;
  const r = await api('PATCH', '/api/auth/password', admin, { currentPassword: ADMIN_PW, newPassword: 'eleven-char' });
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /at least 12 characters/);
  assert.strictEqual((await me(admin)).status, 200);
});

test('auth: failed logins are limited per email and a correct login is not what uses the allowance', { skip }, async () => {
  await api('POST', '/api/auth/signup', null, { email: 'limited@e2e.test', password: 'password123', firstName: 'l' });
  for (let i = 0; i < 3; i++) assert.strictEqual((await login('limited@e2e.test', 'wrong' + i)).status, 401);
  assert.strictEqual((await login('limited@e2e.test', 'password123')).status, 200, 'a correct login still works and clears the count');
  for (let i = 0; i < 10; i++) assert.strictEqual((await login('limited@e2e.test', 'wrong' + i)).status, 401);
  const blocked = await login('limited@e2e.test', 'password123');
  assert.strictEqual(blocked.status, 429);
  assert.match(blocked.json.error, /Too many failed attempts/);
  assert.strictEqual((await login('someone-else@e2e.test', 'x')).status, 401, 'other addresses are unaffected');
  for (let i = 0; i < 10; i++) await login('nobody@e2e.test', 'x' + i);
  assert.strictEqual((await login('nobody@e2e.test', 'x')).status, 429, 'unknown addresses are limited too, so the limit does not reveal which exist');
});

test('auth: wrong current-password entries when changing a password are limited per user', { skip }, async () => {
  const t = (await api('POST', '/api/auth/signup', null, { email: 'pwlimit@e2e.test', password: 'password123', firstName: 'p' })).json.token;
  for (let i = 0; i < 5; i++) assert.strictEqual((await api('PATCH', '/api/auth/password', t, { currentPassword: 'nope' + i, newPassword: 'another-new-pass-1' })).status, 400);
  assert.strictEqual((await api('PATCH', '/api/auth/password', t, { currentPassword: 'password123', newPassword: 'another-new-pass-1' })).status, 429);
});

test('auth: a role change or deletion applies to an existing token straight away', { skip }, async () => {
  const admin = (await login('aneeq@caseroom.app', ADMIN_PW)).json.token;
  const t = (await api('POST', '/api/auth/signup', null, { email: 'promoted@e2e.test', password: 'password123', firstName: 'r' })).json.token;
  const id = (await me(t)).json.id;
  assert.strictEqual((await api('GET', '/api/creator/solved-frameworks', t)).status, 403);
  assert.strictEqual((await api('PATCH', `/api/admin/users/${id}/role`, admin, { role: 'creator' })).status, 200);
  assert.strictEqual((await api('GET', '/api/creator/solved-frameworks', t)).status, 200, 'promotion needs no new login');
  assert.strictEqual((await api('PATCH', `/api/admin/users/${id}/role`, admin, { role: 'user' })).status, 200);
  assert.strictEqual((await api('GET', '/api/creator/solved-frameworks', t)).status, 403, 'demotion is immediate');
  assert.strictEqual((await api('DELETE', `/api/admin/users/${id}`, admin)).status, 200);
  assert.strictEqual((await me(t)).status, 401, 'a deleted account\'s token stops working');
});

test('auth: an existing admin account that still has the old published password is flagged, then rotated from the environment', { skip }, async () => {
  const bcrypt = require(path.join(__dirname, '..', 'backend', 'node_modules', 'bcryptjs'));
  const q = (sql, p) => pool.query(sql, p);
  // This is the production situation: the account already exists with the password that was published in the repo.
  await q("INSERT INTO users (email, password_hash, first_name, role) VALUES ('chohan@caseroom.app', $1, 'Chohan', 'admin')", [await bcrypt.hash('CaseFramework2', 10)]);
  const oldToken = (await login('chohan@caseroom.app', 'CaseFramework2')).json.token;
  assert.strictEqual((await api('GET', '/api/admin/users', oldToken)).status, 200, 'precondition: the old password works');

  const run = async () => { const c = await pool.connect(); try { await seedAdmins(c); } finally { c.release(); } };
  const warnings = [];
  const realWarn = console.warn; console.warn = (...a) => warnings.push(a.join(' '));
  try {
    delete process.env.ADMIN_PASSWORD_CHOHAN;
    await run();
    assert.ok(warnings.some(w => /SECURITY: chohan@caseroom.app still accepts the old published default password/.test(w)));
    assert.strictEqual((await login('chohan@caseroom.app', 'CaseFramework2')).status, 200, 'without the variable nothing changes');

    process.env.ADMIN_PASSWORD_CHOHAN = 'short';
    await run();
    assert.ok(warnings.some(w => /ADMIN_PASSWORD_CHOHAN is ignored/.test(w)));
    process.env.ADMIN_PASSWORD_CHOHAN = 'CaseFramework2';
    await run();
    assert.strictEqual((await login('chohan@caseroom.app', 'CaseFramework2')).status, 200, 'the old default is not accepted as the new value');
  } finally { console.warn = realWarn; }

  process.env.ADMIN_PASSWORD_CHOHAN = 'rotated-admin-password-9';
  await run();
  assert.strictEqual((await login('chohan@caseroom.app', 'CaseFramework2')).status, 401, 'the old password stops working');
  assert.strictEqual((await api('GET', '/api/admin/users', oldToken)).status, 401, 'and so does a session opened with it');
  const fresh = await login('chohan@caseroom.app', 'rotated-admin-password-9');
  assert.strictEqual(fresh.status, 200);

  const hash1 = (await q("SELECT password_hash FROM users WHERE email = 'chohan@caseroom.app'")).rows[0].password_hash;
  await run();
  assert.strictEqual((await q("SELECT password_hash FROM users WHERE email = 'chohan@caseroom.app'")).rows[0].password_hash, hash1, 'restarting with the same value changes nothing');

  // The admin then picks their own password in the app; a restart must not undo it.
  const changed = await api('PATCH', '/api/auth/password', fresh.json.token, { currentPassword: 'rotated-admin-password-9', newPassword: 'chosen-in-the-app-pass-1' });
  assert.strictEqual(changed.status, 200);
  await run();
  assert.strictEqual((await login('chohan@caseroom.app', 'chosen-in-the-app-pass-1')).status, 200, 'an in-app change survives a restart');
  assert.strictEqual((await login('chohan@caseroom.app', 'rotated-admin-password-9')).status, 401);

  // Changing the variable's value is the recovery path if the password is forgotten.
  process.env.ADMIN_PASSWORD_CHOHAN = 'recovered-admin-password-3';
  await run();
  assert.strictEqual((await login('chohan@caseroom.app', 'recovered-admin-password-3')).status, 200);
  assert.strictEqual((await login('chohan@caseroom.app', 'chosen-in-the-app-pass-1')).status, 401);
});

test('auth: a variable that is set creates a missing admin account with that password', { skip }, async () => {
  await pool.query("DELETE FROM users WHERE email = 'chohan@caseroom.app'");
  await pool.query("DELETE FROM system_config WHERE key = 'admin_password_applied:chohan@caseroom.app'");
  process.env.ADMIN_PASSWORD_CHOHAN = 'created-from-env-password-1';
  const c = await pool.connect(); try { await seedAdmins(c); } finally { c.release(); }
  const r = await login('chohan@caseroom.app', 'created-from-env-password-1');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.user.role, 'admin');
});

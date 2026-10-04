// Drives the real app in Chromium: judged and fallback reviews, expert frameworks (gating, comments), badges, admin tools.
// Needs Playwright and the server from tests/ui/server.js:
//   UI_DATABASE_URL=... node tests/ui/server.js &   then   node tests/ui/browser.test.js
// UI_BASE overrides the server address; UI_SHOTS sets where screenshots go (default: the OS temp dir).
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }
const os = require('os'), path = require('path'), fs = require('fs');
const assert = require('node:assert');
const BASE = process.env.UI_BASE || 'http://localhost:3001';
const SHOTS = path.join(process.env.UI_SHOTS || path.join(os.tmpdir(), 'caseroom-ui-shots'), path.sep);
fs.mkdirSync(SHOTS, { recursive: true });

const post = async (url, body, token) => (await fetch(BASE + url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) })).json();
const get = async (url, token) => (await fetch(BASE + url, { headers: { authorization: 'Bearer ' + token } })).json();
const results = [];
const has = (text, sub) => text.toLowerCase().includes(sub.toLowerCase());
const check = (name, fn) => async () => { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + ' :: ' + e.message.split('\n')[0]]); } };

(async () => {
  const stamp = Date.now();
  const su = await post('/api/auth/signup', { email: `ui${stamp}@t.test`, password: 'password123', firstName: 'Uma' + (stamp % 100000) });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await ctx.addInitScript(([t, u]) => { localStorage.setItem('cf_token', t); localStorage.setItem('cf_user', u); }, [su.token, JSON.stringify(su.user)]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Deepgram|speak|favicon|Failed to load resource/i.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(BASE);
  await page.waitForFunction(() => typeof runReview === 'function' && typeof loadCaseBank === 'function');

  const runReviewFor = async (caseId, structText, transcript) => {
    await page.evaluate(async ([caseId]) => { await loadCaseBank(); S.pendingPick = { caseId }; try { await startDrill(); } catch (e) { /* speech is unavailable offline */ } }, [caseId]);
    await page.evaluate(([structText, transcript]) => {
      S.recorded = false; el('fwText').value = transcript; el('structText').value = structText;
      el('structureEditCard').style.display = ''; document.querySelectorAll('.modal.show').forEach(m => m.classList.remove('show')); gotoStage('review'); renderPreview();
    }, [structText, transcript]);
    await page.evaluate(() => { window.__rv = runReview(); });
  };

  const STRUCT = '# Market size\n- how big is the market\n- how fast is it growing\n# Competition\n- who are the main rivals\n- how do they price';

  // ---- judged review
  await runReviewFor('ex07', STRUCT, 'I would look at market size and competition');
  await page.waitForSelector('#reviewOut .crit', { timeout: 15000 });
  await page.waitForTimeout(1300);
  await page.screenshot({ path: SHOTS + '1-review-judged.png', fullPage: true });
  await check('judged review shows the coach card with all four notes', async () => {
    const t = await page.locator('#reviewOut').innerText();
    for (const s of ["Coach's notes", 'Clear, separate market', 'Next: Tie each area', 'An expert would also: A test of the financial hurdle', 'Say where you would start']) assert.ok(has(t, s), 'missing: ' + s);
  })();
  await check('judge text is escaped, not rendered as HTML', async () => {
    const html = await page.locator('#reviewOut').innerHTML();
    assert.ok(html.includes('&lt;b&gt;pricing&lt;/b&gt;'), 'model markup was not escaped');
    assert.strictEqual(await page.locator('#reviewOut b:text-is("pricing")').count(), 0);
    assert.ok((await page.locator('#reviewOut').innerText()).includes('You said: “who are the main rivals”'));
  })();
  await check('score is recomputed from rule + judged levels (Structure weak, MECE ok, Succinct strong, Relevant weak = 3/8)', async () => {
    assert.strictEqual((await page.locator('#gnum').innerText()).trim(), '38');
    const levels = await page.$$eval('#reviewOut .crit', els => els.map(e => e.querySelector('.ctitle2').textContent + ':' + e.querySelector('.cicon').className.split(' ').pop()));
    assert.deepStrictEqual(levels, ['Structure:c-weak', 'MECE:c-ok', 'Succinct:c-strong', 'Relevant:c-weak']);
    assert.ok(!has(await page.locator('#reviewOut').innerText(), 'Quick review'));
  })();

  // ---- saved with rubric version 3 and coach notes
  await page.waitForFunction(() => document.querySelector('#expertLinkSlot button'), null, { timeout: 15000 });
  await check('the drill is saved with rubric version 3 and the coach notes', async () => {
    const drills = await get('/api/drills', su.token);
    assert.strictEqual(drills[0].case_id, 'ex07');
    assert.strictEqual(drills[0].rubric_version, 3);
    assert.strictEqual(JSON.parse(drills[0].ai_feedback).topPriority, 'Tie each area to the three-year breakeven the client gave.');
    assert.strictEqual(drills[0].score, 38);
  })();

  // ---- expert link after the attempt, unlocked framework view
  await page.screenshot({ path: SHOTS + '2-review-with-expert-link.png', fullPage: true });
  await page.click('#expertLinkSlot button');
  await page.waitForSelector('#communityDetailContent .ai-bucket', { timeout: 10000 });
  await check('the expert link opens the unlocked framework', async () => {
    const t = await page.locator('#communityDetailContent').innerText();
    for (const s of ["Jane Darden", 'Go / no-go', 'Test Expert', 'Where to start', 'Clarifying questions and answers']) assert.ok(has(t, s), 'missing: ' + s);
    assert.strictEqual(await page.locator('#communityDetailContent .ai-bucket').count(), 4);
    assert.strictEqual(await page.locator('#communityDetailContent .chip:text-is("Start here")').count(), 1);
    assert.ok((await page.locator('#communityDetailContent').innerText()).includes('Hypothesis:'));
  })();
  await page.screenshot({ path: SHOTS + '3-expert-framework.png', fullPage: true });

  const myComment = 'I would also test the occupancy assumption first. ' + stamp;
  await page.fill('#communityCommentBody', myComment);
  await page.click('text=Post comment');
  await page.waitForFunction(t => document.querySelector('#communityDetailContent').innerText.includes(t) && document.querySelectorAll('#communityDetailContent .ai-bucket').length === 4, myComment, { timeout: 10000 });
  await check('commenting on an expert framework keeps you on the expert view', async () => {
    assert.ok((await page.locator('#communityDetailContent').innerText()).includes(myComment));
    assert.ok(await page.locator('#communityDetailContent .ai-bucket').count() === 4, 'framework should still be shown after commenting');
  })();

  // ---- back goes to the expert list; lock state
  await page.click('#communityBackBtn');
  await page.waitForSelector('#communityExpertsList article', { timeout: 10000 });
  await check('expert list: 15 entries, only the attempted case unlocked, no framework text leaked', async () => {
    assert.strictEqual(await page.locator('#communityExpertsList article').count(), 15);
    assert.strictEqual(await page.locator('#communityExpertsList .status-pill:text-is("Unlocked")').count(), 1);
    assert.strictEqual(await page.locator('#communityExpertsList .status-pill:text-is("Locked")').count(), 14);
    const t = await page.locator('#communityExpertsList').innerText();
    assert.ok(!has(t, 'I expect') && !has(t, 'Where to start'));
    assert.ok(has(t, 'Practice this case to unlock'));
  })();
  await page.screenshot({ path: SHOTS + '4-expert-list.png', fullPage: true });
  await page.locator('#communityExpertsList article', { hasText: 'Hooville' }).locator('.post-main').click();
  await page.waitForSelector('text=This unlocks once you have attempted the case');
  await check('opening a locked entry shows the lock message and a way to practise', async () => {
    assert.ok(await page.locator('text=Practice this case').count() >= 1);
    assert.strictEqual(await page.locator('#communityDetailContent .ai-bucket').count(), 0);
  })();
  await page.screenshot({ path: SHOTS + '5-locked-entry.png', fullPage: true });

  // ---- the practice button starts a drill on that case
  await page.click('#communityDetailContent >> text=Practice this case');
  await page.waitForFunction(() => S.caseObj && S.caseObj.title === 'Hooville College', null, { timeout: 10000 });
  await check('"Practice this case" starts a drill on that exact case', async () => {
    assert.strictEqual(await page.evaluate(() => S.caseObj.id), 'ex04');
  })();

  // ---- fallback when the coach is unavailable
  await runReviewFor('ex02', STRUCT + '\n- FAILME', 'transcript');
  await page.waitForSelector('#reviewOut .crit', { timeout: 15000 });
  await page.waitForTimeout(1300);
  await page.screenshot({ path: SHOTS + '6-review-fallback.png', fullPage: true });
  await check('judge outage falls back to the rule-based review with a visible note, and still scores', async () => {
    const t = await page.locator('#reviewOut').innerText();
    assert.ok(has(t, 'Quick review: the coach was unavailable'));
    assert.ok(!has(t, "Coach's notes"));
    assert.ok(await page.locator('#reviewOut .crit').count() === 4);
    assert.ok(/^\d+$/.test((await page.locator('#gnum').innerText()).trim()));
  })();
  await page.waitForTimeout(800);
  await check('the fallback result is saved at rubric version 2 with no coach notes', async () => {
    const d = (await get('/api/drills', su.token)).find(x => x.case_id === 'ex02');
    assert.strictEqual(d.rubric_version, 2);
    assert.strictEqual(d.ai_feedback, null);
  })();

  // ---- members badge
  await page.evaluate(() => { _activeCommunityTab = 'members'; showView('community'); });
  await page.waitForSelector('.member-card', { timeout: 10000 });
  await check('the expert shows a badge with their solved count on the members page', async () => {
    const card = page.locator('.member-card', { hasText: 'Test Expert' });
    assert.ok((await card.innerText()).includes('Expert · 15 solved'));
    assert.ok(!(await page.locator('.member-card', { hasText: 'Uma' + (stamp % 100000) }).innerText()).includes('Expert'));
  })();
  await page.locator('.member-card', { hasText: 'Test Expert' }).click();
  await page.waitForSelector('#communityMemberProfileContent .profile-head');
  await check('and on their profile, without leaking expert-thread comments', async () => {
    const t = await page.locator('#communityMemberProfileContent').innerText();
    assert.ok(t.includes('Expert · 15 solved'));
    assert.ok(t.includes('0 public post'));
  })();

  // ---- admin: structured creator form + approval preview
  const adminLogin = await post('/api/auth/login', { email: 'aneeq@caseroom.app', password: 'CaseFramework1' });
  const actx = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
  await actx.addInitScript(([t, u]) => { localStorage.setItem('cf_token', t); localStorage.setItem('cf_user', u); }, [adminLogin.token, JSON.stringify(adminLogin.user)]);
  const ap = await actx.newPage();
  ap.on('pageerror', e => errors.push('admin pageerror: ' + e.message));
  await ap.goto(BASE);
  await ap.waitForFunction(() => typeof showView === 'function' && typeof submitFramework === 'function');
  await ap.evaluate(() => showView('creator'));
  await ap.waitForSelector('#creatorFwShape');
  await ap.screenshot({ path: SHOTS + '7-creator-form.png', fullPage: true });
  await ap.evaluate(() => { el('creatorFrameworkCaseId').value = 'ex01'; });
  await ap.selectOption('#creatorFwShape', 'gate');
  await ap.fill('#creatorFwPurpose', 'To decide whether to proceed, I would look at two areas:');
  await ap.fill('#creatorFrameworkText', 'no hash here');
  await ap.fill('#creatorFwStart', 'Start with the first area.');
  await ap.click('#submitFrameworkBtn');
  await ap.waitForTimeout(400);
  await check('bad bucket text shows an inline error', async () => {
    assert.ok((await ap.locator('#frameworkStatus').innerText()).includes('start with a # bucket question'));
  })();
  await ap.fill('#creatorFrameworkText', '# Is it attractive?\n- How big?\n> I expect it is small.\n# Can we win?\n- What do we have?');
  await ap.fill('#creatorFwClarifying', 'Q: What is the goal?\nA: Grow revenue.');
  await ap.click('#submitFrameworkBtn');
  await ap.waitForFunction(() => /submitted/i.test(document.getElementById('frameworkStatus').textContent), null, { timeout: 10000 });
  await check('a valid structured submission is accepted and stored in the schema', async () => {
    const rows = await get('/api/admin/solved-frameworks', adminLogin.token);
    const mine = rows.find(r => r.status === 'pending' && r.case_id === 'ex01');
    assert.ok(mine, 'pending row not found');
    assert.strictEqual(mine.framework.shape, 'gate');
    assert.strictEqual(mine.framework.buckets[0].hypothesis, 'I expect it is small.');
    assert.deepStrictEqual(mine.framework.clarifying, [{ question: 'What is the goal?', answer: 'Grow revenue.' }]);
  })();
  await ap.evaluate(() => showView('admin'));
  await ap.click('button[data-tab="solved-frameworks"]');
  await ap.waitForSelector('#solvedFrameworksTable tbody tr details', { timeout: 10000 });
  await check('admin approval table can show the framework before approving', async () => {
    const row = ap.locator('#solvedFrameworksTable tbody tr', { hasText: 'pending' }).first();
    await row.locator('summary').click();
    const t = await row.locator('pre').innerText();
    assert.ok(has(t, 'Shape: gate') && t.includes('1. Is it attractive?') && t.includes('> I expect it is small.'));
  })();
  await ap.screenshot({ path: SHOTS + '8-admin-approval.png', fullPage: true });


  // ---- admin: system prompt tab (versions, preview, planted-flaw test)
  await ap.click('button[data-tab="system-prompt"]');
  await ap.waitForFunction(() => document.getElementById('systemPromptEditor').value.length > 50);
  await ap.evaluate(() => { const e = el('systemPromptEditor'); e.value = e.value + '\nUI test line.'; });
  await ap.click('#spSaveBtn');
  await ap.waitForFunction(() => /Saved successfully/.test(document.getElementById('spStatus').textContent));
  await ap.waitForFunction(() => document.querySelectorAll('#spHistorySel option').length >= 2 && document.querySelector('#spHistorySel option').value);
  await check('saving a prompt adds a version to the history list', async () => {
    assert.ok(await ap.locator('#spHistorySel option').count() >= 2);
  })();
  await ap.selectOption('#spHistorySel', { index: (await ap.locator('#spHistorySel option').count()) - 1 }); // oldest = the original prompt
  await ap.click('#spLoadVersionBtn');
  await ap.waitForFunction(() => /Loaded into the editor/.test(document.getElementById('spStatus').textContent), null, { timeout: 10000 });
  await check('an older version can be loaded back into the editor (without saving)', async () => {
    const val = await ap.inputValue('#systemPromptEditor'), st = await ap.locator('#spStatus').innerText();
    const opts = await ap.$$eval('#spHistorySel option', o => o.map(x => x.value + ':' + x.textContent.slice(-20) + (x.selected ? '*' : '')));
    assert.ok(!val.includes('UI test line.'), 'editor still has the test line; options=' + JSON.stringify(opts) + ' status=' + st);
    assert.ok(has(st, 'Save to make it live'), 'status was: ' + st);
  })();
  await ap.click('#spPreviewBtn');
  await ap.waitForFunction(() => /Stable prompt/.test(document.getElementById('spPanel').textContent), null, { timeout: 15000 });
  await check('preview shows prompt size, exemplar count, what the coach scores and usage so far', async () => {
    const t = await ap.locator('#spPanel').innerText();
    for (const x of ['Stable prompt:', 'Expert frameworks included: 15', 'Coach scores: MECE, Relevant', 'Prompt caching: off', 'Large enough to cache on Haiku', 'model calls']) assert.ok(has(t, x), 'missing: ' + x);
  })();
  await ap.click('#spTestBtn');
  await ap.click('.modal.show button:has-text("Run test")');
  await ap.waitForFunction(() => /expectations held/.test(document.getElementById('spPanel').textContent), null, { timeout: 30000 });
  await ap.screenshot({ path: SHOTS + '9-admin-prompt-checks.png', fullPage: true });
  await check('planted-flaw test reports pass/fail per variant (fake model: gold fails, generic and overlap hold)', async () => {
    const t = await ap.locator('#spPanel').innerText();
    assert.ok(has(t, '6 of 9 expectations held'), t.split('\n')[0]);
    assert.strictEqual((t.match(/FAIL {2}.*\/ gold/g) || []).length, 3);
    assert.strictEqual((t.match(/PASS {2}.*\/ generic/g) || []).length, 3);
  })();

  await check('no uncaught page errors during the whole run', async () => { assert.deepStrictEqual(errors, []); })();
  await browser.close();
  for (const [s, n] of results) console.log(s, n);
  console.log(`\n${results.filter(r => r[0] === 'PASS').length} passed, ${results.filter(r => r[0] === 'FAIL').length} failed`);
  process.exit(results.some(r => r[0] === 'FAIL') ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });

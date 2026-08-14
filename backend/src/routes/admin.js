const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdmin);

// ---- Users ----

// GET /api/admin/users - list all users with their drill count
router.get('/users', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.email, u.first_name, u.role, u.bypass_approval, u.created_at,
             COUNT(d.id)::int AS drill_count
      FROM users u
      LEFT JOIN drill_results d ON d.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Admin list users error:', err);
    res.status(500).json({ error: 'Could not fetch users' });
  }
});

// PATCH /api/admin/users/:id/role - promote or demote a user
router.patch('/users/:id/role', async (req, res) => {
  const { role } = req.body;
  if (!['user', 'creator', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Role must be "user", "creator", or "admin"' });
  }
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: "You can't change your own role" });
  }
  try {
    const result = await pool.query(
      'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, email, role',
      [role, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Admin update role error:', err);
    res.status(500).json({ error: 'Could not update role' });
  }
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', async (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: "You can't delete your own account" });
  }
  try {
    const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Admin delete user error:', err);
    res.status(500).json({ error: 'Could not delete user' });
  }
});

// ---- Case bank ----

// GET /api/admin/cases - same data as /api/cases, kept separate so admin tooling can evolve independently
router.get('/cases', async (req, res) => {
  try {
    const result = await pool.query('SELECT data FROM cases ORDER BY id');
    res.json(result.rows.map(r => r.data));
  } catch (err) {
    console.error('Admin list cases error:', err);
    res.status(500).json({ error: 'Could not fetch cases' });
  }
});

// POST /api/admin/cases - create a new case
router.post('/cases', async (req, res) => {
  const { title, type, source, prompt, facts, clarifiers, meceDimensions, caseKeywords } = req.body;
  if (!title || !prompt) {
    return res.status(400).json({ error: 'Title and prompt are required' });
  }
  const id = 'c' + crypto.randomBytes(4).toString('hex');
  const data = {
    id, title, source: source || '', type: type || 'general', prompt,
    facts: facts || [], clarifiers: clarifiers || [],
    meceDimensions: meceDimensions || [], caseKeywords: caseKeywords || []
  };
  try {
    await pool.query(
      'INSERT INTO cases (id, title, source, type, data) VALUES ($1, $2, $3, $4, $5)',
      [id, title, source || '', type || '', JSON.stringify(data)]
    );
    res.json(data);
  } catch (err) {
    console.error('Admin create case error:', err);
    res.status(500).json({ error: 'Could not create case' });
  }
});

// PUT /api/admin/cases/:id - replace an existing case's fields
router.put('/cases/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await pool.query('SELECT data FROM cases WHERE id = $1', [id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Case not found' });

    const merged = { ...existing.rows[0].data, ...req.body, id };
    await pool.query(
      'UPDATE cases SET title = $1, source = $2, type = $3, data = $4, updated_at = NOW() WHERE id = $5',
      [merged.title, merged.source || '', merged.type || '', JSON.stringify(merged), id]
    );
    res.json(merged);
  } catch (err) {
    console.error('Admin update case error:', err);
    res.status(500).json({ error: 'Could not update case' });
  }
});

// DELETE /api/admin/cases/:id
router.delete('/cases/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM cases WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Case not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Admin delete case error:', err);
    res.status(500).json({ error: 'Could not delete case' });
  }
});

// ---- Marking Criteria ----

// GET /api/admin/marking-criteria - list all marking criteria
router.get('/marking-criteria', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, description, enabled, weight, config FROM marking_criteria ORDER BY id');
    res.json(result.rows);
  } catch (err) {
    console.error('Admin list marking criteria error:', err);
    res.status(500).json({ error: 'Could not fetch marking criteria' });
  }
});

// PUT /api/admin/marking-criteria/:name - update a marking criterion
router.put('/marking-criteria/:name', async (req, res) => {
  const { name } = req.params;
  const { description, enabled, weight, config } = req.body;
  try {
    const result = await pool.query(
      'UPDATE marking_criteria SET description = $1, enabled = $2, weight = $3, config = $4, updated_at = NOW() WHERE name = $5 RETURNING *',
      [description, enabled, weight, JSON.stringify(config), name]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Marking criterion not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Admin update marking criterion error:', err);
    res.status(500).json({ error: 'Could not update marking criterion' });
  }
});

// POST /api/admin/marking-criteria/:name/reset - reset to defaults
router.post('/marking-criteria/:name/reset', async (req, res) => {
  const { name } = req.params;
  const defaults = {
    Structure: {
      minBuckets: 3, maxBuckets: 5, minPointsPerBucket: 4, maxPointsPerBucket: 5,
      feedback: { strong: 'Within the 3–5 bucket range with 4–5 points each.', ok: 'Either bucket count or point distribution could be optimized.', weak: 'Needs adjustment: aim for 3–5 buckets with 4–5 points each.' }
    },
    MECE: {
      overlapThreshold: 0.22, minSharedWords: 2, minCoveragePct: 0,
      feedback: { strong: 'No significant overlap; covers key dimensions.', ok: 'Some overlap exists; could improve exclusivity.', weak: 'Significant overlap or missing key dimensions.' }
    },
    Succinct: {
      maxAvgWordLength: 12, maxLongPointsBeforeOk: 2, maxLongPointsBeforeWeak: 3, maxTotalBullets: 22,
      feedback: { strong: 'Points are concise and phrase-length.', ok: 'Some points could be more concise.', weak: 'Several points are too long; compress to phrases.' }
    },
    Relevant: {
      minRelevancePctForStrong: 0.5, minRelevancePctForOk: 0.25,
      feedback: { strong: 'Well tailored to this case with good specificity.', ok: 'Partly tailored; add more case-specific hooks.', weak: 'Generic. Reference client, industry, and specific figures.' }
    }
  };
  const config = defaults[name];
  if (!config) return res.status(400).json({ error: 'Unknown criterion name' });
  try {
    const result = await pool.query(
      'UPDATE marking_criteria SET config = $1, updated_at = NOW() WHERE name = $2 RETURNING *',
      [JSON.stringify(config), name]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Marking criterion not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Admin reset marking criterion error:', err);
    res.status(500).json({ error: 'Could not reset marking criterion' });
  }
});

// ---- System Configuration ----

// GET /api/admin/system-config/system-prompt
router.get('/system-config/system-prompt', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT value FROM system_config WHERE key = $1',
      ['system_prompt']
    );
    const value = result.rows.length > 0 ? result.rows[0].value : '';
    res.json({ systemPrompt: value });
  } catch (err) {
    console.error('Get system prompt error:', err);
    res.status(500).json({ error: 'Could not fetch system prompt' });
  }
});

// PUT /api/admin/system-config/system-prompt
router.put('/system-config/system-prompt', async (req, res) => {
  const { systemPrompt } = req.body;
  if (typeof systemPrompt !== 'string') {
    return res.status(400).json({ error: 'System prompt must be a string' });
  }
  try {
    const result = await pool.query(
      `UPDATE system_config SET value = $1, updated_at = NOW() WHERE key = $2 RETURNING value, updated_at`,
      [systemPrompt, 'system_prompt']
    );
    if (!result.rows.length) {
      await pool.query(
        'INSERT INTO system_config (key, value) VALUES ($1, $2) RETURNING value, updated_at',
        ['system_prompt', systemPrompt]
      );
    }
    res.json({ systemPrompt, message: 'System prompt updated successfully' });
  } catch (err) {
    console.error('Update system prompt error:', err);
    res.status(500).json({ error: 'Could not update system prompt' });
  }
});

// ---- Creator Management ----

// PATCH /api/admin/users/:id/bypass-approval - toggle bypass approval for a creator
router.patch('/users/:id/bypass-approval', async (req, res) => {
  const { bypassApproval } = req.body;
  if (typeof bypassApproval !== 'boolean') {
    return res.status(400).json({ error: 'bypassApproval must be a boolean' });
  }

  try {
    const result = await pool.query(
      'UPDATE users SET bypass_approval = $1 WHERE id = $2 RETURNING id, email, role, bypass_approval',
      [bypassApproval, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Admin update bypass approval error:', err);
    res.status(500).json({ error: 'Could not update bypass approval' });
  }
});

// ---- Solved Frameworks Approval ----

// GET /api/admin/solved-frameworks - list all solved frameworks with approval status
router.get('/solved-frameworks', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sf.id, sf.creator_id, u.email, u.first_name, sf.case_id, sf.framework, sf.status, sf.version, sf.approved_by, sf.created_at, sf.updated_at
      FROM solved_frameworks sf
      JOIN users u ON sf.creator_id = u.id
      ORDER BY sf.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Admin list solved frameworks error:', err);
    res.status(500).json({ error: 'Could not fetch solved frameworks' });
  }
});

// PATCH /api/admin/solved-frameworks/:id/approve - approve a solved framework
router.patch('/solved-frameworks/:id/approve', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `UPDATE solved_frameworks
       SET status = $1, approved_by = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING id, creator_id, case_id, framework, status, version, approved_by, created_at, updated_at`,
      ['approved', req.user.id, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Solved framework not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Admin approve framework error:', err);
    res.status(500).json({ error: 'Could not approve framework' });
  }
});

// PATCH /api/admin/solved-frameworks/:id/reject - reject a solved framework
router.patch('/solved-frameworks/:id/reject', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `UPDATE solved_frameworks
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, creator_id, case_id, framework, status, version, approved_by, created_at, updated_at`,
      ['rejected', id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Solved framework not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Admin reject framework error:', err);
    res.status(500).json({ error: 'Could not reject framework' });
  }
});

// DELETE /api/admin/solved-frameworks/:id - delete a solved framework
router.delete('/solved-frameworks/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM solved_frameworks WHERE id = $1 RETURNING id', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Solved framework not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Admin delete framework error:', err);
    res.status(500).json({ error: 'Could not delete framework' });
  }
});

// ---- Case Submissions Approval ----

// GET /api/admin/case-submissions - list all case submissions with approval status
router.get('/case-submissions', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT cs.id, cs.creator_id, u.email, u.first_name, cs.title, cs.source, cs.type, cs.data, cs.status, cs.approved_by, cs.created_at, cs.updated_at
      FROM case_submissions cs
      JOIN users u ON cs.creator_id = u.id
      ORDER BY cs.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Admin list case submissions error:', err);
    res.status(500).json({ error: 'Could not fetch case submissions' });
  }
});

// PATCH /api/admin/case-submissions/:id/approve - approve and migrate a case submission to cases
router.patch('/case-submissions/:id/approve', async (req, res) => {
  const { id } = req.params;

  try {
    const submission = await pool.query(
      'SELECT title, source, type, data FROM case_submissions WHERE id = $1',
      [id]
    );
    if (!submission.rows.length) {
      return res.status(404).json({ error: 'Case submission not found' });
    }

    const caseData = submission.rows[0];
    const caseId = 'c' + crypto.randomBytes(4).toString('hex');

    await pool.query('BEGIN');

    await pool.query(
      'INSERT INTO cases (id, title, source, type, data) VALUES ($1, $2, $3, $4, $5)',
      [caseId, caseData.title, caseData.source || '', caseData.type || '', JSON.stringify(caseData.data)]
    );

    await pool.query(
      `UPDATE case_submissions
       SET status = $1, approved_by = $2, updated_at = NOW()
       WHERE id = $3`,
      ['approved', req.user.id, id]
    );

    await pool.query('COMMIT');

    res.json({ ok: true, caseId, message: 'Case submission approved and migrated to cases' });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Admin approve case submission error:', err);
    res.status(500).json({ error: 'Could not approve case submission' });
  }
});

// PATCH /api/admin/case-submissions/:id/reject - reject a case submission
router.patch('/case-submissions/:id/reject', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `UPDATE case_submissions
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, creator_id, title, source, type, data, status, approved_by, created_at, updated_at`,
      ['rejected', id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Case submission not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Admin reject case submission error:', err);
    res.status(500).json({ error: 'Could not reject case submission' });
  }
});

// DELETE /api/admin/case-submissions/:id - delete a case submission
router.delete('/case-submissions/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM case_submissions WHERE id = $1 RETURNING id', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Case submission not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Admin delete case submission error:', err);
    res.status(500).json({ error: 'Could not delete case submission' });
  }
});

module.exports = router;

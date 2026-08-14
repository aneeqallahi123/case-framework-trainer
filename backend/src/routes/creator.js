const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireCreator } = require('../middleware/auth');

const router = express.Router();
router.use(requireCreator);

// ---- Solved Frameworks ----

// POST /api/creator/solved-frameworks - submit a solved framework
router.post('/solved-frameworks', async (req, res) => {
  const { caseId, framework } = req.body;
  if (!caseId || !framework) {
    return res.status(400).json({ error: 'Case ID and framework are required' });
  }

  try {
    const caseExists = await pool.query('SELECT id FROM cases WHERE id = $1', [caseId]);
    if (!caseExists.rows.length) {
      return res.status(404).json({ error: 'Case not found' });
    }

    const status = req.user.bypass_approval ? 'approved' : 'pending';
    const approvedBy = req.user.bypass_approval ? req.user.id : null;

    const result = await pool.query(
      `INSERT INTO solved_frameworks (creator_id, case_id, framework, status, approved_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, creator_id, case_id, framework, status, version, approved_by, created_at, updated_at`,
      [req.user.id, caseId, JSON.stringify(framework), status, approvedBy]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create solved framework error:', err);
    res.status(500).json({ error: 'Could not create solved framework' });
  }
});

// GET /api/creator/solved-frameworks - get creator's solved frameworks
router.get('/solved-frameworks', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, creator_id, case_id, framework, status, version, approved_by, created_at, updated_at
       FROM solved_frameworks
       WHERE creator_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Get solved frameworks error:', err);
    res.status(500).json({ error: 'Could not fetch solved frameworks' });
  }
});

// PATCH /api/creator/solved-frameworks/:id - edit a solved framework (creator's own)
router.patch('/solved-frameworks/:id', async (req, res) => {
  const { id } = req.params;
  const { framework } = req.body;
  if (!framework) {
    return res.status(400).json({ error: 'Framework is required' });
  }

  try {
    const existing = await pool.query(
      'SELECT creator_id, status FROM solved_frameworks WHERE id = $1',
      [id]
    );
    if (!existing.rows.length) {
      return res.status(404).json({ error: 'Solved framework not found' });
    }
    if (existing.rows[0].creator_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only edit your own submissions' });
    }
    if (existing.rows[0].status === 'approved') {
      return res.status(400).json({ error: 'Cannot edit approved frameworks' });
    }

    const result = await pool.query(
      `UPDATE solved_frameworks
       SET framework = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, creator_id, case_id, framework, status, version, approved_by, created_at, updated_at`,
      [JSON.stringify(framework), id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update solved framework error:', err);
    res.status(500).json({ error: 'Could not update solved framework' });
  }
});

// DELETE /api/creator/solved-frameworks/:id - delete a solved framework (creator's own)
router.delete('/solved-frameworks/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const existing = await pool.query(
      'SELECT creator_id, status FROM solved_frameworks WHERE id = $1',
      [id]
    );
    if (!existing.rows.length) {
      return res.status(404).json({ error: 'Solved framework not found' });
    }
    if (existing.rows[0].creator_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only delete your own submissions' });
    }

    await pool.query('DELETE FROM solved_frameworks WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete solved framework error:', err);
    res.status(500).json({ error: 'Could not delete solved framework' });
  }
});

// ---- Case Submissions ----

// POST /api/creator/case-submissions - submit a new case
router.post('/case-submissions', async (req, res) => {
  const { title, type, source, prompt, facts, clarifiers, meceDimensions, caseKeywords } = req.body;
  if (!title || !prompt) {
    return res.status(400).json({ error: 'Title and prompt are required' });
  }

  try {
    const data = {
      title,
      source: source || '',
      type: type || 'general',
      prompt,
      facts: facts || [],
      clarifiers: clarifiers || [],
      meceDimensions: meceDimensions || [],
      caseKeywords: caseKeywords || []
    };

    const status = req.user.bypass_approval ? 'approved' : 'pending';
    const approvedBy = req.user.bypass_approval ? req.user.id : null;

    const result = await pool.query(
      `INSERT INTO case_submissions (creator_id, title, source, type, data, status, approved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, creator_id, title, source, type, data, status, approved_by, created_at, updated_at`,
      [req.user.id, title, source || '', type || '', JSON.stringify(data), status, approvedBy]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create case submission error:', err);
    res.status(500).json({ error: 'Could not create case submission' });
  }
});

// GET /api/creator/case-submissions - get creator's case submissions
router.get('/case-submissions', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, creator_id, title, source, type, data, status, approved_by, created_at, updated_at
       FROM case_submissions
       WHERE creator_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Get case submissions error:', err);
    res.status(500).json({ error: 'Could not fetch case submissions' });
  }
});

// PATCH /api/creator/case-submissions/:id - edit a case submission (creator's own)
router.patch('/case-submissions/:id', async (req, res) => {
  const { id } = req.params;
  const { title, type, source, prompt, facts, clarifiers, meceDimensions, caseKeywords } = req.body;

  try {
    const existing = await pool.query(
      'SELECT creator_id, status, data FROM case_submissions WHERE id = $1',
      [id]
    );
    if (!existing.rows.length) {
      return res.status(404).json({ error: 'Case submission not found' });
    }
    if (existing.rows[0].creator_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only edit your own submissions' });
    }
    if (existing.rows[0].status === 'approved') {
      return res.status(400).json({ error: 'Cannot edit approved cases' });
    }

    const merged = {
      ...existing.rows[0].data,
      title: title !== undefined ? title : existing.rows[0].data.title,
      type: type !== undefined ? type : existing.rows[0].data.type,
      source: source !== undefined ? source : existing.rows[0].data.source,
      prompt: prompt !== undefined ? prompt : existing.rows[0].data.prompt,
      facts: facts !== undefined ? facts : existing.rows[0].data.facts,
      clarifiers: clarifiers !== undefined ? clarifiers : existing.rows[0].data.clarifiers,
      meceDimensions: meceDimensions !== undefined ? meceDimensions : existing.rows[0].data.meceDimensions,
      caseKeywords: caseKeywords !== undefined ? caseKeywords : existing.rows[0].data.caseKeywords
    };

    const result = await pool.query(
      `UPDATE case_submissions
       SET title = $1, source = $2, type = $3, data = $4, updated_at = NOW()
       WHERE id = $5
       RETURNING id, creator_id, title, source, type, data, status, approved_by, created_at, updated_at`,
      [merged.title, merged.source || '', merged.type || '', JSON.stringify(merged), id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update case submission error:', err);
    res.status(500).json({ error: 'Could not update case submission' });
  }
});

// DELETE /api/creator/case-submissions/:id - delete a case submission (creator's own)
router.delete('/case-submissions/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const existing = await pool.query(
      'SELECT creator_id, status FROM case_submissions WHERE id = $1',
      [id]
    );
    if (!existing.rows.length) {
      return res.status(404).json({ error: 'Case submission not found' });
    }
    if (existing.rows[0].creator_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only delete your own submissions' });
    }

    await pool.query('DELETE FROM case_submissions WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete case submission error:', err);
    res.status(500).json({ error: 'Could not delete case submission' });
  }
});

module.exports = router;

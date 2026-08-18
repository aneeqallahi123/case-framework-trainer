const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /api/drills  - save a completed drill
router.post('/', requireAuth, async (req, res) => {
  const {
    caseId, caseTitle, caseSource, caseType,
    score, levels, bullets,
    rawTranscript, structuredFramework, aiFeedback
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO drill_results
        (user_id, case_id, case_title, case_source, case_type, score, levels, bullets, raw_transcript, structured_framework, ai_feedback)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        req.user.id, caseId, caseTitle, caseSource, caseType,
        score,
        JSON.stringify(levels || {}),
        bullets || 0,
        rawTranscript || null,
        JSON.stringify(structuredFramework || null),
        aiFeedback || null
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Save drill error:', err);
    res.status(500).json({ error: 'Could not save drill result' });
  }
});

// GET /api/drills  - get current user's drill history
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, case_id, case_title, case_source, case_type, score, levels, bullets, ai_feedback, created_at
       FROM drill_results
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Get drills error:', err);
    res.status(500).json({ error: 'Could not fetch drill history' });
  }
});

// DELETE /api/drills  - erase the current user's drill history
router.delete('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM drill_results WHERE user_id = $1',
      [req.user.id]
    );
    res.json({ deleted: result.rowCount });
  } catch (err) {
    console.error('Delete drills error:', err);
    res.status(500).json({ error: 'Could not reset drill history' });
  }
});

module.exports = router;

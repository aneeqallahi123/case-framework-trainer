const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/cases - full case bank, used by the frontend to run drills
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT data FROM cases ORDER BY id');
    res.json(result.rows.map(r => r.data));
  } catch (err) {
    console.error('Get cases error:', err);
    res.status(500).json({ error: 'Could not fetch case bank' });
  }
});

module.exports = router;

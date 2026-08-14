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

// GET /api/cases/marking-criteria - fetch active marking criteria for drill scoring
router.get('/marking-criteria', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT name, description, enabled, weight, config FROM marking_criteria WHERE enabled = true ORDER BY id'
    );
    const criteria = {};
    result.rows.forEach(row => {
      criteria[row.name] = {
        description: row.description,
        weight: row.weight,
        config: row.config
      };
    });
    res.json(criteria);
  } catch (err) {
    console.error('Get marking criteria error:', err);
    res.status(500).json({ error: 'Could not fetch marking criteria' });
  }
});

module.exports = router;

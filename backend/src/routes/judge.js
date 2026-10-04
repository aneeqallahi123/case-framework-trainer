const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { judge } = require('../judge/service');
const { LEVELS } = require('../judge/prompt');
const { makeLimiter } = require('../lib/rateLimit');

const router = express.Router();

// Each judged framework costs real money, so cap how many one account can run per hour.
const allow = makeLimiter({
  max: Math.max(1, parseInt(process.env.JUDGE_RATE_PER_HOUR || '30', 10) || 30),
  windowMs: 60 * 60 * 1000
});

function cleanRuleResults(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 10).filter(r => r && typeof r.name === 'string' && LEVELS.includes(r.level)).map(r => ({
    name: r.name.slice(0, 40),
    level: r.level,
    notes: (Array.isArray(r.notes) ? r.notes : []).filter(n => typeof n === 'string').slice(0, 3).map(n => n.slice(0, 200))
  }));
}

// POST /api/judge - judge the MECE and Relevant dimensions of a confirmed framework and write feedback.
// Errors carry fallback:true so the client can use the rule-based review instead.
router.post('/', requireAuth, async (req, res) => {
  const { caseId, structText, transcript, ruleResults } = req.body || {};
  if (typeof caseId !== 'string' || !caseId || typeof structText !== 'string' || structText.length > 20000
      || (transcript != null && (typeof transcript !== 'string' || transcript.length > 50000))) {
    return res.status(400).json({ error: 'caseId and structText are required', fallback: true });
  }
  if (!allow(req.user.id)) {
    return res.status(429).json({ error: 'Too many reviews this hour. Showing the quick review instead.', fallback: true });
  }

  try {
    const result = await judge({
      pool,
      input: { caseId, structText, transcript: transcript || '', ruleResults: cleanRuleResults(ruleResults) }
    });
    res.json(result);
  } catch (err) {
    const status = err.status === 404 ? 404 : err.status === 503 ? 503 : 502;
    if (status === 502) console.error('Judge error:', err.message);
    res.status(status).json({ error: status === 404 ? 'Case not found' : 'Judge unavailable', fallback: true });
  }
});

module.exports = router;

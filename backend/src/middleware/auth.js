const jwt = require('jsonwebtoken');
const { pool } = require('../db');

// A token is only good while the account still exists and its token_version matches the one the token was issued
// under, so a password change or reset ends older sessions instead of leaving them valid for the rest of their
// 30 days. Role and bypass_approval come from the database, so a demoted admin loses access right away.
// Tokens issued before versioning carry no version and count as version 0, which every account starts at.
// Lookups are cached for a few seconds to keep this to roughly one query per active user per interval.
const CACHE_MS = 15000;
const cache = new Map();

async function accountState(userId) {
  const hit = cache.get(userId);
  if (hit && hit.expires > Date.now()) return hit.state;
  const r = await pool.query('SELECT token_version, role, bypass_approval FROM users WHERE id = $1', [userId]);
  const state = r.rows.length
    ? { version: r.rows[0].token_version, role: r.rows[0].role, bypassApproval: r.rows[0].bypass_approval }
    : null;
  cache.set(userId, { state, expires: Date.now() + CACHE_MS });
  if (cache.size > 5000) for (const [k, v] of cache) if (v.expires <= Date.now()) cache.delete(k);
  return state;
}

// Call after changing an account's password, role or version so this server stops trusting its cached copy.
function forgetAccount(userId) {
  cache.delete(userId);
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  const token = header.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Session expired, please log in again' });
  }

  let state;
  try {
    state = await accountState(decoded.id);
  } catch (err) {
    console.error('Auth lookup failed:', err.message);
    return res.status(503).json({ error: 'Could not verify your session, please try again' });
  }
  if (!state || state.version !== (decoded.tv || 0)) {
    return res.status(401).json({ error: 'Session expired, please log in again' });
  }

  req.user = { ...decoded, role: state.role, bypass_approval: state.bypassApproval };
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

function requireCreator(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'creator' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Creator access required' });
    }
    next();
  });
}

module.exports = { requireAuth, requireAdmin, requireCreator, forgetAccount };

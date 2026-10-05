const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { requireAuth, forgetAccount } = require('../middleware/auth');
const { makeFailureLimiter } = require('../lib/rateLimit');

const router = express.Router();

// Wrong passwords: 10 per 15 minutes per email address (counted for unknown emails too, so this does not reveal which
// addresses exist), and 5 wrong "current password" entries per 15 minutes per signed-in user when changing a password.
const loginFailures = makeFailureLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
const passwordFailures = makeFailureLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
const TOO_MANY = 'Too many failed attempts. Please wait a few minutes and try again.';

// The token records the account's token_version, so a later password change or reset ends it.
function issueToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, bypass_approval: user.bypass_approval, tv: user.token_version || 0 },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  const { email, password, firstName } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'An account with this email already exists' });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, first_name) VALUES ($1, $2, $3) RETURNING id, email, first_name, role, bypass_approval, token_version',
      [email.toLowerCase(), hash, firstName || '']
    );

    const user = result.rows[0];
    const token = issueToken(user);

    res.json({ token, user: { id: user.id, email: user.email, firstName: user.first_name, role: user.role, bypassApproval: user.bypass_approval, showStats: true } });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const key = String(email).toLowerCase();
  if (loginFailures.blocked(key)) {
    return res.status(429).json({ error: TOO_MANY });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [key]);
    const user = result.rows[0];

    if (!user) {
      loginFailures.fail(key);
      return res.status(401).json({ error: 'Incorrect email or password' });
    }

    const valid = await bcrypt.compare(String(password), user.password_hash);
    if (!valid) {
      loginFailures.fail(key);
      return res.status(401).json({ error: 'Incorrect email or password' });
    }
    loginFailures.reset(key);

    const token = issueToken(user);

    res.json({ token, user: { id: user.id, email: user.email, firstName: user.first_name, role: user.role, bypassApproval: user.bypass_approval, showStats: user.show_stats !== false } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// GET /api/auth/me  - get current user info
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, first_name, role, bypass_approval, show_stats, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user.id, email: user.email, firstName: user.first_name, role: user.role, bypassApproval: user.bypass_approval, showStats: user.show_stats });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// PATCH /api/auth/profile - update profile settings (e.g. stats visibility)
router.patch('/profile', requireAuth, async (req, res) => {
  const { showStats } = req.body;
  if (typeof showStats !== 'boolean') {
    return res.status(400).json({ error: 'showStats must be a boolean' });
  }
  try {
    await pool.query('UPDATE users SET show_stats = $1 WHERE id = $2', [showStats, req.user.id]);
    res.json({ showStats });
  } catch (err) {
    res.status(500).json({ error: 'Could not update profile settings' });
  }
});

// PATCH /api/auth/password - change your own password. Ends every other session and returns a fresh token for this one.
// Admin and creator accounts need a longer password because they can see and change other people's data.
router.patch('/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || !currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are required' });
  }
  const privileged = req.user.role === 'admin' || req.user.role === 'creator';
  const minLength = privileged ? 12 : 8;
  if (newPassword.length < minLength) {
    return res.status(400).json({ error: `New password must be at least ${minLength} characters${privileged ? ' for admin and creator accounts' : ''}` });
  }
  if (newPassword.length > 200) {
    return res.status(400).json({ error: 'New password is too long' });
  }
  if (newPassword === currentPassword) {
    return res.status(400).json({ error: 'New password must be different from the current one' });
  }

  const key = String(req.user.id);
  if (passwordFailures.blocked(key)) {
    return res.status(429).json({ error: TOO_MANY });
  }

  try {
    const found = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!found.rows.length) return res.status(404).json({ error: 'User not found' });
    if (!(await bcrypt.compare(currentPassword, found.rows[0].password_hash))) {
      passwordFailures.fail(key);
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    passwordFailures.reset(key);

    const hash = await bcrypt.hash(newPassword, 10);
    const updated = await pool.query(
      'UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2 RETURNING id, email, role, bypass_approval, token_version',
      [hash, req.user.id]
    );
    forgetAccount(req.user.id);
    res.json({ token: issueToken(updated.rows[0]), message: 'Password changed. Other devices have been signed out.' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Could not change password' });
  }
});

module.exports = router;

// Run with: node --test tests/auth.test.js
// Pure pieces of the password work: the change-password form rules and the failed-attempt limiter.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeFailureLimiter } = require('../backend/src/lib/rateLimit');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/\/\* PWFORM:BEGIN[^\n]*\n([\s\S]*?)\/\* PWFORM:END \*\//);
assert.ok(m, 'PWFORM markers not found in index.html');
const { minPasswordLength, passwordFormError } = new Function(m[1] + '\nreturn {minPasswordLength,passwordFormError};')();

test('admin and creator accounts need 12 characters, everyone else 8', () => {
  assert.strictEqual(minPasswordLength('admin'), 12);
  assert.strictEqual(minPasswordLength('creator'), 12);
  assert.strictEqual(minPasswordLength('user'), 8);
  assert.strictEqual(minPasswordLength(undefined), 8);
});

test('the form reports the first problem in a sensible order and accepts a good entry', () => {
  const ok = { current: 'old-password', next: 'a-new-password', confirm: 'a-new-password' };
  assert.strictEqual(passwordFormError(ok, 'user'), '');
  assert.match(passwordFormError({ ...ok, current: '' }, 'user'), /Fill in all three fields/);
  assert.match(passwordFormError({ ...ok, confirm: '' }, 'user'), /Fill in all three fields/);
  assert.match(passwordFormError({ ...ok, next: 'short', confirm: 'short' }, 'user'), /at least 8 characters/);
  assert.match(passwordFormError({ ...ok, confirm: 'different-one' }, 'user'), /do not match/);
  assert.match(passwordFormError({ current: 'same-password-1', next: 'same-password-1', confirm: 'same-password-1' }, 'user'), /different from the current/);
});

test('the form applies the longer minimum to admin and creator accounts', () => {
  const eleven = { current: 'old-password-1', next: 'eleven-char', confirm: 'eleven-char' };
  assert.strictEqual(passwordFormError(eleven, 'user'), '');
  assert.match(passwordFormError(eleven, 'admin'), /at least 12 characters/);
  assert.match(passwordFormError(eleven, 'creator'), /at least 12 characters/);
  assert.strictEqual(passwordFormError({ current: 'old-password-1', next: 'twelve-chars', confirm: 'twelve-chars' }, 'admin'), '');
});

test('failure limiter blocks after max failures within the window, only counts failures, and recovers', () => {
  let t = 0;
  const l = makeFailureLimiter({ max: 3, windowMs: 1000, now: () => t });
  assert.strictEqual(l.blocked('a'), false);
  l.fail('a'); l.fail('a');
  assert.strictEqual(l.blocked('a'), false);
  l.fail('a');
  assert.strictEqual(l.blocked('a'), true);
  assert.strictEqual(l.blocked('b'), false, 'keys are independent');
  t = 1001;
  assert.strictEqual(l.blocked('a'), false, 'the window slides');
});

test('a successful attempt clears the failure count', () => {
  const l = makeFailureLimiter({ max: 2, windowMs: 60000 });
  l.fail('a'); l.fail('a');
  assert.strictEqual(l.blocked('a'), true);
  l.reset('a');
  assert.strictEqual(l.blocked('a'), false);
});

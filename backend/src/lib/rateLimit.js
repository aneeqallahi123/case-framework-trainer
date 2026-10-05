// Sliding-window limiter, in memory (per server instance). Returns a function key -> allowed?
function makeLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return function allow(key) {
    const t = now();
    const recent = (hits.get(key) || []).filter(ts => t - ts < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return false; }
    recent.push(t);
    hits.set(key, recent);
    // Keep the map from growing without bound across many one-off users.
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(ts => t - ts < windowMs)) hits.delete(k);
    return true;
  };
}

// Counts failures only, so correct logins never use up the allowance: blocked(key) before checking a credential,
// fail(key) after a wrong one, reset(key) after a right one.
function makeFailureLimiter({ max, windowMs, now = () => Date.now() }) {
  const fails = new Map();
  const recent = key => { const t = now(); const r = (fails.get(key) || []).filter(ts => t - ts < windowMs); fails.set(key, r); return r; };
  return {
    blocked: key => recent(key).length >= max,
    fail(key) {
      const r = recent(key); r.push(now());
      if (fails.size > 5000) for (const [k, v] of fails) if (!v.some(ts => now() - ts < windowMs)) fails.delete(k);
    },
    reset: key => { fails.delete(key); }
  };
}

module.exports = { makeLimiter, makeFailureLimiter };

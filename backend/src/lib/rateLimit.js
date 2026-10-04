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

module.exports = { makeLimiter };

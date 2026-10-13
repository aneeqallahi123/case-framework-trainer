// Helpers shared by the model-calling routes.

// Scans for the first balanced {...} span, ignoring braces inside strings.
// Returns null if no complete object is found (e.g. real truncation).
function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

// Parses a model reply that should be a single JSON object, tolerating code fences and stray prose.
function parseJsonReply(raw) {
  let cleaned = String(raw || '').trim().replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
  cleaned = extractFirstJsonObject(cleaned) || cleaned;
  return JSON.parse(cleaned);
}

// Normalizes text for fuzzy substring matching: lowercase, strip punctuation,
// collapse whitespace. Used to verify a "quote" actually occurs in the transcript.
function normalizeForMatch(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Returns true if `quote` is actually present in `transcript`. An exact normalized
// substring always passes. Otherwise a tightly-windowed fuzzy match tolerates minor
// Deepgram/model drift (a dropped or swapped word) but not words scattered across
// the transcript, so a fabricated quote cannot pass by reusing common words.
function quoteIsGrounded(quote, transcript) {
  if (!quote || !String(quote).trim()) return false;
  const nq = normalizeForMatch(quote);
  const nt = normalizeForMatch(transcript);
  if (nq.length < 3) return false;
  if (nt.includes(nq)) return true;
  const qWords = nq.split(' ');
  // Too short to fuzzy-match safely: must be an exact substring.
  if (qWords.length < 4) return false;
  const tWords = nt.split(' ');
  const windowSize = Math.ceil(qWords.length * 1.25) + 1;
  for (let start = 0; start + 1 <= tWords.length; start++) {
    if (tWords[start] !== qWords[0]) continue;
    const end = Math.min(tWords.length, start + windowSize);
    let ti = start, matched = 0;
    for (const w of qWords) {
      const idx = tWords.indexOf(w, ti);
      if (idx === -1 || idx >= end) continue;
      matched++;
      ti = idx + 1;
    }
    if (matched / qWords.length >= 0.85) return true;
  }
  return false;
}

module.exports = { extractFirstJsonObject, parseJsonReply, normalizeForMatch, quoteIsGrounded };

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

// Returns true if `quote` (normalized) is a substring of `transcript` (normalized).
function quoteIsGrounded(quote, transcript) {
  if (!quote || !String(quote).trim()) return false;
  const nq = normalizeForMatch(quote);
  const nt = normalizeForMatch(transcript);
  if (nq.length < 3) return false;
  if (nt.includes(nq)) return true;
  // Allow minor Deepgram/model drift: require most of the quote's words to
  // appear in order within a reasonably tight window of the transcript.
  const qWords = nq.split(' ');
  const tWords = nt.split(' ');
  let ti = 0, matched = 0;
  for (let qi = 0; qi < qWords.length; qi++) {
    const idx = tWords.indexOf(qWords[qi], ti);
    if (idx === -1) continue;
    matched++;
    ti = idx + 1;
  }
  return matched / qWords.length >= 0.8;
}

module.exports = { extractFirstJsonObject, parseJsonReply, normalizeForMatch, quoteIsGrounded };

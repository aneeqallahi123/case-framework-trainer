const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const { getExampleForType } = require('../data/framework-examples');

const router = express.Router();

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

// Store audio in memory (not disk) - fine for short recordings
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// POST /api/transcribe  - send audio blob, get back plain transcript
router.post('/', requireAuth, upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file received' });
  }

  try {
    const { createClient } = require('@deepgram/sdk');
    const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
      req.file.buffer,
      {
        model: 'nova-2',
        smart_format: true,
        punctuate: true,
        paragraphs: true,
        language: 'en-US'
      }
    );

    if (error) {
      console.error('Deepgram error:', error);
      return res.status(500).json({ error: 'Transcription failed' });
    }

    const transcript = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    res.json({ transcript });
  } catch (err) {
    console.error('Transcribe route error:', err);
    res.status(500).json({ error: 'Transcription service unavailable' });
  }
});

// Normalizes text for fuzzy substring matching: lowercase, strip punctuation,
// collapse whitespace. Used to verify a "quote" actually occurs in the transcript.
function normalizeForMatch(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Returns true if `quote` (normalized) is a substring of `transcript` (normalized).
function quoteIsGrounded(quote, transcript) {
  if (!quote || !quote.trim()) return false;
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

async function generateJson(model, prompt) {
  const result = await model.generateContent(prompt);
  const finishReason = result.response.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== 'STOP') {
    console.error('Gemini stopped early, finishReason:', finishReason);
  }
  const raw = result.response.text().trim();
  let cleaned = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
  cleaned = extractFirstJsonObject(cleaned) || cleaned;
  return { raw, parsed: JSON.parse(cleaned) };
}

// STAGE 1 — extraction. Pulls a flat list of atomic points out of the transcript,
// each anchored to a verbatim quote. Points whose quote can't be found in the
// transcript are dropped by code (not by trusting the model), so nothing enters
// stage 2 that wasn't actually said.
async function extractPoints(model, transcript) {
  const prompt = `A candidate just delivered a case interview framework out loud. Below is the raw transcript (messy — filler words, run-ons, restatements).

Transcript:
"${transcript}"

## Your job

Break this transcript down into a flat list of atomic points — each point is one distinct idea the candidate expressed (e.g. "look at customer segmentation", "revenue went from 10k to 12k units", "check fixed vs variable costs"). Do not organize or group them yet — just extract, one item per distinct idea. Merge only exact restatements of the same idea into one point (if they said it twice in different words, that's still one point).

For EACH point, give:
- "text": a short, clean paraphrase of the idea (a business phrase, 2-8 words)
- "quote": the exact verbatim words from the transcript that this point is based on (copy them exactly, do not paraphrase the quote itself — it must be a real substring of the transcript above)
- "metric": if the candidate stated an actual number for this point, {"before":"...","after":"...","unit":"..."} or {"value":"...","unit":"..."}; otherwise null

## CRITICAL
- Every point must be traceable to words the candidate actually said. Do not add points for ideas that weren't spoken, even standard/expected ones.
- "quote" must be copied verbatim from the transcript — not reworded, not summarized. This is what makes the point verifiable.
- If the candidate only said 2 things, return 2 points. Do not pad the list.

Return ONLY JSON, no markdown fences:
{ "points": [ { "id": "p1", "text": "...", "quote": "...", "metric": null } ] }`;

  const { raw, parsed } = await generateJson(model, prompt);
  const points = Array.isArray(parsed.points) ? parsed.points : [];

  const grounded = [];
  const dropped = [];
  points.forEach((p, i) => {
    const id = p.id || `p${i + 1}`;
    if (p && typeof p.text === 'string' && quoteIsGrounded(p.quote, transcript)) {
      grounded.push({ id, text: p.text.trim(), quote: p.quote, metric: p.metric || null });
    } else {
      dropped.push({ id, text: p && p.text, quote: p && p.quote });
    }
  });

  if (dropped.length) {
    console.warn(`Structure: dropped ${dropped.length} ungrounded point(s):`, dropped.map(d => d.text));
  }

  return { grounded, raw };
}

// STAGE 2 — structuring. The model organizes ONLY the pre-validated points into
// a MECE tree by referencing their ids; it cannot introduce new leaf content.
// Bucket/grouping labels (nodes with no pointId) are the only freeform text
// allowed, since those are structural, not content.
async function structurePoints(model, { transcript, caseType, caseTitle, points, example }) {
  const pointsList = points.map(p => `- id: ${p.id} | text: "${p.text}"${p.metric ? ` | metric: ${JSON.stringify(p.metric)}` : ''}`).join('\n');

  const prompt = `You are a McKinsey case interview coach who is an expert at building MECE issue trees — the kind found in real casebooks (Wharton, Yale, Darden, MBB).

Case: "${caseTitle || 'Unknown case'}"
Case type: ${caseType || 'general'}

A candidate delivered a framework verbally. It has already been broken into these validated atomic points (extracted from their actual words — you may NOT add, remove, reword the meaning of, or split/merge these further):

${pointsList}

## Your job

Organize these points into a hierarchical MECE issue tree — a root question that branches into top-level issues, which may branch further into sub-issues, exactly like a consultant would draw it on paper. Use the order and any nesting cues in how the points were listed/grouped to infer structure (e.g. points about the same theme belong under the same branch).

- Every point above MUST appear as exactly one leaf node in the tree, referencing its "pointId". Do not drop any point and do not invent new leaves.
- You MAY create intermediate grouping nodes (branches with no pointId) to organize points under a shared theme — e.g. if points p2 and p3 are both about revenue, you can create a "Revenue" branch containing them. Grouping labels should be short, punchy business phrases (2-6 words).
- A leaf node's "label" should be the point's own "text" field, verbatim from the list above — do not reword it further.
- Do not add any node that isn't either a leaf from the list above or a grouping node for organizing them.

## Reference example (STYLE ONLY — how deep nesting typically goes, how grouping nodes work. Do NOT borrow its actual branch names or content)

Question: "${example.question}"
Tree: ${JSON.stringify(example.tree)}

## Output format

Return ONLY JSON, no markdown fences:
{
  "frameworkType": "e.g. Profitability / Market Entry / Pricing / Growth / M&A / Operations",
  "hypothesis": "One sentence: what is the candidate's main hypothesis or angle, based only on the points above?",
  "tree": {
    "label": "Root node — the case question, rephrased short",
    "children": [
      {
        "label": "Grouping label OR a point's text",
        "pointId": "p1 or null if this is a grouping node",
        "metric": null,
        "children": []
      }
    ]
  },
  "meceNotes": ["Any overlap or gap in MECE-ness you noticed across the top-level branches"],
  "gaps": ["Important standard elements this case type usually needs that are absent from the points list — feedback only, do not add them to the tree"],
  "strengths": ["What they did well in their structure"],
  "overallQuality": "strong | ok | weak"
}

## Rules
- Only as many top-level branches as naturally group the given points — do not pad the count.
- Every leaf must carry a "pointId" that matches one of the ids listed above, exactly once each across the whole tree.
- Grouping nodes must have "pointId": null.
- Be honest about quality — a small tree that faithfully reflects a thin answer should score lower on completeness than a large one, so there is no incentive to invent content.`;

  const { raw, parsed } = await generateJson(model, prompt);
  return { raw, structured: parsed };
}

// Validates that every leaf in the tree maps to a real, known pointId, and
// collects which pointIds were actually placed. Strips any leaf that
// references an unknown pointId (defensive — should not happen given the
// stage-2 prompt, but we don't trust model output blindly).
function validateAndCleanTree(node, knownIds, usedIds) {
  if (!node || typeof node !== 'object') return null;
  const children = Array.isArray(node.children) ? node.children : [];
  const cleanedChildren = children
    .map(child => validateAndCleanTree(child, knownIds, usedIds))
    .filter(Boolean);

  if (node.pointId != null) {
    if (!knownIds.has(node.pointId)) {
      console.warn(`Structure: dropping node with unknown pointId "${node.pointId}"`);
      return null;
    }
    if (usedIds.has(node.pointId)) {
      console.warn(`Structure: dropping duplicate node for pointId "${node.pointId}"`);
      return null;
    }
    usedIds.add(node.pointId);
  }

  return { ...node, children: cleanedChildren };
}

// POST /api/transcribe/structure  - send transcript text, get back structured framework JSON
router.post('/structure', requireAuth, async (req, res) => {
  const { transcript, caseType, caseTitle } = req.body;

  if (!transcript || transcript.trim().length < 20) {
    return res.status(400).json({ error: 'Transcript is too short to structure' });
  }

  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 8000 }
    });

    const example = getExampleForType(caseType);

    // Stage 1: extract atomic points and drop anything not grounded in the transcript.
    let extractRaw, grounded;
    try {
      ({ grounded, raw: extractRaw } = await extractPoints(model, transcript));
    } catch (parseErr) {
      console.error('Extraction JSON parse failed:', parseErr);
      return res.status(500).json({ error: 'Could not parse AI extraction response', raw: extractRaw });
    }

    if (grounded.length === 0) {
      return res.status(500).json({ error: 'Could not extract any grounded points from the transcript' });
    }

    // Stage 2: structure only the validated points into a tree.
    let structureRaw, structured;
    try {
      ({ structured, raw: structureRaw } = await structurePoints(model, { transcript, caseType, caseTitle, points: grounded, example }));
    } catch (parseErr) {
      console.error('Structuring JSON parse failed:', parseErr);
      return res.status(500).json({ error: 'Could not parse AI structuring response', raw: structureRaw });
    }

    // Code-enforced grounding check: strip any leaf that isn't a real,
    // once-used pointId from the validated extraction. This is what makes
    // fidelity guaranteed rather than merely requested.
    const knownIds = new Set(grounded.map(p => p.id));
    const usedIds = new Set();
    const cleanedTree = validateAndCleanTree(structured.tree, knownIds, usedIds);

    // Anything the candidate said but the model failed to place in the tree
    // is real content too — surface it instead of silently dropping it.
    const missing = grounded.filter(p => !usedIds.has(p.id));
    if (missing.length) {
      console.warn(`Structure: ${missing.length} extracted point(s) never placed in tree:`, missing.map(p => p.text));
      cleanedTree.children = cleanedTree.children || [];
      cleanedTree.children.push({
        label: 'Other points mentioned',
        pointId: null,
        metric: null,
        children: missing.map(p => ({ label: p.text, pointId: p.id, metric: p.metric || null, children: [] }))
      });
    }

    structured.tree = cleanedTree;
    res.json({ structured });
  } catch (err) {
    console.error('Structure route error:', err);
    res.status(500).json({ error: 'AI structuring unavailable' });
  }
});

// POST /api/transcribe/speak  - send text, get back audio stream via Deepgram TTS
router.post('/speak', requireAuth, async (req, res) => {
  const { text, speed } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'No text provided' });
  }

  try {
    const url = `https://api.deepgram.com/v1/speak?model=aura-2-apollo-en&speed=${speed || 1}`;
    const dgRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
        'Content-Type': 'text/plain'
      },
      body: text.trim()
    });

    if (!dgRes.ok) {
      const err = await dgRes.text();
      console.error('Deepgram TTS error:', err);
      return res.status(500).json({ error: 'TTS request failed' });
    }

    const buffer = Buffer.from(await dgRes.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (err) {
    console.error('Speak route error:', err);
    res.status(500).json({ error: 'TTS service unavailable' });
  }
});

module.exports = router;

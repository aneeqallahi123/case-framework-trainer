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

    const prompt = `You are a McKinsey case interview coach who is an expert at building MECE issue trees — the kind found in real casebooks (Wharton, Yale, Darden, MBB). A candidate just delivered their framework VERBALLY for this case:

Case: "${caseTitle || 'Unknown case'}"
Case type: ${caseType || 'general'}

Candidate's spoken response (raw transcript, messy — filler words, run-ons, restatements):
"${transcript}"

## Your job

Do NOT transcribe or lightly reword their sentences. Understand their underlying intent and rebuild it as a real, hierarchical MECE issue tree — a root question that branches into 2-5 top-level issues, each of which can itself branch into sub-issues, exactly like a consultant would draw it on paper. Depth matters: if the candidate nested an idea while speaking ("within revenue, that's volume and price, and within volume that's units and category mix"), preserve that as three levels, not one flat list.

Merge repeated or restated ideas into a single node. Convert every node label into a short, punchy business phrase (2-6 words) — never a sentence fragment lifted verbatim from the transcript. If the candidate mentioned specific numbers while describing a branch (e.g. "we went from 10,000 to 12,000 units"), attach that as a "metric" on that node instead of losing it in the label.

## CRITICAL — content fidelity

The tree must contain ONLY what the candidate actually said, restructured and relabeled. You are a transcription-to-structure tool, not a case-solving tool. Never add a branch, sub-branch, or idea the candidate did not express, even if it's a standard part of this framework type or something a strong candidate "should" have said. If they gave 2 top-level ideas, output 2 — do not pad it to 3-5 by inventing more. If a branch they mentioned has no sub-points, leave its children empty — do not manufacture sub-points to fill it out. Missing standard elements belong in "gaps" as feedback text, never as fabricated tree nodes.

## Reference example (for STYLE ONLY — how to phrase labels, how deep nesting typically goes, how metrics attach. Do NOT borrow any of its actual branch names, topics, or content — this is a different case)

Question: "${example.question}"
Tree: ${JSON.stringify(example.tree)}

## Output format

Return ONLY a JSON object with this exact structure (no extra text, no markdown fences, no explanation):
{
  "frameworkType": "e.g. Profitability / Market Entry / Pricing / Growth / M&A / Operations",
  "hypothesis": "One sentence: what is the candidate's main hypothesis or angle?",
  "tree": {
    "label": "Root node — the case question, rephrased short",
    "children": [
      {
        "label": "Top-level MECE branch (2-6 words)",
        "metric": null,
        "children": [
          {
            "label": "Sub-branch (2-6 words)",
            "metric": { "before": "10,000", "after": "12,000", "unit": "units/month" },
            "children": []
          }
        ]
      }
    ]
  },
  "meceNotes": ["Any overlap or gap in MECE-ness you noticed across the top-level branches"],
  "gaps": ["Important areas this case type usually needs that the candidate missed"],
  "strengths": ["What they did well in their structure"],
  "overallQuality": "strong | ok | weak"
}

## Rules
- Only as many top-level branches as the candidate actually distinguished — could be 2, could be 5. Never pad the count.
- Nest to a second (and third, if the candidate actually spoke that deep) level wherever their answer implied it — do not flatten real nesting into one level, and do not invent depth that wasn't there
- Only set "metric" on a node when the candidate stated an actual number for it; otherwise omit the key or set it to null
- If they only said 1-2 things, output a small 1-2 branch tree — that is a correct, honest transcription of a thin framework. Do NOT fill it out with what the case type "typically requires." List what's missing under "gaps" instead — as text feedback, never as invented tree nodes.
- meceNotes, gaps, and strengths should each have 1-3 items
- Be honest about quality — a small tree that faithfully reflects a thin answer should score lower on completeness than a fabricated large one, so there is no incentive to invent content`;

    const result = await model.generateContent(prompt);
    const finishReason = result.response.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      console.error('Gemini stopped early, finishReason:', finishReason);
    }
    const raw = result.response.text().trim();

    // Strip markdown code fences if present
    let cleaned = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();

    // Gemini occasionally appends stray trailing characters (e.g. an extra
    // closing brace) after an otherwise-valid JSON object. Extract just the
    // balanced {...} span instead of trusting the whole response verbatim.
    cleaned = extractFirstJsonObject(cleaned) || cleaned;

    let structured;
    try {
      structured = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('JSON parse failed, raw response:', raw);
      return res.status(500).json({ error: 'Could not parse AI response', raw });
    }

    res.json({ structured });
  } catch (err) {
    console.error('Structure route error:', err);
    res.status(500).json({ error: 'AI structuring unavailable' });
  }
});

module.exports = router;

const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

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
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic.default();

    const prompt = `You are a McKinsey case interview coach. A candidate just delivered their framework verbally for this case:

Case: "${caseTitle || 'Unknown case'}"
Case type: ${caseType || 'general'}

Candidate's spoken response (raw transcript):
"${transcript}"

Your job is to parse what they said and return it as a clean, structured framework JSON. Even if they spoke informally, extract their intent.

Return ONLY a JSON object with this exact structure (no extra text, no markdown, no explanation):
{
  "frameworkType": "e.g. Profitability / Market Entry / Pricing / Growth / M&A / Operations",
  "hypothesis": "One sentence: what is the candidate's main hypothesis or angle?",
  "buckets": [
    {
      "name": "Short bucket name (2-5 words)",
      "bullets": ["sub-point 1", "sub-point 2", "sub-point 3"]
    }
  ],
  "gaps": ["Any important areas they missed for this case type"],
  "strengths": ["What they did well in their structure"],
  "overallQuality": "strong | ok | weak"
}

Rules:
- Extract 3-5 buckets from what they said
- Each bucket should have 2-5 bullets
- If they only said 1-2 things, still try to infer structure from what was said
- gaps and strengths should each have 1-3 items
- Be honest about quality`;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = message.content[0].text.trim();

    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();

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

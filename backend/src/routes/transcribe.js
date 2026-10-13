const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const { runStructure } = require('../lib/structure');

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

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Structure route: ANTHROPIC_API_KEY is not set');
    return res.status(500).json({ error: 'AI structuring unavailable — ANTHROPIC_API_KEY not configured' });
  }

  try {
    const structured = await runStructure({ transcript, caseType, caseTitle });
    res.json({ structured });
  } catch (err) {
    console.error('Structure route error:', err);
    if (err.stage === 'extraction') return res.status(500).json({ error: 'Could not parse AI extraction response' });
    if (err.stage === 'structuring') return res.status(500).json({ error: 'Could not parse AI structuring response' });
    if (err.stage === 'empty') return res.status(500).json({ error: err.message });
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

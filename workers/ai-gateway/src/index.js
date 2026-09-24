const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

// Shared CORS headers
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health') {
      return json({ ok: true });
    }

    // Only accept POST /generate
    if (url.pathname !== '/generate' || request.method !== 'POST') {
      return json({ error: 'Not found' }, 404);
    }

    // Authenticate with a shared secret stored as a Worker secret
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (env.API_SECRET && token !== env.API_SECRET) {
      return json({ error: 'Unauthorized' }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { messages, max_tokens } = body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: 'messages array is required' }, 400);
    }

    try {
      const response = await env.AI.run(MODEL, {
        messages,
        max_tokens: max_tokens || 8000,
      });

      // Workers AI returns { response: "..." }
      const text = response?.response ?? '';
      return json({ content: text });
    } catch (err) {
      console.error('Workers AI error:', err);
      return json({ error: 'AI inference failed', detail: err.message }, 500);
    }
  },
};

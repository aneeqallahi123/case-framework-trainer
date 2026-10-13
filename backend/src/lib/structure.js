const { extractFirstJsonObject, quoteIsGrounded, normalizeForMatch } = require('./json');

async function defaultGenerateJson(prompt) {
  const Anthropic = require('@anthropic-ai/sdk');
  const clientOpts = { apiKey: process.env.ANTHROPIC_API_KEY };
  if (process.env.ANTHROPIC_WORKSPACE_ID) {
    clientOpts.defaultHeaders = { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID };
  }
  const client = new Anthropic(clientOpts);
  const response = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
    max_tokens: 8000,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }]
  });
  const raw = response.content.find(b => b.type === 'text')?.text?.trim() || '';
  let cleaned = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
  cleaned = extractFirstJsonObject(cleaned) || cleaned;
  return { raw, parsed: JSON.parse(cleaned) };
}

// STAGE 1 — extraction. Pulls a flat list of atomic points out of the transcript,
// each anchored to a verbatim quote. Points whose quote can't be found in the
// transcript are dropped by code (not by trusting the model), so nothing enters
// stage 2 that wasn't actually said.
async function extractPoints(transcript, generateJson = defaultGenerateJson) {
  const prompt = `A candidate just delivered a case interview framework out loud. Below is the raw transcript (messy — filler words, run-ons, restatements).

Transcript:
"${transcript}"

## Your job

Extract the **terminal analytical areas** the candidate named — the actual leaf-level things they said they would examine. These are the specific, concrete areas of analysis (e.g. "price sensitivity", "labor costs", "average items per transaction").

## What NOT to extract
- Structural announcements that introduce a container the candidate immediately breaks down further. For example, if they say "within revenue I'll look at price and volume — within price I'll look at price sensitivity and average price per category", then "revenue" and "price" are containers, NOT extraction points. Extract only "price sensitivity" and "average price per category".
- Meta-commentary like "I'll be thinking about X and Y" is NOT a point when X and Y are themselves broken down into sub-areas.
- Do not extract a parent bucket as a separate point if the candidate explicitly lists its sub-components.

## What TO extract
Only the terminal leaves — the most specific analytical areas the candidate mentioned that are NOT further broken down by the candidate themselves.

For EACH point, give:
- "text": a short, clean paraphrase of the idea (a business phrase, 2-8 words)
- "quote": the exact verbatim words from the transcript that this point is based on (copy them exactly, do not paraphrase the quote itself — it must be a real substring of the transcript above)
- "metric": if the candidate stated an actual number for this point, {"before":"...","after":"...","unit":"..."} or {"value":"...","unit":"..."}; otherwise null

## CRITICAL
- Every point must be traceable to words the candidate actually said. Do not add points for ideas that weren't spoken, even standard/expected ones.
- "quote" must be copied verbatim from the transcript — not reworded, not summarized. This is what makes the point verifiable.
- If the candidate only said 2 things, return 2 points. Do not pad the list.
- A MECE tree has containers (Revenue, Costs) that are NOT leaf points — only the terminal items under them are leaf points.

Return ONLY JSON, no markdown fences:
{ "points": [ { "id": "p1", "text": "...", "quote": "...", "metric": null } ] }`;

  const { raw, parsed } = await generateJson(prompt);
  const points = Array.isArray(parsed.points) ? parsed.points : [];

  const grounded = [];
  const dropped = [];
  points.forEach((p, i) => {
    const id = p.id || `p${i + 1}`;
    if (p && typeof p.text === 'string' && quoteIsGrounded(p.quote, transcript)) {
      let metric = p.metric || null;
      if (metric && !metricIsGrounded(metric, transcript)) {
        console.warn(`Structure: dropping ungrounded metric on "${p.text}":`, metric);
        metric = null;
      }
      grounded.push({ id, text: p.text.trim(), quote: p.quote, metric });
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
async function structurePoints({ caseType, caseTitle, points }, generateJson = defaultGenerateJson) {
  const pointsList = points.map(p => `- id: ${p.id} | text: "${p.text}"${p.metric ? ` | metric: ${JSON.stringify(p.metric)}` : ''}`).join('\n');

  const prompt = `You are a McKinsey case interview coach who is an expert at building MECE issue trees — the kind found in real casebooks (Wharton, Yale, Darden, MBB).

Case: "${caseTitle || 'Unknown case'}"
Case type: ${caseType || 'general'}

A candidate delivered a framework verbally. It has already been broken into these validated atomic LEAF points (the most terminal analysis areas the candidate mentioned — extracted from their actual words):

${pointsList}

## Your job

Organize ONLY these points into a hierarchical MECE issue tree. In a proper MECE issue tree:
- The ROOT is the central question being analyzed
- INTERMEDIATE nodes are grouping containers (e.g. "Revenue", "Costs", "Variable Costs") — they have NO pointId
- LEAF nodes are the terminal analysis areas — each must reference exactly one pointId from the list above

Rules:
- Every point above MUST appear as exactly one leaf node in the tree. Do not drop any.
- Do NOT invent new leaf nodes. The only new nodes you may add are intermediate grouping containers.
- Grouping labels should be short business phrases (2-5 words) that name the category, NOT describe an action (use "Variable Costs" not "Analyze variable costs").
- A leaf node's "label" must match the point's "text" field verbatim — do not reword.
- Infer the grouping structure from how the candidate presented the points (the sequence and logical relationships in the transcript).
- Only as many top-level branches as naturally emerge from the points — do not pad.

- Grouping labels must be generic categories that cover the points beneath them. If the candidate named a grouping in their own words, prefer their wording. Never use a grouping label to introduce a topic that none of the points beneath it covers.

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

  const { raw, parsed } = await generateJson(prompt);
  return { raw, structured: parsed };
}

// Validates that every leaf in the tree maps to a real, known pointId, and
// collects which pointIds were actually placed. Leaf label/metric are overwritten
// from the validated point. Strips any leaf that references an unknown pointId (defensive — should not happen given the
// stage-2 prompt, but we don't trust model output blindly).
function validateAndCleanTree(node, pointsById, usedIds, isRoot = true) {
  if (!node || typeof node !== 'object') return null;
  const children = Array.isArray(node.children) ? node.children : [];
  const cleanedChildren = children
    .map(child => validateAndCleanTree(child, pointsById, usedIds, false))
    .filter(Boolean);

  if (node.pointId != null) {
    const point = pointsById.get(node.pointId);
    if (!point) {
      console.warn(`Structure: dropping node with unknown pointId "${node.pointId}"`);
      return null;
    }
    if (usedIds.has(node.pointId)) {
      console.warn(`Structure: dropping duplicate node for pointId "${node.pointId}"`);
      return null;
    }
    usedIds.add(node.pointId);
    // Leaf content comes from the validated extraction, never from the model's
    // stage-2 output, so labels and metrics cannot be reworded or invented.
    return { ...node, label: point.text, metric: point.metric || null, quote: point.quote, children: [] };
  }

  // A grouping node with nothing beneath it is an invented container: prune it.
  if (!isRoot && cleanedChildren.length === 0) return null;
  // Grouping nodes are structural only and never carry a metric.
  return { ...node, metric: null, children: cleanedChildren };
}


// Returns true if every number in a metric appears in the transcript. A metric
// the candidate never stated is invented content, so it is dropped.
function metricIsGrounded(metric, transcript) {
  if (!metric) return true;
  const nt = normalizeForMatch(transcript).split(' ');
  const nums = JSON.stringify(metric).match(/\d+(?:\.\d+)?/g) || [];
  return nums.every(n => nt.includes(n) || nt.includes(n.replace(/\.0+$/, '')) || normalizeForMatch(transcript).includes(normalizeForMatch(n)));
}

// Full pipeline: extract -> structure -> code-enforced cleanup. Throws
// {stage, cause, raw} style errors via `err.stage` / `err.raw` so the route can report them.
async function runStructure({ transcript, caseType, caseTitle }, generateJson = defaultGenerateJson) {
  let grounded;
  try {
    ({ grounded } = await extractPoints(transcript, generateJson));
  } catch (e) { e.stage = 'extraction'; throw e; }
  if (grounded.length === 0) {
    const e = new Error('Could not extract any grounded points from the transcript');
    e.stage = 'empty';
    throw e;
  }

  let structured;
  try {
    ({ structured } = await structurePoints({ transcript, caseType, caseTitle, points: grounded }, generateJson));
  } catch (e) { e.stage = 'structuring'; throw e; }

  const pointsById = new Map(grounded.map(p => [p.id, p]));
  const usedIds = new Set();
  let cleanedTree = validateAndCleanTree(structured?.tree, pointsById, usedIds);

  // Anything the candidate said but the model failed to place is real content —
  // surface it instead of silently dropping it. If the model returned no usable
  // tree at all, fall back to a flat tree of the validated points.
  const missing = grounded.filter(p => !usedIds.has(p.id));
  if (!cleanedTree) {
    cleanedTree = { label: caseTitle || 'Framework', pointId: null, metric: null, children: [] };
  }
  if (missing.length) {
    console.warn(`Structure: ${missing.length} extracted point(s) never placed in tree:`, missing.map(p => p.text));
    const leaves = missing.map(p => ({ label: p.text, pointId: p.id, metric: p.metric || null, quote: p.quote, children: [] }));
    if (cleanedTree.children.length === 0) cleanedTree.children = leaves;
    else cleanedTree.children.push({ label: 'Other points mentioned', pointId: null, metric: null, children: leaves });
  }

  const out = structured && typeof structured === 'object' ? structured : {};
  out.tree = cleanedTree;
  return out;
}

module.exports = { extractPoints, structurePoints, validateAndCleanTree, metricIsGrounded, runStructure, defaultGenerateJson };

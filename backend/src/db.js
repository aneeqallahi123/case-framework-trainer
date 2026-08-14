const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Accounts created automatically on first boot. Change these passwords after logging in.
const SEED_ADMINS = [
  { email: 'aneeq@caseroom.app', password: 'CaseFramework1', firstName: 'Aneeq' },
  { email: 'chohan@caseroom.app', password: 'CaseFramework2', firstName: 'Chohan' }
];

// Create all tables if they don't exist
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        first_name VARCHAR(100),
        role VARCHAR(20) DEFAULT 'user',
        bypass_approval BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS drill_results (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        case_id VARCHAR(100),
        case_title VARCHAR(255),
        case_source VARCHAR(100),
        case_type VARCHAR(100),
        score INTEGER,
        levels JSONB,
        bullets INTEGER,
        raw_transcript TEXT,
        structured_framework JSONB,
        ai_feedback TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS cases (
        id VARCHAR(50) PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        source VARCHAR(255),
        type VARCHAR(100),
        data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS solved_frameworks (
        id SERIAL PRIMARY KEY,
        creator_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        case_id VARCHAR(100) REFERENCES cases(id),
        framework JSONB NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        version INTEGER DEFAULT 1,
        approved_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS case_submissions (
        id SERIAL PRIMARY KEY,
        creator_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        source VARCHAR(255),
        type VARCHAR(100),
        data JSONB NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        approved_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS marking_criteria (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) UNIQUE NOT NULL,
        description TEXT,
        enabled BOOLEAN DEFAULT true,
        weight INTEGER DEFAULT 2,
        config JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS system_config (
        id SERIAL PRIMARY KEY,
        key VARCHAR(100) UNIQUE NOT NULL,
        value TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Database tables ready');

    await seedAdmins(client);
    await seedCases(client);
    await seedMarkingCriteria(client);
    await seedSystemConfig(client);
  } catch (err) {
    console.error('❌ Database init error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// Idempotent: only creates each seed admin if that email doesn't already exist.
async function seedAdmins(client) {
  for (const admin of SEED_ADMINS) {
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [admin.email]);
    if (existing.rows.length > 0) continue;
    const hash = await bcrypt.hash(admin.password, 10);
    await client.query(
      'INSERT INTO users (email, password_hash, first_name, role) VALUES ($1, $2, $3, $4)',
      [admin.email, hash, admin.firstName, 'admin']
    );
    console.log(`✅ Seeded admin account: ${admin.email}`);
  }
}

// Only runs once: if the cases table is already populated (e.g. an admin has edited it), never overwrite it.
async function seedCases(client) {
  const { rows } = await client.query('SELECT COUNT(*)::int AS count FROM cases');
  if (rows[0].count > 0) return;

  const bankPath = path.join(__dirname, 'data', 'case-bank.json');
  if (!fs.existsSync(bankPath)) return;

  const cases = JSON.parse(fs.readFileSync(bankPath, 'utf8'));
  for (const c of cases) {
    await client.query(
      'INSERT INTO cases (id, title, source, type, data) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING',
      [c.id, c.title, c.source || '', c.type || '', JSON.stringify(c)]
    );
  }
  console.log(`✅ Seeded ${cases.length} cases into the database`);
}

async function seedMarkingCriteria(client) {
  const { rows } = await client.query('SELECT COUNT(*)::int AS count FROM marking_criteria');
  if (rows[0].count > 0) return;

  const criteria = [
    {
      name: 'Structure',
      description: '3–5 buckets, 4–5 points each',
      config: {
        minBuckets: 3,
        maxBuckets: 5,
        minPointsPerBucket: 4,
        maxPointsPerBucket: 5,
        feedback: {
          strong: 'Within the 3–5 bucket range with 4–5 points each.',
          ok: 'Either bucket count or point distribution could be optimized.',
          weak: 'Needs adjustment: aim for 3–5 buckets with 4–5 points each.'
        }
      }
    },
    {
      name: 'MECE',
      description: 'Mutually exclusive, collectively exhaustive',
      config: {
        overlapThreshold: 0.22,
        minSharedWords: 2,
        minCoveragePct: 0,
        feedback: {
          strong: 'No significant overlap; covers key dimensions.',
          ok: 'Some overlap exists; could improve exclusivity.',
          weak: 'Significant overlap or missing key dimensions.'
        }
      }
    },
    {
      name: 'Succinct',
      description: 'Tight, phrase-length points',
      config: {
        maxAvgWordLength: 12,
        maxLongPointsBeforeOk: 2,
        maxLongPointsBeforeWeak: 3,
        maxTotalBullets: 22,
        feedback: {
          strong: 'Points are concise and phrase-length.',
          ok: 'Some points could be more concise.',
          weak: 'Several points are too long; compress to phrases.'
        }
      }
    },
    {
      name: 'Relevant',
      description: 'Tailored to THIS case',
      config: {
        minRelevancePctForStrong: 0.5,
        minRelevancePctForOk: 0.25,
        feedback: {
          strong: 'Well tailored to this case with good specificity.',
          ok: 'Partly tailored; add more case-specific hooks.',
          weak: 'Generic. Reference client, industry, and specific figures.'
        }
      }
    }
  ];

  for (const crit of criteria) {
    await client.query(
      'INSERT INTO marking_criteria (name, description, enabled, weight, config) VALUES ($1, $2, $3, $4, $5)',
      [crit.name, crit.description, true, 2, JSON.stringify(crit.config)]
    );
  }
  console.log(`✅ Seeded ${criteria.length} marking criteria`);
}

async function seedSystemConfig(client) {
  const { rows } = await client.query('SELECT COUNT(*)::int AS count FROM system_config');
  if (rows[0].count > 0) return;

  const defaultPrompt = `You are an expert case interview evaluator. Your role is to assess frameworks across four key dimensions:

1. **Structure** - Does the framework use 3-5 distinct buckets, each with 4-5 supporting points? Evaluate whether the architecture is balanced and comprehensive.

2. **MECE** - Are the buckets mutually exclusive (no overlap) and collectively exhaustive (covering all relevant dimensions)? Look for redundancy and critical gaps.

3. **Succinct** - Are the points concise and deliverable? Each bullet should be a short phrase (under 12 words), not long sentences.

4. **Relevant** - Are the points tailored to THIS case? Generic answers that could apply to any case are less valuable than those with specific client, industry, or financial anchors.

Each dimension is scored as:
- Strong (2 points): Meets or exceeds expectations
- OK (1 point): Partially meets expectations, room for improvement
- Weak (0 points): Below expectations

Total score is out of 8, converted to a percentage. At 87%+, the framework is interview-ready. At 50-86%, it's solid but needs refinement. Below 50%, rework is needed.

Focus feedback on what's working and what to address next, providing actionable guidance for improvement.`;

  await client.query(
    'INSERT INTO system_config (key, value) VALUES ($1, $2)',
    ['system_prompt', defaultPrompt]
  );
  console.log('✅ Seeded default system prompt');
}

module.exports = { pool, initDB };

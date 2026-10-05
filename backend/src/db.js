const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Admin accounts managed from the server's environment: ADMIN_PASSWORD_<NAME> sets (and, when its value changes,
// resets) that account's password. Without the variable the account is not created, and nothing ships a password.
const SEED_ADMINS = [
  { email: 'aneeq@caseroom.app', firstName: 'Aneeq', envVar: 'ADMIN_PASSWORD_ANEEQ' },
  { email: 'chohan@caseroom.app', firstName: 'Chohan', envVar: 'ADMIN_PASSWORD_CHOHAN' }
];
const MIN_ADMIN_PASSWORD = 12;

// Earlier versions created these accounts with passwords that were published in the repository. They are kept here
// only to detect and flag a database that still accepts one (and to refuse them as new passwords). Nothing uses
// them to sign in or to create an account.
const LEGACY_DEFAULT_PASSWORDS = {
  'aneeq@caseroom.app': 'CaseFramework1',
  'chohan@caseroom.app': 'CaseFramework2'
};

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

      CREATE TABLE IF NOT EXISTS community_posts (
        id SERIAL PRIMARY KEY,
        case_id VARCHAR(50) REFERENCES cases(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        note TEXT,
        status VARCHAR(20) DEFAULT 'open',
        anonymous BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS community_comments (
        id SERIAL PRIMARY KEY,
        post_id INTEGER REFERENCES community_posts(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        is_accepted BOOLEAN DEFAULT false,
        anonymous BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS community_comment_votes (
        comment_id INTEGER REFERENCES community_comments(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (comment_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS community_post_votes (
        post_id INTEGER REFERENCES community_posts(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (post_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS direct_conversations (
        id SERIAL PRIMARY KEY,
        user1_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        user2_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS direct_messages (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER REFERENCES direct_conversations(id) ON DELETE CASCADE,
        sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        read_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS bypass_approval BOOLEAN DEFAULT false;
    `);

    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS show_stats BOOLEAN DEFAULT true;
    `);

    // Bumped on a password change or reset; tokens carry the version they were issued under, so older sessions end.
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
    `);

    // Judge results keyed by a hash of (prompt, framework, model): identical retries cost nothing and read the same.
    await client.query(`
      CREATE TABLE IF NOT EXISTS judge_cache (
        key CHAR(64) PRIMARY KEY,
        result JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      DELETE FROM judge_cache WHERE created_at < NOW() - INTERVAL '90 days';

      CREATE TABLE IF NOT EXISTS system_prompt_history (
        id SERIAL PRIMARY KEY,
        value TEXT NOT NULL,
        edited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Expert-framework entries live in the community as posts of kind 'expert' pointing at a solved framework,
    // so comments, votes and the thread UI are shared with the student Q&A. One entry per framework.
    await client.query(`
      ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS kind VARCHAR(20) DEFAULT 'post';
      ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS solved_framework_id INTEGER REFERENCES solved_frameworks(id) ON DELETE CASCADE;
      CREATE UNIQUE INDEX IF NOT EXISTS community_posts_solved_framework_idx
        ON community_posts (solved_framework_id) WHERE solved_framework_id IS NOT NULL;
    `);

    // Scoring rubric version each result was marked under (1 = original rules), so
    // trend views can tell scales apart when the rubric changes.
    await client.query(`
      ALTER TABLE drill_results ADD COLUMN IF NOT EXISTS rubric_version INTEGER DEFAULT 1;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS drill_results_user_created_idx
      ON drill_results (user_id, created_at DESC);
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS direct_conversations_pair_idx
      ON direct_conversations (LEAST(user1_id, user2_id), GREATEST(user1_id, user2_id));
    `);
    console.log('✅ Database tables ready');

    await seedAdmins(client);
    await seedCases(client);
    try {
      await seedExpertCases(client);
    } catch (err) {
      // Optional content: never let it stop the app from booting.
      console.warn('⚠️  Expert case seed failed:', err.message);
    }
    await seedMarkingCriteria(client);
    await seedSystemConfig(client);
  } catch (err) {
    console.error('❌ Database init error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// Creates or resets the seed admin accounts from their ADMIN_PASSWORD_* variables.
// - A variable that is not set creates nothing and changes nothing (an existing account that still accepts its old
//   published default password is flagged in the log).
// - A variable is applied once per value: a fingerprint of (email, password) is stored, so changing the value in the
//   environment resets the password on the next start (this is also the recovery path), while a password the admin
//   later changes in the app is left alone until the variable's value changes again.
// - Resetting a password ends that account's existing sessions.
async function seedAdmins(client) {
  for (const admin of SEED_ADMINS) {
    const password = process.env[admin.envVar];
    const found = await client.query('SELECT id, password_hash FROM users WHERE email = $1', [admin.email]);
    const existing = found.rows[0];

    if (!password) {
      if (!existing) {
        console.warn(`⚠️  No ${admin.email} account yet: set ${admin.envVar} (at least ${MIN_ADMIN_PASSWORD} characters) to create it.`);
      } else if (await bcrypt.compare(LEGACY_DEFAULT_PASSWORDS[admin.email], existing.password_hash)) {
        console.warn(`⚠️  SECURITY: ${admin.email} still accepts the old published default password. Set ${admin.envVar} to replace it.`);
      }
      continue;
    }
    if (password.length < MIN_ADMIN_PASSWORD || password === LEGACY_DEFAULT_PASSWORDS[admin.email]) {
      console.warn(`⚠️  ${admin.envVar} is ignored: it must be at least ${MIN_ADMIN_PASSWORD} characters and not the old default.`);
      continue;
    }

    const fingerprint = crypto.createHash('sha256').update(admin.email + '\n' + password).digest('hex');
    const marker = 'admin_password_applied:' + admin.email;
    const stored = await client.query('SELECT value FROM system_config WHERE key = $1', [marker]);
    if (existing && stored.rows[0] && stored.rows[0].value === fingerprint) continue;

    const hash = await bcrypt.hash(password, 10);
    if (existing) {
      await client.query(
        "UPDATE users SET password_hash = $1, role = 'admin', token_version = token_version + 1 WHERE id = $2",
        [hash, existing.id]
      );
      // Required here, not at the top, because the middleware imports this module. Drops any cached copy of the
      // account so its old sessions stop working immediately, not after the cache expires.
      require('./middleware/auth').forgetAccount(existing.id);
    } else {
      await client.query(
        'INSERT INTO users (email, password_hash, first_name, role) VALUES ($1, $2, $3, $4)',
        [admin.email, hash, admin.firstName, 'admin']
      );
    }
    await client.query(
      'INSERT INTO system_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()',
      [marker, fingerprint]
    );
    console.log(`✅ ${existing ? 'Reset the password of' : 'Created'} admin account ${admin.email} from ${admin.envVar}`);
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

// Expert-solved cases (case + approved solved framework). Opt-in: set SEED_EXPERT_CASES=true once you have
// confirmed you may show these prompts and frameworks to students. Idempotent and non-destructive: an existing
// case id is never overwritten (admins may have edited it), and each framework is inserted once per origin marker.
async function seedExpertCases(client) {
  if (process.env.SEED_EXPERT_CASES !== 'true') return;

  const filePath = path.join(__dirname, 'data', 'expert-cases.json');
  if (!fs.existsSync(filePath)) return;
  const { validateSolvedFramework } = require('./lib/solvedFramework');

  // The frameworks are credited to a dedicated creator account, not to an admin. Its password is random and never
  // shown, so nobody can log in as it; to let the consultant submit more, promote their own account to creator.
  // EXPERT_DISPLAY_NAME sets the name students see (default is deliberately neutral).
  const expertEmail = 'expert@caseroom.app';
  const displayName = (process.env.EXPERT_DISPLAY_NAME || 'Expert consultant').slice(0, 100);
  let expert = await client.query('SELECT id FROM users WHERE email = $1', [expertEmail]);
  if (!expert.rows.length) {
    const hash = await bcrypt.hash(require('crypto').randomBytes(24).toString('hex'), 10);
    expert = await client.query(
      "INSERT INTO users (email, password_hash, first_name, role) VALUES ($1, $2, $3, 'creator') RETURNING id",
      [expertEmail, hash, displayName]
    );
  } else {
    await client.query('UPDATE users SET first_name = $1 WHERE id = $2', [displayName, expert.rows[0].id]);
  }
  const adminId = expert.rows[0].id;
  // Earlier seeds credited an admin; move those frameworks to the expert account.
  await client.query(
    "UPDATE solved_frameworks SET creator_id = $1, approved_by = $1 WHERE framework->>'origin' LIKE 'darden-2024-25-case-%' AND creator_id <> $1",
    [adminId]
  );

  const entries = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  let added = 0;
  for (const { case: c, framework } of entries) {
    const checked = validateSolvedFramework(framework);
    if (!checked.ok) {
      console.warn(`⚠️  Skipping expert framework for ${c.id}: ${checked.errors.join('; ')}`);
      continue;
    }
    if (!checked.value.origin) {
      console.warn(`⚠️  Skipping expert framework for ${c.id}: missing origin marker (needed to seed once)`);
      continue;
    }
    await client.query(
      'INSERT INTO cases (id, title, source, type, data) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING',
      [c.id, c.title, c.source || '', c.type || '', JSON.stringify(c)]
    );
    const result = await client.query(
      `INSERT INTO solved_frameworks (creator_id, case_id, framework, status, approved_by)
       SELECT $1::int, $2::varchar, $3::jsonb, 'approved', $1::int
       WHERE NOT EXISTS (SELECT 1 FROM solved_frameworks WHERE case_id = $2::varchar AND framework->>'origin' = $4::text)`,
      [adminId, c.id, JSON.stringify(checked.value), checked.value.origin || null]
    );
    added += result.rowCount;
  }
  if (added) console.log(`✅ Seeded ${added} expert solved frameworks`);
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
  // Keyed on the row itself: system_config also holds other settings (such as the admin password markers).
  const { rows } = await client.query("SELECT 1 FROM system_config WHERE key = 'system_prompt'");
  if (rows.length > 0) return;

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

module.exports = { pool, initDB, seedAdmins };

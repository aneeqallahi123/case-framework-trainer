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
    `);
    console.log('✅ Database tables ready');

    await seedAdmins(client);
    await seedCases(client);
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

module.exports = { pool, initDB };

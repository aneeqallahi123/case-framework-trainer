# Case Framework Trainer

A case interview practice platform with AI-powered transcription and framework structuring.

## What this does
- Practice case interviews with a 400-case bank
- Record your framework delivery — Deepgram transcribes it
- Claude AI structures your spoken words into a visual framework
- Confirms if the AI got it right before scoring
- Saves your history and scores to the cloud

## Tech Stack
- **Frontend**: Single HTML file (no build step)
- **Backend**: Node.js + Express
- **Database**: PostgreSQL (on Railway)
- **Transcription**: Deepgram API
- **AI Structuring**: Anthropic Claude API

---

## Local Setup (for development)

### 1. Clone the repo
```bash
git clone https://github.com/aneeqallahi123/case-framework-trainer.git
cd case-framework-trainer
```

### 2. Set up the backend
```bash
cd backend
npm install
cp .env.example .env
# Edit .env and fill in your API keys
```

### 3. Start the backend
```bash
npm run dev
# Server runs on http://localhost:3001
```

### 4. Open the frontend
Open `index.html` in your browser directly (no server needed for frontend).

The `API_BASE` in `index.html` auto-detects `localhost` and points to `http://localhost:3001`.

---

## Deploy to Railway

### Step 1: Push to GitHub
```bash
git add .
git commit -m "Initial setup"
git push origin main
```

### Step 2: Railway Setup
1. Go to [railway.app](https://railway.app)
2. New Project → Deploy from GitHub → select this repo
3. Add a **PostgreSQL** service
4. Go to your Node.js service → **Variables** and add:

```
DATABASE_URL     = (auto-populated from PostgreSQL service)
JWT_SECRET       = (any long random string, e.g. 32+ random chars)
DEEPGRAM_API_KEY = (from console.deepgram.com)
ANTHROPIC_API_KEY= (from console.anthropic.com)
NODE_ENV         = production
FRONTEND_URL     = *
```

5. Set **Root Directory** to `backend` in Railway service settings
6. Set **Start Command** to `node src/index.js`

### Step 3: Update frontend URL
Once Railway gives you a deployment URL (e.g. `https://case-framework-trainer-production.up.railway.app`), update line in `index.html`:

```javascript
: 'https://YOUR-RAILWAY-URL-HERE.up.railway.app';
```

Replace `YOUR-RAILWAY-URL-HERE` with your actual Railway subdomain.

Push again and you're live.

---

## API Keys You Need

| Key | Where to get | Free tier |
|-----|-------------|-----------|
| `DEEPGRAM_API_KEY` | [console.deepgram.com/signup](https://console.deepgram.com/signup) | $200 free |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) | Free tier |
| `JWT_SECRET` | Make up any long random string | N/A |

---

## How a drill is marked

Marking is a hybrid. Rules score what can be counted: **Structure** (bucket and point counts) and **Succinct** (point length). A model, the "coach", scores **MECE** and **Relevant** by meaning and writes the feedback. If the coach is unavailable the review falls back to simple keyword checks for those two, so a score always appears, and the result is saved with an older `rubric_version` (2 = rules only, 3 = coach).

- The coach's instructions are the **System prompt** in the admin panel, combined with the live marking criteria and the expert frameworks. Write `{{Structure.minPointsPerBucket}}` to insert a live setting. The admin panel also keeps prompt versions, shows the prompt's size and usage, and can run a planted-flaw test (judges test frameworks built from each expert solution with that case's own expert framework left out).
- Identical frameworks reuse the stored result, so a retry costs nothing and reads the same. Each user is limited to `JUDGE_RATE_PER_HOUR` judged reviews per hour.
- The per-shape playbook (`backend/src/data/expert-playbook.json`) is included once its `status` is `reviewed`; it is.
- Cost: the stable prompt is roughly 8k tokens. Prompt caching is off by default; see `.env.example` for when to turn it on.

## Admin accounts and passwords

No password is built into the code. The admin accounts `aneeq@caseroom.app` and `chohan@caseroom.app` are created from the `ADMIN_PASSWORD_ANEEQ` and `ADMIN_PASSWORD_CHOHAN` settings (at least 12 characters). Everyone, admins included, can change their own password under **Profile & Privacy > Change password**: 8 characters or more, 12 or more for admin and creator accounts.

- Changing a password ends every other session for that account, and removing or demoting an account takes effect immediately.
- A setting is applied once per value. To reset a forgotten password, change the setting on Railway and redeploy. A password you chose inside the app is kept across restarts until you change the setting.
- If an account in an older database still accepts its old published default password, the server log says so at start-up (`SECURITY: ... still accepts the old published default password`). Set its setting or change the password in the app.
- Wrong passwords are limited to 10 attempts per 15 minutes per email address, and 5 wrong current-password entries per 15 minutes when changing a password.

## Expert frameworks

Creators submit structured solved frameworks (answer shape, purpose, buckets as questions with hypotheses, where to start, clarifying Q&A) which admins approve. Approved ones feed the coach as calibration examples and appear under **Community > Expert frameworks**, where each one unlocks after the student has attempted that case (enforced by the server).

`backend/src/data/expert-cases.json` holds 15 expert-solved cases. They are seeded only when `SEED_EXPERT_CASES=true` is set, because you should confirm you may show those prompts and frameworks before doing so.

## Tests

```
node --test tests/analytics.test.js tests/scoring.test.js tests/solved-framework.test.js tests/judge.test.js tests/judge-service.test.js tests/auth.test.js
```

Two further suites need a scratch Postgres and make no real model calls:

```
E2E_DATABASE_URL=postgresql://... node --test tests/e2e-community-judge.test.js   # API, gating, judge route
UI_DATABASE_URL=postgresql://... node tests/ui/server.js &  node tests/ui/browser.test.js   # needs Playwright
```

---

## File Structure

```
case-framework-trainer/
├── index.html              ← The full app (frontend)
├── README.md
└── backend/
    ├── package.json
    ├── .env.example         ← Copy to .env, fill in keys
    └── src/
        ├── index.js         ← Express server entry point
        ├── db.js            ← PostgreSQL connection + table setup
        ├── middleware/
        │   └── auth.js      ← JWT auth middleware
        └── routes/
            ├── auth.js      ← /api/auth/signup, /login, /me
            ├── drills.js    ← /api/drills (save + fetch history)
            ├── judge.js     ← /api/judge (the coach: MECE, Relevant, feedback)
            ├── creator.js, admin.js, community.js, cases.js
            └── transcribe.js← /api/transcribe + /structure
        ├── judge/           ← prompt builder, model call, service, test samples
        ├── lib/             ← solved-framework schema, JSON helpers, rate limiter
        └── data/            ← case bank, expert cases, reviewed playbook
```

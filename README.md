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
            └── transcribe.js← /api/transcribe + /structure
```

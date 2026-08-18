require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { initDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/drills', require('./routes/drills'));
app.use('/api/transcribe', require('./routes/transcribe'));
app.use('/api/cases', require('./routes/cases'));
app.use('/api/creator', require('./routes/creator'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/community', require('./routes/community'));

// Health check - Railway uses this to confirm the app is running
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Serve the frontend
const FRONTEND_DIR = path.join(__dirname, '..', '..');
app.use(express.static(FRONTEND_DIR));
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// Start server
async function start() {
  try {
    await initDB();
    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      console.log(`   Health: http://localhost:${PORT}/health`);
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }
}

start();

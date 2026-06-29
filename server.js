require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db');
const apiRoutes = require('./routes/api');
const walletRoutes = require('./routes/wallet');
const adminRoutes = require('./routes/admin');
const { GameEngine } = require('./gameEngine');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

initDB();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', apiRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/admin', adminRoutes);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

const engine = new GameEngine(broadcast);
app.locals.engine = engine;

wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleWSMessage(ws, data);
    } catch (e) {
      console.error('WS parse error', e);
    }
  });

  ws.on('close', () => console.log('Client disconnected'));

  const state = engine.getCurrentState();
  ws.send(JSON.stringify({ type: 'GAME_STATE', payload: state }));
});

function handleWSMessage(ws, data) {
  switch (data.type) {
    case 'CLAIM_BINGO':
      engine.claimBingo(data.userId, data.gameId, data.cartelaId, ws);
      break;
    case 'JOIN_GAME':
      engine.addWatcher(data.gameId, ws);
      break;
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Bingo server running on port ${PORT}`);
  engine.startAutoGame();

  if (process.env.BOT_TOKEN) {
    const onRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
    const allowLocalBot = process.env.ENABLE_BOT === 'true';
    if (onRailway || allowLocalBot) {
      require('./bot').startBot();
    } else {
      console.log('⚠️  Bot disabled locally — only runs on Railway (set ENABLE_BOT=true to override)');
    }
  } else {
    console.log('⚠️  BOT_TOKEN not set — Telegram bot not started');
  }
});

module.exports = { broadcast };

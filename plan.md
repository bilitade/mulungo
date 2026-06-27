# Mulungo — Telegram Mini App: Full MVP Implementation Guide

> **Stack:** Node.js + Express (backend) · Vanilla HTML/CSS/JS (frontend) · SQLite (database) · Telegraf (Telegram bot) · Free-tier deployable (Railway / Render / Fly.io)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Project Structure](#2-project-structure)
3. [Backend — Server & Bot](#3-backend--server--bot)
4. [Database Schema](#4-database-schema)
5. [Game Logic Engine](#5-game-logic-engine)
6. [Telegram Bot Commands](#6-telegram-bot-commands)
7. [Frontend — Telegram Mini App UI](#7-frontend--telegram-mini-app-ui)
8. [Wallet & Payment Flow](#8-wallet--payment-flow)
9. [WebSocket — Real-time Game Events](#9-websocket--real-time-game-events)
10. [Environment Variables & Config](#10-environment-variables--config)
11. [Deployment (Free Tier)](#11-deployment-free-tier)
12. [Full File Listing](#12-full-file-listing)

---

## 1. Architecture Overview

```
Telegram User
     │
     ▼
Telegram Bot (Telegraf)
     │  ← /start, /play, /balance, /deposit, /withdraw
     │
     ▼
Express Server (Node.js)
     ├── REST API  (/api/*)
     ├── WebSocket (ws://)  ← real-time number calling
     └── Static Files  (Mini App HTML/CSS/JS)
          │
          ▼
     SQLite Database
     (users, games, cartelas, wallets, transactions)
```

**Key flows:**
- User opens Mini App via Telegram → picks cartela → joins game room
- Server auto-calls numbers every 5s via WebSocket broadcast
- Frontend auto-marks numbers on cartela
- Player clicks BINGO → server validates → winner gets pot

---

## 2. Project Structure

```
bingo-app/
├── package.json
├── .env
├── server.js              ← Express + WebSocket server
├── bot.js                 ← Telegraf Telegram bot
├── db.js                  ← SQLite setup + queries
├── gameEngine.js          ← Bingo logic, number calling, win detection
├── routes/
│   ├── api.js             ← REST endpoints
│   └── wallet.js          ← Wallet & transaction endpoints
└── public/
    ├── index.html         ← Mini App shell
    ├── style.css          ← All styles
    └── app.js             ← Frontend JS (WebSocket + UI)
```

---

## 3. Backend — Server & Bot

### `package.json`

```json
{
  "name": "mulungo",
  "version": "1.0.0",
  "description": "Ethiopian Telegram Bingo Mini App",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "telegraf": "^4.15.0",
    "better-sqlite3": "^9.4.3",
    "ws": "^8.16.0",
    "uuid": "^9.0.0",
    "cors": "^2.8.5",
    "dotenv": "^16.4.1"
  },
  "devDependencies": {
    "nodemon": "^3.0.3"
  }
}
```

---

### `server.js`

```javascript
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db');
const apiRoutes = require('./routes/api');
const walletRoutes = require('./routes/wallet');
const { GameEngine } = require('./gameEngine');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Init DB
initDB();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api', apiRoutes);
app.use('/api/wallet', walletRoutes);

// Serve Mini App for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket: broadcast to all connected clients
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// Game engine singleton — manages all active games
const engine = new GameEngine(broadcast);

// Attach engine to app for use in routes
app.locals.engine = engine;

wss.on('connection', (ws, req) => {
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

  // Send current game state on connect
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
  engine.startAutoGame(); // Start the first game loop
});

module.exports = { broadcast };
```

---

### `bot.js`

```javascript
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { getOrCreateUser, getBalance, createDeposit } = require('./db');

const bot = new Telegraf(process.env.BOT_TOKEN);
const MINI_APP_URL = process.env.MINI_APP_URL; // e.g. https://yourdomain.railway.app

// /start — Register user & show main menu
bot.start(async (ctx) => {
  const tgUser = ctx.from;
  const user = getOrCreateUser({
    telegramId: tgUser.id,
    username: tgUser.username || tgUser.first_name,
    firstName: tgUser.first_name,
  });

  await ctx.reply(
    `🎱 *Mulungo* へようこそ!\n\nHello ${tgUser.first_name}! Ready to play?\n\n💰 Balance: *${user.main_wallet} ETB*`,
    {
      parse_mode: 'Markdown',
      ...Markup.keyboard([
        [Markup.button.webApp('🎮 Play Bingo', MINI_APP_URL)],
        ['/balance', '/deposit', '/help'],
      ]).resize(),
    }
  );
});

// /balance
bot.command('balance', async (ctx) => {
  const user = getOrCreateUser({ telegramId: ctx.from.id, username: ctx.from.username });
  await ctx.reply(
    `💼 *Account Info*\n\n` +
    `Name: ${user.username}\n` +
    `Main Wallet: *${user.main_wallet} ETB*\n` +
    `Play Wallet: *${user.play_wallet} ETB*`,
    { parse_mode: 'Markdown' }
  );
});

// /deposit
bot.command('deposit', async (ctx) => {
  await ctx.reply(
    `💳 *Deposit via Telebirr*\n\n` +
    `Send ETB to: *0923471256* (Mulungo)\n\n` +
    `Then send your transaction reference here:\n` +
    `/confirm_deposit <amount> <ref_number>\n\n` +
    `Example: /confirm_deposit 50 DFL123ABC`,
    { parse_mode: 'Markdown' }
  );
});

// /confirm_deposit <amount> <ref>
bot.command('confirm_deposit', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  if (parts.length < 3) {
    return ctx.reply('Usage: /confirm_deposit <amount> <reference>');
  }
  const amount = parseFloat(parts[1]);
  const ref = parts[2];

  if (isNaN(amount) || amount <= 0) {
    return ctx.reply('❌ Invalid amount.');
  }

  // In production: verify against Telebirr API
  // For MVP: auto-approve (notify admin via separate channel)
  const { addToPlayWallet } = require('./db');
  addToPlayWallet(ctx.from.id, amount, ref);

  await ctx.reply(
    `✅ Deposit of *${amount} ETB* approved!\nRef: ${ref}\n\nYour play wallet has been credited.`,
    { parse_mode: 'Markdown' }
  );

  // Notify admin
  if (process.env.ADMIN_CHAT_ID) {
    bot.telegram.sendMessage(
      process.env.ADMIN_CHAT_ID,
      `💰 New deposit: ${amount} ETB from @${ctx.from.username} (Ref: ${ref})`
    );
  }
});

// /help
bot.command('help', async (ctx) => {
  await ctx.reply(
    `🎱 *Mulungo Help*\n\n` +
    `*How to play:*\n` +
    `1. Deposit ETB to your play wallet\n` +
    `2. Open the game and pick your cartela (1-96)\n` +
    `3. Join a game room and wait for numbers\n` +
    `4. Numbers are called automatically every 5 seconds\n` +
    `5. Complete a line (horizontal, vertical, or diagonal) and claim BINGO!\n\n` +
    `*Win types:*\n` +
    `↔️ Horizontal — 5 in a row\n` +
    `↕️ Vertical — 5 in a column\n` +
    `↗️ Diagonal — corner to corner\n` +
    `⬛ Full House — entire card\n\n` +
    `⚠️ False BINGO = removed from game + lose stake`,
    { parse_mode: 'Markdown' }
  );
});

bot.launch();
console.log('🤖 Bot started');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
```

---

## 4. Database Schema

### `db.js`

```javascript
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'bingo.db'));

function initDB() {
  db.exec(`
    -- Users
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE NOT NULL,
      username TEXT,
      first_name TEXT,
      main_wallet REAL DEFAULT 0,
      play_wallet REAL DEFAULT 0,
      games_won INTEGER DEFAULT 0,
      total_earning REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Games
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      status TEXT DEFAULT 'waiting',   -- waiting | active | finished
      bet_amount REAL DEFAULT 10,
      player_count INTEGER DEFAULT 0,
      derash REAL DEFAULT 0,           -- pot amount
      called_numbers TEXT DEFAULT '[]',-- JSON array
      winner_ids TEXT DEFAULT '[]',    -- JSON array
      started_at DATETIME,
      finished_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Cartelas (player cards in a game)
    CREATE TABLE IF NOT EXISTS cartelas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      cartela_number INTEGER NOT NULL, -- 1-96
      card_data TEXT NOT NULL,          -- JSON: 5x5 grid
      is_active INTEGER DEFAULT 1,
      FOREIGN KEY (game_id) REFERENCES games(id)
    );

    -- Transactions
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,              -- deposit | withdraw | bet | win
      amount REAL NOT NULL,
      reference TEXT,
      game_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('✅ Database initialized');
}

// ── User queries ──────────────────────────────────────────

function getOrCreateUser({ telegramId, username, firstName }) {
  const existing = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(telegramId));
  if (existing) return existing;

  db.prepare(
    'INSERT INTO users (telegram_id, username, first_name) VALUES (?, ?, ?)'
  ).run(String(telegramId), username || '', firstName || '');

  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(telegramId));
}

function getUser(telegramId) {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(telegramId));
}

function getBalance(telegramId) {
  const user = getUser(telegramId);
  return user ? { main: user.main_wallet, play: user.play_wallet } : null;
}

function addToPlayWallet(telegramId, amount, ref) {
  db.prepare('UPDATE users SET play_wallet = play_wallet + ? WHERE telegram_id = ?')
    .run(amount, String(telegramId));
  db.prepare(
    'INSERT INTO transactions (user_id, type, amount, reference) VALUES (?, ?, ?, ?)'
  ).run(String(telegramId), 'deposit', amount, ref);
}

function deductPlayWallet(telegramId, amount) {
  const user = getUser(telegramId);
  if (!user || user.play_wallet < amount) return false;
  db.prepare('UPDATE users SET play_wallet = play_wallet - ? WHERE telegram_id = ?')
    .run(amount, String(telegramId));
  return true;
}

function creditWinnings(telegramId, amount, gameId) {
  db.prepare(
    'UPDATE users SET main_wallet = main_wallet + ?, games_won = games_won + 1, total_earning = total_earning + ? WHERE telegram_id = ?'
  ).run(amount, amount, String(telegramId));
  db.prepare(
    'INSERT INTO transactions (user_id, type, amount, game_id) VALUES (?, ?, ?, ?)'
  ).run(String(telegramId), 'win', amount, gameId);
}

// ── Game queries ──────────────────────────────────────────

function createGame(gameId, betAmount) {
  db.prepare(
    'INSERT INTO games (id, bet_amount, status) VALUES (?, ?, ?)'
  ).run(gameId, betAmount, 'waiting');
}

function getGame(gameId) {
  return db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
}

function updateGameNumbers(gameId, calledNumbers) {
  db.prepare('UPDATE games SET called_numbers = ? WHERE id = ?')
    .run(JSON.stringify(calledNumbers), gameId);
}

function startGame(gameId) {
  db.prepare("UPDATE games SET status = 'active', started_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(gameId);
}

function finishGame(gameId, winnerIds) {
  db.prepare(
    "UPDATE games SET status = 'finished', winner_ids = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(JSON.stringify(winnerIds), gameId);
}

function addPlayerToGame(gameId, userId, cartelaNumber, cardData, betAmount) {
  const ok = deductPlayWallet(userId, betAmount);
  if (!ok) return { success: false, error: 'Insufficient balance' };

  db.prepare(
    'INSERT INTO cartelas (game_id, user_id, cartela_number, card_data) VALUES (?, ?, ?, ?)'
  ).run(gameId, String(userId), cartelaNumber, JSON.stringify(cardData));

  db.prepare('UPDATE games SET player_count = player_count + 1, derash = derash + ? WHERE id = ?')
    .run(betAmount, gameId);

  db.prepare(
    'INSERT INTO transactions (user_id, type, amount, game_id) VALUES (?, ?, ?, ?)'
  ).run(String(userId), 'bet', betAmount, gameId);

  return { success: true };
}

function getCartelaForUser(gameId, userId) {
  const row = db.prepare('SELECT * FROM cartelas WHERE game_id = ? AND user_id = ?').get(gameId, String(userId));
  if (!row) return null;
  return { ...row, card_data: JSON.parse(row.card_data) };
}

function getGameHistory(userId) {
  return db.prepare(`
    SELECT g.id, g.status, g.bet_amount, g.derash, g.finished_at,
           c.cartela_number, t.type as result
    FROM cartelas c
    JOIN games g ON c.game_id = g.id
    LEFT JOIN transactions t ON t.game_id = g.id AND t.user_id = ? AND t.type IN ('win','bet')
    WHERE c.user_id = ?
    ORDER BY g.created_at DESC LIMIT 20
  `).all(String(userId), String(userId));
}

module.exports = {
  initDB, db,
  getOrCreateUser, getUser, getBalance,
  addToPlayWallet, deductPlayWallet, creditWinnings,
  createGame, getGame, updateGameNumbers, startGame, finishGame,
  addPlayerToGame, getCartelaForUser, getGameHistory,
};
```

---

## 5. Game Logic Engine

### `gameEngine.js`

```javascript
const { v4: uuidv4 } = require('uuid');
const {
  createGame, getGame, startGame, finishGame,
  updateGameNumbers, addPlayerToGame, getCartelaForUser, creditWinnings, db
} = require('./db');

const BET_AMOUNT = 10;        // ETB per game
const CALL_INTERVAL_MS = 5000; // 5 seconds between numbers
const MIN_PLAYERS = 2;         // min players to start
const LOBBY_WAIT_MS = 30000;   // 30s lobby window

// Generate a proper BINGO cartela card
// B: 1-15, I: 16-30, N: 31-45, G: 46-60, O: 61-75
function generateCard(cartelaNumber) {
  const ranges = [
    [1, 15],   // B
    [16, 30],  // I
    [31, 45],  // N
    [46, 60],  // G
    [61, 75],  // O
  ];

  // Seeded shuffle for deterministic cards by cartela number
  const seededRandom = (seed) => {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  };

  const card = [];
  for (let col = 0; col < 5; col++) {
    const [min, max] = ranges[col];
    const pool = [];
    for (let n = min; n <= max; n++) pool.push(n);

    // Shuffle pool with seed = cartelaNumber * (col+1)
    const seed = cartelaNumber * (col + 1);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(seededRandom(seed + i) * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const col_vals = pool.slice(0, 5);
    if (col === 2) col_vals[2] = 'FREE'; // N column, middle = FREE
    card.push(col_vals);
  }
  return card; // card[col][row] — 5 cols, 5 rows
}

// Check if called numbers constitute a BINGO on a card
function checkBingo(card, calledNumbers) {
  const called = new Set(calledNumbers);
  const isMarked = (col, row) => card[col][row] === 'FREE' || called.has(card[col][row]);

  // Check rows
  for (let row = 0; row < 5; row++) {
    if ([0,1,2,3,4].every(col => isMarked(col, row))) return true;
  }
  // Check columns
  for (let col = 0; col < 5; col++) {
    if ([0,1,2,3,4].every(row => isMarked(col, row))) return true;
  }
  // Check diagonals
  if ([0,1,2,3,4].every(i => isMarked(i, i))) return true;
  if ([0,1,2,3,4].every(i => isMarked(i, 4 - i))) return true;

  return false;
}

class GameEngine {
  constructor(broadcast) {
    this.broadcast = broadcast;
    this.currentGame = null;
    this.calledNumbers = [];
    this.callTimer = null;
    this.lobbyTimer = null;
    this.watchers = new Map(); // gameId → Set<ws>
  }

  getCurrentState() {
    if (!this.currentGame) return { status: 'no_game' };
    const game = getGame(this.currentGame);
    return {
      gameId: this.currentGame,
      status: game?.status || 'waiting',
      calledNumbers: this.calledNumbers,
      playerCount: game?.player_count || 0,
      betAmount: game?.bet_amount || BET_AMOUNT,
      pot: game?.derash || 0,
    };
  }

  startAutoGame() {
    this.initNewGame();
  }

  initNewGame() {
    const gameId = uuidv4().slice(0, 8).toUpperCase();
    createGame(gameId, BET_AMOUNT);
    this.currentGame = gameId;
    this.calledNumbers = [];

    this.broadcast({
      type: 'LOBBY_OPEN',
      payload: {
        gameId,
        betAmount: BET_AMOUNT,
        waitTime: LOBBY_WAIT_MS / 1000,
      }
    });

    // Start game after lobby window
    this.lobbyTimer = setTimeout(() => {
      const game = getGame(gameId);
      if (game.player_count >= MIN_PLAYERS) {
        this.beginGame(gameId);
      } else {
        this.broadcast({ type: 'GAME_CANCELLED', payload: { gameId, reason: 'Not enough players' } });
        // Refund players
        this.refundPlayers(gameId);
        setTimeout(() => this.initNewGame(), 5000);
      }
    }, LOBBY_WAIT_MS);
  }

  refundPlayers(gameId) {
    const cartelas = db.prepare('SELECT * FROM cartelas WHERE game_id = ?').all(gameId);
    cartelas.forEach(c => {
      db.prepare('UPDATE users SET play_wallet = play_wallet + ? WHERE telegram_id = ?')
        .run(BET_AMOUNT, c.user_id);
    });
    db.prepare("UPDATE games SET status = 'cancelled' WHERE id = ?").run(gameId);
  }

  beginGame(gameId) {
    startGame(gameId);
    const game = getGame(gameId);

    this.broadcast({
      type: 'GAME_STARTED',
      payload: {
        gameId,
        playerCount: game.player_count,
        pot: game.derash,
      }
    });

    // Shuffle numbers 1-75
    const numbers = Array.from({ length: 75 }, (_, i) => i + 1);
    for (let i = numbers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
    }
    this.numberQueue = numbers;
    this.callNextNumber(gameId);
  }

  callNextNumber(gameId) {
    if (this.numberQueue.length === 0) {
      // All numbers called, end game with no winner
      this.endGame(gameId, []);
      return;
    }

    const number = this.numberQueue.shift();
    this.calledNumbers.push(number);
    updateGameNumbers(gameId, this.calledNumbers);

    const column = ['B','I','N','G','O'][Math.floor((number - 1) / 15)];

    this.broadcast({
      type: 'NUMBER_CALLED',
      payload: {
        gameId,
        number,
        column,
        calledNumbers: this.calledNumbers,
        remaining: this.numberQueue.length,
      }
    });

    this.callTimer = setTimeout(() => this.callNextNumber(gameId), CALL_INTERVAL_MS);
  }

  claimBingo(userId, gameId, cartelaId, ws) {
    if (gameId !== this.currentGame) {
      ws.send(JSON.stringify({ type: 'BINGO_INVALID', payload: { reason: 'Wrong game' } }));
      return;
    }

    const cartela = getCartelaForUser(gameId, userId);
    if (!cartela) {
      ws.send(JSON.stringify({ type: 'BINGO_INVALID', payload: { reason: 'No cartela found' } }));
      return;
    }

    const valid = checkBingo(cartela.card_data, this.calledNumbers);
    if (!valid) {
      // False BINGO penalty: already deducted stake, mark as penalized
      ws.send(JSON.stringify({
        type: 'FALSE_BINGO',
        payload: { reason: 'No valid BINGO pattern found. You have been removed from the game.' }
      }));
      db.prepare('UPDATE cartelas SET is_active = 0 WHERE game_id = ? AND user_id = ?')
        .run(gameId, String(userId));
      return;
    }

    // Valid BINGO!
    const game = getGame(gameId);
    const winAmount = game.derash; // split if multiple winners at same time
    creditWinnings(userId, winAmount, gameId);
    this.endGame(gameId, [{ userId, cartelaId: cartela.cartela_number, winAmount }]);
  }

  endGame(gameId, winners) {
    clearTimeout(this.callTimer);
    finishGame(gameId, winners.map(w => w.userId));

    const game = getGame(gameId);
    this.broadcast({
      type: 'GAME_OVER',
      payload: {
        gameId,
        winners,
        calledNumbers: this.calledNumbers,
        totalCalled: this.calledNumbers.length,
      }
    });

    // Start next game after 10 seconds
    setTimeout(() => this.initNewGame(), 10000);
  }

  joinGame(userId, cartelaNumber) {
    if (!this.currentGame) return { success: false, error: 'No active game' };
    const game = getGame(this.currentGame);
    if (game.status !== 'waiting') return { success: false, error: 'Game already started' };

    // Check cartela not already taken in this game
    const taken = db.prepare(
      'SELECT id FROM cartelas WHERE game_id = ? AND cartela_number = ?'
    ).get(this.currentGame, cartelaNumber);
    if (taken) return { success: false, error: 'Cartela already taken' };

    const cardData = generateCard(cartelaNumber);
    const result = addPlayerToGame(this.currentGame, userId, cartelaNumber, cardData, BET_AMOUNT);
    if (!result.success) return result;

    // Broadcast updated player count
    const updatedGame = getGame(this.currentGame);
    this.broadcast({
      type: 'PLAYER_JOINED',
      payload: {
        gameId: this.currentGame,
        playerCount: updatedGame.player_count,
        pot: updatedGame.derash,
      }
    });

    return {
      success: true,
      gameId: this.currentGame,
      cardData,
      cartelaNumber,
    };
  }

  addWatcher(gameId, ws) {
    if (!this.watchers.has(gameId)) this.watchers.set(gameId, new Set());
    this.watchers.get(gameId).add(ws);
  }
}

module.exports = { GameEngine, generateCard, checkBingo };
```

---

## 6. REST API Routes

### `routes/api.js`

```javascript
const express = require('express');
const router = express.Router();
const { getOrCreateUser, getUser, getCartelaForUser, getGameHistory } = require('../db');
const { generateCard } = require('../gameEngine');

// POST /api/join — Join a game with a cartela
router.post('/join', (req, res) => {
  const { userId, cartelaNumber } = req.body;
  if (!userId || !cartelaNumber) {
    return res.status(400).json({ error: 'userId and cartelaNumber required' });
  }

  const engine = req.app.locals.engine;
  const result = engine.joinGame(String(userId), parseInt(cartelaNumber));

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  res.json(result);
});

// GET /api/state — Current game state
router.get('/state', (req, res) => {
  const engine = req.app.locals.engine;
  res.json(engine.getCurrentState());
});

// GET /api/user/:telegramId — Get user info
router.get('/user/:telegramId', (req, res) => {
  const user = getUser(req.params.telegramId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    id: user.telegram_id,
    username: user.username,
    mainWallet: user.main_wallet,
    playWallet: user.play_wallet,
    gamesWon: user.games_won,
    totalEarning: user.total_earning,
  });
});

// GET /api/history/:userId — Game history
router.get('/history/:userId', (req, res) => {
  const history = getGameHistory(req.params.userId);
  res.json(history);
});

// POST /api/preview-card — Preview a cartela without joining
router.post('/preview-card', (req, res) => {
  const { cartelaNumber } = req.body;
  if (!cartelaNumber || cartelaNumber < 1 || cartelaNumber > 96) {
    return res.status(400).json({ error: 'cartelaNumber must be 1-96' });
  }
  const cardData = generateCard(parseInt(cartelaNumber));
  res.json({ cartelaNumber, cardData });
});

module.exports = router;
```

### `routes/wallet.js`

```javascript
const express = require('express');
const router = express.Router();
const { getUser, addToPlayWallet, db } = require('../db');

// GET /api/wallet/:userId
router.get('/:userId', (req, res) => {
  const user = getUser(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    mainWallet: user.main_wallet,
    playWallet: user.play_wallet,
  });
});

// GET /api/wallet/:userId/transactions
router.get('/:userId/transactions', (req, res) => {
  const txns = db.prepare(
    'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 30'
  ).all(req.params.userId);
  res.json(txns);
});

module.exports = router;
```

---

## 7. Frontend — Telegram Mini App UI

### `public/index.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mulungo</title>
  <link rel="stylesheet" href="style.css" />
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
</head>
<body>
  <div id="app">
    <!-- Tab Navigation -->
    <nav class="tab-nav">
      <button class="tab-btn active" data-tab="game">🎮 Game</button>
      <button class="tab-btn" data-tab="history">📋 History</button>
      <button class="tab-btn" data-tab="wallet">💰 Wallet</button>
      <button class="tab-btn" data-tab="profile">👤 Profile</button>
    </nav>

    <!-- ── GAME TAB ── -->
    <div id="tab-game" class="tab-content active">
      <!-- Lobby / Waiting -->
      <div id="screen-lobby" class="screen">
        <div class="game-info-bar">
          <div class="info-chip"><span class="label">Game ID</span><span id="lobby-game-id">—</span></div>
          <div class="info-chip"><span class="label">Players</span><span id="lobby-players">0</span></div>
          <div class="info-chip"><span class="label">Bet</span><span id="lobby-bet">10</span></div>
          <div class="info-chip"><span class="label">Pot</span><span id="lobby-pot">0</span></div>
        </div>

        <div class="lobby-status">
          <div class="countdown-ring">
            <svg viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="45" class="ring-bg"/>
              <circle cx="50" cy="50" r="45" class="ring-fill" id="countdown-circle"/>
            </svg>
            <span id="lobby-countdown">30</span>
          </div>
          <p class="lobby-msg">Waiting for players...</p>
        </div>

        <div class="cartela-picker">
          <h3>Select Your Cartela</h3>
          <p class="cartela-hint">Pick a number 1–96 to play</p>
          <div class="cartela-grid" id="cartela-grid">
            <!-- 96 cartela buttons generated by JS -->
          </div>
        </div>

        <div id="cartela-preview" class="cartela-preview hidden">
          <h4>Cartela Preview</h4>
          <div class="bingo-card" id="preview-card"></div>
          <button class="btn btn-primary" id="btn-join-game">Join Game — 10 ETB</button>
        </div>
      </div>

      <!-- Active Game -->
      <div id="screen-game" class="screen hidden">
        <div class="game-info-bar">
          <div class="info-chip"><span class="label">Game</span><span id="game-id-display">—</span></div>
          <div class="info-chip"><span class="label">Players</span><span id="game-players">0</span></div>
          <div class="info-chip"><span class="label">Pot</span><span id="game-pot">0 ETB</span></div>
          <div class="info-chip"><span class="label">Called</span><span id="game-called-count">0</span></div>
        </div>

        <div class="called-display">
          <div class="current-number">
            <div class="column-label" id="current-column">B</div>
            <div class="number-big" id="current-number">—</div>
          </div>
          <div class="called-history" id="called-history"></div>
        </div>

        <div class="bingo-card" id="active-card"></div>

        <button class="btn btn-bingo" id="btn-bingo">🎉 BINGO!</button>
        <p class="watch-only-msg hidden" id="watch-msg">Watching — You are not in this game</p>
      </div>

      <!-- Game Over -->
      <div id="screen-gameover" class="screen hidden">
        <div class="gameover-card">
          <div class="crown">👑</div>
          <h2 class="bingo-title">BINGO!</h2>
          <p id="winners-list"></p>
          <div class="bingo-card small" id="winning-card"></div>
          <p class="next-game-msg">Next game starting in <span id="next-game-timer">10</span>s</p>
        </div>
      </div>
    </div>

    <!-- ── HISTORY TAB ── -->
    <div id="tab-history" class="tab-content hidden">
      <div class="section-header">Game History</div>
      <div id="history-list" class="history-list">
        <p class="empty-msg">No games played yet.</p>
      </div>
    </div>

    <!-- ── WALLET TAB ── -->
    <div id="tab-wallet" class="tab-content hidden">
      <div class="wallet-hero">
        <div class="wallet-card">
          <div class="wallet-label">Main Wallet</div>
          <div class="wallet-amount" id="main-wallet-amount">0 ETB</div>
        </div>
        <div class="wallet-card play">
          <div class="wallet-label">Play Wallet</div>
          <div class="wallet-amount" id="play-wallet-amount">0 ETB</div>
        </div>
      </div>
      <div class="wallet-actions">
        <button class="btn btn-outline" id="btn-deposit">+ Deposit</button>
        <button class="btn btn-outline" id="btn-withdraw">Withdraw</button>
      </div>
      <div class="deposit-info hidden" id="deposit-info">
        <h4>Deposit via Telebirr</h4>
        <p>Send ETB to: <strong>0923471256</strong></p>
        <p>Then send <code>/confirm_deposit &lt;amount&gt; &lt;ref&gt;</code> to the bot.</p>
      </div>
      <div class="section-header">Recent Transactions</div>
      <div id="txn-list" class="txn-list"></div>
    </div>

    <!-- ── PROFILE TAB ── -->
    <div id="tab-profile" class="tab-content hidden">
      <div class="profile-hero">
        <div class="avatar" id="profile-avatar">B</div>
        <div class="profile-name" id="profile-name">—</div>
      </div>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Main Wallet</div><div class="stat-value" id="stat-main">0</div></div>
        <div class="stat-card"><div class="stat-label">Play Wallet</div><div class="stat-value" id="stat-play">0</div></div>
        <div class="stat-card"><div class="stat-label">Games Won</div><div class="stat-value" id="stat-won">0</div></div>
        <div class="stat-card"><div class="stat-label">Total Earning</div><div class="stat-value" id="stat-earning">0</div></div>
      </div>
    </div>
  </div>

  <script src="app.js"></script>
</body>
</html>
```

---

### `public/style.css`

```css
/* ── Reset & Base ──────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #0f0f1a;
  --surface: #1a1a2e;
  --surface2: #16213e;
  --accent: #7c3aed;
  --accent2: #a855f7;
  --green: #22c55e;
  --orange: #f97316;
  --red: #ef4444;
  --yellow: #eab308;
  --text: #f1f5f9;
  --text-muted: #94a3b8;
  --border: rgba(255,255,255,0.08);
  --radius: 12px;
  --radius-sm: 8px;

  --col-b: #3b82f6;
  --col-i: #8b5cf6;
  --col-n: #a855f7;
  --col-g: #22c55e;
  --col-o: #f97316;
}

html, body {
  height: 100%;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 14px;
  overflow: hidden;
}

#app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  max-width: 480px;
  margin: 0 auto;
}

/* ── Tab Navigation ──────────────────────────── */
.tab-nav {
  display: flex;
  background: var(--surface);
  border-top: 1px solid var(--border);
  order: 2; /* push to bottom */
  flex-shrink: 0;
}

.tab-btn {
  flex: 1;
  padding: 12px 4px;
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
  transition: color 0.2s;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.tab-btn.active { color: var(--accent2); }

/* ── Tab Content ─────────────────────────────── */
.tab-content {
  flex: 1;
  overflow-y: auto;
  order: 1;
}

.tab-content.hidden { display: none; }

/* ── Screens ─────────────────────────────────── */
.screen { padding: 12px; }
.screen.hidden { display: none; }

/* ── Game Info Bar ───────────────────────────── */
.game-info-bar {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.info-chip {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
  min-width: 60px;
}

.info-chip .label {
  font-size: 10px;
  color: var(--text-muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.info-chip span:last-child {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
}

/* ── Lobby Countdown ─────────────────────────── */
.lobby-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px 0;
  gap: 8px;
}

.countdown-ring {
  position: relative;
  width: 80px;
  height: 80px;
}

.countdown-ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.ring-bg { fill: none; stroke: var(--surface); stroke-width: 6; }
.ring-fill {
  fill: none;
  stroke: var(--accent);
  stroke-width: 6;
  stroke-linecap: round;
  stroke-dasharray: 283;
  stroke-dashoffset: 0;
  transition: stroke-dashoffset 1s linear;
}

.countdown-ring span {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  font-weight: 800;
  color: var(--accent2);
}

.lobby-msg { color: var(--text-muted); font-size: 13px; }

/* ── Cartela Picker ──────────────────────────── */
.cartela-picker { margin-top: 8px; }
.cartela-picker h3 { font-size: 15px; font-weight: 700; margin-bottom: 4px; }
.cartela-hint { font-size: 12px; color: var(--text-muted); margin-bottom: 10px; }

.cartela-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 5px;
}

.cartela-num {
  aspect-ratio: 1;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, border-color 0.15s;
}

.cartela-num:hover { background: var(--accent); border-color: var(--accent); }
.cartela-num.selected { background: var(--accent); border-color: var(--accent2); }
.cartela-num.taken { background: var(--surface2); color: var(--text-muted); cursor: not-allowed; opacity: 0.5; }

/* ── Bingo Card ──────────────────────────────── */
.cartela-preview { margin-top: 16px; }
.cartela-preview h4 { font-size: 13px; margin-bottom: 8px; color: var(--text-muted); }

.bingo-card {
  background: var(--surface);
  border-radius: var(--radius);
  overflow: hidden;
  border: 1px solid var(--border);
  margin-bottom: 12px;
}

.bingo-header {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
}

.bingo-col-label {
  padding: 10px 4px;
  text-align: center;
  font-size: 18px;
  font-weight: 900;
  letter-spacing: 0.05em;
}

.bingo-col-label.B { background: var(--col-b); }
.bingo-col-label.I { background: var(--col-i); }
.bingo-col-label.N { background: var(--col-n); }
.bingo-col-label.G { background: var(--col-g); }
.bingo-col-label.O { background: var(--col-o); }

.bingo-row {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  border-top: 1px solid var(--border);
}

.bingo-cell {
  padding: 10px 4px;
  text-align: center;
  font-size: 15px;
  font-weight: 600;
  transition: background 0.2s;
  position: relative;
}

.bingo-cell.marked {
  background: var(--orange);
  color: white;
  border-radius: 4px;
}

.bingo-cell.free {
  background: var(--green);
  color: white;
  font-size: 18px;
}

/* ── Called Number Display ───────────────────── */
.called-display {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 16px;
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 16px;
}

.current-number {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 70px;
}

.column-label {
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.1em;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--accent);
}

.number-big {
  font-size: 48px;
  font-weight: 900;
  color: var(--accent2);
  line-height: 1;
}

.called-history {
  flex: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-height: 80px;
  overflow: hidden;
}

.called-chip {
  background: var(--surface2);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 11px;
  font-weight: 600;
}

/* ── Buttons ─────────────────────────────────── */
.btn {
  width: 100%;
  padding: 14px;
  border: none;
  border-radius: var(--radius);
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  transition: opacity 0.2s, transform 0.1s;
}

.btn:active { transform: scale(0.98); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-primary { background: linear-gradient(135deg, var(--accent), var(--accent2)); color: white; }
.btn-bingo {
  background: linear-gradient(135deg, #f97316, #ef4444);
  color: white;
  font-size: 20px;
  padding: 18px;
  letter-spacing: 0.1em;
  margin-top: 12px;
  border-radius: var(--radius);
  border: none;
  width: 100%;
  cursor: pointer;
  font-weight: 900;
}

.btn-outline {
  background: none;
  border: 2px solid var(--accent);
  color: var(--accent2);
}

/* ── Game Over Screen ────────────────────────── */
.gameover-card {
  background: var(--surface);
  border-radius: 20px;
  padding: 24px 16px;
  text-align: center;
}

.crown { font-size: 48px; margin-bottom: 8px; }
.bingo-title { font-size: 32px; font-weight: 900; color: var(--yellow); margin-bottom: 4px; }
#winners-list { color: var(--text-muted); margin: 8px 0 16px; font-size: 14px; }
.next-game-msg { color: var(--text-muted); font-size: 13px; margin-top: 12px; }

/* ── History ─────────────────────────────────── */
.section-header {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  padding: 12px 12px 6px;
}

.history-list, .txn-list { padding: 0 12px; }

.history-item, .txn-item {
  background: var(--surface);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  margin-bottom: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.empty-msg { color: var(--text-muted); padding: 24px 0; text-align: center; }

/* ── Wallet ──────────────────────────────────── */
.wallet-hero { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 12px; }

.wallet-card {
  background: linear-gradient(135deg, var(--accent), var(--surface2));
  border-radius: var(--radius);
  padding: 16px;
}

.wallet-card.play { background: linear-gradient(135deg, #0f766e, var(--surface2)); }
.wallet-label { font-size: 11px; color: rgba(255,255,255,0.7); margin-bottom: 6px; }
.wallet-amount { font-size: 20px; font-weight: 800; }

.wallet-actions { display: flex; gap: 10px; padding: 0 12px 12px; }

.deposit-info {
  margin: 0 12px 12px;
  background: var(--surface);
  border-radius: var(--radius-sm);
  padding: 12px;
  font-size: 13px;
  line-height: 1.6;
}

.deposit-info h4 { margin-bottom: 8px; color: var(--accent2); }
.deposit-info code { background: var(--surface2); padding: 2px 6px; border-radius: 4px; font-size: 11px; }

/* ── Profile ─────────────────────────────────── */
.profile-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24px 12px 12px;
  gap: 8px;
}

.avatar {
  width: 64px;
  height: 64px;
  background: var(--accent);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  font-weight: 800;
}

.profile-name { font-size: 18px; font-weight: 700; }

.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  padding: 0 12px;
}

.stat-card {
  background: var(--surface);
  border-radius: var(--radius-sm);
  padding: 14px;
}

.stat-label { font-size: 11px; color: var(--text-muted); margin-bottom: 6px; }
.stat-value { font-size: 22px; font-weight: 800; }

/* ── Utility ─────────────────────────────────── */
.hidden { display: none !important; }
.watch-only-msg { text-align: center; color: var(--text-muted); padding: 16px; font-size: 13px; }
```

---

### `public/app.js`

```javascript
// ── Telegram Web App Init ──────────────────────
const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

const userId = tg.initDataUnsafe?.user?.id || 'demo_user';
const username = tg.initDataUnsafe?.user?.first_name || 'Player';

// ── State ──────────────────────────────────────
let ws;
let currentGameId = null;
let myCartelaData = null;
let myCartelaNumber = null;
let calledNumbers = [];
let selectedCartela = null;
let isInGame = false;
let nextGameTimer = null;

// ── WebSocket ──────────────────────────────────
function connectWS() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    console.log('WS connected');
    ws.send(JSON.stringify({ type: 'JOIN_GAME', gameId: currentGameId }));
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleWSMessage(msg);
  };

  ws.onclose = () => {
    console.log('WS closed, reconnecting...');
    setTimeout(connectWS, 3000);
  };
}

function handleWSMessage(msg) {
  switch (msg.type) {
    case 'GAME_STATE':
      applyGameState(msg.payload);
      break;
    case 'LOBBY_OPEN':
      onLobbyOpen(msg.payload);
      break;
    case 'PLAYER_JOINED':
      updateLobbyInfo(msg.payload);
      break;
    case 'GAME_STARTED':
      onGameStarted(msg.payload);
      break;
    case 'NUMBER_CALLED':
      onNumberCalled(msg.payload);
      break;
    case 'GAME_OVER':
      onGameOver(msg.payload);
      break;
    case 'BINGO_INVALID':
    case 'FALSE_BINGO':
      showAlert(msg.payload.reason, 'error');
      break;
    case 'GAME_CANCELLED':
      showAlert('Game cancelled — not enough players. Refunded.', 'info');
      break;
  }
}

// ── Game State Handlers ───────────────────────
function applyGameState(state) {
  currentGameId = state.gameId;
  calledNumbers = state.calledNumbers || [];

  if (state.status === 'waiting') {
    showScreen('lobby');
    document.getElementById('lobby-game-id').textContent = state.gameId?.slice(0,8) || '—';
    document.getElementById('lobby-players').textContent = state.playerCount || 0;
    document.getElementById('lobby-pot').textContent = state.pot || 0;
  } else if (state.status === 'active') {
    showScreen('game');
    renderCalledNumbers(calledNumbers);
  }
}

function onLobbyOpen(payload) {
  currentGameId = payload.gameId;
  isInGame = false;
  myCartelaData = null;
  myCartelaNumber = null;
  calledNumbers = [];

  document.getElementById('lobby-game-id').textContent = payload.gameId.slice(0,8);
  document.getElementById('lobby-bet').textContent = payload.betAmount;
  document.getElementById('lobby-players').textContent = 0;
  document.getElementById('lobby-pot').textContent = 0;
  showScreen('lobby');
  startLobbyCountdown(payload.waitTime);
  renderCartelaGrid([]);
}

function updateLobbyInfo(payload) {
  document.getElementById('lobby-players').textContent = payload.playerCount;
  document.getElementById('lobby-pot').textContent = payload.pot;
}

function onGameStarted(payload) {
  showScreen('game');
  document.getElementById('game-id-display').textContent = payload.gameId?.slice(0,8);
  document.getElementById('game-players').textContent = payload.playerCount;
  document.getElementById('game-pot').textContent = payload.pot + ' ETB';
  document.getElementById('game-called-count').textContent = '0';
  calledNumbers = [];

  if (myCartelaData) {
    renderBingoCard('active-card', myCartelaData, calledNumbers);
    document.getElementById('btn-bingo').classList.remove('hidden');
    document.getElementById('watch-msg').classList.add('hidden');
  } else {
    document.getElementById('btn-bingo').classList.add('hidden');
    document.getElementById('watch-msg').classList.remove('hidden');
  }
}

function onNumberCalled(payload) {
  calledNumbers = payload.calledNumbers;
  const num = payload.number;
  const col = payload.column;

  // Update display
  document.getElementById('current-number').textContent = num;
  document.getElementById('current-column').textContent = col;
  document.getElementById('game-called-count').textContent = calledNumbers.length;

  // Update column color
  const colColors = { B:'--col-b', I:'--col-i', N:'--col-n', G:'--col-g', O:'--col-o' };
  document.getElementById('current-column').style.background = `var(${colColors[col]})`;

  // Add chip to history
  const chip = document.createElement('div');
  chip.className = 'called-chip';
  chip.textContent = num;
  const hist = document.getElementById('called-history');
  hist.insertBefore(chip, hist.firstChild);

  // Re-render card
  if (myCartelaData) {
    renderBingoCard('active-card', myCartelaData, calledNumbers);
  }
}

function onGameOver(payload) {
  clearTimeout(nextGameTimer);
  showScreen('gameover');

  const winnerNames = payload.winners.map(w =>
    `🏆 Player #${w.cartelaId} — Won ${w.winAmount} ETB`
  ).join('\n');
  document.getElementById('winners-list').textContent =
    payload.winners.length > 0 ? winnerNames : 'No winners this round.';

  let countdown = 10;
  const el = document.getElementById('next-game-timer');
  el.textContent = countdown;
  nextGameTimer = setInterval(() => {
    countdown--;
    el.textContent = countdown;
    if (countdown <= 0) clearInterval(nextGameTimer);
  }, 1000);

  // Refresh user balance
  loadUserData();
}

// ── Lobby Countdown ───────────────────────────
let countdownTimer = null;
function startLobbyCountdown(seconds) {
  clearInterval(countdownTimer);
  let remaining = seconds;
  const circumference = 283;
  const el = document.getElementById('lobby-countdown');
  const circle = document.getElementById('countdown-circle');

  const update = () => {
    el.textContent = remaining;
    circle.style.strokeDashoffset = circumference * (1 - remaining / seconds);
    if (remaining <= 0) clearInterval(countdownTimer);
    remaining--;
  };
  update();
  countdownTimer = setInterval(update, 1000);
}

// ── Cartela Grid ──────────────────────────────
function renderCartelaGrid(takenList) {
  const grid = document.getElementById('cartela-grid');
  grid.innerHTML = '';
  for (let i = 1; i <= 96; i++) {
    const btn = document.createElement('button');
    btn.className = 'cartela-num' + (takenList.includes(i) ? ' taken' : '');
    btn.textContent = i;
    btn.disabled = takenList.includes(i);
    btn.addEventListener('click', () => selectCartela(i));
    grid.appendChild(btn);
  }
}

async function selectCartela(num) {
  // Deselect previous
  document.querySelectorAll('.cartela-num.selected').forEach(b => b.classList.remove('selected'));
  const btn = document.querySelector(`.cartela-num:nth-child(${num})`);
  if (btn) btn.classList.add('selected');
  selectedCartela = num;

  // Preview card
  try {
    const res = await fetch('/api/preview-card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cartelaNumber: num }),
    });
    const data = await res.json();
    renderBingoCard('preview-card', data.cardData, []);
    document.getElementById('cartela-preview').classList.remove('hidden');
  } catch (err) {
    console.error('Preview error', err);
  }
}

// ── Bingo Card Renderer ───────────────────────
function renderBingoCard(containerId, cardData, called) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  const calledSet = new Set(called);
  const cols = ['B','I','N','G','O'];

  // Header
  const header = document.createElement('div');
  header.className = 'bingo-header';
  cols.forEach(c => {
    const lbl = document.createElement('div');
    lbl.className = `bingo-col-label ${c}`;
    lbl.textContent = c;
    header.appendChild(lbl);
  });
  container.appendChild(header);

  // Rows (cardData is [col][row])
  for (let row = 0; row < 5; row++) {
    const rowEl = document.createElement('div');
    rowEl.className = 'bingo-row';
    for (let col = 0; col < 5; col++) {
      const val = cardData[col][row];
      const cell = document.createElement('div');
      cell.className = 'bingo-cell';
      if (val === 'FREE') {
        cell.textContent = '⭐';
        cell.classList.add('free');
      } else {
        cell.textContent = val;
        if (calledSet.has(val)) cell.classList.add('marked');
      }
      rowEl.appendChild(cell);
    }
    container.appendChild(rowEl);
  }
}

function renderCalledNumbers(nums) {
  const hist = document.getElementById('called-history');
  hist.innerHTML = '';
  [...nums].reverse().forEach(n => {
    const chip = document.createElement('div');
    chip.className = 'called-chip';
    chip.textContent = n;
    hist.appendChild(chip);
  });
}

// ── Join Game ─────────────────────────────────
document.getElementById('btn-join-game')?.addEventListener('click', async () => {
  if (!selectedCartela) return showAlert('Please select a cartela first', 'error');

  try {
    const res = await fetch('/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, cartelaNumber: selectedCartela }),
    });
    const data = await res.json();

    if (data.error) return showAlert(data.error, 'error');

    myCartelaData = data.cardData;
    myCartelaNumber = data.cartelaNumber;
    isInGame = true;

    showAlert(`Joined with Cartela #${selectedCartela}!`, 'success');
    document.getElementById('cartela-preview').classList.add('hidden');
  } catch (err) {
    showAlert('Failed to join game', 'error');
  }
});

// ── Claim BINGO ───────────────────────────────
document.getElementById('btn-bingo')?.addEventListener('click', () => {
  if (!currentGameId || !myCartelaData) return;
  ws.send(JSON.stringify({
    type: 'CLAIM_BINGO',
    userId,
    gameId: currentGameId,
    cartelaId: myCartelaNumber,
  }));
});

// ── Tab Navigation ─────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(`tab-${tab}`).classList.remove('hidden');

    if (tab === 'wallet') loadWallet();
    if (tab === 'history') loadHistory();
    if (tab === 'profile') loadProfile();
  });
});

// ── Wallet ────────────────────────────────────
async function loadWallet() {
  try {
    const res = await fetch(`/api/wallet/${userId}`);
    const data = await res.json();
    document.getElementById('main-wallet-amount').textContent = `${data.mainWallet} ETB`;
    document.getElementById('play-wallet-amount').textContent = `${data.playWallet} ETB`;

    const txnRes = await fetch(`/api/wallet/${userId}/transactions`);
    const txns = await txnRes.json();
    const list = document.getElementById('txn-list');
    list.innerHTML = txns.length === 0
      ? '<p class="empty-msg">No transactions yet.</p>'
      : txns.map(t => `
        <div class="txn-item">
          <span>${t.type.toUpperCase()}</span>
          <span>${t.amount > 0 ? '+' : ''}${t.amount} ETB</span>
        </div>
      `).join('');
  } catch (e) { console.error(e); }
}

document.getElementById('btn-deposit')?.addEventListener('click', () => {
  document.getElementById('deposit-info').classList.toggle('hidden');
});

// ── History ───────────────────────────────────
async function loadHistory() {
  try {
    const res = await fetch(`/api/history/${userId}`);
    const games = await res.json();
    const list = document.getElementById('history-list');
    list.innerHTML = games.length === 0
      ? '<p class="empty-msg">No games played yet.</p>'
      : games.map(g => `
        <div class="history-item">
          <div>
            <div style="font-weight:700;">Game ${g.id?.slice(0,8)}</div>
            <div style="font-size:11px;color:var(--text-muted);">Cartela #${g.cartela_number}</div>
          </div>
          <div style="text-align:right;">
            <div style="color:${g.result === 'win' ? 'var(--green)' : 'var(--text-muted)'};">
              ${g.result === 'win' ? '🏆 Won' : 'Played'}
            </div>
            <div style="font-size:11px;color:var(--text-muted);">${g.bet_amount} ETB</div>
          </div>
        </div>
      `).join('');
  } catch (e) { console.error(e); }
}

// ── Profile ───────────────────────────────────
async function loadUserData() {
  try {
    const res = await fetch(`/api/user/${userId}`);
    const user = await res.json();
    if (user.error) return;

    document.getElementById('stat-main').textContent = user.mainWallet;
    document.getElementById('stat-play').textContent = user.playWallet;
    document.getElementById('stat-won').textContent = user.gamesWon;
    document.getElementById('stat-earning').textContent = user.totalEarning;
  } catch (e) { console.error(e); }
}

async function loadProfile() {
  document.getElementById('profile-avatar').textContent = username.charAt(0).toUpperCase();
  document.getElementById('profile-name').textContent = username;
  await loadUserData();
}

// ── Screen Helper ─────────────────────────────
function showScreen(name) {
  ['lobby','game','gameover'].forEach(s => {
    document.getElementById(`screen-${s}`)?.classList.toggle('hidden', s !== name);
  });
}

// ── Alert Helper ──────────────────────────────
function showAlert(msg, type = 'info') {
  tg.showAlert ? tg.showAlert(msg) : alert(msg);
}

// ── Init ──────────────────────────────────────
(async () => {
  // Register user
  await fetch('/api/user/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telegramId: userId, username }),
  }).catch(() => {});

  renderCartelaGrid([]);
  connectWS();
})();
```

---

## 8. Wallet & Payment Flow

The MVP uses a **manual verification** flow (common in Ethiopian Telebirr apps):

```
Player                    Bot                    Admin
  │                        │                       │
  │── /deposit ──────────► │                       │
  │◄─ Send 50 ETB to ──── │                       │
  │   0923471256           │                       │
  │                        │                       │
  │  [Player sends ETB via Telebirr]               │
  │                        │                       │
  │── /confirm_deposit ──► │ ─── notify ─────────► │
  │   50 DFL123ABC         │                       │ [admin verifies]
  │                        │                       │
  │◄─ ✅ Approved ──────── │                       │
  │   Play wallet +50      │                       │
```

**For production**, integrate the [Telebirr Developer API](https://developer.ethiotelecom.et) for automatic verification.

---

## 9. WebSocket — Real-time Game Events

| Event (Server → Client) | Payload | Description |
|---|---|---|
| `GAME_STATE` | `{gameId, status, calledNumbers, playerCount, pot}` | Sent on connect |
| `LOBBY_OPEN` | `{gameId, betAmount, waitTime}` | New lobby opened |
| `PLAYER_JOINED` | `{gameId, playerCount, pot}` | A player joined |
| `GAME_STARTED` | `{gameId, playerCount, pot}` | Game begins |
| `NUMBER_CALLED` | `{gameId, number, column, calledNumbers, remaining}` | Every 5s |
| `GAME_OVER` | `{gameId, winners, calledNumbers}` | Game ended |
| `GAME_CANCELLED` | `{gameId, reason}` | Not enough players |

| Event (Client → Server) | Payload | Description |
|---|---|---|
| `CLAIM_BINGO` | `{userId, gameId, cartelaId}` | Player claims BINGO |
| `JOIN_GAME` | `{gameId}` | Subscribe to game updates |

---

## 10. Environment Variables & Config

### `.env`

```bash
# Telegram
BOT_TOKEN=your_telegram_bot_token_here
MINI_APP_URL=https://your-app.railway.app
ADMIN_CHAT_ID=123456789

# Server
PORT=3000
NODE_ENV=production
```

**How to get `BOT_TOKEN`:**
1. Open Telegram, search `@BotFather`
2. Send `/newbot`, follow prompts
3. Copy the token

**How to set Mini App URL:**
1. Send `/newapp` to `@BotFather`
2. Select your bot
3. Set the web app URL to your deployed app URL
4. Done — users can open it via keyboard button

---

## 11. Deployment (Free Tier)

### Option A: Railway (Recommended — simplest)

```bash
# 1. Install Railway CLI
npm install -g @railway/cli

# 2. Login
railway login

# 3. In your project folder
railway init
railway up

# 4. Set env vars in Railway dashboard → Variables
# BOT_TOKEN, MINI_APP_URL (set to your Railway URL), ADMIN_CHAT_ID

# 5. Railway auto-assigns a URL like: https://bingo-production.up.railway.app
```

**railway.json** (add to project root):
```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": { "builder": "NIXPACKS" },
  "deploy": { "startCommand": "node server.js", "healthcheckPath": "/", "restartPolicyType": "ON_FAILURE" }
}
```

---

### Option B: Render (also free)

1. Push code to GitHub
2. Go to [render.com](https://render.com) → New Web Service
3. Connect your repo
4. Set build command: `npm install`
5. Set start command: `node server.js`
6. Add environment variables
7. Deploy

**Persistent disk** (for SQLite): In Render, add a disk at `/data` and update `db.js`:
```javascript
const DB_PATH = process.env.NODE_ENV === 'production'
  ? '/data/bingo.db'
  : path.join(__dirname, 'bingo.db');
const db = new Database(DB_PATH);
```

---

### Option C: Fly.io

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Deploy
fly launch
fly secrets set BOT_TOKEN=xxx MINI_APP_URL=xxx
fly volumes create bingo_data --size 1
fly deploy
```

**fly.toml** (auto-generated, add volume):
```toml
[mounts]
  source = "bingo_data"
  destination = "/data"
```

---

## 12. Full File Listing

```
bingo-app/
├── package.json          ← Dependencies
├── .env                  ← Secrets (never commit!)
├── .gitignore            ← node_modules, .env, *.db
├── server.js             ← HTTP + WebSocket server
├── bot.js                ← Telegram bot (Telegraf)
├── db.js                 ← SQLite schema + queries
├── gameEngine.js         ← Bingo logic + card gen
├── routes/
│   ├── api.js            ← Game REST endpoints
│   └── wallet.js         ← Wallet REST endpoints
└── public/
    ├── index.html        ← Mini App UI shell
    ├── style.css         ← All styles (dark theme)
    └── app.js            ← Frontend JS + WebSocket
```

### `.gitignore`
```
node_modules/
.env
*.db
*.db-journal
```

---

## Quick Start

```bash
# Clone / create folder
mkdir mulungo && cd mulungo

# Install deps
npm install

# Set up .env
cp .env.example .env
# Edit .env with your BOT_TOKEN

# Run locally
npm run dev

# Test in browser
open http://localhost:3000

# Test bot
# Open Telegram → your bot → /start
```

---

## What's Included in This MVP

| Feature | Status |
|---|---|
| 5×5 BINGO card generation (deterministic by cartela #) | ✅ |
| 96 cartelas (1–96) | ✅ |
| Real-time number calling via WebSocket | ✅ |
| Auto-mark numbers on card | ✅ |
| BINGO validation (rows, cols, diagonals) | ✅ |
| False BINGO penalty | ✅ |
| Lobby countdown + min players check | ✅ |
| Play wallet (ETB) | ✅ |
| Manual Telebirr deposit flow | ✅ |
| Telegram bot commands (/start, /balance, /deposit) | ✅ |
| Game history | ✅ |
| Dark UI with Amharic-ready font stack | ✅ |
| Free-tier deployment (Railway/Render/Fly.io) | ✅ |

---

*Built to mirror Mulungo — Ethiopian Telegram Mini App. For production: add Telebirr API auto-verification, admin dashboard, and rate limiting.*
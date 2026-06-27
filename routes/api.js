const express = require('express');
const router = express.Router();
const {
  getOrCreateUser, getUser, getGameHistory, isUserRegistered, getUserByAuthToken,
  getTakenCartelas,
} = require('../db');
const { generateCard } = require('../gameEngine');
const { resolveTelegramId } = require('../telegramAuth');

function userPayload(user) {
  const id = String(user.telegram_id);
  return {
    id,
    username: user.username,
    mainWallet: user.main_wallet,
    playWallet: user.play_wallet,
    gamesWon: user.games_won,
    totalEarning: user.total_earning,
    isRegistered: isUserRegistered(id),
    phoneNumber: user.phone_number || null,
  };
}

router.post('/join', (req, res) => {
  const { userId, cartelaNumber } = req.body;
  console.log(`[JOIN] userId=${userId} cartela=${cartelaNumber}`);

  if (!userId || !cartelaNumber) {
    console.log('[JOIN] Missing fields');
    return res.status(400).json({ error: 'userId and cartelaNumber required' });
  }

  const registered = isUserRegistered(userId);
  console.log(`[JOIN] isRegistered=${registered}`);
  if (!registered) {
    return res.status(403).json({ error: 'Phone registration required before playing' });
  }

  const engine = req.app.locals.engine;
  const result = engine.joinGame(String(userId), parseInt(cartelaNumber));
  console.log(`[JOIN] result=${JSON.stringify(result)}`);

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  res.json(result);
});

router.get('/state', (req, res) => {
  const engine = req.app.locals.engine;
  res.json(engine.getCurrentState());
});

router.get('/lobby', (req, res) => {
  const engine = req.app.locals.engine;
  const state = engine.getCurrentState();
  const takenCartelas = state.gameId ? getTakenCartelas(state.gameId) : [];
  res.json({ ...state, takenCartelas });
});

router.post('/auth/token', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });

  const user = getUserByAuthToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid or expired token. Open the game from the bot again.' });

  res.json(userPayload(user));
});

router.post('/user/register', (req, res) => {
  const { username, firstName } = req.body;
  const headerInitData = req.headers['x-telegram-init-data'];
  const initData = req.body.initData || headerInitData;

  const telegramId = resolveTelegramId({
    telegramId: req.body.telegramId,
    initData,
    botToken: process.env.BOT_TOKEN,
  });

  if (!telegramId) {
    return res.status(400).json({ error: 'Could not identify Telegram user. Open from the bot.' });
  }

  const user = getOrCreateUser({
    telegramId,
    username,
    firstName: firstName || username,
  });

  res.json(userPayload(user));
});

router.get('/user/:telegramId', (req, res) => {
  const user = getUser(String(req.params.telegramId));
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(userPayload(user));
});

router.get('/history/:userId', (req, res) => {
  const history = getGameHistory(req.params.userId);
  res.json(history);
});

router.post('/preview-card', (req, res) => {
  const { cartelaNumber } = req.body;
  if (!cartelaNumber || cartelaNumber < 1 || cartelaNumber > 96) {
    return res.status(400).json({ error: 'cartelaNumber must be 1-96' });
  }
  const cardData = generateCard(parseInt(cartelaNumber));
  res.json({ cartelaNumber, cardData });
});

module.exports = router;

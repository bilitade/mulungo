const express = require('express');
const router = express.Router();
const {
  getOrCreateUser, getUser, getGameHistory, isUserRegistered, getUserByAuthToken,
  getTakenCartelas,
} = require('../db');
const { generateCard } = require('../gameEngine');
const { resolveTelegramId } = require('../telegramAuth');

async function userPayload(user) {
  const id = String(user.telegram_id);
  return {
    id,
    username: user.username,
    mainWallet: user.main_wallet,
    playWallet: user.play_wallet,
    gamesWon: user.games_won,
    totalEarning: user.total_earning,
    isRegistered: await isUserRegistered(id),
    phoneNumber: user.phone_number || null,
  };
}

router.post('/join', async (req, res) => {
  try {
    const { userId, cartelaNumber } = req.body;
    if (!userId || !cartelaNumber) return res.status(400).json({ error: 'userId and cartelaNumber required' });
    const num = parseInt(cartelaNumber, 10);
    if (isNaN(num) || num < 1 || num > 96) return res.status(400).json({ error: 'cartelaNumber must be 1–96' });
    if (!(await isUserRegistered(userId))) return res.status(403).json({ error: 'Phone registration required before playing' });
    const engine = req.app.locals.engine;
    const result = await engine.joinGame(String(userId), num);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (e) {
    console.error('POST /join error:', e.message);
    res.status(500).json({ error: 'Failed to join game' });
  }
});

router.get('/state', (req, res) => {
  try {
    const engine = req.app.locals.engine;
    res.json(engine.getCurrentState());
  } catch (e) {
    console.error('GET /state error:', e.message);
    res.status(500).json({ error: 'Failed to get state' });
  }
});

router.get('/lobby', async (req, res) => {
  try {
    const engine = req.app.locals.engine;
    const state = engine.getCurrentState();
    const takenCartelas = state.gameId ? await getTakenCartelas(state.gameId) : [];
    res.json({ ...state, takenCartelas });
  } catch (e) {
    console.error('GET /lobby error:', e.message);
    res.status(500).json({ error: 'Failed to get lobby' });
  }
});

router.post('/auth/token', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    const user = await getUserByAuthToken(token);
    if (!user) return res.status(401).json({ error: 'Invalid or expired token. Open the game from the bot again.' });
    res.json(await userPayload(user));
  } catch (e) {
    console.error('POST /auth/token error:', e.message);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

router.post('/user/register', async (req, res) => {
  try {
    const { username, firstName } = req.body;
    const headerInitData = req.headers['x-telegram-init-data'];
    const initData = req.body.initData || headerInitData;
    const telegramId = resolveTelegramId({ telegramId: req.body.telegramId, initData, botToken: process.env.BOT_TOKEN });
    if (!telegramId) return res.status(400).json({ error: 'Could not identify Telegram user. Open from the bot.' });
    const user = await getOrCreateUser({ telegramId, username, firstName: firstName || username });
    res.json(await userPayload(user));
  } catch (e) {
    console.error('POST /user/register error:', e.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.get('/user/:telegramId', async (req, res) => {
  try {
    const user = await getUser(String(req.params.telegramId));
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(await userPayload(user));
  } catch (e) {
    console.error('GET /user/:telegramId error:', e.message);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

router.get('/history/:userId', async (req, res) => {
  try {
    const history = await getGameHistory(req.params.userId);
    res.json(history);
  } catch (e) {
    console.error('GET /history/:userId error:', e.message);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
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

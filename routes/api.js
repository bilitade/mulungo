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
  const { userId, cartelaNumber } = req.body;
  if (!userId || !cartelaNumber) return res.status(400).json({ error: 'userId and cartelaNumber required' });
  const num = parseInt(cartelaNumber, 10);
  if (isNaN(num) || num < 1 || num > 96) return res.status(400).json({ error: 'cartelaNumber must be 1–96' });
  if (!(await isUserRegistered(userId))) return res.status(403).json({ error: 'Phone registration required before playing' });
  const engine = req.app.locals.engine;
  const result = await engine.joinGame(String(userId), num);
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json(result);
});

router.get('/state', async (req, res) => {
  const engine = req.app.locals.engine;
  res.json(engine.getCurrentState());
});

router.get('/lobby', async (req, res) => {
  const engine = req.app.locals.engine;
  const state = engine.getCurrentState();
  const takenCartelas = state.gameId ? await getTakenCartelas(state.gameId) : [];
  res.json({ ...state, takenCartelas });
});

router.post('/auth/token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });
  const user = await getUserByAuthToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid or expired token. Open the game from the bot again.' });
  res.json(await userPayload(user));
});

router.post('/user/register', async (req, res) => {
  const { username, firstName } = req.body;
  const headerInitData = req.headers['x-telegram-init-data'];
  const initData = req.body.initData || headerInitData;
  const telegramId = resolveTelegramId({ telegramId: req.body.telegramId, initData, botToken: process.env.BOT_TOKEN });
  if (!telegramId) return res.status(400).json({ error: 'Could not identify Telegram user. Open from the bot.' });
  const user = await getOrCreateUser({ telegramId, username, firstName: firstName || username });
  res.json(await userPayload(user));
});

router.get('/user/:telegramId', async (req, res) => {
  const user = await getUser(String(req.params.telegramId));
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(await userPayload(user));
});

router.get('/history/:userId', async (req, res) => {
  const history = await getGameHistory(req.params.userId);
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

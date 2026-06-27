const express = require('express');
const router = express.Router();
const { getUser, db } = require('../db');

router.get('/:userId', (req, res) => {
  const user = getUser(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    mainWallet: user.main_wallet,
    playWallet: user.play_wallet,
  });
});

router.get('/:userId/transactions', (req, res) => {
  const txns = db.prepare(
    'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 30'
  ).all(req.params.userId);
  res.json(txns);
});

module.exports = router;

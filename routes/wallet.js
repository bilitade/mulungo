const express = require('express');
const router = express.Router();
const { getUser, query } = require('../db');

router.get('/:userId', async (req, res) => {
  const user = await getUser(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ mainWallet: user.main_wallet, playWallet: user.play_wallet });
});

router.get('/:userId/transactions', async (req, res) => {
  const result = await query(
    'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30',
    [req.params.userId]
  );
  res.json(result.rows);
});

module.exports = router;

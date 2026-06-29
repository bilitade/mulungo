const express = require('express');
const router = express.Router();
const path = require('path');
const {
  listUsers, getUser, adminAddCredits,
  listDeposits, getDepositByRef, approveDeposit, rejectDeposit,
  getGameHistory, db,
} = require('../db');

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) return res.status(503).json({ error: 'ADMIN_TOKEN not configured' });
  if (!token || token !== adminToken) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Serve admin HTML (public — login handled client-side with token)
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// All API routes below require the admin token
router.use('/api', requireAdmin);

// ── Users ──────────────────────────────────────────────────

router.get('/api/users', (req, res) => {
  const { search, limit = 50, offset = 0 } = req.query;
  const users = listUsers({ search, limit: parseInt(limit), offset: parseInt(offset) });
  res.json(users);
});

router.get('/api/users/:id', (req, res) => {
  const user = getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const history = getGameHistory(req.params.id);
  const txns = db.prepare(
    'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 30'
  ).all(String(req.params.id));
  res.json({ ...user, history, transactions: txns });
});

router.post('/api/users/:id/credits', (req, res) => {
  const { amount, note } = req.body;
  if (!amount || isNaN(amount) || amount <= 0 || amount > 100000) {
    return res.status(400).json({ error: 'Invalid amount (1–100000)' });
  }
  const result = adminAddCredits(req.params.id, parseFloat(amount), note || 'admin');
  if (!result.success) return res.status(404).json({ error: result.error });
  res.json({ success: true, newBalance: result.newBalance });
});

// ── Deposits ───────────────────────────────────────────────

router.get('/api/deposits', (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query;
  const deposits = listDeposits({ status: status || undefined, limit: parseInt(limit), offset: parseInt(offset) });
  res.json(deposits);
});

router.post('/api/deposits/:ref/approve', (req, res) => {
  const result = approveDeposit(req.params.ref);
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json(result);
});

router.post('/api/deposits/:ref/reject', (req, res) => {
  const { reason } = req.body;
  const result = rejectDeposit(req.params.ref, reason);
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json(result);
});

// ── Stats ──────────────────────────────────────────────────

router.get('/api/stats', requireAdmin, (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const registeredUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE is_registered = 1").get().c;
  const totalGames = db.prepare('SELECT COUNT(*) as c FROM games').get().c;
  const activeGames = db.prepare("SELECT COUNT(*) as c FROM games WHERE status = 'active'").get().c;
  const pendingDeposits = db.prepare("SELECT COUNT(*) as c FROM deposits WHERE status = 'pending'").get().c;
  const totalDeposited = db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM deposits WHERE status = 'approved'").get().s;
  const totalWagered = db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM transactions WHERE type = 'bet'").get().s;
  const totalPaidOut = db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM transactions WHERE type = 'win'").get().s;
  res.json({ totalUsers, registeredUsers, totalGames, activeGames, pendingDeposits, totalDeposited, totalWagered, totalPaidOut });
});

module.exports = router;

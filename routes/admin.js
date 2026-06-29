const express = require('express');
const router = express.Router();
const path = require('path');
const {
  listUsers, getUser, adminAddCredits,
  listDeposits, getDepositByRef, approveDeposit, rejectDeposit,
  getGameHistory, query,
} = require('../db');

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) return res.status(503).json({ error: 'ADMIN_TOKEN not configured' });
  if (!token || token !== adminToken) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

router.use('/api', requireAdmin);

router.get('/api/users', async (req, res) => {
  try {
    const { search, limit = 50, offset = 0 } = req.query;
    const users = await listUsers({ search, limit: parseInt(limit), offset: parseInt(offset) });
    res.json(users);
  } catch (e) {
    console.error('GET /api/users error:', e.message);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

router.get('/api/users/:id', async (req, res) => {
  try {
    const user = await getUser(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const history = await getGameHistory(req.params.id);
    const txns = await query(
      'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30',
      [String(req.params.id)]
    );
    res.json({ ...user, history, transactions: txns.rows });
  } catch (e) {
    console.error('GET /api/users/:id error:', e.message);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

router.post('/api/users/:id/credits', async (req, res) => {
  try {
    const { amount, note } = req.body;
    if (!amount || isNaN(amount) || amount <= 0 || amount > 100000) {
      return res.status(400).json({ error: 'Invalid amount (1–100000)' });
    }
    const result = await adminAddCredits(req.params.id, parseFloat(amount), note || 'admin');
    if (!result.success) return res.status(404).json({ error: result.error });
    res.json({ success: true, newBalance: result.newBalance });
  } catch (e) {
    console.error('POST /api/users/:id/credits error:', e.message);
    res.status(500).json({ error: 'Failed to add credits' });
  }
});

router.get('/api/deposits', async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const deposits = await listDeposits({ status: status || undefined, limit: parseInt(limit), offset: parseInt(offset) });
    res.json(deposits);
  } catch (e) {
    console.error('GET /api/deposits error:', e.message);
    res.status(500).json({ error: 'Failed to fetch deposits' });
  }
});

router.post('/api/deposits/:ref/approve', async (req, res) => {
  try {
    const result = await approveDeposit(req.params.ref);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (e) {
    console.error('POST /api/deposits/:ref/approve error:', e.message);
    res.status(500).json({ error: 'Failed to approve deposit' });
  }
});

router.post('/api/deposits/:ref/reject', async (req, res) => {
  try {
    const { reason } = req.body;
    const result = await rejectDeposit(req.params.ref, reason);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (e) {
    console.error('POST /api/deposits/:ref/reject error:', e.message);
    res.status(500).json({ error: 'Failed to reject deposit' });
  }
});

router.get('/api/stats', async (req, res) => {
  try {
    const [totalUsers, registeredUsers, totalGames, activeGames, pendingDeposits, totalDeposited, totalWagered, totalPaidOut] =
      await Promise.all([
        query('SELECT COUNT(*) as c FROM users').then(r => parseInt(r.rows[0].c)),
        query("SELECT COUNT(*) as c FROM users WHERE is_registered = 1").then(r => parseInt(r.rows[0].c)),
        query('SELECT COUNT(*) as c FROM games').then(r => parseInt(r.rows[0].c)),
        query("SELECT COUNT(*) as c FROM games WHERE status = 'active'").then(r => parseInt(r.rows[0].c)),
        query("SELECT COUNT(*) as c FROM deposits WHERE status = 'pending'").then(r => parseInt(r.rows[0].c)),
        query("SELECT COALESCE(SUM(amount),0) as s FROM deposits WHERE status = 'approved'").then(r => parseFloat(r.rows[0].s)),
        query("SELECT COALESCE(SUM(amount),0) as s FROM transactions WHERE type = 'bet'").then(r => parseFloat(r.rows[0].s)),
        query("SELECT COALESCE(SUM(amount),0) as s FROM transactions WHERE type = 'win'").then(r => parseFloat(r.rows[0].s)),
      ]);
    res.json({ totalUsers, registeredUsers, totalGames, activeGames, pendingDeposits, totalDeposited, totalWagered, totalPaidOut });
  } catch (e) {
    console.error('GET /api/stats error:', e.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;

const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      telegram_id TEXT UNIQUE NOT NULL,
      username TEXT,
      first_name TEXT,
      main_wallet NUMERIC DEFAULT 0,
      play_wallet NUMERIC DEFAULT 0,
      games_won INTEGER DEFAULT 0,
      total_earning NUMERIC DEFAULT 0,
      phone_number TEXT,
      is_registered INTEGER DEFAULT 0,
      registered_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      status TEXT DEFAULT 'waiting',
      bet_amount NUMERIC DEFAULT 10,
      player_count INTEGER DEFAULT 0,
      derash NUMERIC DEFAULT 0,
      called_numbers TEXT DEFAULT '[]',
      winner_ids TEXT DEFAULT '[]',
      started_at TIMESTAMP,
      finished_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cartelas (
      id SERIAL PRIMARY KEY,
      game_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      cartela_number INTEGER NOT NULL,
      card_data TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      UNIQUE (game_id, cartela_number)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      reference TEXT,
      game_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS deposits (
      id SERIAL PRIMARY KEY,
      ref_code TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      amount NUMERIC,
      receiver_phone TEXT,
      receiver_name TEXT,
      sender_phone TEXT,
      sender_name TEXT,
      receipt_url TEXT,
      raw_snippet TEXT,
      status TEXT DEFAULT 'pending',
      reject_reason TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      processed_at TIMESTAMP
    );
  `);
  // Clean up expired tokens
  await query(`DELETE FROM auth_tokens WHERE expires_at < NOW()`);
  console.log('✅ Database initialized (Neon PostgreSQL)');
}

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('251') && digits.length === 12) return `+${digits}`;
  if (digits.startsWith('0') && digits.length === 10) return `+251${digits.slice(1)}`;
  if (digits.length === 9 && /^9/.test(digits)) return `+251${digits}`;
  return null;
}

async function isUserRegistered(telegramId) {
  const user = await getUser(telegramId);
  return !!(user && user.is_registered && user.phone_number);
}

async function getOrCreateUser({ telegramId, username, firstName }) {
  const existing = await query('SELECT * FROM users WHERE telegram_id = $1', [String(telegramId)]);
  if (existing.rows[0]) return existing.rows[0];
  await query(
    'INSERT INTO users (telegram_id, username, first_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [String(telegramId), username || '', firstName || '']
  );
  const res = await query('SELECT * FROM users WHERE telegram_id = $1', [String(telegramId)]);
  return res.rows[0];
}

async function getUser(telegramId) {
  const res = await query('SELECT * FROM users WHERE telegram_id = $1', [String(telegramId)]);
  return res.rows[0] || null;
}

async function getBalance(telegramId) {
  const user = await getUser(telegramId);
  return user ? { main: user.main_wallet, play: user.play_wallet } : null;
}

async function addToPlayWallet(telegramId, amount, ref) {
  await query('UPDATE users SET play_wallet = play_wallet + $1 WHERE telegram_id = $2', [amount, String(telegramId)]);
  await query(
    'INSERT INTO transactions (user_id, type, amount, reference) VALUES ($1, $2, $3, $4)',
    [String(telegramId), 'deposit', amount, ref]
  );
}

async function deductPlayWallet(telegramId, amount) {
  const user = await getUser(telegramId);
  if (!user || parseFloat(user.play_wallet) < amount) return false;
  await query('UPDATE users SET play_wallet = play_wallet - $1 WHERE telegram_id = $2', [amount, String(telegramId)]);
  return true;
}

async function creditWinnings(telegramId, amount, gameId) {
  await query(
    'UPDATE users SET main_wallet = main_wallet + $1, games_won = games_won + 1, total_earning = total_earning + $1 WHERE telegram_id = $2',
    [amount, String(telegramId)]
  );
  await query(
    'INSERT INTO transactions (user_id, type, amount, game_id) VALUES ($1, $2, $3, $4)',
    [String(telegramId), 'win', amount, gameId]
  );
}

async function registerPhone(telegramId, phone, { username, firstName } = {}) {
  const normalized = normalizePhone(phone);
  if (!normalized) return { success: false, error: 'Invalid phone number. Use 09XXXXXXXX or +2519XXXXXXXX' };

  await getOrCreateUser({ telegramId, username, firstName });

  const existing = await query(
    'SELECT telegram_id FROM users WHERE phone_number = $1 AND telegram_id != $2 AND is_registered = 1',
    [normalized, String(telegramId)]
  );
  if (existing.rows[0]) return { success: false, error: 'This phone number is already registered' };

  await query(
    'UPDATE users SET phone_number = $1, is_registered = 1, registered_at = NOW() WHERE telegram_id = $2',
    [normalized, String(telegramId)]
  );

  const freshUser = await getUser(telegramId);
  const isFirstReg = freshUser && parseFloat(freshUser.play_wallet) === 0;
  if (isFirstReg) {
    await query('UPDATE users SET play_wallet = play_wallet + 50 WHERE telegram_id = $1', [String(telegramId)]);
    await query(
      'INSERT INTO transactions (user_id, type, amount, reference) VALUES ($1, $2, $3, $4)',
      [String(telegramId), 'bonus', 50, 'welcome_bonus']
    );
  }

  return { success: true, phoneNumber: normalized, welcomeBonus: isFirstReg ? 50 : 0 };
}

// ── Games ─────────────────────────────────────────────────

async function createGame(gameId, betAmount) {
  await query('INSERT INTO games (id, bet_amount, status) VALUES ($1, $2, $3)', [gameId, betAmount, 'waiting']);
}

async function getGame(gameId) {
  const res = await query('SELECT * FROM games WHERE id = $1', [gameId]);
  return res.rows[0] || null;
}

async function getWaitingGame() {
  const res = await query("SELECT * FROM games WHERE status = 'waiting' ORDER BY created_at DESC LIMIT 1");
  return res.rows[0] || null;
}

async function getActiveGame() {
  const res = await query("SELECT * FROM games WHERE status = 'active' ORDER BY started_at DESC LIMIT 1");
  return res.rows[0] || null;
}

async function getTakenCartelas(gameId) {
  const res = await query('SELECT cartela_number FROM cartelas WHERE game_id = $1', [gameId]);
  return res.rows.map(r => r.cartela_number);
}

async function updateGameNumbers(gameId, calledNumbers) {
  await query('UPDATE games SET called_numbers = $1 WHERE id = $2', [JSON.stringify(calledNumbers), gameId]);
}

async function startGame(gameId) {
  await query("UPDATE games SET status = 'active', started_at = NOW() WHERE id = $1", [gameId]);
}

async function finishGame(gameId, winnerIds) {
  await query(
    "UPDATE games SET status = 'finished', winner_ids = $1, finished_at = NOW() WHERE id = $2",
    [JSON.stringify(winnerIds), gameId]
  );
}

async function addPlayerToGame(gameId, userId, cartelaNumber, cardData, betAmount) {
  const user = await getUser(userId);
  if (!user || parseFloat(user.play_wallet) < betAmount) {
    return {
      success: false,
      error: `Insufficient play wallet balance. You need ${betAmount} ETB. Current balance: ${user ? user.play_wallet : 0} ETB.`,
    };
  }

  const res = await query(
    'INSERT INTO cartelas (game_id, user_id, cartela_number, card_data) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id',
    [gameId, String(userId), cartelaNumber, JSON.stringify(cardData)]
  );
  if (res.rowCount === 0) return { success: false, error: 'Cartela already taken by another player' };

  await deductPlayWallet(userId, betAmount);
  await query('UPDATE games SET player_count = player_count + 1, derash = derash + $1 WHERE id = $2', [betAmount, gameId]);
  await query(
    'INSERT INTO transactions (user_id, type, amount, game_id) VALUES ($1, $2, $3, $4)',
    [String(userId), 'bet', betAmount, gameId]
  );

  return { success: true };
}

async function getCartelaForUser(gameId, userId) {
  const res = await query('SELECT * FROM cartelas WHERE game_id = $1 AND user_id = $2', [gameId, String(userId)]);
  const row = res.rows[0];
  if (!row) return null;
  return { ...row, card_data: JSON.parse(row.card_data) };
}

async function getGameHistory(userId) {
  const res = await query(`
    SELECT g.id, g.status, g.bet_amount, g.derash, g.finished_at,
           c.cartela_number, t.type as result
    FROM cartelas c
    JOIN games g ON c.game_id = g.id
    LEFT JOIN transactions t ON t.game_id = g.id AND t.user_id = $1 AND t.type IN ('win','bet')
    WHERE c.user_id = $1
    ORDER BY g.created_at DESC LIMIT 20
  `, [String(userId)]);
  return res.rows;
}

// ── Auth tokens ───────────────────────────────────────────

function createAuthToken(telegramId) {
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  // fire-and-forget — token creation doesn't need to block
  query('INSERT INTO auth_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)', [token, String(telegramId), expiresAt])
    .catch(e => console.error('createAuthToken error:', e));
  return token;
}

async function getUserByAuthToken(token) {
  if (!token) return null;
  const res = await query('SELECT * FROM auth_tokens WHERE token = $1 AND expires_at > NOW()', [token]);
  if (!res.rows[0]) return null;
  return getUser(res.rows[0].user_id);
}

// ── Deposits ──────────────────────────────────────────────

async function getDepositByRef(refCode) {
  const res = await query('SELECT * FROM deposits WHERE ref_code = $1', [refCode.toUpperCase()]);
  return res.rows[0] || null;
}

async function createDeposit({ refCode, userId, amount, receiverPhone, receiverName, senderPhone, senderName, receiptUrl, rawSnippet }) {
  try {
    await query(
      `INSERT INTO deposits (ref_code, user_id, amount, receiver_phone, receiver_name, sender_phone, sender_name, receipt_url, raw_snippet, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')`,
      [refCode.toUpperCase(), String(userId), amount, receiverPhone, receiverName, senderPhone, senderName, receiptUrl, rawSnippet]
    );
    return true;
  } catch (e) {
    if (e.code === '23505') return false; // unique violation
    throw e;
  }
}

async function approveDeposit(refCode) {
  const dep = await getDepositByRef(refCode);
  if (!dep) return { success: false, error: 'Deposit not found' };
  if (dep.status === 'approved') return { success: false, error: 'Already approved' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE deposits SET status = 'approved', processed_at = NOW() WHERE ref_code = $1`,
      [dep.ref_code]
    );
    await client.query('UPDATE users SET play_wallet = play_wallet + $1 WHERE telegram_id = $2', [dep.amount, dep.user_id]);
    await client.query(
      'INSERT INTO transactions (user_id, type, amount, reference) VALUES ($1, $2, $3, $4)',
      [dep.user_id, 'deposit', dep.amount, dep.ref_code]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return { success: true, deposit: { ...dep, status: 'approved' } };
}

async function rejectDeposit(refCode, reason) {
  const dep = await getDepositByRef(refCode);
  if (!dep) return { success: false, error: 'Deposit not found' };
  if (dep.status === 'approved') return { success: false, error: 'Already approved — cannot reject' };
  await query(
    `UPDATE deposits SET status = 'rejected', reject_reason = $1, processed_at = NOW() WHERE ref_code = $2`,
    [reason || 'Rejected by admin', dep.ref_code]
  );
  return { success: true };
}

async function listDeposits({ status, limit = 50, offset = 0 } = {}) {
  if (status) {
    const res = await query(
      'SELECT d.*, u.username, u.phone_number FROM deposits d LEFT JOIN users u ON d.user_id = u.telegram_id WHERE d.status = $1 ORDER BY d.created_at DESC LIMIT $2 OFFSET $3',
      [status, limit, offset]
    );
    return res.rows;
  }
  const res = await query(
    'SELECT d.*, u.username, u.phone_number FROM deposits d LEFT JOIN users u ON d.user_id = u.telegram_id ORDER BY d.created_at DESC LIMIT $1 OFFSET $2',
    [limit, offset]
  );
  return res.rows;
}

async function listUsers({ search, limit = 50, offset = 0 } = {}) {
  if (search) {
    const q = `%${search}%`;
    const res = await query(
      'SELECT * FROM users WHERE username ILIKE $1 OR phone_number ILIKE $1 OR telegram_id ILIKE $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [q, limit, offset]
    );
    return res.rows;
  }
  const res = await query('SELECT * FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset]);
  return res.rows;
}

async function adminAddCredits(telegramId, amount, note) {
  const user = await getUser(telegramId);
  if (!user) return { success: false, error: 'User not found' };
  await addToPlayWallet(telegramId, amount, `admin:${note || 'manual'}`);
  return { success: true, newBalance: parseFloat(user.play_wallet) + amount };
}

module.exports = {
  pool, query, initDB,
  getOrCreateUser, getUser, getBalance,
  addToPlayWallet, deductPlayWallet, creditWinnings,
  createGame, getGame, getWaitingGame, getActiveGame, getTakenCartelas,
  updateGameNumbers, startGame, finishGame,
  addPlayerToGame, getCartelaForUser, getGameHistory,
  normalizePhone, isUserRegistered, registerPhone,
  createAuthToken, getUserByAuthToken,
  getDepositByRef, createDeposit, approveDeposit, rejectDeposit, listDeposits,
  listUsers, adminAddCredits,
};

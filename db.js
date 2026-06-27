const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function getDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;

  const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) {
    try {
      fs.mkdirSync(volumePath, { recursive: true });
    } catch (e) {
      console.warn('Could not create DB directory:', e.message);
    }
    return path.join(volumePath, 'bingo.db');
  }

  return path.join(__dirname, 'bingo.db');
}

const DB_PATH = getDbPath();
const db = new Database(DB_PATH);

// WAL mode: allows concurrent readers + one writer without locking errors
db.pragma('journal_mode = WAL');
db.pragma('synchronous = normal');
db.pragma('foreign_keys = ON');

// Warn early if we're on Railway without a persistent volume
if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) {
  const isVolume = process.env.RAILWAY_VOLUME_MOUNT_PATH || DB_PATH.startsWith('/data');
  if (!isVolume) {
    console.warn('⚠️  WARNING: Railway detected but no volume configured.');
    console.warn('   DB is EPHEMERAL — data will be lost on every deploy!');
    console.warn('   Fix: Railway Dashboard → Service → Add Volume → mount at /data');
  } else {
    console.log(`✅ DB path: ${DB_PATH}`);
  }
}

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
      phone_number TEXT,
      is_registered INTEGER DEFAULT 0,
      registered_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Games
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      status TEXT DEFAULT 'waiting',
      bet_amount REAL DEFAULT 10,
      player_count INTEGER DEFAULT 0,
      derash REAL DEFAULT 0,
      called_numbers TEXT DEFAULT '[]',
      winner_ids TEXT DEFAULT '[]',
      started_at DATETIME,
      finished_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Cartelas (player cards in a game)
    CREATE TABLE IF NOT EXISTS cartelas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      cartela_number INTEGER NOT NULL,
      card_data TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      FOREIGN KEY (game_id) REFERENCES games(id),
      UNIQUE (game_id, cartela_number)
    );

    -- Transactions
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      reference TEXT,
      game_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  migrateUsersTable();
  migrateAuthTokensTable();
  migrateCartelasTable();
  console.log(`✅ Database initialized (${DB_PATH})`);
}

function migrateAuthTokensTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare("DELETE FROM auth_tokens WHERE expires_at < datetime('now')").run();
}

function createAuthToken(telegramId) {
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO auth_tokens (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, String(telegramId), expiresAt);
  return token;
}

function getUserByAuthToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM auth_tokens WHERE token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token);
    return null;
  }
  return getUser(row.user_id);
}

function migrateCartelasTable() {
  try {
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_cartelas_game_cartela ON cartelas (game_id, cartela_number)'
    );
  } catch (e) {
    // Index may already exist or conflict — not fatal
    console.warn('Cartelas migration note:', e.message);
  }
}

function migrateUsersTable() {
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('phone_number')) {
    db.exec('ALTER TABLE users ADD COLUMN phone_number TEXT');
  }
  if (!cols.includes('is_registered')) {
    db.exec('ALTER TABLE users ADD COLUMN is_registered INTEGER DEFAULT 0');
  }
  if (!cols.includes('registered_at')) {
    db.exec('ALTER TABLE users ADD COLUMN registered_at DATETIME');
  }
}

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('251') && digits.length === 12) return `+${digits}`;
  if (digits.startsWith('0') && digits.length === 10) return `+251${digits.slice(1)}`;
  if (digits.length === 9 && /^9/.test(digits)) return `+251${digits}`;
  return null;
}

function isUserRegistered(telegramId) {
  const user = getUser(telegramId);
  return !!(user && user.is_registered && user.phone_number);
}

function registerPhone(telegramId, phone, { username, firstName } = {}) {
  const normalized = normalizePhone(phone);
  if (!normalized) return { success: false, error: 'Invalid phone number. Use 09XXXXXXXX or +2519XXXXXXXX' };

  getOrCreateUser({ telegramId, username, firstName });

  const existing = db.prepare(
    'SELECT telegram_id FROM users WHERE phone_number = ? AND telegram_id != ? AND is_registered = 1'
  ).get(normalized, String(telegramId));
  if (existing) {
    return { success: false, error: 'This phone number is already registered' };
  }

  db.prepare(`
    UPDATE users
    SET phone_number = ?, is_registered = 1, registered_at = CURRENT_TIMESTAMP
    WHERE telegram_id = ?
  `).run(normalized, String(telegramId));

  // Give a 50 ETB welcome bonus to play wallet (only for brand-new registrations)
  const freshUser = getUser(telegramId);
  const isFirstReg = freshUser && freshUser.play_wallet === 0;
  if (isFirstReg) {
    db.prepare('UPDATE users SET play_wallet = play_wallet + 50 WHERE telegram_id = ?')
      .run(String(telegramId));
    db.prepare(
      'INSERT INTO transactions (user_id, type, amount, reference) VALUES (?, ?, ?, ?)'
    ).run(String(telegramId), 'bonus', 50, 'welcome_bonus');
  }

  return { success: true, phoneNumber: normalized, welcomeBonus: isFirstReg ? 50 : 0 };
}

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

function createGame(gameId, betAmount) {
  db.prepare(
    'INSERT INTO games (id, bet_amount, status) VALUES (?, ?, ?)'
  ).run(gameId, betAmount, 'waiting');
}

function getGame(gameId) {
  return db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
}

function getWaitingGame() {
  return db.prepare(
    "SELECT * FROM games WHERE status = 'waiting' ORDER BY created_at DESC LIMIT 1"
  ).get();
}

function getActiveGame() {
  return db.prepare(
    "SELECT * FROM games WHERE status = 'active' ORDER BY started_at DESC LIMIT 1"
  ).get();
}

function getTakenCartelas(gameId) {
  return db.prepare(
    'SELECT cartela_number FROM cartelas WHERE game_id = ?'
  ).all(gameId).map(r => r.cartela_number);
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
  const user = getUser(userId);
  if (!user || user.play_wallet < betAmount) {
    return {
      success: false,
      error: `Insufficient play wallet balance. You need ${betAmount} ETB. Current balance: ${user ? user.play_wallet : 0} ETB. Deposit via the bot.`,
    };
  }

  const insertCartela = db.prepare(
    'INSERT OR IGNORE INTO cartelas (game_id, user_id, cartela_number, card_data) VALUES (?, ?, ?, ?)'
  );
  const result = insertCartela.run(gameId, String(userId), cartelaNumber, JSON.stringify(cardData));

  if (result.changes === 0) {
    return { success: false, error: 'Cartela already taken by another player' };
  }

  deductPlayWallet(userId, betAmount);

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
  createGame, getGame, getWaitingGame, getActiveGame, getTakenCartelas,
  updateGameNumbers, startGame, finishGame,
  addPlayerToGame, getCartelaForUser, getGameHistory,
  normalizePhone, isUserRegistered, registerPhone,
  createAuthToken, getUserByAuthToken,
};

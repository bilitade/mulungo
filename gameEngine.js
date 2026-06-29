const { v4: uuidv4 } = require('uuid');
const {
  createGame, getGame, getWaitingGame, getActiveGame, startGame, finishGame,
  updateGameNumbers, addPlayerToGame, getCartelaForUser, creditWinnings, db
} = require('./db');

const BET_AMOUNT = 10;
const CALL_INTERVAL_MS = 5000;
const MAX_CALLS_PER_GAME = 75;
const MIN_PLAYERS = 2;
const LOBBY_WAIT_MS = 30000;

function generateCard(cartelaNumber) {
  const ranges = [
    [1, 15],
    [16, 30],
    [31, 45],
    [46, 60],
    [61, 75],
  ];

  const seededRandom = (seed) => {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  };

  const card = [];
  for (let col = 0; col < 5; col++) {
    const [min, max] = ranges[col];
    const pool = [];
    for (let n = min; n <= max; n++) pool.push(n);

    const seed = cartelaNumber * (col + 1);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(seededRandom(seed + i) * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const col_vals = pool.slice(0, 5);
    if (col === 2) col_vals[2] = 'FREE';
    card.push(col_vals);
  }
  return card;
}

function checkBingo(card, calledNumbers) {
  const called = new Set(calledNumbers);
  const isMarked = (col, row) => card[col][row] === 'FREE' || called.has(card[col][row]);

  for (let row = 0; row < 5; row++) {
    if ([0, 1, 2, 3, 4].every(col => isMarked(col, row))) return true;
  }
  for (let col = 0; col < 5; col++) {
    if ([0, 1, 2, 3, 4].every(row => isMarked(col, row))) return true;
  }
  if ([0, 1, 2, 3, 4].every(i => isMarked(i, i))) return true;
  if ([0, 1, 2, 3, 4].every(i => isMarked(i, 4 - i))) return true;

  return false;
}

class GameEngine {
  constructor(broadcast) {
    this.broadcast = broadcast;
    this.currentGame = null;
    this.calledNumbers = [];
    this.callTimer = null;
    this.lobbyTimer = null;
    this.watchers = new Map();
  }

  getCurrentState() {
    this.ensureCurrentGame();
    if (!this.currentGame) return { status: 'no_game' };
    const game = getGame(this.currentGame);
    if (!game) return { status: 'no_game' };
    return {
      gameId: this.currentGame,
      status: game.status || 'waiting',
      calledNumbers: this.calledNumbers,
      playerCount: game.player_count || 0,
      betAmount: game.bet_amount || BET_AMOUNT,
      pot: game.derash || 0,
      lobbyCreatedAt: game.created_at || null,
    };
  }

  startAutoGame() {
    this.syncFromDb();
  }

  ensureCurrentGame() {
    if (this.currentGame) {
      const game = getGame(this.currentGame);
      if (game && (game.status === 'waiting' || game.status === 'active')) return;
    }
    const active = getActiveGame();
    if (active) {
      this.currentGame = active.id;
      this.calledNumbers = JSON.parse(active.called_numbers || '[]');
      return;
    }
    const waiting = getWaitingGame();
    if (waiting) {
      this.currentGame = waiting.id;
      this.calledNumbers = [];
    }
  }

  syncFromDb() {
    const active = getActiveGame();
    if (active) {
      this.currentGame = active.id;
      this.calledNumbers = JSON.parse(active.called_numbers || '[]');
      this.resumeActiveGame(active);
      return;
    }

    const waiting = getWaitingGame();
    if (waiting) {
      this.currentGame = waiting.id;
      this.calledNumbers = [];
      this.scheduleLobbyEnd(waiting.id);
      return;
    }

    this.initNewGame();
  }

  resumeActiveGame(game) {
    if (this.calledNumbers.length >= MAX_CALLS_PER_GAME) {
      this.finishRound(game.id);
      return;
    }

    const called = new Set(this.calledNumbers);
    const remaining = Array.from({ length: 75 }, (_, i) => i + 1).filter(n => !called.has(n));
    for (let i = remaining.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
    }
    const slotsLeft = MAX_CALLS_PER_GAME - this.calledNumbers.length;
    this.numberQueue = remaining.slice(0, slotsLeft);
    if (this.numberQueue.length > 0) {
      this.callNextNumber(game.id);
    } else {
      this.finishRound(game.id);
    }
  }

  scheduleLobbyEnd(gameId) {
    clearTimeout(this.lobbyTimer);
    const game = getGame(gameId);
    const elapsed = game?.created_at
      ? Date.now() - new Date(game.created_at).getTime()
      : 0;
    const remaining = Math.max(0, LOBBY_WAIT_MS - elapsed);
    this.lobbyTimer = setTimeout(() => this.onLobbyTimeout(gameId), remaining);
  }

  onLobbyTimeout(gameId) {
    const game = getGame(gameId);
    if (!game || game.status !== 'waiting') return;
    if (game.player_count >= MIN_PLAYERS) {
      this.beginGame(gameId);
    } else {
      // Only notify players who actually joined (got refunded). With 0 players there is
      // nobody to notify, so broadcasting would just confuse connected spectators.
      if (game.player_count > 0) {
        this.broadcast({ type: 'GAME_CANCELLED', payload: { gameId, reason: 'No players joined' } });
      } else {
        // Silent cancel — tell clients a fresh lobby is coming instead of a scary error
        this.broadcast({ type: 'LOBBY_RESTART', payload: { gameId } });
      }
      this.refundPlayers(gameId);
      this.currentGame = null;
      setTimeout(() => this.initNewGame(), 3000);
    }
  }

  initNewGame() {
    const existing = getWaitingGame();
    if (existing) {
      this.currentGame = existing.id;
      this.calledNumbers = [];
      this.scheduleLobbyEnd(existing.id);
      return;
    }

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

    this.scheduleLobbyEnd(gameId);
  }

  refundStakes(gameId) {
    const cartelas = db.prepare('SELECT * FROM cartelas WHERE game_id = ?').all(gameId);
    cartelas.forEach(c => {
      db.prepare('UPDATE users SET play_wallet = play_wallet + ? WHERE telegram_id = ?')
        .run(BET_AMOUNT, c.user_id);
    });
  }

  refundPlayers(gameId) {
    this.refundStakes(gameId);
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
        maxCalls: MAX_CALLS_PER_GAME,
      }
    });

    const numbers = Array.from({ length: 75 }, (_, i) => i + 1);
    for (let i = numbers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
    }
    this.numberQueue = numbers.slice(0, MAX_CALLS_PER_GAME);
    this.callNextNumber(gameId);
  }

  findWinners(gameId) {
    const game = getGame(gameId);
    if (!game) return [];

    const cartelas = db.prepare(
      'SELECT * FROM cartelas WHERE game_id = ? AND is_active = 1'
    ).all(gameId);

    const winners = [];
    for (const row of cartelas) {
      const cardData = JSON.parse(row.card_data);
      if (!checkBingo(cardData, this.calledNumbers)) continue;
      creditWinnings(row.user_id, game.derash, gameId);
      winners.push({
        userId: row.user_id,
        cartelaId: row.cartela_number,
        winAmount: game.derash,
      });
      break; // first valid bingo wins the pot
    }
    return winners;
  }

  finishRound(gameId) {
    clearTimeout(this.callTimer);
    this.numberQueue = [];
    const winners = this.findWinners(gameId);
    if (winners.length === 0) {
      this.refundStakes(gameId);
    }
    this.endGame(gameId, winners);
  }

  callNextNumber(gameId) {
    if (gameId !== this.currentGame) return;

    const game = getGame(gameId);
    if (!game || game.status !== 'active') return;

    if (this.calledNumbers.length >= MAX_CALLS_PER_GAME) {
      this.finishRound(gameId);
      return;
    }

    if (this.numberQueue.length === 0) {
      this.finishRound(gameId);
      return;
    }

    const number = this.numberQueue.shift();
    this.calledNumbers.push(number);
    updateGameNumbers(gameId, this.calledNumbers);

    const column = ['B', 'I', 'N', 'G', 'O'][Math.floor((number - 1) / 15)];

    this.broadcast({
      type: 'NUMBER_CALLED',
      payload: {
        gameId,
        number,
        column,
        calledNumbers: this.calledNumbers,
        remaining: Math.max(0, MAX_CALLS_PER_GAME - this.calledNumbers.length),
        maxCalls: MAX_CALLS_PER_GAME,
      }
    });

    if (this.calledNumbers.length >= MAX_CALLS_PER_GAME) {
      this.finishRound(gameId);
      return;
    }

    this.callTimer = setTimeout(() => this.callNextNumber(gameId), CALL_INTERVAL_MS);
  }

  claimBingo(userId, gameId, cartelaId, ws) {
    if (gameId !== this.currentGame) {
      ws.send(JSON.stringify({ type: 'BINGO_INVALID', payload: { reason: 'Wrong game' } }));
      return;
    }

    const game = getGame(gameId);
    if (!game || game.status !== 'active') {
      ws.send(JSON.stringify({ type: 'BINGO_INVALID', payload: { reason: 'Game is no longer active' } }));
      return;
    }

    const cartela = getCartelaForUser(gameId, userId);
    if (!cartela) {
      ws.send(JSON.stringify({ type: 'BINGO_INVALID', payload: { reason: 'No cartela found' } }));
      return;
    }

    if (!cartela.is_active) {
      ws.send(JSON.stringify({ type: 'BINGO_INVALID', payload: { reason: 'You were removed from this game for a false BINGO' } }));
      return;
    }

    const valid = checkBingo(cartela.card_data, this.calledNumbers);
    if (!valid) {
      ws.send(JSON.stringify({
        type: 'FALSE_BINGO',
        payload: { reason: 'No valid BINGO pattern found. You have been removed from the game.' }
      }));
      db.prepare('UPDATE cartelas SET is_active = 0 WHERE game_id = ? AND user_id = ?')
        .run(gameId, String(userId));
      return;
    }

    const winAmount = game.derash;
    // End game first — sets currentGame=null and marks DB as finished,
    // preventing any concurrent claim or finishRound from also paying out.
    this.endGame(gameId, [{ userId, cartelaId: cartela.cartela_number, winAmount }]);
    creditWinnings(userId, winAmount, gameId);
  }

  endGame(gameId, winners) {
    clearTimeout(this.callTimer);
    this.numberQueue = [];

    const game = getGame(gameId);
    if (game && game.status === 'active') {
      finishGame(gameId, winners.map(w => w.userId));
    }

    this.broadcast({
      type: 'GAME_OVER',
      payload: {
        gameId,
        winners,
        calledNumbers: this.calledNumbers,
        totalCalled: this.calledNumbers.length,
        maxCalls: MAX_CALLS_PER_GAME,
        noWinner: winners.length === 0,
      }
    });

    this.currentGame = null;
    this.calledNumbers = [];
    setTimeout(() => this.initNewGame(), 10000);
  }

  joinGame(userId, cartelaNumber) {
    this.ensureCurrentGame();
    if (!this.currentGame) return { success: false, error: 'No active game' };
    const game = getGame(this.currentGame);
    if (!game || game.status !== 'waiting') return { success: false, error: 'Game already started' };

    const taken = db.prepare(
      'SELECT id FROM cartelas WHERE game_id = ? AND cartela_number = ?'
    ).get(this.currentGame, cartelaNumber);
    if (taken) return { success: false, error: 'Cartela already taken' };

    const cardData = generateCard(cartelaNumber);
    const result = addPlayerToGame(this.currentGame, userId, cartelaNumber, cardData, BET_AMOUNT);
    if (!result.success) return result;

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
      playerCount: updatedGame.player_count,
      pot: updatedGame.derash,
    };
  }

  addWatcher(gameId, ws) {
    if (!this.watchers.has(gameId)) this.watchers.set(gameId, new Set());
    this.watchers.get(gameId).add(ws);
  }
}

module.exports = { GameEngine, generateCard, checkBingo };

const { v4: uuidv4 } = require('uuid');
const {
  createGame, getGame, getWaitingGame, getActiveGame, startGame, finishGame,
  updateGameNumbers, addPlayerToGame, getCartelaForUser, creditWinnings, query
} = require('./db');

const BET_AMOUNT = 10;
const CALL_INTERVAL_MS = 5000;
const MAX_CALLS_PER_GAME = 75;
const MIN_PLAYERS = 2;
const LOBBY_WAIT_MS = 30000;

function generateCard(cartelaNumber) {
  const ranges = [
    [1, 15], [16, 30], [31, 45], [46, 60], [61, 75],
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
    this.numberQueue = [];
  }

  getCurrentState() {
    // Returns a cached snapshot — callers must not await this
    return this._cachedState || { status: 'no_game' };
  }

  async _refreshState() {
    if (!this.currentGame) { this._cachedState = { status: 'no_game' }; return; }
    const game = await getGame(this.currentGame);
    if (!game) { this._cachedState = { status: 'no_game' }; return; }
    this._cachedState = {
      gameId: this.currentGame,
      status: game.status || 'waiting',
      calledNumbers: this.calledNumbers,
      playerCount: game.player_count || 0,
      betAmount: game.bet_amount || BET_AMOUNT,
      pot: game.derash || 0,
      lobbyCreatedAt: game.created_at || null,
    };
  }

  async startAutoGame() {
    await this.syncFromDb();
  }

  async ensureCurrentGame() {
    if (this.currentGame) {
      const game = await getGame(this.currentGame);
      if (game && (game.status === 'waiting' || game.status === 'active')) return;
    }
    const active = await getActiveGame();
    if (active) {
      this.currentGame = active.id;
      this.calledNumbers = JSON.parse(active.called_numbers || '[]');
      return;
    }
    const waiting = await getWaitingGame();
    if (waiting) {
      this.currentGame = waiting.id;
      this.calledNumbers = [];
    }
  }

  async syncFromDb() {
    const active = await getActiveGame();
    if (active) {
      this.currentGame = active.id;
      this.calledNumbers = JSON.parse(active.called_numbers || '[]');
      await this.resumeActiveGame(active);
      await this._refreshState();
      return;
    }
    const waiting = await getWaitingGame();
    if (waiting) {
      this.currentGame = waiting.id;
      this.calledNumbers = [];
      this.scheduleLobbyEnd(waiting.id, waiting.created_at);
      await this._refreshState();
      return;
    }
    await this.initNewGame();
  }

  async resumeActiveGame(game) {
    if (this.calledNumbers.length >= MAX_CALLS_PER_GAME) {
      await this.finishRound(game.id);
      return;
    }
    const called = new Set(this.calledNumbers);
    const remaining = Array.from({ length: 75 }, (_, i) => i + 1).filter(n => !called.has(n));
    for (let i = remaining.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
    }
    this.numberQueue = remaining.slice(0, MAX_CALLS_PER_GAME - this.calledNumbers.length);
    if (this.numberQueue.length > 0) {
      this.callNextNumber(game.id);
    } else {
      await this.finishRound(game.id);
    }
  }

  scheduleLobbyEnd(gameId, createdAt) {
    clearTimeout(this.lobbyTimer);
    const elapsed = createdAt ? Date.now() - new Date(createdAt).getTime() : 0;
    const remaining = Math.max(0, LOBBY_WAIT_MS - elapsed);
    this.lobbyTimer = setTimeout(() => this.onLobbyTimeout(gameId), remaining);
  }

  async onLobbyTimeout(gameId) {
    const game = await getGame(gameId);
    if (!game || game.status !== 'waiting') return;
    if (game.player_count >= MIN_PLAYERS) {
      await this.beginGame(gameId);
    } else {
      if (game.player_count > 0) {
        this.broadcast({ type: 'GAME_CANCELLED', payload: { gameId, reason: 'Not enough players' } });
      } else {
        this.broadcast({ type: 'LOBBY_RESTART', payload: { gameId } });
      }
      await this.refundPlayers(gameId);
      this.currentGame = null;
      setTimeout(() => this.initNewGame(), 3000);
    }
  }

  async initNewGame() {
    const existing = await getWaitingGame();
    if (existing) {
      this.currentGame = existing.id;
      this.calledNumbers = [];
      this.scheduleLobbyEnd(existing.id, existing.created_at);
      await this._refreshState();
      return;
    }
    const gameId = uuidv4().slice(0, 8).toUpperCase();
    await createGame(gameId, BET_AMOUNT);
    this.currentGame = gameId;
    this.calledNumbers = [];
    this.broadcast({
      type: 'LOBBY_OPEN',
      payload: { gameId, betAmount: BET_AMOUNT, waitTime: LOBBY_WAIT_MS / 1000 },
    });
    this.scheduleLobbyEnd(gameId, new Date());
    await this._refreshState();
  }

  async refundStakes(gameId) {
    const res = await query('SELECT * FROM cartelas WHERE game_id = $1', [gameId]);
    for (const c of res.rows) {
      await query('UPDATE users SET play_wallet = play_wallet + $1 WHERE telegram_id = $2', [BET_AMOUNT, c.user_id]);
    }
  }

  async refundPlayers(gameId) {
    await this.refundStakes(gameId);
    await query("UPDATE games SET status = 'cancelled' WHERE id = $1", [gameId]);
  }

  async beginGame(gameId) {
    await startGame(gameId);
    const game = await getGame(gameId);
    this.broadcast({
      type: 'GAME_STARTED',
      payload: { gameId, playerCount: game.player_count, pot: game.derash, maxCalls: MAX_CALLS_PER_GAME },
    });
    const numbers = Array.from({ length: 75 }, (_, i) => i + 1);
    for (let i = numbers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
    }
    this.numberQueue = numbers.slice(0, MAX_CALLS_PER_GAME);
    await this._refreshState();
    this.callNextNumber(gameId);
  }

  async findWinners(gameId) {
    const game = await getGame(gameId);
    if (!game) return [];
    const res = await query('SELECT * FROM cartelas WHERE game_id = $1 AND is_active = 1', [gameId]);
    for (const row of res.rows) {
      const cardData = JSON.parse(row.card_data);
      if (!checkBingo(cardData, this.calledNumbers)) continue;
      await creditWinnings(row.user_id, game.derash, gameId);
      return [{ userId: row.user_id, cartelaId: row.cartela_number, winAmount: game.derash }];
    }
    return [];
  }

  async finishRound(gameId) {
    clearTimeout(this.callTimer);
    this.numberQueue = [];
    const winners = await this.findWinners(gameId);
    if (winners.length === 0) await this.refundStakes(gameId);
    await this.endGame(gameId, winners);
  }

  callNextNumber(gameId) {
    if (gameId !== this.currentGame) return;
    if (this.calledNumbers.length >= MAX_CALLS_PER_GAME || this.numberQueue.length === 0) {
      this.finishRound(gameId);
      return;
    }
    const number = this.numberQueue.shift();
    this.calledNumbers.push(number);
    updateGameNumbers(gameId, this.calledNumbers).catch(e => console.error('updateGameNumbers error:', e));
    const column = ['B', 'I', 'N', 'G', 'O'][Math.floor((number - 1) / 15)];
    this.broadcast({
      type: 'NUMBER_CALLED',
      payload: { gameId, number, column, calledNumbers: this.calledNumbers,
        remaining: MAX_CALLS_PER_GAME - this.calledNumbers.length, maxCalls: MAX_CALLS_PER_GAME },
    });
    if (this.calledNumbers.length >= MAX_CALLS_PER_GAME) {
      this.finishRound(gameId);
      return;
    }
    this.callTimer = setTimeout(() => this.callNextNumber(gameId), CALL_INTERVAL_MS);
  }

  async claimBingo(userId, gameId, cartelaId, ws) {
    if (gameId !== this.currentGame) {
      ws.send(JSON.stringify({ type: 'BINGO_INVALID', payload: { reason: 'Wrong game' } }));
      return;
    }
    const game = await getGame(gameId);
    if (!game || game.status !== 'active') {
      ws.send(JSON.stringify({ type: 'BINGO_INVALID', payload: { reason: 'Game is no longer active' } }));
      return;
    }
    const cartela = await getCartelaForUser(gameId, userId);
    if (!cartela) {
      ws.send(JSON.stringify({ type: 'BINGO_INVALID', payload: { reason: 'No cartela found' } }));
      return;
    }
    if (!cartela.is_active) {
      ws.send(JSON.stringify({ type: 'BINGO_INVALID', payload: { reason: 'Removed for false BINGO' } }));
      return;
    }
    if (!checkBingo(cartela.card_data, this.calledNumbers)) {
      ws.send(JSON.stringify({ type: 'FALSE_BINGO', payload: { reason: 'No valid BINGO. You have been removed from the game.' } }));
      await query('UPDATE cartelas SET is_active = 0 WHERE game_id = $1 AND user_id = $2', [gameId, String(userId)]);
      return;
    }
    const winAmount = game.derash;
    await this.endGame(gameId, [{ userId, cartelaId: cartela.cartela_number, winAmount }]);
    await creditWinnings(userId, winAmount, gameId);
  }

  async endGame(gameId, winners) {
    clearTimeout(this.callTimer);
    this.numberQueue = [];
    const game = await getGame(gameId);
    if (game && game.status === 'active') await finishGame(gameId, winners.map(w => w.userId));
    this.broadcast({
      type: 'GAME_OVER',
      payload: { gameId, winners, calledNumbers: this.calledNumbers,
        totalCalled: this.calledNumbers.length, maxCalls: MAX_CALLS_PER_GAME, noWinner: winners.length === 0 },
    });
    this.currentGame = null;
    this.calledNumbers = [];
    this._cachedState = { status: 'no_game' };
    setTimeout(() => this.initNewGame(), 10000);
  }

  async joinGame(userId, cartelaNumber) {
    await this.ensureCurrentGame();
    if (!this.currentGame) return { success: false, error: 'No active game' };
    const game = await getGame(this.currentGame);
    if (!game || game.status !== 'waiting') return { success: false, error: 'Game already started' };

    const taken = await query(
      'SELECT id FROM cartelas WHERE game_id = $1 AND cartela_number = $2',
      [this.currentGame, cartelaNumber]
    );
    if (taken.rows[0]) return { success: false, error: 'Cartela already taken' };

    const cardData = generateCard(cartelaNumber);
    const result = await addPlayerToGame(this.currentGame, userId, cartelaNumber, cardData, BET_AMOUNT);
    if (!result.success) return result;

    const updatedGame = await getGame(this.currentGame);
    this.broadcast({
      type: 'PLAYER_JOINED',
      payload: { gameId: this.currentGame, playerCount: updatedGame.player_count, pot: updatedGame.derash },
    });

    // Start as soon as min players are in
    if (updatedGame.player_count >= MIN_PLAYERS) {
      clearTimeout(this.lobbyTimer);
      const gameId = this.currentGame;
      this.lobbyTimer = setTimeout(() => this.onLobbyTimeout(gameId), 10000);
      this.broadcast({
        type: 'LOBBY_STARTING',
        payload: { gameId: this.currentGame, startsIn: 10, playerCount: updatedGame.player_count },
      });
    }

    await this._refreshState();
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

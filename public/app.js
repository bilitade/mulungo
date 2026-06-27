/* global Telegram */
(function () {
  'use strict';

  function getTg() {
    return window.Telegram?.WebApp ?? null;
  }

  function getInitDataFromUrl() {
    try {
      const hash = window.location.hash.replace(/^#/, '');
      if (!hash) return '';
      const params = new URLSearchParams(hash);
      return params.get('tgWebAppData') || '';
    } catch {
      return '';
    }
  }

  function waitForTelegram(maxWaitMs = 5000) {
    return new Promise((resolve) => {
      const deadline = Date.now() + maxWaitMs;
      const tick = () => {
        const tg = getTg();
        const initData = tg?.initData || getInitDataFromUrl();
        const hasUser = tg?.initDataUnsafe?.user?.id || (initData && initData.includes('user='));

        if (tg && hasUser) {
          tg.ready();
          tg.expand();
          resolve(tg);
          return;
        }
        if (Date.now() >= deadline) {
          if (tg) {
            tg.ready();
            tg.expand();
          }
          resolve(tg);
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  function resolveTelegramUser() {
    const tg = getTg();
    const liveInitData = tg?.initData || getInitDataFromUrl() || '';

    if (liveInitData) {
      try {
        const raw = new URLSearchParams(liveInitData).get('user');
        if (raw) {
          const u = JSON.parse(raw);
          if (u?.id) {
            return {
              id: String(u.id),
              username: u.first_name || u.username || 'Player',
              fromTelegram: true,
              initData: liveInitData,
            };
          }
        }
      } catch (e) {
        console.error('initData parse failed', e);
      }
    }

    if (tg?.initDataUnsafe?.user?.id) {
      const u = tg.initDataUnsafe.user;
      return {
        id: String(u.id),
        username: u.first_name || u.username || 'Player',
        fromTelegram: true,
        initData: liveInitData,
      };
    }

    const inTelegram = !!(tg && tg.platform && tg.platform !== 'unknown');
    return {
      id: 'demo_user',
      username: 'Player',
      fromTelegram: inTelegram,
      initData: liveInitData,
    };
  }

  let userId = 'demo_user';
  let authUserId = null;
  let username = 'Player';
  let initData = '';
  let isRegistered = false;
  let playBalance = 0;
  let ws;
  let currentGameId = null;
  let myCartelaData = null;
  let myCartelaNumber = null;
  let calledNumbers = [];
  let selectedCartela = null;
  let isInGame = false;
  let maxCallsPerGame = 5;
  let nextGameTimer = null;

  // Returns the authoritative user ID — always prefer the token-authenticated one
  function getUID() {
    return authUserId || userId;
  }

  function refreshTelegramUser() {
    const u = resolveTelegramUser();
    // Never overwrite userId when we're already token-authenticated
    if (!authUserId) {
      userId = u.id;
    }
    username = u.username || username;
    initData = u.initData;
    return { ...u, id: getUID() };
  }

  function apiHeaders(extra = {}) {
    const headers = { ...extra };
    if (initData) headers['X-Telegram-Init-Data'] = initData;
    return headers;
  }

  async function apiFetch(url, options = {}) {
    // Always restore the authoritative ID before any request
    userId = getUID();
    if (!authUserId) refreshTelegramUser();
    const headers = apiHeaders(options.headers || {});
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    return fetch(url, { ...options, headers });
  }

  function updateCalledCount(count) {
    const el = document.getElementById('game-called-count');
    if (el) el.textContent = `${count}/${maxCallsPerGame}`;
  }

  function showBotRegisterNotice(message) {
    const subtitle = document.querySelector('#screen-register .register-subtitle');
    if (subtitle && message) subtitle.innerHTML = message;
    document.getElementById('screen-register').classList.remove('hidden');
  }

  function hideBotRegisterNotice() {
    document.getElementById('screen-register').classList.add('hidden');
  }

  function showNoTelegramUserScreen() {
    showBotRegisterNotice(
      'Could not read your Telegram account.<br><br>' +
      '1. Close this app completely<br>' +
      '2. Open the bot chat in Telegram<br>' +
      '3. Tap <strong>🎮 Play Bingo</strong> (do not open the link in a browser)<br><br>' +
      '<small>Make sure BotFather Mini App URL matches:<br>' +
      '<code>https://mulungo-production.up.railway.app</code></small>'
    );
  }

  function getAuthTokenFromUrl() {
    return new URLSearchParams(window.location.search).get('auth')
      || sessionStorage.getItem('mulungo_auth') || '';
  }

  function saveAuthToken(token) {
    if (token) sessionStorage.setItem('mulungo_auth', token);
  }

  async function authenticateWithToken() {
    const token = getAuthTokenFromUrl();
    if (!token) return null;

    const res = await fetch('/api/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const user = await res.json();

    if (!res.ok || user.error) {
      // Token is expired or invalid — clear it so we don't keep retrying
      sessionStorage.removeItem('mulungo_auth');
      return null;
    }

    userId = String(user.id);
    authUserId = userId;
    username = user.username || username;
    isRegistered = !!user.isRegistered;
    playBalance = user.playWallet ?? 0;
    saveAuthToken(token);
    return user;
  }

  async function authenticateWithTelegramId() {
    const tgUser = refreshTelegramUser();
    if (tgUser.id === 'demo_user') return null;

    try {
      const res = await apiFetch('/api/user/register', {
        method: 'POST',
        body: JSON.stringify({
          telegramId: tgUser.id,
          username: tgUser.username,
          firstName: tgUser.username,
          initData: tgUser.initData || undefined,
        }),
      });
      const user = await res.json();
      if (!res.ok || user.error) return null;

      if (user.id) {
        userId = String(user.id);
        authUserId = userId;
      }
      isRegistered = !!user.isRegistered;
      playBalance = user.playWallet ?? 0;
      return user;
    } catch {
      return null;
    }
  }

  async function syncUser() {
    return authenticateWithTelegramId();
  }

  async function checkRegistration() {
    try {
      // Step 1: Try the auth token from the URL/session (best — bot-issued, carries real ID)
      const authed = await authenticateWithToken();
      if (authed) {
        if (isRegistered) {
          hideBotRegisterNotice();
          updateLobbyBalance();
        } else {
          showBotRegisterNotice(
            'Your Telegram account was identified, but you haven\'t registered yet.<br><br>' +
            '1. Go back to the bot chat<br>' +
            '2. Send <strong>/register</strong><br>' +
            '3. Tap <strong>📱 Share Phone Number</strong><br>' +
            '4. Then tap <strong>🎮 Play Bingo</strong> → <strong>▶️ Open Mulungo</strong>'
          );
        }
        return isRegistered;
      }

      // Step 2: Auth token absent or expired — try Telegram initData
      const tgUser = refreshTelegramUser();
      if (tgUser.id !== 'demo_user') {
        const user = await authenticateWithTelegramId();
        if (user) {
          isRegistered = !!user.isRegistered;
          if (isRegistered) {
            hideBotRegisterNotice();
            updateLobbyBalance();
          } else {
            showBotRegisterNotice(
              'You\'re in Telegram but haven\'t registered your phone yet.<br><br>' +
              '1. Send <strong>/register</strong> to the bot<br>' +
              '2. Tap <strong>📱 Share Phone Number</strong><br>' +
              '3. Tap <strong>🎮 Play Bingo</strong> → <strong>▶️ Open Mulungo</strong>'
            );
          }
          return isRegistered;
        }
      }

      // Step 3: No Telegram context at all — must open from bot
      showBotRegisterNotice(
        'Open the game from the Mulungo bot:<br><br>' +
        '1. Open the bot in Telegram<br>' +
        '2. Tap <strong>🎮 Play Bingo</strong><br>' +
        '3. Tap <strong>▶️ Open Mulungo</strong> (the blue button)<br><br>' +
        '<small>Do not open the link directly in a browser.</small>'
      );
      return false;
    } catch (e) {
      console.error('checkRegistration error:', e);
      showBotRegisterNotice(
        'Could not verify your account.<br><br>' +
        'Tap <strong>🎮 Play Bingo</strong> in the bot → <strong>▶️ Open Mulungo</strong>'
      );
      return false;
    }
  }

  document.getElementById('btn-recheck-register')?.addEventListener('click', async () => {
    await waitForTelegram(2000);
    const ok = await checkRegistration();
    if (ok) showAlert('You are registered! Welcome to Mulungo.');
    else showAlert('Go back to the bot → tap 🎮 Play Bingo → tap ▶️ Open Mulungo');
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkRegistration();
  });

  document.getElementById('btn-close-app')?.addEventListener('click', () => {
    const tg = getTg();
    if (tg?.close) tg.close();
    else showAlert('Go back to the Mulungo bot and send /register');
  });

  function connectWS() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onopen = () => {
      console.log('WS connected');
      if (currentGameId) {
        ws.send(JSON.stringify({ type: 'JOIN_GAME', gameId: currentGameId }));
      }
      refreshLobbyState();
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      handleWSMessage(msg);
    };

    ws.onclose = () => {
      console.log('WS closed, reconnecting...');
      setTimeout(connectWS, 3000);
    };
  }

  function handleWSMessage(msg) {
    switch (msg.type) {
      case 'GAME_STATE':
        applyGameState(msg.payload);
        break;
      case 'LOBBY_OPEN':
        onLobbyOpen(msg.payload);
        break;
      case 'PLAYER_JOINED':
        updateLobbyInfo(msg.payload);
        break;
      case 'GAME_STARTED':
        onGameStarted(msg.payload);
        break;
      case 'NUMBER_CALLED':
        onNumberCalled(msg.payload);
        break;
      case 'GAME_OVER':
        onGameOver(msg.payload);
        break;
      case 'BINGO_INVALID':
      case 'FALSE_BINGO':
        showAlert(msg.payload.reason, 'error');
        break;
      case 'GAME_CANCELLED':
        // Only fires when player_count > 0 — actual players got refunded
        if (isInGame) {
          showAlert('Game cancelled — your 10 ETB has been refunded to your play wallet.');
          playBalance += 10;
          updateLobbyBalance();
        }
        isInGame = false;
        myCartelaData = null;
        myCartelaNumber = null;
        break;
      case 'LOBBY_RESTART':
        // Silent restart — game expired with 0 players, new lobby coming in 3s
        showToast('New game starting…');
        break;
    }
  }

  function applyGameState(state) {
    if (state.status === 'no_game') return;

    currentGameId = state.gameId;
    calledNumbers = state.calledNumbers || [];

    if (state.status === 'waiting') {
      showScreen('lobby');
      document.getElementById('lobby-game-id').textContent = state.gameId?.slice(0, 8) || '—';
      document.getElementById('lobby-players').textContent = state.playerCount || 0;
      document.getElementById('lobby-pot').textContent = state.pot || 0;
      document.getElementById('lobby-bet').textContent = state.betAmount || 10;

      // Compute real remaining wait time from server-side creation timestamp
      if (state.lobbyCreatedAt) {
        const elapsed = (Date.now() - new Date(state.lobbyCreatedAt).getTime()) / 1000;
        const remaining = Math.max(0, 30 - Math.floor(elapsed));
        startLobbyCountdown(remaining);
      }
    } else if (state.status === 'active') {
      showScreen('game');
      renderCalledNumbers(calledNumbers);
      document.getElementById('game-id-display').textContent = state.gameId?.slice(0, 8);
      document.getElementById('game-players').textContent = state.playerCount || 0;
      document.getElementById('game-pot').textContent = (state.pot || 0) + ' ETB';
      updateCalledCount(calledNumbers.length);

      if (myCartelaData) {
        renderBingoCard('active-card', myCartelaData, calledNumbers);
        document.getElementById('btn-bingo').classList.remove('hidden');
        document.getElementById('watch-msg').classList.add('hidden');
      } else {
        document.getElementById('btn-bingo').classList.add('hidden');
        document.getElementById('watch-msg').classList.remove('hidden');
      }
    }
  }

  function onLobbyOpen(payload) {
    // Don't reset game state if we're actively in a different game
    if (isInGame && currentGameId && currentGameId !== payload.gameId) return;

    currentGameId = payload.gameId;
    isInGame = false;
    myCartelaData = null;
    myCartelaNumber = null;
    selectedCartela = null;
    calledNumbers = [];

    document.getElementById('lobby-game-id').textContent = payload.gameId.slice(0, 8);
    document.getElementById('lobby-bet').textContent = payload.betAmount;
    document.getElementById('cartela-preview').classList.add('hidden');
    showScreen('lobby');
    startLobbyCountdown(payload.waitTime);
    refreshLobbyState();
  }

  function updateLobbyBalance() {
    const el = document.getElementById('lobby-balance');
    if (!el) return;
    el.textContent = `${playBalance} ETB`;
    const joinBtn = document.getElementById('btn-join-game');
    if (!joinBtn) return;
    if (playBalance < 10) {
      joinBtn.disabled = true;
      joinBtn.textContent = `Insufficient balance (${playBalance} ETB) — Deposit in Wallet tab`;
    } else {
      joinBtn.disabled = false;
      joinBtn.textContent = `Join Game — 10 ETB`;
    }
  }

  function updateLobbyInfo(payload) {
    if (payload.gameId && currentGameId && payload.gameId !== currentGameId) return;
    document.getElementById('lobby-players').textContent = payload.playerCount ?? 0;
    document.getElementById('lobby-pot').textContent = payload.pot ?? 0;
  }

  async function refreshLobbyState() {
    try {
      const res = await apiFetch('/api/lobby');
      const data = await res.json();
      if (data.status === 'no_game') return;

      currentGameId = data.gameId;
      updateLobbyInfo({ gameId: data.gameId, playerCount: data.playerCount, pot: data.pot });
      document.getElementById('lobby-game-id').textContent = data.gameId?.slice(0, 8) || '—';
      document.getElementById('lobby-bet').textContent = data.betAmount || 10;
      if (data.takenCartelas) renderCartelaGrid(data.takenCartelas);
    } catch (e) {
      console.error('Lobby refresh failed', e);
    }
  }

  function onGameStarted(payload) {
    showScreen('game');
    maxCallsPerGame = payload.maxCalls || 5;
    document.getElementById('game-id-display').textContent = payload.gameId?.slice(0, 8);
    document.getElementById('game-players').textContent = payload.playerCount;
    document.getElementById('game-pot').textContent = payload.pot + ' ETB';
    updateCalledCount(0);
    document.getElementById('called-history').innerHTML = '';
    document.getElementById('current-number').textContent = '—';
    calledNumbers = [];

    if (myCartelaData) {
      renderBingoCard('active-card', myCartelaData, calledNumbers);
      document.getElementById('btn-bingo').classList.remove('hidden');
      document.getElementById('watch-msg').classList.add('hidden');
    } else {
      document.getElementById('btn-bingo').classList.add('hidden');
      document.getElementById('watch-msg').classList.remove('hidden');
    }
  }

  function onNumberCalled(payload) {
    calledNumbers = payload.calledNumbers;
    if (payload.maxCalls) maxCallsPerGame = payload.maxCalls;
    const num = payload.number;
    const col = payload.column;

    document.getElementById('current-number').textContent = num;
    document.getElementById('current-column').textContent = col;
    updateCalledCount(calledNumbers.length);

    const colColors = { B: '--col-b', I: '--col-i', N: '--col-n', G: '--col-g', O: '--col-o' };
    document.getElementById('current-column').style.background = `var(${colColors[col]})`;

    const chip = document.createElement('div');
    chip.className = 'called-chip';
    chip.textContent = num;
    const hist = document.getElementById('called-history');
    hist.insertBefore(chip, hist.firstChild);

    if (myCartelaData) {
      renderBingoCard('active-card', myCartelaData, calledNumbers);
    }
  }

  function onGameOver(payload) {
    clearInterval(nextGameTimer);
    isInGame = false;
    myCartelaData = null;
    myCartelaNumber = null;
    showScreen('gameover');

    const titleEl = document.querySelector('#screen-gameover .bingo-title');
    if (payload.winners.length > 0) {
      if (titleEl) titleEl.textContent = 'BINGO!';
      const winnerNames = payload.winners.map(w =>
        `🏆 Cartela #${w.cartelaId} — Won ${w.winAmount} ETB`
      ).join('\n');
      document.getElementById('winners-list').textContent = winnerNames;
    } else {
      if (titleEl) titleEl.textContent = 'Round Over';
      document.getElementById('winners-list').textContent =
        `All ${payload.maxCalls || maxCallsPerGame} numbers called — no BINGO.\nYour 10 ETB stake has been refunded.`;
    }

    let countdown = 10;
    const el = document.getElementById('next-game-timer');
    el.textContent = countdown;
    nextGameTimer = setInterval(() => {
      countdown--;
      el.textContent = countdown;
      if (countdown <= 0) clearInterval(nextGameTimer);
    }, 1000);

    loadUserData();
  }

  let countdownTimer = null;
  function startLobbyCountdown(seconds) {
    clearInterval(countdownTimer);
    let remaining = seconds;
    const circumference = 283;
    const el = document.getElementById('lobby-countdown');
    const circle = document.getElementById('countdown-circle');

    const update = () => {
      el.textContent = remaining;
      circle.style.strokeDashoffset = circumference * (1 - remaining / seconds);
      if (remaining <= 0) clearInterval(countdownTimer);
      remaining--;
    };
    update();
    countdownTimer = setInterval(update, 1000);
  }

  function renderCartelaGrid(takenList) {
    const grid = document.getElementById('cartela-grid');
    grid.innerHTML = '';
    for (let i = 1; i <= 96; i++) {
      const btn = document.createElement('button');
      btn.className = 'cartela-num' + (takenList.includes(i) ? ' taken' : '');
      btn.textContent = i;
      btn.disabled = takenList.includes(i);
      btn.addEventListener('click', () => selectCartela(i));
      grid.appendChild(btn);
    }
  }

  async function selectCartela(num) {
    document.querySelectorAll('.cartela-num.selected').forEach(b => b.classList.remove('selected'));
    const buttons = document.querySelectorAll('.cartela-num');
    if (buttons[num - 1]) buttons[num - 1].classList.add('selected');
    selectedCartela = num;

    try {
      const res = await apiFetch('/api/preview-card', {
        method: 'POST',
        body: JSON.stringify({ cartelaNumber: num }),
      });
      const data = await res.json();
      renderBingoCard('preview-card', data.cardData, []);
      document.getElementById('cartela-preview').classList.remove('hidden');
    } catch (err) {
      console.error('Preview error', err);
    }
  }

  function renderBingoCard(containerId, cardData, called) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';

    const calledSet = new Set(called);
    const cols = ['B', 'I', 'N', 'G', 'O'];

    const header = document.createElement('div');
    header.className = 'bingo-header';
    cols.forEach(c => {
      const lbl = document.createElement('div');
      lbl.className = `bingo-col-label ${c}`;
      lbl.textContent = c;
      header.appendChild(lbl);
    });
    container.appendChild(header);

    for (let row = 0; row < 5; row++) {
      const rowEl = document.createElement('div');
      rowEl.className = 'bingo-row';
      for (let col = 0; col < 5; col++) {
        const val = cardData[col][row];
        const cell = document.createElement('div');
        cell.className = 'bingo-cell';
        if (val === 'FREE') {
          cell.textContent = '⭐';
          cell.classList.add('free');
        } else {
          cell.textContent = val;
          if (calledSet.has(val)) cell.classList.add('marked');
        }
        rowEl.appendChild(cell);
      }
      container.appendChild(rowEl);
    }
  }

  function renderCalledNumbers(nums) {
    const hist = document.getElementById('called-history');
    hist.innerHTML = '';
    [...nums].reverse().forEach(n => {
      const chip = document.createElement('div');
      chip.className = 'called-chip';
      chip.textContent = n;
      hist.appendChild(chip);
    });
    if (nums.length > 0) {
      const last = nums[nums.length - 1];
      document.getElementById('current-number').textContent = last;
      const col = ['B', 'I', 'N', 'G', 'O'][Math.floor((last - 1) / 15)];
      document.getElementById('current-column').textContent = col;
    }
  }

  document.getElementById('btn-join-game')?.addEventListener('click', async () => {
    if (!isRegistered) {
      return showAlert('Register in the Mulungo bot first.\n\nSend /start and tap Share Phone Number.');
    }
    if (!selectedCartela) return showAlert('Please select a cartela first.');
    if (playBalance < 10) {
      return showAlert(
        `Not enough balance!\n\nYou have ${playBalance} ETB but need 10 ETB.\n\nGo to the Wallet tab to deposit.`
      );
    }

    const joinBtn = document.getElementById('btn-join-game');
    joinBtn.disabled = true;
    joinBtn.textContent = 'Joining…';

    try {
      const res = await apiFetch('/api/join', {
        method: 'POST',
        body: JSON.stringify({ userId: getUID(), cartelaNumber: selectedCartela }),
      });
      const data = await res.json();

      if (data.error) {
        joinBtn.disabled = false;
        joinBtn.textContent = 'Join Game — 10 ETB';
        return showAlert(data.error);
      }

      myCartelaData = data.cardData;
      myCartelaNumber = data.cartelaNumber;
      isInGame = true;
      currentGameId = data.gameId || currentGameId;
      playBalance = Math.max(0, playBalance - 10);

      updateLobbyInfo({
        gameId: currentGameId,
        playerCount: data.playerCount,
        pot: data.pot,
      });
      updateLobbyBalance();

      if (currentGameId) {
        ws?.send(JSON.stringify({ type: 'JOIN_GAME', gameId: currentGameId }));
      }
      refreshLobbyState();

      showToast(`✅ Joined Cartela #${selectedCartela}! Waiting for game to start…`);
      document.getElementById('cartela-preview').classList.add('hidden');
    } catch (err) {
      console.error('Join error:', err);
      joinBtn.disabled = false;
      joinBtn.textContent = 'Join Game — 10 ETB';
      showAlert('Could not join game. Please try again.');
    }
  });

  document.getElementById('btn-bingo')?.addEventListener('click', () => {
    if (!currentGameId || !myCartelaData) return;
    ws.send(JSON.stringify({
      type: 'CLAIM_BINGO',
      userId: getUID(),
      gameId: currentGameId,
      cartelaId: myCartelaNumber,
    }));
  });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById(`tab-${tab}`).classList.remove('hidden');

      if (tab === 'wallet') loadWallet();
      if (tab === 'history') loadHistory();
      if (tab === 'profile') loadProfile();
    });
  });

  async function loadWallet() {
    try {
      const res = await apiFetch(`/api/wallet/${getUID()}`);
      const data = await res.json();
      document.getElementById('main-wallet-amount').textContent = `${data.mainWallet} ETB`;
      document.getElementById('play-wallet-amount').textContent = `${data.playWallet} ETB`;

      const txnRes = await apiFetch(`/api/wallet/${getUID()}/transactions`);
      const txns = await txnRes.json();
      const list = document.getElementById('txn-list');
      list.innerHTML = txns.length === 0
        ? '<p class="empty-msg">No transactions yet.</p>'
        : txns.map(t => `
          <div class="txn-item">
            <span>${t.type.toUpperCase()}</span>
            <span>${t.amount > 0 ? '+' : ''}${t.amount} ETB</span>
          </div>
        `).join('');
    } catch (e) { console.error(e); }
  }

  document.getElementById('btn-deposit')?.addEventListener('click', () => {
    document.getElementById('deposit-info').classList.toggle('hidden');
  });

  async function loadHistory() {
    try {
      const res = await apiFetch(`/api/history/${getUID()}`);
      const games = await res.json();
      const list = document.getElementById('history-list');
      list.innerHTML = games.length === 0
        ? '<p class="empty-msg">No games played yet.</p>'
        : games.map(g => `
          <div class="history-item">
            <div>
              <div style="font-weight:700;">Game ${g.id?.slice(0, 8)}</div>
              <div style="font-size:11px;color:var(--text-muted);">Cartela #${g.cartela_number}</div>
            </div>
            <div style="text-align:right;">
              <div style="color:${g.result === 'win' ? 'var(--green)' : 'var(--text-muted)'};">
                ${g.result === 'win' ? '🏆 Won' : 'Played'}
              </div>
              <div style="font-size:11px;color:var(--text-muted);">${g.bet_amount} ETB</div>
            </div>
          </div>
        `).join('');
    } catch (e) { console.error(e); }
  }

  async function loadUserData() {
    try {
      const res = await apiFetch(`/api/user/${getUID()}`);
      const user = await res.json();
      if (user.error) return;

      playBalance = user.playWallet ?? 0;

      document.getElementById('stat-main').textContent = user.mainWallet;
      document.getElementById('stat-play').textContent = user.playWallet;
      document.getElementById('stat-won').textContent = user.gamesWon;
      document.getElementById('stat-earning').textContent = user.totalEarning;
      document.getElementById('stat-phone').textContent = user.phoneNumber
        ? user.phoneNumber.replace(/(\+251\d{2})\d{4}(\d{3})/, '$1****$2')
        : '—';

      updateLobbyBalance();
    } catch (e) { console.error(e); }
  }

  async function loadProfile() {
    // Don't call refreshTelegramUser here — it may clobber userId if initData is unavailable
    document.getElementById('profile-avatar').textContent = username.charAt(0).toUpperCase();
    document.getElementById('profile-name').textContent = username;
    await loadUserData();
  }

  function showScreen(name) {
    ['lobby', 'game', 'gameover'].forEach(s => {
      document.getElementById(`screen-${s}`)?.classList.toggle('hidden', s !== name);
    });
  }

  function showAlert(msg) {
    const tg = getTg();
    if (tg?.showAlert) tg.showAlert(msg);
    else alert(msg);
  }

  let toastTimer = null;
  function showToast(msg, durationMs = 3000) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('visible'), durationMs);
  }

  async function boot() {
    await waitForTelegram(3000);

    const urlToken = new URLSearchParams(window.location.search).get('auth');
    if (urlToken) saveAuthToken(urlToken);

    refreshTelegramUser();
    console.log('Auth token:', getAuthTokenFromUrl() ? 'yes' : 'no', 'Telegram user:', userId);

    await checkRegistration();
    renderCartelaGrid([]);
    connectWS();

    if (getUID() !== 'demo_user') {
      loadProfile().catch(() => {});
    }
  }

  boot();
})();

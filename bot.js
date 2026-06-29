require('dotenv').config();
const https = require('https');
const { Telegraf, Markup } = require('telegraf');
const { getOrCreateUser, getUser, addToPlayWallet, registerPhone, isUserRegistered, createAuthToken } = require('./db');

const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: {
    agent: new https.Agent({ family: 4, keepAlive: true }),
  },
});
const MINI_APP_URL = (process.env.MINI_APP_URL || 'http://localhost:3000').replace(/\/$/, '');

const BOT_COMMANDS = [
  { command: 'start', description: 'Open main menu' },
  { command: 'register', description: 'Register with phone number' },
  { command: 'balance', description: 'Check wallet balance' },
  { command: 'deposit', description: 'Deposit via Telebirr' },
  { command: 'confirm_deposit', description: 'Confirm deposit (amount + ref)' },
  { command: 'play', description: 'Open the game' },
  { command: 'help', description: 'How to play' },
];

// Admin-only commands (not listed in the public menu)
// /addcredits <telegramId> <amount>

function registerKeyboard() {
  return Markup.keyboard([
    [Markup.button.contactRequest('📱 Share Phone Number')],
  ]).resize();
}

function mainKeyboard() {
  return Markup.keyboard([
    [Markup.button.text('🎮 Play Bingo')],
    [
      Markup.button.text('💼 Balance'),
      Markup.button.text('💳 Deposit'),
      Markup.button.text('❓ Help'),
    ],
  ]).resize();
}

function playInlineButton(telegramId) {
  const token = createAuthToken(telegramId);
  return Markup.inlineKeyboard([
    [Markup.button.webApp('▶️ Open Mulungo', `${MINI_APP_URL}?auth=${token}`)],
  ]);
}

async function sendPlayLauncher(ctx, text = 'Tap the button below to open the game 👇') {
  if (!isUserRegistered(ctx.from.id)) {
    return ctx.reply(
      'You need to register first.\n\nSend /register and share your phone number.',
      registerKeyboard()
    );
  }
  // Send persistent keyboard and inline button as SEPARATE messages.
  // Telegram cannot combine reply keyboard + inline keyboard in one message.
  await ctx.reply(text, mainKeyboard());
  await ctx.reply('▶️ Open Mulungo', playInlineButton(ctx.from.id));
}

function keyboardFor(telegramId) {
  return isUserRegistered(telegramId) ? mainKeyboard() : registerKeyboard();
}

function welcomeText(user, firstName) {
  if (user.is_registered) {
    return (
      `🎱 *Mulungo*\n` +
      `እንኳን ደህና መጡ! Welcome, ${firstName}!\n\n` +
      `💰 Main: *${user.main_wallet} ETB* · Play: *${user.play_wallet} ETB*\n` +
      `📱 Phone: \`${user.phone_number}\`\n\n` +
      `Tap 🎮 Play Bingo below, then tap *▶️ Open Mulungo*`
    );
  }
  return (
    `🎱 *Mulungo*\n` +
    `እንኳን ደህና መጡ! Welcome, ${firstName}!\n\n` +
    `Before you can play, register with your phone number.\n\n` +
    `Tap *📱 Share Phone Number* below — Telegram will send your number securely.`
  );
}

bot.start(async (ctx) => {
  const tgUser = ctx.from;
  const user = getOrCreateUser({
    telegramId: tgUser.id,
    username: tgUser.username || tgUser.first_name,
    firstName: tgUser.first_name,
  });

  await ctx.reply(welcomeText(user, tgUser.first_name), {
    parse_mode: 'Markdown',
    ...keyboardFor(tgUser.id),
  });

  if (user.is_registered) {
    await ctx.reply('▶️ Open Mulungo', playInlineButton(tgUser.id));
  }
});

bot.command('register', async (ctx) => {
  if (isUserRegistered(ctx.from.id)) {
    const user = getOrCreateUser({ telegramId: ctx.from.id });
    await ctx.reply(
      `✅ You're already registered.\n📱 ${user.phone_number}`,
      keyboardFor(ctx.from.id)
    );
    return sendPlayLauncher(ctx, 'Tap below to open the game:');
  }
  await ctx.reply(
    'Register by sharing your phone number.\n\nTap the button below:',
    registerKeyboard()
  );
});

async function sendBalance(ctx) {
  const user = getOrCreateUser({ telegramId: ctx.from.id, username: ctx.from.username });
  await ctx.reply(
    `💼 *Account Info*\n\n` +
    `Name: ${user.username}\n` +
    `Main Wallet: *${user.main_wallet} ETB*\n` +
    `Play Wallet: *${user.play_wallet} ETB*`,
    { parse_mode: 'Markdown', ...keyboardFor(ctx.from.id) }
  );
}

bot.hears('🎮 Play Bingo', (ctx) => sendPlayLauncher(ctx));
bot.command('play', (ctx) => sendPlayLauncher(ctx));

bot.hears('💼 Balance', sendBalance);

bot.hears('💳 Deposit', async (ctx) => {
  await ctx.reply(
    `💳 *Deposit via Telebirr*\n\n` +
    `Send ETB to: *0923471256* (Mulungo)\n\n` +
    `Then send:\n` +
    `/confirm_deposit 50 DFL123ABC\n\n` +
    `(Replace 50 with your amount and DFL123ABC with your reference)`,
    { parse_mode: 'Markdown', ...keyboardFor(ctx.from.id) }
  );
});

bot.hears('❓ Help', async (ctx) => {
  await ctx.reply(helpText(), { parse_mode: 'Markdown', ...keyboardFor(ctx.from.id) });
});

function helpText() {
  return (
    `🎱 *Mulungo Help*\n\n` +
    `*How to play:*\n` +
    `1. Register with /register — share your phone number\n` +
    `2. Deposit ETB to your play wallet\n` +
    `3. Tap 🎮 Play Bingo → ▶️ Open Mulungo and pick your cartela (1-96)\n` +
    `4. Numbers are called every 5 seconds\n` +
    `5. Complete a line and claim BINGO!\n\n` +
    `⚠️ False BINGO = removed from game + lose stake`
  );
}

bot.command('balance', sendBalance);

bot.command('deposit', async (ctx) => {
  await ctx.reply(
    `💳 *Deposit via Telebirr*\n\n` +
    `Send ETB to: *0923471256* (Mulungo)\n\n` +
    `Then send:\n` +
    `/confirm_deposit 50 DFL123ABC\n\n` +
    `(Replace 50 with your amount and DFL123ABC with your reference)`,
    { parse_mode: 'Markdown', ...keyboardFor(ctx.from.id) }
  );
});

bot.command('confirm_deposit', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  if (parts.length < 3) {
    return ctx.reply('Usage: /confirm_deposit <amount> <reference>', keyboardFor(ctx.from.id));
  }
  const amount = parseFloat(parts[1]);
  const ref = parts[2];

  if (isNaN(amount) || amount <= 0) {
    return ctx.reply('❌ Invalid amount.', keyboardFor(ctx.from.id));
  }

  addToPlayWallet(ctx.from.id, amount, ref);

  await ctx.reply(
    `✅ Deposit of *${amount} ETB* approved!\nRef: ${ref}\n\nYour play wallet has been credited.`,
    { parse_mode: 'Markdown', ...keyboardFor(ctx.from.id) }
  );

  if (process.env.ADMIN_CHAT_ID) {
    bot.telegram.sendMessage(
      process.env.ADMIN_CHAT_ID,
      `💰 New deposit: ${amount} ETB from @${ctx.from.username} (Ref: ${ref})`
    );
  }
});

bot.command('help', async (ctx) => {
  await ctx.reply(helpText(), { parse_mode: 'Markdown', ...keyboardFor(ctx.from.id) });
});

bot.command('addcredits', async (ctx) => {
  const adminId = process.env.ADMIN_CHAT_ID ? String(process.env.ADMIN_CHAT_ID) : null;
  if (!adminId || String(ctx.from.id) !== adminId) {
    return ctx.reply('❌ This command is restricted to admins.', keyboardFor(ctx.from.id));
  }
  const parts = ctx.message.text.split(' ');
  if (parts.length < 3) {
    return ctx.reply('Usage: /addcredits <telegramId> <amount>', keyboardFor(ctx.from.id));
  }
  const targetId = parts[1];
  const amount = parseFloat(parts[2]);
  if (!targetId || isNaN(amount) || amount <= 0 || amount > 10000) {
    return ctx.reply('Usage: /addcredits <telegramId> <amount> (max 10000)', keyboardFor(ctx.from.id));
  }
  const target = getUser(targetId);
  if (!target) {
    return ctx.reply(`❌ User ${targetId} not found.`, keyboardFor(ctx.from.id));
  }
  addToPlayWallet(targetId, amount, 'admin_credit');
  const fresh = getUser(targetId);
  await ctx.reply(
    `✅ *${amount} ETB* credited to user ${targetId} (@${target.username || '—'}).\n💳 Their play wallet: *${fresh?.play_wallet || 0} ETB*`,
    { parse_mode: 'Markdown', ...keyboardFor(ctx.from.id) }
  );
});

bot.on('contact', async (ctx) => {
  const contact = ctx.message.contact;
  if (contact.user_id !== ctx.from.id) {
    return ctx.reply('Please share your own phone number.', registerKeyboard());
  }

  const result = registerPhone(ctx.from.id, contact.phone_number, {
    username: ctx.from.username,
    firstName: ctx.from.first_name,
  });

  if (!result.success) {
    return ctx.reply(`❌ ${result.error}`, registerKeyboard());
  }

  if (!isUserRegistered(ctx.from.id)) {
    console.error('Registration save failed for user', ctx.from.id);
    return ctx.reply(
      '❌ Registration could not be saved. Please try again in a moment.',
      registerKeyboard()
    );
  }

  console.log(`✅ Registered user ${ctx.from.id} → ${result.phoneNumber}`);
  const freshUser = getUser(ctx.from.id);

  const bonusLine = result.welcomeBonus
    ? `\n🎁 *Welcome bonus:* ${result.welcomeBonus} ETB added to your play wallet!`
    : '';

  await ctx.reply(
    `✅ *Registration complete!*\n\n` +
    `📱 Phone: \`${result.phoneNumber}\`\n` +
    `💳 Play wallet: *${freshUser ? freshUser.play_wallet : 0} ETB*` +
    bonusLine +
    `\n\nTap *▶️ Open Mulungo* to start playing.`,
    { parse_mode: 'Markdown', ...mainKeyboard() }
  );
  await ctx.reply('▶️ Open Mulungo', playInlineButton(ctx.from.id));
});

async function startBot() {
  try {
    await bot.telegram.setMyCommands(BOT_COMMANDS);
    await bot.launch();
    console.log('🤖 Bot started (commands menu registered)');
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
  } catch (err) {
    console.error('⚠️  Telegram bot failed to start:', err.message || err.code || err);
    console.error('   The web app still runs — check network/VPN access to api.telegram.org');
    scheduleBotRetry();
  }
}

function scheduleBotRetry() {
  const delayMs = 30000;
  console.log(`   Retrying bot connection in ${delayMs / 1000}s...`);
  setTimeout(startBot, delayMs);
}

module.exports = { startBot };

require('dotenv').config();
const https = require('https');
const { Telegraf, Markup } = require('telegraf');
const { getOrCreateUser, getUser, addToPlayWallet, registerPhone, isUserRegistered, createAuthToken,
        getDepositByRef, createDeposit, approveDeposit } = require('./db');
const { fetchAndParseReceipt, extractRefCode, normalizePhone } = require('./telebirr');

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
  { command: 'confirm_deposit', description: 'Submit Telebirr receipt to credit wallet' },
  { command: 'play', description: 'Open the game' },
  { command: 'help', description: 'How to play' },
];

function registerKeyboard() {
  return Markup.keyboard([[Markup.button.contactRequest('📱 Share Phone Number')]]).resize();
}

function mainKeyboard() {
  return Markup.keyboard([
    [Markup.button.text('🎮 Play Bingo')],
    [Markup.button.text('💼 Balance'), Markup.button.text('💳 Deposit'), Markup.button.text('❓ Help')],
  ]).resize();
}

function playInlineButton(telegramId) {
  const token = createAuthToken(telegramId);
  return Markup.inlineKeyboard([[Markup.button.webApp('▶️ Open Mulungo', `${MINI_APP_URL}?auth=${token}`)]]);
}

async function sendPlayLauncher(ctx, text = 'Tap the button below to open the game 👇') {
  if (!(await isUserRegistered(ctx.from.id))) {
    return ctx.reply('You need to register first.\n\nSend /register and share your phone number.', registerKeyboard());
  }
  await ctx.reply(text, mainKeyboard());
  await ctx.reply('▶️ Open Mulungo', playInlineButton(ctx.from.id));
}

async function keyboardFor(telegramId) {
  return (await isUserRegistered(telegramId)) ? mainKeyboard() : registerKeyboard();
}

async function welcomeText(user, firstName) {
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
  const user = await getOrCreateUser({ telegramId: tgUser.id, username: tgUser.username || tgUser.first_name, firstName: tgUser.first_name });
  await ctx.reply(await welcomeText(user, tgUser.first_name), { parse_mode: 'Markdown', ...(await keyboardFor(tgUser.id)) });
  if (user.is_registered) await ctx.reply('▶️ Open Mulungo', playInlineButton(tgUser.id));
});

bot.command('register', async (ctx) => {
  if (await isUserRegistered(ctx.from.id)) {
    const user = await getOrCreateUser({ telegramId: ctx.from.id });
    await ctx.reply(`✅ You're already registered.\n📱 ${user.phone_number}`, await keyboardFor(ctx.from.id));
    return sendPlayLauncher(ctx, 'Tap below to open the game:');
  }
  await ctx.reply('Register by sharing your phone number.\n\nTap the button below:', registerKeyboard());
});

async function sendBalance(ctx) {
  const user = await getOrCreateUser({ telegramId: ctx.from.id, username: ctx.from.username });
  await ctx.reply(
    `💼 *Account Info*\n\nName: ${user.username}\nMain Wallet: *${user.main_wallet} ETB*\nPlay Wallet: *${user.play_wallet} ETB*`,
    { parse_mode: 'Markdown', ...(await keyboardFor(ctx.from.id)) }
  );
}

bot.hears('🎮 Play Bingo', (ctx) => sendPlayLauncher(ctx));
bot.command('play', (ctx) => sendPlayLauncher(ctx));
bot.hears('💼 Balance', sendBalance);
bot.command('balance', sendBalance);

bot.hears('❓ Help', async (ctx) => {
  await ctx.reply(helpText(), { parse_mode: 'Markdown', ...(await keyboardFor(ctx.from.id)) });
});
bot.command('help', async (ctx) => {
  await ctx.reply(helpText(), { parse_mode: 'Markdown', ...(await keyboardFor(ctx.from.id)) });
});

function helpText() {
  return (
    `🎱 *Mulungo Help*\n\n*How to play:*\n` +
    `1. Register with /register — share your phone number\n` +
    `2. Deposit ETB via Telebirr and send your receipt with /confirm_deposit\n` +
    `3. Tap 🎮 Play Bingo → ▶️ Open Mulungo and pick your cartela (1-96)\n` +
    `4. Numbers are called every 5 seconds\n` +
    `5. Complete a line and claim BINGO!\n\n` +
    `⚠️ False BINGO = removed from game + lose stake`
  );
}

bot.hears('💳 Deposit', async (ctx) => {
  await ctx.reply(depositInstructions(), { parse_mode: 'Markdown', ...(await keyboardFor(ctx.from.id)) });
});
bot.command('deposit', async (ctx) => {
  await ctx.reply(depositInstructions(), { parse_mode: 'Markdown', ...(await keyboardFor(ctx.from.id)) });
});

function depositInstructions() {
  return (
    `💳 *Deposit via Telebirr*\n\n` +
    `1. Send ETB to: *${process.env.TELEBIRR_PHONE || '0923471256'}* (Mulungo)\n\n` +
    `2. Open your Telebirr app → Recent transactions → tap the transfer → *Share Receipt*\n\n` +
    `3. Send the receipt link here:\n` +
    `/confirm_deposit https://transactioninfo.ethiotelecom.et/receipt/YOURCODE\n\n` +
    `Or just the reference code:\n/confirm_deposit YOURCODE\n\n` +
    `_Deposits are verified automatically from the official Telebirr receipt._`
  );
}

bot.command('confirm_deposit', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    return ctx.reply(
      '❌ Please include your receipt link or reference code.\n\n' +
      'Example:\n`/confirm_deposit https://transactioninfo.ethiotelecom.et/receipt/DES7F9MJKR`\n\nor:\n`/confirm_deposit DES7F9MJKR`',
      { parse_mode: 'Markdown', ...(await keyboardFor(ctx.from.id)) }
    );
  }
  const refCode = extractRefCode(parts[1]);
  if (!refCode) {
    return ctx.reply('❌ Could not read a reference code from that. Send the full receipt URL or the code directly.', await keyboardFor(ctx.from.id));
  }
  const existing = await getDepositByRef(refCode);
  if (existing) {
    if (existing.user_id === String(ctx.from.id) && existing.status === 'approved') {
      return ctx.reply(`⚠️ This receipt (*${refCode}*) was already used for a deposit on your account.`, { parse_mode: 'Markdown', ...(await keyboardFor(ctx.from.id)) });
    }
    return ctx.reply(`❌ Receipt *${refCode}* has already been submitted. Each receipt can only be used once.`, { parse_mode: 'Markdown', ...(await keyboardFor(ctx.from.id)) });
  }

  const processing = await ctx.reply('🔍 Fetching receipt from Telebirr…', await keyboardFor(ctx.from.id));

  let parsed;
  try {
    parsed = await fetchAndParseReceipt(refCode);
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, processing.message_id, null, `❌ ${err.message}`);
    return;
  }

  const businessPhone = normalizePhone(process.env.TELEBIRR_PHONE || '0923471256');
  const receiverOk = !parsed.receiverPhone || parsed.receiverPhone === businessPhone;

  if (!parsed.success) {
    await createDeposit({ refCode, userId: ctx.from.id, ...parsed, rawSnippet: parsed.rawSnippet });
    return ctx.reply(
      `❌ This transaction does not appear to be completed.\n\nReceipt: *${refCode}*\n\nIf you believe this is an error, contact support.`,
      { parse_mode: 'Markdown', ...(await keyboardFor(ctx.from.id)) }
    );
  }
  if (!receiverOk) {
    await createDeposit({ refCode, userId: ctx.from.id, ...parsed, rawSnippet: parsed.rawSnippet });
    const expected = process.env.TELEBIRR_PHONE || '0923471256';
    return ctx.reply(
      `❌ This payment was sent to *${parsed.receiverPhone || 'an unknown number'}*, not to Mulungo (*${expected}*).\n\nPlease send to *${expected}* and try again.`,
      { parse_mode: 'Markdown', ...(await keyboardFor(ctx.from.id)) }
    );
  }
  if (!parsed.amount || parsed.amount <= 0) {
    return ctx.reply('❌ Could not read the amount from this receipt. Please contact support with your receipt code.', await keyboardFor(ctx.from.id));
  }

  await createDeposit({ refCode, userId: ctx.from.id, ...parsed, rawSnippet: parsed.rawSnippet });
  const result = await approveDeposit(refCode);
  if (!result.success) return ctx.reply(`❌ ${result.error}`, await keyboardFor(ctx.from.id));

  const freshUser = await getUser(ctx.from.id);
  await ctx.reply(
    `✅ *Deposit Verified!*\n\n💰 Amount: *${parsed.amount} ETB*\n🔖 Ref: \`${refCode}\`\n` +
    (parsed.date ? `📅 Date: ${parsed.date}\n` : '') +
    `\n💳 Play wallet: *${freshUser?.play_wallet ?? 0} ETB*\n\nTap 🎮 Play Bingo to start playing!`,
    { parse_mode: 'Markdown', ...(await keyboardFor(ctx.from.id)) }
  );
  if (process.env.ADMIN_CHAT_ID) {
    bot.telegram.sendMessage(
      process.env.ADMIN_CHAT_ID,
      `💰 Auto-verified deposit: *${parsed.amount} ETB*\nUser: @${ctx.from.username || ctx.from.id}\nRef: \`${refCode}\`\nSender: ${parsed.senderPhone || '—'} (${parsed.senderName || '—'})`,
      { parse_mode: 'Markdown' }
    );
  }
});

bot.command('addcredits', async (ctx) => {
  const adminId = process.env.ADMIN_CHAT_ID ? String(process.env.ADMIN_CHAT_ID) : null;
  if (!adminId || String(ctx.from.id) !== adminId) {
    return ctx.reply('❌ This command is restricted to admins.', await keyboardFor(ctx.from.id));
  }
  const parts = ctx.message.text.split(' ');
  if (parts.length < 3) return ctx.reply('Usage: /addcredits <telegramId> <amount>', await keyboardFor(ctx.from.id));
  const targetId = parts[1];
  const amount = parseFloat(parts[2]);
  if (!targetId || isNaN(amount) || amount <= 0 || amount > 10000) {
    return ctx.reply('Usage: /addcredits <telegramId> <amount> (max 10000)', await keyboardFor(ctx.from.id));
  }
  const target = await getUser(targetId);
  if (!target) return ctx.reply(`❌ User ${targetId} not found.`, await keyboardFor(ctx.from.id));
  await addToPlayWallet(targetId, amount, 'admin_credit');
  const fresh = await getUser(targetId);
  await ctx.reply(
    `✅ *${amount} ETB* credited to user ${targetId} (@${target.username || '—'}).\n💳 Their play wallet: *${fresh?.play_wallet || 0} ETB*`,
    { parse_mode: 'Markdown', ...(await keyboardFor(ctx.from.id)) }
  );
});

bot.on('contact', async (ctx) => {
  const contact = ctx.message.contact;
  if (contact.user_id !== ctx.from.id) {
    return ctx.reply('Please share your own phone number.', registerKeyboard());
  }
  const result = await registerPhone(ctx.from.id, contact.phone_number, {
    username: ctx.from.username,
    firstName: ctx.from.first_name,
  });
  if (!result.success) return ctx.reply(`❌ ${result.error}`, registerKeyboard());
  if (!(await isUserRegistered(ctx.from.id))) {
    console.error('Registration save failed for user', ctx.from.id);
    return ctx.reply('❌ Registration could not be saved. Please try again in a moment.', registerKeyboard());
  }
  console.log(`✅ Registered user ${ctx.from.id} → ${result.phoneNumber}`);
  const freshUser = await getUser(ctx.from.id);
  const bonusLine = result.welcomeBonus ? `\n🎁 *Welcome bonus:* ${result.welcomeBonus} ETB added to your play wallet!` : '';
  await ctx.reply(
    `✅ *Registration complete!*\n\n📱 Phone: \`${result.phoneNumber}\`\n💳 Play wallet: *${freshUser ? freshUser.play_wallet : 0} ETB*` +
    bonusLine + `\n\nTap *▶️ Open Mulungo* to start playing.`,
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
    scheduleBotRetry();
  }
}

function scheduleBotRetry() {
  const delayMs = 30000;
  console.log(`   Retrying bot connection in ${delayMs / 1000}s...`);
  setTimeout(startBot, delayMs);
}

module.exports = { startBot };

const crypto = require('crypto');

function parseUserFromInitData(initData) {
  if (!initData) return null;
  try {
    const raw = new URLSearchParams(initData).get('user');
    if (!raw) return null;
    const user = JSON.parse(raw);
    return user?.id ? { id: String(user.id), ...user } : null;
  } catch {
    return null;
  }
}

function validateInitData(initData, botToken) {
  if (!initData || !botToken) return null;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return parseUserFromInitData(initData);

    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (calculatedHash !== hash) return null;
    return parseUserFromInitData(initData);
  } catch {
    return null;
  }
}

function resolveTelegramId({ telegramId, initData, botToken }) {
  if (initData) {
    if (botToken) {
      const validated = validateInitData(initData, botToken);
      if (validated?.id) return validated.id;
    }
    const parsed = parseUserFromInitData(initData);
    if (parsed?.id) return parsed.id;
  }

  if (telegramId && telegramId !== 'demo_user') {
    return String(telegramId);
  }
  return null;
}

module.exports = { resolveTelegramId, validateInitData, parseUserFromInitData };

const RECEIPT_BASE = 'https://transactioninfo.ethiotelecom.et/receipt';

// Strip HTML tags and decode entities to plain text
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('251') && digits.length === 12) return `+${digits}`;
  if (digits.startsWith('0') && digits.length === 10) return `+251${digits.slice(1)}`;
  if (digits.length === 9 && /^9/.test(digits)) return `+251${digits}`;
  return null;
}

// Try each pattern in order, return the first match's capture group 1
function tryPatterns(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function parseReceipt(html, refCode) {
  const text = htmlToText(html);

  // Amount
  const amountRaw = tryPatterns(text, [
    /[Aa]mount\s*:?\s*(?:ETB\s*)?([\d,]+\.?\d*)/,
    /ETB\s*([\d,]+\.?\d*)/,
    /([\d,]+\.?\d*)\s*(?:ETB|Birr)/i,
  ]);
  const amount = amountRaw ? parseFloat(amountRaw.replace(/,/g, '')) : null;

  // Receiver phone
  const receiverRaw = tryPatterns(text, [
    /[Rr]eceiver\s*(?:[Pp]hone)?\s*:?\s*([\d+]{9,15})/,
    /[Rr]ecipient\s*:?\s*([\d+]{9,15})/,
    /[Tt]o\s*:?\s*([\d+]{9,15})/,
  ]);
  const receiverPhone = normalizePhone(receiverRaw);

  // Receiver name
  const receiverName = tryPatterns(text, [
    /[Rr]eceiver\s*[Nn]ame\s*:?\s*([A-Za-z ]{2,50})/,
    /[Rr]ecipient\s*[Nn]ame\s*:?\s*([A-Za-z ]{2,50})/,
  ]);

  // Sender phone
  const senderRaw = tryPatterns(text, [
    /[Ss]ender\s*(?:[Pp]hone)?\s*:?\s*([\d+]{9,15})/,
    /[Ff]rom\s*:?\s*([\d+]{9,15})/,
  ]);
  const senderPhone = normalizePhone(senderRaw);

  // Sender name
  const senderName = tryPatterns(text, [
    /[Ss]ender\s*[Nn]ame\s*:?\s*([A-Za-z ]{2,50})/,
    /[Ff]rom\s*[Nn]ame\s*:?\s*([A-Za-z ]{2,50})/,
  ]);

  // Transaction date
  const date = tryPatterns(text, [
    /[Dd]ate\s*(?:&\s*[Tt]ime)?\s*:?\s*(\d{4}-\d{2}-\d{2}[^\n<]{0,20})/,
    /[Tt]ransaction\s*[Dd]ate\s*:?\s*([^\n]{5,30})/,
  ]);

  // Status — look for success/completed/failed
  const statusRaw = tryPatterns(text, [
    /[Ss]tatus\s*:?\s*(\w+)/,
  ]);
  const success = /success|complet|approved/i.test(statusRaw || '') ||
                  /success|complet/i.test(text);

  // Extract ref from page as cross-check
  const pageRef = tryPatterns(text, [
    /[Rr]ef(?:erence)?\s*(?:[Nn]umber|[Ii][Dd])?\s*:?\s*([A-Z0-9]{6,20})/,
    /[Tt]x(?:Ref|ID)?\s*:?\s*([A-Z0-9]{6,20})/,
  ]);

  return {
    refCode: pageRef || refCode,
    amount,
    receiverPhone,
    receiverName: receiverName?.trim() || null,
    senderPhone,
    senderName: senderName?.trim() || null,
    date: date?.trim() || null,
    success,
    rawSnippet: text.slice(0, 500),
  };
}

async function fetchAndParseReceipt(refCode) {
  const clean = refCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!clean || clean.length < 4) throw new Error('Invalid reference code format');

  const url = `${RECEIPT_BASE}/${clean}`;
  let html;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Mulungo/1.0)' },
      signal: AbortSignal.timeout(12000),
    });
    if (res.status === 404) throw new Error('Receipt not found. Check the reference code.');
    if (!res.ok) throw new Error(`Telebirr returned HTTP ${res.status}. Try again later.`);
    html = await res.text();
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error('Telebirr site timed out. Try again in a moment.');
    throw err;
  }

  if (!html || html.length < 100) throw new Error('Empty response from Telebirr. Try again.');

  const parsed = parseReceipt(html, clean);
  parsed.receiptUrl = url;
  return parsed;
}

// Extract reference code from either a full URL or bare code
function extractRefCode(input) {
  const trimmed = input.trim();
  // Full URL
  const urlMatch = trimmed.match(/receipt\/([A-Z0-9]+)/i);
  if (urlMatch) return urlMatch[1].toUpperCase();
  // Bare code (letters + digits)
  const codeMatch = trimmed.match(/^([A-Z0-9]{4,20})$/i);
  if (codeMatch) return codeMatch[1].toUpperCase();
  return null;
}

module.exports = { fetchAndParseReceipt, extractRefCode, normalizePhone };

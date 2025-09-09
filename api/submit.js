// api/submit.js  — Node.js (Vercel Serverless Function, CommonJS)

const TOKEN = process.env.TG_TOKEN;
const CHAT_ID = process.env.TG_CHAT;   // публичный канал "Заявки БСЗ"
const ADMIN_ID = process.env.TG_ADMIN; // админ-канал "полная информация"

// Белый список доменов для CORS (в точности как Origin браузера, включая схему)
const ORIGINS = String(process.env.ALLOW_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// --- Helpers ---------------------------------------------------------------

function allowOrigin(origin) {
  return ORIGINS.length === 0 ? '*' : (ORIGINS.includes(origin) ? origin : null);
}

function setCors(res, origin) {
  const allowed = allowOrigin(origin);
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', allowed);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function ok(res, origin, payload = { ok: true }) {
  setCors(res, origin);
  json(res, 200, payload);
}

function bad(res, origin, message, code = 400) {
  setCors(res, origin);
  json(res, code, { ok: false, error: message });
}

function getIP(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

// Простая проверка email
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
// E.164: + и 8–15 цифр
const E164_RE = /^\+\d{8,15}$/;

// Страна по телефонному коду (минимально нужные)
function countryByDial(dial) {
  const d = String(dial || '').replace(/^\+/, '');
  // приоритетные
  if (d.startsWith('7')) return 'Россия';        // (для наших задач — Россия)
  if (d.startsWith('375')) return 'Беларусь';
  if (d.startsWith('380')) return 'Украина';
  if (d.startsWith('76') || d.startsWith('77')) return 'Казахстан';
  if (d.startsWith('374')) return 'Армения';
  if (d.startsWith('998')) return 'Узбекистан';
  if (d.startsWith('996')) return 'Киргизия';
  if (d.startsWith('992')) return 'Таджикистан';
  if (d.startsWith('993')) return 'Туркменистан';
  // дефолт
  return '';
}

function boolToRu(b) {
  return b ? 'да' : 'нет';
}

async function tgSend(chatId, text) {
  if (!TOKEN || !chatId) return;
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Telegram error ${r.status}: ${t}`);
  }
}

// --- Handler ---------------------------------------------------------------

module.exports = async (req, res) => {
  const origin = String(req.headers.origin || '');

  // CORS preflight
  if (req.method === 'OPTIONS') {
    const allowed = allowOrigin(origin);
    if (!allowed) return bad(res, origin, 'Origin not allowed', 403);
    setCors(res, origin);
    res.statusCode = 200;
    return res.end();
  }

  if (req.method !== 'POST') {
    return bad(res, origin, 'Method not allowed', 405);
  }

  // Проверка Origin
  if (ORIGINS.length && !ORIGINS.includes(origin)) {
    return bad(res, origin, 'Origin not allowed', 403);
  }

  // Парсинг тела
  let body = req.body;
  if (!body) {
    try {
      const raw = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', c => (data += c));
        req.on('end', () => resolve(data));
        req.on('error', reject);
      });
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return bad(res, origin, 'Invalid JSON', 400);
    }
  }

  // Достаём поля
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const phoneNational = String(body.phone || '').trim();      // "(993) 497-85-33"
  const phoneE164 = String(body.phone_e164 || '').trim();     // "+79934978533"
  const subscribe = Boolean(body.subscribe);
  const policyVersion = String(body.policy_version || '').trim();
  const url = String(body.url || '').trim();
  const ua = String(body.ua || '').trim();
  const hp = String(body.hp || '').trim(); // honeypot
  const t = Number(body.t || 0);

  // Доп.поля с фронта (если есть)
  const countryName = String(body.countryName || '').trim();
  const dialCode = String(body.dialCode || '').trim(); // например "7"

  // Антибот
  if (hp) return ok(res, origin, { ok: true, skipped: true, reason: 'honeypot' });
  if (t && t < 600) return ok(res, origin, { ok: true, skipped: true, reason: 'timer' });

  // Серверная валидация
  if (!name) return bad(res, origin, 'Укажите имя');
  if (!email || !EMAIL_RE.test(email)) return bad(res, origin, 'Неверный email');
  if (!phoneE164 || !E164_RE.test(phoneE164)) return bad(res, origin, 'Неверный телефон');

  // Страна: приоритет countryName -> dialCode -> phoneE164
  const country =
    countryName ||
    countryByDial(dialCode ? `+${dialCode}` : '') ||
    countryByDial(phoneE164);

  // Время/технические детали
  const now = new Date();
  const timeRu = now.toLocaleString('ru-RU', { hour12: false, timeZone: 'Europe/Moscow' });
  const ip = getIP(req);
  const referer = String(req.headers.referer || '');

  // --- ТЕКСТЫ ДЛЯ TELEGRAM -----------------------------------------------

  // Короткая версия (публичный канал)
  const shortText =
    `🎟 Новая заявка\n` +
    `Имя: ${name}\n` +
    `Email: ${email}\n` +
    (country ? `Страна: ${country}\n\n` : `\n`) +
    `Телефон: ${phoneNational || phoneE164}\n` +
    `Подписка: ${boolToRu(subscribe)}\n\n` +
    `URL: ${url || referer || '-'}`;

  // Полная версия (админ-канал)
  const fullText =
    `<b>Заявка (подробно)</b>\n` +
    `Имя: ${name}\n` +
    `Email: ${email}\n` +
    `Телефон: ${phoneNational || '-'}\n` +
    `E164: ${phoneE164}\n` +
    (country ? `Страна: ${country}\n` : '') +
    `Подписка: ${boolToRu(subscribe)}\n` +
    (policyVersion ? `Политика: ${policyVersion}\n` : '') +
    `Когда: ${timeRu}\n` +
    `URL: ${url || referer || '-'}\n` +
    `UA: ${ua || '-'}\n` +
    `IP: ${ip || '-'}\n` +
    `Origin: ${origin || '-'}`;

  try {
    // сначала админ, потом публичный (чтобы при сбое было что посмотреть)
    await tgSend(ADMIN_ID, fullText);
    await tgSend(CHAT_ID, shortText);

    return ok(res, origin, { ok: true });
  } catch (e) {
    console.error(e);
    return bad(res, origin, 'Telegram send failed', 502);
  }
};

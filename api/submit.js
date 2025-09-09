// api/submit.js
// Vercel Node Serverless Function

// --- ENV ---
const {
  TG_TOKEN = '',
  TG_CHAT = '',      // публичный канал/чат
  TG_ADMIN = '',     // админский канал/чат
  ALLOW_ORIGIN = '', // список доменов, через запятую: "https://gkbsz.su,https://www.gkbsz.su"
  // Upstash Redis (любой из вариантов)
  KV_REST_API_URL,
  KV_REST_API_TOKEN,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
} = process.env;

// --- CORS allow-list ---
const ALLOWED = ALLOW_ORIGIN
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// --- Upstash REST helper (без зависимостей) ---
const REDIS_URL = KV_REST_API_URL || UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = KV_REST_API_TOKEN || UPSTASH_REDIS_REST_TOKEN || '';

async function redis(cmd, ...args) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const body = { cmd: [cmd, ...args] };
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) return null;
  const data = await r.json().catch(() => null);
  return data?.result ?? null;
}

// --- Rate Limit: max 20 запросов за 5 минут на IP ---
async function rateLimit(ip) {
  try {
    if (!REDIS_URL || !REDIS_TOKEN) return { ok: true };
    const key = `form:rate:${ip}`;
    const count = await redis('INCR', key);
    if (Number(count) === 1) await redis('EXPIRE', key, 300); // 5 минут
    if (Number(count) > 20) return { ok: false, reason: 'rate' };
    return { ok: true };
  } catch {
    // если редис недоступен — не ломаем отправку
    return { ok: true };
  }
}

// --- Утилиты ---
const json = (res, status, data, corsOrigin) => {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.send(JSON.stringify(data));
};

const okOrigin = origin =>
  origin && ALLOWED.some(allowed => allowed.toLowerCase() === origin.toLowerCase());

// форматирование телефона по E.164 -> "+7 (927) 127-85-33" для RU/KZ; иначе просто E.164
function formatPhoneE164(e164) {
  const s = String(e164 || '').replace(/[^\d+]/g, '');
  if (!s.startsWith('+')) return s || '';
  const digits = s.replace(/\D/g, '');
  // +7XXXXXXXXXX (11 цифр включая "7")
  if (digits.length === 11 && digits.startsWith('7')) {
    const p = digits;
    return `+7 (${p.slice(1, 4)}) ${p.slice(4, 7)}-${p.slice(7, 9)}-${p.slice(9, 11)}`;
  }
  // +375XXXXXXXXX (BY)
  if (digits.length === 13 && digits.startsWith('375')) {
    const cc = '+375';
    const rest = digits.slice(3);
    return `${cc} (${rest.slice(0, 2)}) ${rest.slice(2, 5)}-${rest.slice(5, 7)}-${rest.slice(7, 9)}`;
  }
  // fallback: как есть
  return s;
}

// Страна по ISO2, если фронт не прислал — по коду
function countryFromPayload({ country_name, country_iso, country_dial, phone_e164 }) {
  if (country_name) return country_name;
  const mapDial = {
    '7': 'Россия',
    '375': 'Беларусь',
    '76': 'Казахстан',
    '77': 'Казахстан',
  };
  const dial = String(country_dial || '').trim();
  if (mapDial[dial]) return mapDial[dial];
  const m = String(phone_e164 || '').match(/^\+(\d{1,3})/);
  if (m && mapDial[m[1]]) return mapDial[m[1]];
  if (country_iso) return country_iso.toUpperCase();
  return '-';
}

// Ограничение длины для телеги
const clip = (s, n = 600) => (s && s.length > n ? s.slice(0, n) + '…' : (s || ''));

// Телега
async function tgSend(chatId, text) {
  if (!TG_TOKEN || !chatId) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  }).catch(() => null);
}

// --- Handler ---
export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const corsOrigin = okOrigin(origin) ? origin : '';

  // Preflight
  if (req.method === 'OPTIONS') {
    if (!corsOrigin) return json(res, 403, { ok: false, error: 'forbidden' });
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return json(res, 405, { ok: false, error: 'method_not_allowed' }, corsOrigin);
  }

  if (!corsOrigin) {
    return json(res, 403, { ok: false, error: 'forbidden' });
  }

  // Читаем тело
  let body = {};
  try {
    body = req.body && typeof req.body === 'object'
      ? req.body
      : JSON.parse(req.body || '{}');
  } catch {
    return json(res, 400, { ok: false, error: 'invalid_json' }, corsOrigin);
  }

  const ip =
    req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    '0.0.0.0';

  // Honeypot / таймер
  if (String(body.hp || '').trim() !== '') {
    return json(res, 200, { ok: true, bot: true }, corsOrigin);
  }
  if (Number(body.t || 0) < 500) {
    return json(res, 400, { ok: false, error: 'too_fast' }, corsOrigin);
  }

  // Rate limit
  const rl = await rateLimit(ip);
  if (!rl.ok) {
    return json(res, 429, { ok: false, error: 'rate_limited' }, corsOrigin);
  }

  // Валидация
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const phone_national = String(body.phone || '').trim(); // то, что ввёл пользователь
  const phone_e164 = String(body.phone_e164 || '').trim();
  const subscribe = !!body.subscribe;
  const userMsg = String(body.message || '').trim();

  if (!name) return json(res, 400, { ok: false, error: 'name' }, corsOrigin);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json(res, 400, { ok: false, error: 'email' }, corsOrigin);
  }
  if (!/^\+\d{8,15}$/.test(phone_e164)) {
    return json(res, 400, { ok: false, error: 'phone' }, corsOrigin);
  }

  const when = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const url = String(body.url || origin || '-');
  const ua = String(body.ua || req.headers['user-agent'] || '-');
  const policy_version = String(body.policy_version || '-');

  const country = countryFromPayload(body);
  const phoneFormatted = formatPhoneE164(phone_e164);

  // --- ПУБЛИЧНОЕ сообщение (добавили Сообщение:) ---
  const pub =
    `🎟 Новая заявка\n` +
    `Имя: ${name}\n` +
    `Email: ${email}\n` +
    `Страна: ${country}\n` +
    `Телефон: ${phoneFormatted}\n` +
    (userMsg ? `Сообщение: ${clip(userMsg)}\n` : '') +
    `Подписка: ${subscribe ? 'да' : 'нет'}\n` +
    `URL: ${url}`;

  // --- АДМИНСКОЕ (подробно) ---
  const adm =
    `Заявка (подробно)\n` +
    `Имя: ${name}\n` +
    `Email: ${email}\n` +
    `Телефон: ${phoneFormatted}\n` +
    `E164: ${phone_e164}\n` +
    `Страна: ${country}\n` +
    `Подписка: ${subscribe ? 'да' : 'нет'}\n` +
    (userMsg ? `Сообщение: ${clip(userMsg, 1200)}\n` : '') +
    `Политика: ${policy_version}\n` +
    `Когда: ${when}\n` +
    `URL: ${url}\n` +
    `UA: ${ua}\n` +
    `IP: ${ip}\n` +
    `Origin: ${origin || '-'}`;

  try {
    // отправка в телеграм
    await tgSend(TG_CHAT, pub);
    await tgSend(TG_ADMIN, adm);
  } catch (e) {
    return json(res, 500, { ok: false, error: 'tg_send_failed' }, corsOrigin);
  }

  return json(res, 200, { ok: true }, corsOrigin);
}

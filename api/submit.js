// api/submit.js
// Serverless handler for Tilda form -> Telegram + (optional) Upstash KV ratelimit

// ---------- helpers ----------
const json = (res, code, data, extraHeaders = {}) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(data));
};

const text = (res, code, body, extraHeaders = {}) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(body ?? '');
};

function pickEnv() {
  const e = process.env;
  return {
    tgToken: e.TG_TOKEN || e.TELEGRAM_BOT_TOKEN,
    tgChat: e.TG_CHAT || e.TELEGRAM_CHAT_ID,          // публичный канал/чат
    tgAdmin: e.TG_ADMIN || e.ADMIN_CHAT_ID,           // админ канал/чат
    allowOrigin: (e.ALLOW_ORIGIN || e.ALLOW_ORIGINS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),

    // Upstash REST (KV)
    kvUrl: e.KV_REST_API_URL || e.UPSTASH_REDIS_REST_URL || e.UPSTASH_REDIS_REST_API_URL,
    kvToken: e.KV_REST_API_TOKEN || e.UPSTASH_REDIS_REST_TOKEN || e.UPSTASH_REDIS_REST_API_TOKEN,

    // ratelimit
    RATE_LIMIT: Number(e.RATE_LIMIT || 10),      // запросов
    RATE_WINDOW: Number(e.RATE_WINDOW || 300),   // сек
  };
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
  };
}

function originAllowed(origin, allowList) {
  if (!allowList.length) return false;
  if (!origin) return false;
  try {
    const o = new URL(origin);
    return allowList.some(item => {
      try {
        const a = new URL(item.includes('://') ? item : `https://${item}`);
        return a.hostname === o.hostname;
      } catch { return false; }
    });
  } catch {
    return false;
  }
}

async function tgSend(token, chatId, text, parseMode = 'HTML', disablePreview = true) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: disablePreview
    }),
  });
  const j = await r.json().catch(()=> ({}));
  return { ok: r.ok && j.ok, status: r.status, body: j };
}

// форматируем E.164 в вид “+7 (927) 127-85-33” (простая маска для RU/KZ/BY, иначе — как есть)
function prettyPhone(e164, fallbackNational) {
  if (!e164 || !e164.startsWith('+')) return fallbackNational || '';
  // RU/KZ/UA/BY приблизительно
  const digits = e164.replace(/[^\d]/g, '');
  // +7XXXXXXXXXX
  if (/^\+?7\d{10}$/.test(e164)) {
    const d = digits.slice(-10);
    return `+7 (${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6,8)}-${d.slice(8,10)}`;
  }
  // +375XXXXXXXXX
  if (/^\+?375\d{9}$/.test(e164)) {
    const d = digits.slice(-9);
    return `+375 (${d.slice(0,2)}) ${d.slice(2,5)}-${d.slice(5,7)}-${d.slice(7,9)}`;
  }
  // по умолчанию
  return e164;
}

// Upstash KV REST helpers
async function kvCmd(kvUrl, kvToken, cmd, ...args) {
  const path = [cmd, ...args.map(encodeURIComponent)].join('/');
  const r = await fetch(`${kvUrl}/${path}`, {
    headers: { Authorization: `Bearer ${kvToken}` },
    cache: 'no-store',
  });
  return r.json();
}

async function rateLimit(env, key) {
  if (!env.kvUrl || !env.kvToken) return { ok: true, count: 1 };
  // INCR
  const inc = await kvCmd(env.kvUrl, env.kvToken, 'INCR', key);
  const count = Number(inc?.result ?? 1);
  if (count === 1) {
    // первый инкремент — ставим TTL
    await kvCmd(env.kvUrl, env.kvToken, 'EXPIRE', key, String(env.RATE_WINDOW));
  }
  return { ok: count <= env.RATE_LIMIT, count };
}

// ---------- main handler ----------
export default async function handler(req, res) {
  const env = pickEnv();
  const origin = req.headers.origin;
  const allowed = originAllowed(origin, env.allowOrigin);
  const cors = allowed ? corsHeaders(origin) : corsHeaders(env.allowOrigin[0] || '*');

  // CORS preflight
  if (req.method === 'OPTIONS') {
    // Если origin не в белом списке — всё равно отвечаем 204, но фронту POST всё равно вернём 403
    res.statusCode = 204;
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    return res.end();
  }

  if (!allowed) {
    return json(res, 403, { ok: false, error: 'Origin not allowed' }, cors);
  }

  if (req.method !== 'POST') {
    return json(res, 405, { ok: false, error: 'Method not allowed' }, cors);
  }

  // ---- parse body
  let body = {};
  try {
    body = await new Promise((resolve, reject) => {
      let data = '';
      req.on('data', c => (data += c));
      req.on('end', () => {
        try { resolve(JSON.parse(data || '{}')); }
        catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  } catch {
    return json(res, 400, { ok: false, error: 'Invalid JSON' }, cors);
  }

  // ---- basic validation
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const phoneNational = String(body.phone || '').trim();
  const phoneE164 = String(body.phone_e164 || '').trim();
  const msg = String(body.message || '').trim();
  const subscribe = !!body.subscribe;
  const countryName = String(body.country_name || '').trim();
  const countryDial = String(body.country_dial || '').trim();
  const url = String(body.url || '').trim();
  const ua = String(body.ua || '').trim();
  const hp = String(body.hp || '').trim();

  if (hp) return json(res, 200, { ok: true, spam: true }, cors); // honeypot

  const bad = [];
  if (!name) bad.push('name');
  // простой email чек
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad.push('email');
  if (!phoneE164 || !/^\+\d{8,15}$/.test(phoneE164)) bad.push('phone');
  if (bad.length) return json(res, 422, { ok: false, error: 'Validation failed', fields: bad }, cors);

  // ---- ratelimit (IP + UA + Origin)
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '0.0.0.0';
  const rlKey = `rl:${ip}:${(ua || '').slice(0,48)}`;
  const rl = await rateLimit(env, rlKey);
  if (!rl.ok) {
    return json(res, 429, { ok: false, error: 'Too many requests', count: rl.count }, cors);
  }

  // ---- compose messages
  const pretty = prettyPhone(phoneE164, phoneNational);
  const lines = [
    '🎟 <b>Новая заявка</b>',
    `Имя: ${escapeHtml(name)}`,
    `Email: ${escapeHtml(email)}`,
    countryName ? `Страна: ${escapeHtml(countryName)}` : null,
    `Телефон: ${escapeHtml(pretty)}`,
    `Подписка: ${subscribe ? 'да' : 'нет'}`,
    msg ? `Сообщение: ${escapeHtml(msg)}` : null,
    url ? `URL: ${escapeHtml(url)}` : null,
  ].filter(Boolean);
  const publicText = lines.join('\n');

  const adminLines = [
    '🧾 <b>Заявка (подробно)</b>',
    `Имя: ${escapeHtml(name)}`,
    `Email: ${escapeHtml(email)}`,
    countryName ? `Страна: ${escapeHtml(countryName)}` : null,
    `Телефон: ${escapeHtml(pretty)} (${escapeHtml(phoneE164)})`,
    `Подписка: ${subscribe ? 'да' : 'нет'}`,
    msg ? `Сообщение: ${escapeHtml(msg)}` : null,
    url ? `URL: ${escapeHtml(url)}` : null,
    ua ? `UA: ${escapeHtml(ua)}` : null,
    `IP: ${escapeHtml(ip)}`,
    `Origin: ${escapeHtml(origin || '')}`
  ].filter(Boolean);
  const adminText = adminLines.join('\n');

  // ---- send to Telegram
  let pubRes = { ok: false }, admRes = { ok: false };
  try {
    if (env.tgToken && env.tgChat) {
      pubRes = await tgSend(env.tgToken, env.tgChat, publicText);
    }
    if (env.tgToken && env.tgAdmin) {
      admRes = await tgSend(env.tgToken, env.tgAdmin, adminText);
    }
  } catch {}

  const ok = !!(pubRes.ok || admRes.ok);
  if (!ok) {
    return json(res, 502, { ok: false, error: 'Telegram delivery failed', pubRes, admRes }, cors);
  }

  return json(res, 200, { ok: true, pub: pubRes.ok, admin: admRes.ok }, cors);
}

// ---------- utils ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => (
    m === '&' ? '&amp;' :
    m === '<' ? '&lt;' :
    m === '>' ? '&gt;' :
    m === '"' ? '&quot;' : '&#39;'
  ));
}

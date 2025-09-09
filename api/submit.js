// /api/submit.js
export default async function handler(req, res) {
  // ---------- CORS ----------
  const origin = req.headers.origin || '';
  const allow = (process.env.ALLOW_ORIGIN || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (allow.length === 0 || allow.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', allow.length ? origin : '*');
  } else {
    return res.status(403).json({ ok: false, error: 'Origin not allowed' });
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // ---------- Rate limit (Upstash REST) ----------
  const clientIp = getClientIp(req);
  const rl = await checkRateLimit(clientIp).catch(() => ({ limited: false, remaining: 20, resetSec: 0 }));
  if (rl.limited) {
    res.setHeader('Retry-After', String(rl.resetSec || 60));
    return res.status(429).json({ ok: false, error: 'Too many requests' });
  }

  // ---------- Payload ----------
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const {
    name = '',
    email = '',
    phone = '',
    phone_e164 = '',
    subscribe = false,
    policy_version = '',
    ua = '',
    url = '',
    hp = '',
    t = 0,
    country = '' // можно присылать с фронта; иначе возьмём из хедера Vercel
  } = body;

  // anti-bot
  if (hp) return res.status(400).json({ ok: false, error: 'Bot detected' });
  if (t && Number(t) < 500) return res.status(400).json({ ok: false, error: 'Bot detected' });

  // ---------- Server-side validation ----------
  if (!isValidName(name))   return res.status(400).json({ ok: false, error: 'Bad name' });
  if (!isValidEmail(email)) return res.status(400).json({ ok: false, error: 'Bad email' });

  const e164 = String(phone_e164 || '').trim();
  if (!/^\+\d{8,15}$/.test(e164)) {
    return res.status(400).json({ ok: false, error: 'Bad phone' });
  }

  // ---------- Telegram config ----------
  const token   = process.env.TG_TOKEN;
  const chatId  = process.env.TG_CHAT;
  const adminId = process.env.TG_ADMIN;

  if (!token || !chatId) {
    return res.status(500).json({ ok: false, error: 'Server not configured: TG_TOKEN/TG_CHAT' });
  }

  // ---------- Compose messages ----------
  const when = new Date().toLocaleString('ru-RU');
  const headerCountry = req.headers['x-vercel-ip-country'] || '';
  const countryFinal = (country || headerCountry || '-').toString();

  const yesno = subscribe ? 'да' : 'нет';

  const mainText = [
    '📬 <b>Новая заявка</b>',
    `Имя: ${escapeHTML(name)}`,
    `Email: ${escapeHTML(email)}`,
    `Телефон: ${escapeHTML(e164 || phone)}`,
    `Страна: ${escapeHTML(countryFinal)}`,
    `Подписка: ${yesno}`,
    `Страница: ${escapeHTML(url || '-')}`
  ].join('\n');

  const adminText = [
    '🛠 <b>Новая заявка (расширенная)</b>',
    `Имя: ${escapeHTML(name)}`,
    `Email: ${escapeHTML(email)}`,
    `Телефон: ${escapeHTML(e164 || phone)}`,
    `Страна (client/header): ${escapeHTML(country || '')} / ${escapeHTML(headerCountry)}`,
    `Подписка: ${yesno}`,
    `Политика: ${escapeHTML(policy_version || '-')}`,
    `Время: ${when}`,
    `URL: ${escapeHTML(url || '-')}`,
    `UA: ${escapeHTML(ua || '-')}`,
    `IP: ${escapeHTML(clientIp)}`,
    `RL: осталось ${rl.remaining ?? '-'}; окно ${rl.resetSec ? rl.resetSec + 'с' : '-'}`
  ].join('\n');

  // ---------- Send to Telegram ----------
  const sendMain  = sendTG(token, chatId,  mainText);
  const sendAdmin = adminId ? sendTG(token, adminId, adminText) : Promise.resolve({ ok: true });

  const [rMain, rAdm] = await Promise.all([sendMain, sendAdmin]).catch(() => [{ ok: false }, { ok: false }]);

  if (!rMain.ok) {
    return res.status(502).json({ ok: false, error: 'Telegram error (main)', details: rMain });
  }
  if (adminId && !rAdm.ok) {
    // не валим заявку, просто сообщаем что админ-уведомление не дошло
    return res.status(200).json({ ok: true, warn: 'Admin notify failed' });
  }

  return res.status(200).json({ ok: true });
}

/* ===================== helpers ===================== */

function getClientIp(req) {
  const xf = (req.headers['x-forwarded-for'] || '').toString();
  const ip = xf.split(',')[0].trim() || req.headers['x-real-ip'] || req.socket?.remoteAddress || '';
  return ip.toString();
}

function isValidName(v) {
  const s = String(v || '').trim();
  return s.length >= 2 && s.length <= 80;
}
function isValidEmail(v) {
  const s = String(v || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

function escapeHTML(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Upstash REST (Redis) — фиксированное окно 5 минут, лимит 20
async function checkRateLimit(ip) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  const WINDOW = 300;  // секунд
  const LIMIT  = 20;

  if (!url || !token) return { limited: false, remaining: LIMIT, resetSec: 0 };

  const key = `rl:submit:${ip}`;

  const r = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      commands: [
        ['INCR', key],
        ['EXPIRE', key, String(WINDOW), 'NX'],
        ['PTTL', key]
      ]
    })
  });

  const out = await r.json().catch(() => null);
  const count = Number(out?.[0]?.result ?? 0);
  const pttl  = Number(out?.[2]?.result ?? WINDOW * 1000);
  const reset = Math.max(0, Math.ceil(pttl / 1000));

  return { limited: count > LIMIT, remaining: Math.max(0, LIMIT - count), resetSec: reset };
}

async function sendTG(token, chatId, text) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
  const json = await resp.json().catch(() => null);
  return { ok: resp.ok && json?.ok, status: resp.status, json };
}

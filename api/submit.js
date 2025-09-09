// api/submit.js
// Встроено:
// - CORS c белым списком из ALLOW_ORIGIN (через запятую)
// - Валидация входных данных
// - Отправка в два чата Telegram (TG_CHAT — “клиентский”, TG_ADMIN — “полный”)
// - Rate limit на Upstash (IP + Origin): limit 20 за 5 минут

function pickKvEnv() {
  const candidates = [
    ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
    ['UPSTASH_REDIS_REST_API_URL', 'UPSTASH_REDIS_REST_API_TOKEN'],
  ];
  for (const [u, t] of candidates) {
    const url = process.env[u];
    const token = process.env[t];
    if (url && token) {
      return { url, token, urlVar: u, tokenVar: t };
    }
  }
  return null;
}

// простая обёртка над REST API Upstash Redis
async function kv(cmd, args = [], env) {
  // GET/SET/INCR/EXPIRE/... — всё работает через путь
  const parts = [cmd, ...args.map(x => encodeURIComponent(String(x)))];
  const url = `${env.url}/${parts.join('/')}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${env.token}` } });
  const data = await r.json().catch(() => ({}));
  return data;
}

// rate limit: INCR ключ и, если это первый инкремент, ставим EXPIRE
// вернёт { ok: true/false, count, resetSec }
async function rateLimit({ key, limit = 10, windowSec = 300 }, env) {
  // INCR
  const inc = await kv('INCR', [key], env); // { result: number }
  const count = Number(inc?.result ?? 0);

  if (count === 1) {
    // первый запрос в окне — задаём TTL
    await kv('EXPIRE', [key, windowSec], env);
  }

  return {
    ok: count <= limit,
    count,
    resetSec: windowSec,
  };
}

function parseAllowedOrigins(str) {
  return String(str || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function corsHeaders(origin, allowed) {
  const allow = allowed.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allow || '*', // можно оставить '*' если хотите принимать отовсюду
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function htmlEscape(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtPhoneWithCode(national, e164) {
  // national: как пришло с фронта: "(927) 127-85-33"
  // e164: "+79271278533"
  if (!e164) return national || '';
  // вытащим набор цифр национального и вставим пробел после кода страны из e164
  const m = /^\+(\d{1,3})(\d+)$/.exec(e164);
  if (!m) return national || e164;
  const cc = m[1];
  const rest = m[2];
  // Если national задан — используем его как формат после кода
  if (national) {
    return `+${cc} ${national}`.replace(/\s+/g, ' ').trim();
  }
  // fallback простым форматированием
  return `+${cc} ${rest}`;
}

async function sendTg(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok && data?.ok, status: r.status, data };
}

export default async function handler(req, res) {
  const ALLOW_ORIGIN = parseAllowedOrigins(process.env.ALLOW_ORIGIN || process.env.ORIGINS || '');
  const cors = corsHeaders(req.headers.origin || '', ALLOW_ORIGIN);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).set(cors).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).set(cors).json({ ok: false, error: 'Method Not Allowed' });
  }

  try {
    // Origin check
    const origin = req.headers.origin || '';
    if (ALLOW_ORIGIN.length && !ALLOW_ORIGIN.includes(origin)) {
      return res.status(403).set(cors).json({ ok: false, error: 'Forbidden origin' });
    }

    // Body
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const {
      name = '',
      email = '',
      phone = '',
      phone_e164 = '',
      country_name = '',
      country_iso = '',
      country_dial = '',
      subscribe = false,
      message = '',
      policy_version = '',
      url = '',
      ua = '',
      hp = '',
      t = 0,
    } = body;

    // Honeypot
    if (hp && String(hp).trim() !== '') {
      return res.status(200).set(cors).json({ ok: true, skipped: true });
    }

    // Server validation (минимум)
    const bad =
      !name.trim() ||
      !email.trim() ||
      !phone_e164 ||
      !/^\+\d{8,15}$/.test(String(phone_e164)) ||
      body.agree === false; // на фронте required, но дублируем
    if (bad) {
      return res.status(400).set(cors).json({ ok: false, error: 'Validation failed' });
    }

    // Rate limit
    const kvEnv = pickKvEnv();
    if (kvEnv) {
      const ip =
        (req.headers['x-real-ip'] ||
          (req.headers['x-forwarded-for'] || '').toString().split(',')[0] ||
          req.socket?.remoteAddress ||
          'unknown') + '';
      const key = `rl:ip:${ip}:o:${origin.replace(/^https?:\/\//, '')}`;
      const { ok: pass, count } = await rateLimit({ key, limit: 20, windowSec: 300 }, kvEnv);
      if (!pass) {
        return res.status(429).set(cors).json({ ok: false, error: 'Too many requests' });
      }
    }

    // Сообщение для обычного чата (краткое)
    const shortLines = [
      '🎟 <b>Новая заявка</b>',
      `Имя: ${htmlEscape(name)}`,
      `Email: ${htmlEscape(email)}`,
      country_name ? `Страна: ${htmlEscape(country_name)}` : '',
      `Телефон: ${htmlEscape(fmtPhoneWithCode(phone, phone_e164))}`,
      `Подписка: ${subscribe ? 'да' : 'нет'}`,
      url ? `URL: ${htmlEscape(url)}` : '',
    ].filter(Boolean);

    // Сообщение для админа (полное)
    const adminLines = [
      '🧾 <b>Заявка (подробно)</b>',
      `Имя: ${htmlEscape(name)}`,
      `Email: ${htmlEscape(email)}`,
      `Телефон: ${htmlEscape(fmtPhoneWithCode(phone, phone_e164))}`,
      phone_e164 ? `E164: ${htmlEscape(phone_e164)}` : '',
      country_name ? `Страна: ${htmlEscape(country_name)}` : '',
      country_iso ? `ISO: ${htmlEscape(country_iso)}` : '',
      country_dial ? `Код: +${htmlEscape(country_dial)}` : '',
      `Подписка: ${subscribe ? 'да' : 'нет'}`,
      policy_version ? `Политика: ${htmlEscape(policy_version)}` : '',
      url ? `URL: ${htmlEscape(url)}` : '',
      `UA: ${htmlEscape(ua)}`,
      `IP: ${htmlEscape(
        (req.headers['x-real-ip'] ||
          (req.headers['x-forwarded-for'] || '').toString().split(',')[0] ||
          req.socket?.remoteAddress ||
          ''
        ).toString()
      )}`,
      origin ? `Origin: ${htmlEscape(origin.replace(/^https?:\/\//, ''))}` : '',
      message ? `\n💬 Сообщение:\n${htmlEscape(message)}` : '',
    ];

    const TG_TOKEN = process.env.TG_TOKEN;
    const TG_CHAT = process.env.TG_CHAT;   // канал/группа "Заявки БСЗ"
    const TG_ADMIN = process.env.TG_ADMIN; // канал/группа "полная информация"

    if (!TG_TOKEN || (!TG_CHAT && !TG_ADMIN)) {
      return res.status(500).set(cors).json({ ok: false, error: 'Telegram env missing' });
    }

    // Отправляем
    const results = [];
    if (TG_CHAT) {
      results.push(await sendTg(TG_TOKEN, TG_CHAT, shortLines.join('\n')));
    }
    if (TG_ADMIN) {
      results.push(await sendTg(TG_TOKEN, TG_ADMIN, adminLines.join('\n')));
    }

    const ok = results.every(r => r.ok);

    return res.status(ok ? 200 : 502).set(cors).json({
      ok,
      delivered: results.map(r => ({ ok: r.ok, status: r.status })),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

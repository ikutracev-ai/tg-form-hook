// api/submit.js
export default async function handler(req, res) {
  // --- CORS ---
  const ALLOW = (process.env.ALLOW_ORIGIN || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const origin = req.headers.origin;
  if (origin && ALLOW.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', ALLOW[0] || '*');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    // --- Anti-bot / rate limit (Upstash REST) ---
    const ip =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.headers['x-real-ip'] ||
      req.socket.remoteAddress ||
      '-';

    const limited = await isRateLimited(ip).catch(() => false);
    if (limited) {
      return res.status(429).json({ ok: false, error: 'Too Many Requests' });
    }

    const {
      name = '',
      email = '',
      phone = '',
      phone_e164 = '',
      country_name = '',
      country_iso = '',
      country_dial = '',
      subscribe = false,
      policy_version = '',
      ua = '',
      url = '',
      hp = '',
      t = 0,
    } = req.body || {};

    // honeypot / таймер
    if (hp) return res.status(400).json({ ok: false, error: 'Bot detected' });
    if (Number(t) < 600) {
      return res.status(400).json({ ok: false, error: 'Bot detected' });
    }

    // серверная валидация
    if (!name.trim() || !email.trim() || (!phone && !phone_e164)) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailOk) {
      return res.status(400).json({ ok: false, error: 'Invalid email' });
    }
    if (phone_e164 && !/^\+\d{8,15}$/.test(phone_e164)) {
      return res.status(400).json({ ok: false, error: 'Invalid phone' });
    }

    const token = process.env.TG_TOKEN;
    const chatId = process.env.TG_CHAT;   // публичный канал: короткая карточка
    const adminId = process.env.TG_ADMIN; // админ-канал: полные данные
    if (!token || !chatId || !adminId) {
      return res.status(500).json({ ok: false, error: 'Server not configured: TG_TOKEN/TG_CHAT/TG_ADMIN' });
    }

    // аккуратный вид телефона для сообщений
    const nat = (phone || '').replace(/^8\s*/, '').trim(); // если человек ввёл «8 …», уберём
    const dial = (country_dial || '').toString().replace(/^\+/, '');
    const phoneDisplay =
      dial && nat ? `+${dial} ${nat}` : (phone_e164 || nat || '-');

    const countryDisplay =
      country_name || (dial ? `+${dial}` : '');

    // ===== Сообщение в публичный канал =====
    const shortText =
`🎟 Новая заявка
Имя: ${name}
Email: ${email}
Страна: ${countryDisplay || '—'}

Телефон: ${phoneDisplay}
Подписка: ${subscribe ? 'да' : 'нет'}

URL: ${url || '—'}`;

    // ===== Сообщение в админ-канал (подробно) =====
    const now = new Date().toLocaleString('ru-RU');
    const adminText =
`Заявка БСЗ полная информация
📄 Заявка (подробно)
Имя: ${name}
Email: ${email}
Телефон: ${phoneDisplay}
E164: ${phone_e164 || '—'}
Страна: ${country_name || '—'}${country_iso ? ` (${country_iso.toUpperCase()})` : ''}${dial ? `  +${dial}` : ''}
Подписка: ${subscribe ? 'да' : 'нет'}
Политика: ${policy_version || '—'}
Когда: ${now}
URL: ${url || '—'}
UA: ${ua || req.headers['user-agent'] || '—'}
IP: ${ip}
Origin: ${origin || '—'}`;

    // Отправка в Телеграм
    const tg = (text, id) =>
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: id, text }),
      });

    const [pubRes, admRes] = await Promise.all([
      tg(shortText, chatId),
      tg(adminText, adminId),
    ]);

    const ok = pubRes.ok && admRes.ok;
    if (!ok) {
      const a = await pubRes.json().catch(() => null);
      const b = await admRes.json().catch(() => null);
      return res.status(502).json({ ok: false, error: 'Telegram error', details: { pub: a, adm: b } });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

/* -------------------------------------------
   Upstash REST rate-limit по IP (60/5мин)
-------------------------------------------- */
async function isRateLimited(ip) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_API_TOKEN;
  if (!url || !token) return false;

  const key = `rl:${ip}`;
  const windowSec = 300;  // 5 минут
  const limit = 60;

  // LUA скрипт: инкремент + TTL
  const script =
    "local c=redis.call('INCR', KEYS[1]); if c==1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return c";

  const r = await fetch(`${url}/eval`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ script, keys: [key], args: [String(windowSec)] }),
  });

  const json = await r.json().catch(() => ({}));
  const count = Number(json?.result ?? json);
  return Number.isFinite(count) && count > limit;
}

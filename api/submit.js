// /api/submit.js
export default async function handler(req, res) {
  // ---------- CORS (по hostname, а не по протоколу) ----------
  const allowedHosts = (process.env.ALLOW_ORIGIN || '')
    .split(',')
    .map(s => s.trim().replace(/^https?:\/\//, ''))
    .filter(Boolean); // например: ['gkbsz.su','www.gkbsz.su']

  const origin = req.headers.origin || '';
  let originHost = '';
  try { originHost = new URL(origin).hostname; } catch {}

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    // preflight всегда 200
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    return res.status(200).end();
  }

  const corsOk = origin && allowedHosts.includes(originHost);
  if (corsOk) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    return res
      .status(403)
      .json({ ok: false, error: 'Origin not allowed', origin, originHost });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // ---------- Чтение/валидация входных данных ----------
  try {
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
    } = req.body || {};

    // Антибот
    if (hp && String(hp).trim() !== '') {
      return res.status(400).json({ ok: false, error: 'Bot detected' });
    }
    if (Number(t) < 600) {
      return res.status(400).json({ ok: false, error: 'Too fast' });
    }

    // Простая серверная валидация
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email));
    const phoneOk = /^\+\d{8,15}$/.test(String(phone_e164)); // E.164
    const nameOk = String(name).trim().length >= 2;

    if (!nameOk || !emailOk || !phoneOk) {
      return res.status(400).json({
        ok: false,
        error: 'Missing or invalid fields',
        details: { nameOk, emailOk, phoneOk },
      });
    }

    // ---------- Rate limit (Upstash Redis REST) — опционально ----------
    const ip =
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket?.remoteAddress ||
      '0.0.0.0';

    const rateLimitOk = await tryRateLimit(ip, 20, 300); // 20 запросов за 5 минут
    if (!rateLimitOk) {
      return res.status(429).json({ ok: false, error: 'Too many requests' });
    }

    // ---------- Формирование сообщений ----------
    const now = new Date();
    const when = now.toLocaleString('ru-RU');
    const shortText =
      `🎟 Новая заявка\n` +
      `Имя: ${name}\n` +
      `Email: ${email}\n` +
      `Телефон: ${phone || phone_e164}\n` +
      `Подписка: ${subscribe ? 'да' : 'нет'}\n` +
      `Политика: ${policy_version || '-'}\n` +
      `Время: ${when}\n` +
      `URL: ${url || '-'}\n` +
      `UA: ${ua || '-'}`;

    const fullText =
      `🧾 Заявка (подробно)\n` +
      `Имя: ${name}\n` +
      `Email: ${email}\n` +
      `Телефон: ${phone || phone_e164}\n` +
      `E164: ${phone_e164}\n` +
      `Подписка: ${subscribe ? 'да' : 'нет'}\n` +
      `Политика: ${policy_version || '-'}\n` +
      `Когда: ${when}\n` +
      `URL: ${url || '-'}\n` +
      `UA: ${ua || '-'}\n` +
      `IP: ${ip}\n` +
      `Origin: ${origin}`;

    // ---------- Отправка в Telegram ----------
    const token = process.env.TG_TOKEN;
    const chatId = process.env.TG_CHAT;
    const adminId = process.env.TG_ADMIN;

    if (!token || !chatId) {
      return res
        .status(500)
        .json({ ok: false, error: 'Server not configured: TG_TOKEN/TG_CHAT' });
    }

    const tgBase = `https://api.telegram.org/bot${token}`;

    // 1) короткая — в основной канал
    const r1 = await fetch(`${tgBase}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: shortText }),
    });

    // 2) полная — админу (если указан TG_ADMIN)
    let r2ok = true;
    if (adminId) {
      const r2 = await fetch(`${tgBase}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: adminId, text: fullText }),
      });
      r2ok = r2.ok;
    }

    if (!r1.ok || !r2ok) {
      const j1 = await safeJson(r1);
      return res.status(502).json({
        ok: false,
        error: 'Telegram error',
        details: j1 || {},
      });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * Мягкий rate-limit через Upstash Redis REST API.
 * поддерживаются переменные:
 *  - KV_REST_API_URL + KV_REST_API_TOKEN
 *  - или UPSTASH_REDIS_REST_API_URL + UPSTASH_REDIS_REST_API_TOKEN
 * Если ничего не задано — возвращает true (без ограничения).
 */
async function tryRateLimit(ip, limit = 20, ttlSec = 300) {
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_KV_REST_API_URL || // на случай других префиксов
    process.env.UPSTASH_REDIS_REST_KV_API_URL ||
    '';

  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_KV_API_TOKEN ||
    '';

  if (!url || !token) return true;

  const key = `ratelimit:${ip}`;
  try {
    // INCR
    const incr = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ cmd: 'INCR', args: [key] }),
    });
    const incrJson = await safeJson(incr);
    const count = Array.isArray(incrJson) ? incrJson[1] : incrJson?.result ?? 0;

    if (Number(count) === 1) {
      // первый инкремент — ставим EXPIRE
      await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cmd: 'EXPIRE', args: [key, ttlSec] }),
      });
    }
    return Number(count) <= Number(limit);
  } catch (e) {
    console.warn('RateLimit error (skipped):', e?.message);
    return true; // не ломаем поток, если RL недоступен
  }
}

async function safeJson(r) {
  try { return await r.json(); } catch { return null; }
}

// Serverless-функция Vercel: /api/submit
// Без TypeScript! Чистый JS, чтобы не было ошибки "Unexpected identifier 'Body'"

import { Redis } from "@upstash/redis";

/* ================================
 * ENV
 * ================================ */
const TG_TOKEN  = process.env.TG_TOKEN;
const TG_CHAT   = process.env.TG_CHAT;     // канал "Заявки БСЗ"
const TG_ADMIN  = process.env.TG_ADMIN;    // канал "полная информация"
const ALLOW     = (process.env.ALLOW_ORIGIN || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// Upstash (опционально — если не задан, то rate limit пропускаем)
let redis = null;
try { redis = Redis.fromEnv(); } catch { /* no redis */ }

/* ================================
 * Утилиты
 * ================================ */
const okOrigin = (origin) => {
  if (!origin) return false;
  const o = origin.toLowerCase();
  return ALLOW.includes(o) || ALLOW.includes(new URL(origin).host);
};

const corsHeaders = (origin) => ({
  "Access-Control-Allow-Origin": okOrigin(origin) ? origin : "",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "600",
  "Vary": "Origin",
  "Content-Type": "application/json; charset=utf-8",
});

const getIp = (req) => {
  const xf = req.headers.get("x-forwarded-for") || "";
  return (xf.split(",")[0] || req.headers.get("x-real-ip") || "").trim();
};

// +7 (XXX) XXX-XX-XX — если не Россия, вернём international как есть
const fmtPhoneForChat = (e164, international) => {
  if (typeof e164 !== "string") return international || "";
  const digits = e164.replace(/[^\d+]/g, "");
  const m = /^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(digits);
  if (m) return `+7 (${m[1]}) ${m[2]}-${m[3]}-${m[4]}`;
  return international || digits;
};

// очень простой чек e-mail
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());

// очень простой чек телефона в E.164
const isE164 = (s) => /^\+\d{8,15}$/.test(String(s || "").trim());

// Rate limit: 20 запросов / 5 минут на IP
const checkRate = async (ip) => {
  if (!redis || !ip) return true; // нет Redis — не лимитим
  const key = `rl:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 300); // 5 минут
  const limit = Number(process.env.RATE_LIMIT_MAX || 20);
  return count <= limit;
};

const sendTG = async (chatId, text, url) => {
  if (!TG_TOKEN || !chatId) return { ok: false, error: "TG env not set" };
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: false,
    ...(url ? { reply_markup: { inline_keyboard: [[{ text: new URL(url).host, url }]] } } : {})
  };
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  return data;
};

/* ================================
 * Handler
 * ================================ */
export default async function handler(req, res) {
  const origin = req.headers.origin || req.headers.get?.("origin");
  const headers = corsHeaders(origin);

  // OPTIONS preflight
  if (req.method === "OPTIONS") {
    if (!okOrigin(origin)) return res.status(403).set(headers).send(JSON.stringify({ ok:false, error:"Forbidden origin" }));
    return res.status(200).set(headers).send(JSON.stringify({ ok:true }));
  }

  // Origin check
  if (!okOrigin(origin)) {
    return res.status(403).set(headers).send(JSON.stringify({ ok:false, error:"Forbidden origin" }));
  }

  if (req.method !== "POST") {
    return res.status(405).set(headers).send(JSON.stringify({ ok:false, error:"Method Not Allowed" }));
  }

  try {
    // Parse body
    const body = typeof req.body === "object" && req.body
      ? req.body
      : JSON.parse(req.body || "{}");

    const {
      name,
      email,
      message = "",
      phone,
      phone_e164,
      phone_international,
      country_name,
      country_iso,
      country_dial,
      subscribe = false,
      policy_version,
      ua,
      url,
      hp = "",
      t,
    } = body || {};

    // Honeypot
    if (hp) {
      return res.status(200).set(headers).send(JSON.stringify({ ok: true, bot: true }));
    }

    // Validate
    if (!name || String(name).trim().length < 2)
      return res.status(400).set(headers).send(JSON.stringify({ ok:false, error:"Bad name" }));
    if (!isEmail(email))
      return res.status(400).set(headers).send(JSON.stringify({ ok:false, error:"Bad email" }));
    if (!isE164(phone_e164))
      return res.status(400).set(headers).send(JSON.stringify({ ok:false, error:"Bad phone" }));

    // Rate limit
    const ip = getIp(req);
    const allowed = await checkRate(ip);
    if (!allowed) {
      return res.status(429).set(headers).send(JSON.stringify({ ok:false, error:"Too Many Requests" }));
    }

    // Country (доверяем фронту; fallback — по dial)
    const cName = (country_name || "").trim() || (country_dial ? `+${country_dial}` : "");
    const phonePretty = fmtPhoneForChat(phone_e164, phone_international);

    /* -------- Short message (TG_CHAT) -------- */
    const shortLines = [
      "🎟 <b>Новая заявка</b>",
      `Имя: ${name}`,
      `Email: ${email}`,
      `Страна: ${cName}`,
      `Телефон: ${phonePretty}`,
      `Подписка: ${subscribe ? "да" : "нет"}`,
      ...(message ? [`Сообщение: ${message}`] : []),
      `URL: ${url || ""}`
    ];
    const shortText = shortLines.join("\n");

    /* -------- Full message (TG_ADMIN) -------- */
    const adminLines = [
      "🧾 <b>Заявка (подробно)</b>",
      `Имя: ${name}`,
      `Email: ${email}`,
      `Телефон: ${phonePretty}`,
      `E164: ${phone_e164}`,
      `Страна: ${cName} ${country_iso ? `(${country_iso})` : ""}`,
      `Подписка: ${subscribe ? "да" : "нет"}`,
      ...(message ? [`Сообщение: ${message}`] : []),
      `Политика: ${policy_version || "-"}`,
      `Когда: ${new Date().toLocaleString("ru-RU")}`,
      `URL: ${url || ""}`,
      `UA: ${ua || "-"}`,
      `IP: ${ip || "-"}`,
      `Origin: ${origin || "-"}`
    ];
    const adminText = adminLines.join("\n");

    // Send to Telegram
    const send1 = TG_CHAT ? await sendTG(TG_CHAT, shortText, url) : { ok: true };
    const send2 = TG_ADMIN ? await sendTG(TG_ADMIN, adminText, url) : { ok: true };

    if (!send1.ok || !send2.ok) {
      return res.status(502).set(headers).send(JSON.stringify({ ok:false, error:"Telegram error", send1, send2 }));
    }

    return res.status(200).set(headers).send(JSON.stringify({ ok:true }));
  } catch (e) {
    console.error(e);
    return res.status(500).set(headers).send(JSON.stringify({ ok:false, error:"Server error" }));
  }
}


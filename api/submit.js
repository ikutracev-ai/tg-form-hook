// /api/submit.js

// ====== SETTINGS / ENV ======
const ORIGINS = (process.env.ALLOW_ORIGIN || process.env.ALLOW_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const FALLBACK_ORIGINS = ['https://gkbsz.su', 'https://www.gkbsz.su']; // запасной белый список

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;   // краткая карточка
const TG_ADMIN = process.env.ADMIN_CHAT_ID || ''; // полный отчёт (опционально)

// ====== UTILS ======
function isValidEmail(s=''){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
function isValidE164(s=''){ return /^\+\d{8,15}$/.test(s); }

function setSecurityHeaders(res){
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

function setCORS(req, res){
  const allow = ORIGINS.length ? ORIGINS : FALLBACK_ORIGINS;
  const origin = req.headers.origin || '';
  if (allow.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return allow.includes(origin);
}

function getIP(req){
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function flagFromISO2(iso2=''){
  if (!iso2) return '🏳️';
  const up = iso2.toUpperCase();
  return [...up].map(ch => String.fromCodePoint(127397 + ch.charCodeAt(0))).join('');
}

async function sendTG(text, chatId){
  if (!TG_TOKEN || !chatId) return { ok:false, error:'TG not configured' };
  const resp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
  });
  const json = await resp.json().catch(()=> ({}));
  return { ok: resp.ok && json.ok, status: resp.status, json };
}

// ====== SIMPLE RATE LIMIT (in-memory) ======
const WINDOW_MS = 5 * 60 * 1000; // 5 минут
const LIMIT = 20;                // 20 запросов за окно
const BUCKET = global.__rl__ || (global.__rl__ = new Map());
function hitRateLimit(ip){
  const now = Date.now();
  const rec = BUCKET.get(ip) || { start: now, count: 0 };
  if (now - rec.start > WINDOW_MS) { rec.start = now; rec.count = 0; }
  rec.count++;
  BUCKET.set(ip, rec);
  return rec.count > LIMIT;
}

// ====== HANDLER ======
export default async function handler(req, res){
  setSecurityHeaders(res);
  const corsOk = setCORS(req, res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ ok:false, error:'Method not allowed' });
  if (!corsOk)                 return res.status(403).json({ ok:false, error:'Forbidden origin' });

  const ip = getIP(req);
  const ua = req.headers['user-agent'] || '-';
  const origin = req.headers.origin || '-';
  const referer = req.headers.referer || '-';

  try{
    if (hitRateLimit(ip)) return res.status(429).json({ ok:false, error:'Too many requests' });

    const {
      name='',
      email='',
      phone='',           // как ввёл пользователь
      phone_e164='',      // строго E.164 (+7…)
      subscribe=false,
      agree=true,         // обязательно передаём с фронта
      policy_version='',
      ua: uaClient='',
      url='',
      country_iso2='',    // <— добавим на фронте
      country_name='',    // <— добавим на фронте
      dial_code='',       // <— добавим на фронте
      hp='',
      t=0
    } = req.body || {};

    // антибот
    if (hp)               return res.status(400).json({ ok:false, error:'Bot detected (hp)' });
    if (Number(t) < 400)  return res.status(400).json({ ok:false, error:'Bot detected (timer)' });

    // валидация
    const fields = [];
    if (!name || name.trim().length < 2) fields.push('name');
    if (!isValidEmail(email))            fields.push('email');
    if (!isValidE164(phone_e164))        fields.push('phone_e164');
    if (!agree)                          fields.push('agree');
    if (fields.length) return res.status(400).json({ ok:false, error:'Validation failed', fields });

    if (!TG_TOKEN || !TG_CHAT)
      return res.status(500).json({ ok:false, error:'Server not configured: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID' });

    // краткая карточка (в обычный чат)
    const flag = flagFromISO2(country_iso2);
    const short =
`📨 Новая заявка
${flag} Страна: ${country_name || country_iso2 || '-'}
📞 Телефон: ${phone_e164 || phone}
👤 Имя: ${name}
✉️ Email: ${email}
🔔 Подписка: ${subscribe ? 'да' : 'нет'}
🔗 Страница: ${url || referer || '-'}`;

    const tg1 = await sendTG(short, TG_CHAT);
    if (!tg1.ok) {
      console.error('TG short error', { ip, status: tg1.status, json: tg1.json });
      await sendTG(`❗️Ошибка короткого сообщения: ${tg1.status}\nIP: ${ip}`, TG_ADMIN);
      return res.status(502).json({ ok:false, error:'Telegram error (short)', details: tg1.json || { status: tg1.status } });
    }

    // полный отчёт (в админ-чат)
    if (TG_ADMIN) {
      const long =
`🧾 Полная заявка
Время: ${new Date().toLocaleString('ru-RU')}
IP: ${ip}
Origin: ${origin}
Referer: ${url || referer || '-'}
UA: ${uaClient || ua}

Поля формы:
- Имя: ${name}
- Email: ${email}
- Телефон (raw): ${phone}
- Телефон (E.164): ${phone_e164}
- Подписка: ${subscribe ? 'да' : 'нет'}
- Политика: ${policy_version || '-'}

Гео:
- ISO2: ${country_iso2 || '-'}
- Название: ${country_name || '-'}
- Dial code: ${dial_code || '-'}`;

      const tg2 = await sendTG(long, TG_ADMIN);
      if (!tg2.ok) {
        console.error('TG admin error', { ip, status: tg2.status, json: tg2.json });
        // не ломаем ответ пользователю, просто логируем
      }
    }

    return res.status(200).json({ ok:true });
  } catch (e) {
    console.error('Submit error', { ip, err: e?.message });
    if (TG_ADMIN) await sendTG(`🔥 5xx в /api/submit\n${e?.message || e}`, TG_ADMIN);
    return res.status(500).json({ ok:false, error:'Server error' });
  }
}

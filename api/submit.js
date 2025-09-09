// serverless-функция Vercel (CommonJS)

const {
  TG_TOKEN,
  TG_CHAT,
  TG_ADMIN,
  ALLOW_ORIGIN = '',
  KV_REST_API_URL,
  KV_REST_API_TOKEN
} = process.env;

// ------- helpers -------

function parseAllowList(str) {
  const bare = (str || '').split(',').map(s => s.trim()).filter(Boolean);
  // для каждого домена добавим http/https и www-варианты
  const out = new Set();
  for (const d of bare) {
    const host = d.replace(/^https?:\/\//, '');
    const variants = [
      `http://${host}`,
      `https://${host}`,
      `http://www.${host.replace(/^www\./, '')}`,
      `https://www.${host.replace(/^www\./, '')}`
    ];
    variants.forEach(v => out.add(v));
  }
  return Array.from(out);
}

const ORIGINS = parseAllowList(ALLOW_ORIGIN);

function corsHeaders(origin) {
  const allow = ORIGINS.includes(origin) ? origin : '';
  const h = {
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600'
  };
  if (allow) h['Access-Control-Allow-Origin'] = allow;
  return h;
}

function getIP(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string') return xf.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '0.0.0.0';
}

async function upstash(cmdPath) {
  if (!KV_REST_API_URL || !KV_REST_API_TOKEN) return null;
  const r = await fetch(`${KV_REST_API_URL}/${cmdPath}`, {
    headers: { Authorization: `Bearer ${KV_REST_API_TOKEN}` }
  });
  return r.ok ? r.json() : null;
}

async function isRateLimited(ip) {
  // 20 запросов в 5 минут на IP
  const key = `rl:${ip}`;
  const r1 = await upstash(`incr/${encodeURIComponent(key)}`);
  const count = Number(r1?.result || 0);
  if (count === 1) await upstash(`expire/${encodeURIComponent(key)}/300`);
  return count > 20;
}

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
}

function isE164(s) {
  return /^\+\d{8,15}$/.test(String(s || '').trim());
}

function countryFromDial(dial) {
  // минимальная карта для СНГ/Европы, fallback "Неизвестно"
  const map = {
    '7': 'Россия/Казахстан',
    '375': 'Беларусь',
    '380': 'Украина',
    '374': 'Армения',
    '373': 'Молдова',
    '992': 'Таджикистан',
    '993': 'Туркменистан',
    '994': 'Азербайджан',
    '996': 'Киргизия',
    '998': 'Узбекистан',
    '995': 'Грузия',
  };
  // ищем самый длинный префикс
  const keys = Object.keys(map).sort((a,b)=>b.length-a.length);
  for (const k of keys) if (dial.startsWith(k)) return map[k];
  return 'Неизвестно';
}

function phonePretty({ phone, dial, e164 }) {
  // если на фронте прислали national в скобках — покажем "+код national"
  const nat = String(phone || '').trim();
  if (dial && nat) return `+${dial} ${nat}`;
  return e164 || nat || '';
}

async function tgSend(chatId, text) {
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text, disable_web_page_preview: true };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}

// ------- handler -------

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  const headers = corsHeaders(origin);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
    res.status(204).send('');
    return;
  }

  if (!ORIGINS.includes(origin)) {
    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(403).json({ ok: false, error: 'Forbidden origin' });
  }

  if (req.method !== 'POST') {
    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  try {
    const ip = getIP(req);

    // rate limit
    if (await isRateLimited(ip)) {
      Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
      return res.status(429).json({ ok: false, error: 'Too Many Requests' });
    }

    // тело (Vercel уже парсит JSON, но на всякий)
    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');

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
      url = '',
      ua = '',
      hp = '',
      t = 0,
      message = ''
    } = body;

    // honeypot / время заполнения
    if (hp && hp.trim().length > 0) {
      Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
      return res.status(200).json({ ok: true }); // тихо игнорим ботов
    }
    if (Number(t) < 800) {
      Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
      return res.status(400).json({ ok: false, error: 'Form filled too fast' });
    }

    // валидация
    if (!String(name).trim()) throw new Error('name');
    if (!isEmail(email)) throw new Error('email');
    if (!isE164(phone_e164)) throw new Error('phone');

    // страна (если фронт не прислал name — пытаемся по dial)
    const country = (country_name || '').split(' (')[0] ||
                    countryFromDial(String(country_dial || phone_e164.replace(/^\+/, '')));

    const phoneLine = phonePretty({ phone, dial: country_dial, e164: phone_e164 });

    // публичное сообщение
    const pub =
      `🎟 Новая заявка\n` +
      `Имя: ${name}\n` +
      `Email: ${email}\n` +
      `Страна: ${country}\n` +
      `Телефон: ${phoneLine}\n` +
      `Подписка: ${subscribe ? 'да' : 'нет'}\n` +
      `URL: ${url}`;

    // админское
    const when = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const adm =
      `Заявка (подробно)\n` +
      `Имя: ${name}\n` +
      `Email: ${email}\n` +
      `Телефон: ${phoneLine}\n` +
      `E164: ${phone_e164}\n` +
      `Страна: ${country} (${country_iso || '-'})\n` +
      `Подписка: ${subscribe ? 'да' : 'нет'}\n` +
      (message ? `Сообщение: ${message}\n` : '') +
      `Политика: ${policy_version || '-'}\n` +
      `Когда: ${when}\n` +
      `URL: ${url}\n` +
      `UA: ${ua}\n` +
      `IP: ${ip}\n` +
      `Origin: ${origin}`;

    // шлём в TG
    await tgSend(TG_CHAT, pub);
    await tgSend(TG_ADMIN, adm);

    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    Object.entries(corsHeaders(origin)).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};

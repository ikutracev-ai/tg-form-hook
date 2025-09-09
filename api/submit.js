// /pages/api/submit.ts  (или /api/submit.js для Vercel)
// Node.js runtime

type Body = {
  name: string;
  email: string;
  phone: string;       // как в инпуте (национальный формат)
  phone_e164: string;  // +79991234567
  subscribe?: boolean;
  policy_version?: string;
  ua?: string;
  url?: string;
  hp?: string;         // honeypot
  t?: number;          // таймер
};

const TG_TOKEN  = process.env.TG_TOKEN!;
const TG_CHAT   = process.env.TG_CHAT!;   // канал "Заявки БСЗ" — короткое сообщение
const TG_ADMIN  = process.env.TG_ADMIN!;  // канал/чат для полной информации

// В .env (Vercel) заполни ТОЛЬКО ПОЛНЫЕ origin'ы через запятую!
const ALLOW = (process.env.ALLOW_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean); // например: http://gkbsz.su,https://gkbsz.su,http://www.gkbsz.su,https://www.gkbsz.su

function isAllowedOrigin(origin?: string) {
  if (!origin) return false;
  // exact match
  return ALLOW.includes(origin);
}

function corsHeaders(origin: string) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Vary': 'Origin',
  };
}

// Определение страны по E.164
function countryFromE164(e164: string): string {
  // нормализуем
  const n = e164.replace(/\s+/g, '');
  if (!n.startsWith('+')) return '—';

  // самые частые коды; отсортировано по длине кода (длинные — раньше)
  const table: Array<[RegExp, string]> = [
    [/^\+375/, 'Беларусь'],
    [/^\+380/, 'Украина'],
    [/^\+373/, 'Молдова'],
    [/^\+374/, 'Армения'],
    [/^\+992/, 'Таджикистан'],
    [/^\+993/, 'Туркменистан'],
    [/^\+994/, 'Азербайджан'],
    [/^\+995/, 'Грузия'],
    [/^\+996/, 'Киргизия'],
    [/^\+998/, 'Узбекистан'],
    [/^\+1/,   'США/Канада'],
    // +7: Россия или Казахстан
    [/^\+7(7|70)/, 'Казахстан'], // большинство номеров KZ начинаются на +77 / +770
    [/^\+7/,      'Россия'],
  ];
  for (const [re, name] of table) if (re.test(n)) return name;
  return '—';
}

function safeText(s: string) {
  return (s || '').toString().trim().slice(0, 500);
}

async function sendTelegram(chatId: string, text: string) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: false }),
  });
  const data = await r.json();
  if (!r.ok || !data.ok) throw new Error(`TG error: ${r.status} ${data?.description || ''}`);
}

export default async function handler(req: any, res: any) {
  const origin = req.headers.origin as string | undefined;

  // --- CORS preflight ---
  if (req.method === 'OPTIONS') {
    if (origin && isAllowedOrigin(origin)) {
      res.setHeader('Access-Control-Max-Age', '86400');
      Object.entries(corsHeaders(origin)).forEach(([k, v]) => res.setHeader(k, v));
      return res.status(200).end();
    }
    return res.status(403).end('Origin not allowed');
  }

  // Разрешаем только POST с разрешённого Origin
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method not allowed' });
  if (!origin || !isAllowedOrigin(origin)) return res.status(403).json({ ok:false, error:'Origin not allowed' });

  // Всегда возвращаем соответствующие CORS заголовки
  Object.entries(corsHeaders(origin)).forEach(([k, v]) => res.setHeader(k, v));

  try {
    const body: Body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    // Honeypot/минимальная валидация
    if (safeText(body.hp)) return res.status(200).json({ ok:true, spam:true });
    const name  = safeText(body.name);
    const email = safeText(body.email);
    const phone = safeText(body.phone);
    const e164  = safeText(body.phone_e164);
    const url   = safeText(body.url);
    const subscribe = !!body.subscribe;

    if (!name)  return res.status(400).json({ ok:false, error:'name' });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok:false, error:'email' });
    if (!e164 || !/^\+\d{8,15}$/.test(e164)) return res.status(400).json({ ok:false, error:'phone' });

    const country = countryFromE164(e164);

    // --- Текст для канала (Заявки БСЗ) ---
    const short =
`🎟 Новая заявка
Имя: ${name}
Email: ${email}
Страна: ${country}

Телефон: ${phone || e164}
Подписка: ${subscribe ? 'да' : 'нет'}

URL: ${url || '—'}`;

    // --- Текст для админ-канала (полная) ---
    const ip  = (req.headers['x-real-ip'] as string) || (req.headers['x-forwarded-for'] as string) || '';
    const ua  = safeText(body.ua || req.headers['user-agent'] as string);
    const when= new Date().toISOString().replace('T',' ').slice(0,19);

    const full =
`📄 Заявка (подробно)
Имя: ${name}
Email: ${email}
Телефон: ${phone}
E164: ${e164}
Страна: ${country}
Подписка: ${subscribe ? 'да' : 'нет'}
Политика: ${safeText(body.policy_version) || '—'}
Когда: ${when}
URL: ${url || '—'}
UA: ${ua}
IP: ${ip}
Origin: ${origin}`;

    // Отправляем в телеграм
    await Promise.all([
      sendTelegram(TG_CHAT,  short),
      sendTelegram(TG_ADMIN, full),
      // превью сайта (картинка/сниппет) — по желанию в оба чата:
      url ? sendTelegram(TG_CHAT,  url) : null,
      url ? sendTelegram(TG_ADMIN, url) : null,
    ]);

    return res.status(200).json({ ok:true });
  } catch (e: any) {
    console.error('submit error', e);
    return res.status(500).json({ ok:false, error: e?.message || 'internal' });
  }
}

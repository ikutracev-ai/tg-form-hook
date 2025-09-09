// api/submit.js — Vercel Serverless (CommonJS)

const TOKEN   = process.env.TG_TOKEN;
const CHAT_ID = process.env.TG_CHAT;
const ADMIN_ID= process.env.TG_ADMIN;
const ORIGINS = String(process.env.ALLOW_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// ----- helpers -----
function allowOrigin(origin){ return ORIGINS.length ? (ORIGINS.includes(origin)? origin : null) : '*'; }
function setCors(res, origin){
  const allowed = allowOrigin(origin);
  if (allowed){ res.setHeader('Access-Control-Allow-Origin', allowed); res.setHeader('Vary','Origin'); }
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
}
function json(res, code, data){ res.statusCode=code; res.setHeader('Content-Type','application/json; charset=utf-8'); res.end(JSON.stringify(data)); }
function ok(res, origin, payload={ok:true}){ setCors(res, origin); json(res,200,payload); }
function bad(res, origin, msg, code=400){ setCors(res, origin); json(res,code,{ok:false,error:msg}); }
function getIP(req){ const xf=req.headers['x-forwarded-for']; if(typeof xf==='string'&&xf) return xf.split(',')[0].trim(); return req.socket?.remoteAddress||''; }

const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const E164_RE=/^\+\d{8,15}$/;

// страна по коду
function countryByDial(d){
  d=String(d||'').replace(/^\+/,'');
  if(d.startsWith('7'))   return 'Россия';
  if(d.startsWith('375')) return 'Беларусь';
  if(d.startsWith('380')) return 'Украина';
  if(d.startsWith('76')||d.startsWith('77')) return 'Казахстан';
  if(d.startsWith('374')) return 'Армения';
  if(d.startsWith('998')) return 'Узбекистан';
  if(d.startsWith('996')) return 'Киргизия';
  if(d.startsWith('992')) return 'Таджикистан';
  if(d.startsWith('993')) return 'Туркменистан';
  return '';
}

// аккуратно извлечь ТОЛЬКО код страны из e164, если dialCode не пришёл
function extractDialFromE164(e164){
  const s = String(e164||'').replace(/^\+/,'');
  // сначала длинные коды
  const known = ['375','380','998','996','995','994','993','992','374'];
  for (const code of known){ if (s.startsWith(code)) return code; }
  if (s.startsWith('7')) return '7';
  return s ? s[0] : '';
}

const boolRu = b => (b ? 'да' : 'нет');

async function tgSend(chatId, text){
  if(!TOKEN || !chatId) return;
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ chat_id:chatId, text, parse_mode:'HTML', disable_web_page_preview:true })
  });
  if(!r.ok){ const t=await r.text().catch(()=> ''); throw new Error(`Telegram ${r.status}: ${t}`); }
}

// ----- handler -----
module.exports = async (req,res)=>{
  const origin = String(req.headers.origin||'');

  if(req.method==='OPTIONS'){
    const allowed = allowOrigin(origin);
    if(!allowed) return bad(res, origin, 'Origin not allowed', 403);
    setCors(res, origin); res.statusCode=200; return res.end();
  }
  if(req.method!=='POST') return bad(res, origin, 'Method not allowed', 405);
  if(ORIGINS.length && !ORIGINS.includes(origin)) return bad(res, origin, 'Origin not allowed', 403);

  // parse JSON
  let body=req.body;
  if(!body){
    try{
      const raw=await new Promise((resolve,reject)=>{ let d=''; req.on('data',c=>d+=c); req.on('end',()=>resolve(d)); req.on('error',reject); });
      body = raw ? JSON.parse(raw) : {};
    }catch{ return bad(res, origin, 'Invalid JSON', 400); }
  }

  const name   = String(body.name||'').trim();
  const email  = String(body.email||'').trim();
  const phoneN = String(body.phone||'').trim();      // например: "(927) 127-85-33"
  const phoneE = String(body.phone_e164||'').trim(); // например: "+79271278533"
  const subscribe = !!body.subscribe;
  const policyVersion = String(body.policy_version||'').trim();
  const pageUrl = String(body.url||'').trim();
  const ua = String(body.ua||'').trim();
  const hp = String(body.hp||'').trim();
  const t  = Number(body.t||0);

  const countryName = String(body.countryName||'').trim();
  let dialCode = String(body.dialCode||'').trim();   // "7" если пришло с фронта

  if(hp) return ok(res, origin, { ok:true, skipped:true, reason:'honeypot' });
  if(t && t<600) return ok(res, origin, { ok:true, skipped:true, reason:'timer' });

  if(!name) return bad(res, origin, 'Укажите имя');
  if(!email || !EMAIL_RE.test(email)) return bad(res, origin, 'Неверный email');
  if(!phoneE || !E164_RE.test(phoneE)) return bad(res, origin, 'Неверный телефон');

  // если dialCode не получили — вытащим из e164
  if(!dialCode) dialCode = extractDialFromE164(phoneE);

  const country = countryName || countryByDial(`+${dialCode}`) || countryByDial(phoneE) || '';

  // В КОРОТКОМ СООБЩЕНИИ — РОВНО ОДИН НОМЕР С МАСКОЙ "+код (национальный)"
  const phoneShort = phoneN ? `+${dialCode} ${phoneN}` : phoneE;

  const now = new Date();
  const timeRu = now.toLocaleString('ru-RU',{hour12:false,timeZone:'Europe/Moscow'});
  const ip = getIP(req);
  const referer = String(req.headers.referer||'');

  // короткое сообщение
  const shortText =
    `🎟 Новая заявка\n` +
    `Имя: ${name}\n` +
    `Email: ${email}\n` +
    (country ? `Страна: ${country}\n` : ``) +
    `Телефон: ${phoneShort}\n` +
    `Подписка: ${boolRu(subscribe)}\n` +
    `URL: ${pageUrl || referer || '-'}`;

  // полное сообщение
  const fullText =
    `<b>Заявка (подробно)</b>\n` +
    `Имя: ${name}\n` +
    `Email: ${email}\n` +
    `Телефон: ${phoneN || '-'}\n` +
    `E164: ${phoneE}\n` +
    (country ? `Страна: ${country}\n` : '') +
    `Подписка: ${boolRu(subscribe)}\n` +
    (policyVersion ? `Политика: ${policyVersion}\n` : '') +
    `Когда: ${timeRu}\n` +
    `URL: ${pageUrl || referer || '-'}\n` +
    `UA: ${ua || '-'}\n` +
    `IP: ${ip || '-'}\n` +
    `Origin: ${origin || '-'}`;

  try{
    await tgSend(ADMIN_ID, fullText);
    await tgSend(CHAT_ID, shortText);
    return ok(res, origin, { ok:true });
  }catch(e){
    console.error(e);
    return bad(res, origin, 'Telegram send failed', 502);
  }
};

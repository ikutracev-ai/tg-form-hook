// /api/submit.js
export default async function handler(req, res) {
  // ---- CORS ----
  const ORIGINS = [
    'https://gkbsz.su',
    'https://www.gkbsz.su',
    // добавь предпросмотр Tilda, если нужен:
    // 'https://projectXXXX.tilda.ws',
  ];
  const origin = req.headers.origin;
  if (ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    // можно поставить '*' если не используешь cookies/credentials:
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const {
      name, email, phone, phone_e164, subscribe,
      policy_version, ua, url, hp
    } = req.body || {};

    if (hp) return res.status(400).json({ ok: false, error: 'Bot detected' });
    if (!name || !email || !phone) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }

    const token = process.env.TG_TOKEN;
    const chatId = process.env.TG_CHAT;
    if (!token || !chatId) {
      return res.status(500).json({ ok: false, error: 'Server not configured: TG_TOKEN/TG_CHAT' });
    }

    const text =
`📬 Новая заявка
Имя: ${name}
Email: ${email}
Телефон: ${phone_e164 || phone}
Подписка: ${subscribe ? 'да' : 'нет'}
Политика: ${policy_version || '-'}
Время: ${new Date().toLocaleString('ru-RU')}
URL: ${url || '-'}
UA: ${ua || '-'}`;

    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });

    const tgJson = await tgRes.json().catch(() => null);
    if (!tgRes.ok || !tgJson?.ok) {
      return res.status(502).json({
        ok: false,
        error: 'Telegram error',
        details: tgJson || { status: tgRes.status }
      });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}


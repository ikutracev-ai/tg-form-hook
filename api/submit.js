export default async function handler(req, res) {
  const ORIGIN = process.env.ALLOW_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const { name, email, phone, phone_e164, subscribe, policy_version, ua, url, hp, t } = req.body || {};

    // антибот
    if (hp || (typeof t === 'number' && t < 1200)) {
      return res.status(200).json({ ok: true });
    }

    if (!name || !email || !phone_e164) {
      return res.status(400).json({ ok: false, error: 'Missing fields' });
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId   = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) throw new Error('Bot env vars are not set');

    const msg = [
      '📝 <b>Новая заявка</b>',
      `👤 Имя: ${esc(name)}`,
      `✉️ Email: ${esc(email)}`,
      `📞 Телефон: ${esc(phone)} (${esc(phone_e164)})`,
      `📰 Подписка: ${subscribe ? 'да' : 'нет'}`,
      policy_version ? `📄 Политика: ${esc(policy_version)}` : null,
      url ? `🔗 Страница: ${esc(url)}` : null,
      ua ? `💻 UA: ${esc(ua)}` : null,
      `⏱️ ${new Date().toLocaleString('ru-RU')}`
    ].filter(Boolean).join('\n');

    const tg = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: msg,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    }).then(r => r.json());

    if (!tg.ok) throw new Error('Telegram error: ' + JSON.stringify(tg));
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

function esc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

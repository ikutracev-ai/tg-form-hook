export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const { name, email, phone, phone_e164, subscribe, policy_version, ua, url, hp, t } = req.body;

    // Honeypot
    if (hp) return res.status(400).json({ ok: false, error: 'Bot detected' });

    const token = process.env.TG_TOKEN;
    const chatId = process.env.TG_CHAT;

    const text = `📩 Новая заявка
Имя: ${name}
Email: ${email}
Телефон: ${phone_e164 || phone}
Подписка: ${subscribe ? 'да' : 'нет'}
Политика: ${policy_version}
Время: ${t} мс
URL: ${url}
UA: ${ua}`;

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
}

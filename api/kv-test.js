// /api/kv-test.js
// Простой health-check для Upstash KV/Redis через REST API:
// - SET test:ping -> <timestamp> (с TTL 120 сек)
// - GET test:ping
// - Возвращает JSON с результатами и названием использованных переменных

export default async function handler(req, res) {
  try {
    const env = pickKvEnv();
    if (!env.url || !env.token) {
      return res.status(500).json({
        ok: false,
        error: 'KV credentials not found',
        lookedFor: env.lookedFor
      });
    }

    // Ключ для проверки
    const key = 'test:ping';
    const value = `pong-${Date.now()}`;

    // SET key value EX 120
    const setUrl = `${env.url}/SET/${encodeURIComponent(key)}/${encodeURIComponent(value)}/EX/120`;
    const setR = await fetch(setUrl, {
      headers: { Authorization: `Bearer ${env.token}` }
    });
    const setData = await setR.json();

    // GET key
    const getUrl = `${env.url}/GET/${encodeURIComponent(key)}`;
    const getR = await fetch(getUrl, {
      headers: { Authorization: `Bearer ${env.token}` }
    });
    const getData = await getR.json();

    return res.status(200).json({
      ok: true,
      using: {
        urlVar: env.usedUrlVar,
        tokenVar: env.usedTokenVar,
        baseUrl: mask(env.url)
      },
      set: setData,   // ожидаем {"result":"OK"}
      get: getData,   // ожидаем {"result":"pong-..."}
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}

/** Выбираем правильные переменные окружения вне зависимости от префикса */
function pickKvEnv() {
  const candidatesUrl = [
    'KV_REST_API_URL',
    'UPSTASH_KV_REST_URL',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_KV_REST_API_URL'
  ];
  const candidatesToken = [
    'KV_REST_API_TOKEN',
    'UPSTASH_KV_REST_TOKEN',
    'UPSTASH_REDIS_REST_TOKEN',
    'UPSTASH_REDIS_REST_KV_REST_API_TOKEN'
  ];

  let usedUrlVar = null;
  let usedTokenVar = null;

  let url = null;
  for (const v of candidatesUrl) {
    if (process.env[v]) { url = process.env[v]; usedUrlVar = v; break; }
  }
  let token = null;
  for (const v of candidatesToken) {
    if (process.env[v]) { token = process.env[v]; usedTokenVar = v; break; }
  }

  return {
    url,
    token,
    usedUrlVar,
    usedTokenVar,
    lookedFor: { candidatesUrl, candidatesToken }
  };
}

function mask(s) {
  try {
    const u = new URL(s);
    return `${u.origin}${u.pathname.split('/').slice(0,3).join('/')}/...`;
  } catch { return '***'; }
}

// Му-раннер: сервер отчётов (Cloudflare Worker).
// Принимает события из игры и пересылает их владельцу бота в Telegram.
//
// Переменные окружения (Settings → Variables and Secrets):
//   BOT_TOKEN      — токен бота от @BotFather (тип: Secret)
//   OWNER_CHAT_ID  — куда слать отчёты (твой chat_id). Пока не задан,
//                    воркер сам пришлёт его тебе при первом открытии игры.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return new Response('Moo reporter: OK', { headers: CORS });
    if (!env.BOT_TOKEN) return new Response('BOT_TOKEN is not set', { status: 500, headers: CORS });

    let p;
    try { p = JSON.parse(await request.text()); } catch { return new Response('bad json', { status: 400, headers: CORS }); }

    const v = await verifyInitData(p.initData || '', env.BOT_TOKEN);
    const who = v.ok && v.user ? formatUser(v.user) : '❔ неизвестный (открыто не из Telegram или подпись не прошла)';
    const d = p.data || {};
    const platform = p.platform || '?';

    // Режим настройки: OWNER_CHAT_ID ещё не задан — сообщаем chat_id тому, кто открыл игру.
    if (!env.OWNER_CHAT_ID) {
      if (v.ok && v.user && p.event === 'open') {
        await send(env.BOT_TOKEN, v.user.id,
          'Настройка отчётов 🐮\nТвой chat_id: ' + v.user.id +
          '\nДобавь его в переменную OWNER_CHAT_ID воркера — и все входы и результаты будут приходить сюда.', false);
      }
      return new Response('owner not configured', { headers: CORS });
    }

    let text = null, silent = false;
    if (p.event === 'open') {
      text = '👋 ' + who + '\nоткрыл игру · ' + platform;
      silent = true;
    } else if (p.event === 'start') {
      text = '▶️ ' + who + '\nначал забег · ' + (d.mode === 'voice' ? 'голосом' : 'кнопками') +
        (d.camera ? ', камера вкл.' : ', без камеры') +
        (d.mode === 'voice' ? ' · голос ' + d.base + ' Гц, порог ' + d.thr : '');
      silent = true;
    } else if (p.event === 'result') {
      text = '🐮 ' + who + '\n🏁 ' + num(d.distance) + ' м за ' + fmtTime(d.seconds) +
        ' · препятствий: ' + num(d.passed) +
        '\n' + (d.mode === 'voice' ? '🎤 голосом' : '👆 кнопками') + (d.camera ? ' · 📷 камера' : '') +
        ' · скорость до ' + d.maxSpeed + ' м/с' +
        (d.isRecord ? '\n🏆 Личный рекорд!' : '\nРекорд игрока: ' + num(d.record) + ' м') +
        ' · ' + platform;
    } else if (p.event === 'error') {
      text = '⚠️ ' + who + '\nошибка на этапе «' + (d.stage || '?') + '»: ' + (d.name || '') + ' ' + (d.message || '') + ' · ' + platform;
    }
    if (text) await send(env.BOT_TOKEN, env.OWNER_CHAT_ID, text, silent);
    return new Response('ok', { headers: CORS });
  },
};

async function send(token, chatId, text, silent) {
  await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_notification: !!silent }),
  });
}

function num(x) { return typeof x === 'number' ? String(x) : String(x || 0); }
function fmtTime(s) { s = Math.max(0, Math.round(+s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function formatUser(u) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'без имени';
  return name + (u.username ? ' (@' + u.username + ')' : '') + ' · id ' + u.id;
}

// Проверка подписи Telegram initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
export async function verifyInitData(initData, botToken) {
  if (!initData) return { ok: false };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false };
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => k + '=' + v)
    .join('\n');
  const enc = new TextEncoder();
  const k1 = await crypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = await crypto.subtle.sign('HMAC', k1, enc.encode(botToken));
  const k2 = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k2, enc.encode(dataCheckString));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex !== hash) return { ok: false };
  let user = null;
  try { user = JSON.parse(params.get('user')); } catch {}
  return { ok: true, user, authDate: +params.get('auth_date') };
}

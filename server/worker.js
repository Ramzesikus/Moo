// Му-раннер: сервер отчётов (Cloudflare Worker).
// Принимает события из игры и пересылает их владельцу бота в Telegram.
//
// Переменные окружения (Settings → Variables and Secrets):
//   BOT_TOKEN      — токен бота от @BotFather (тип: Secret)
//   OWNER_CHAT_ID  — куда слать отчёты (твой chat_id). Пока не задан,
//                    воркер сам пришлёт его тебе при первом открытии игры.
// События: open (зашёл), level (прошёл уровень) — без звука; error — со звуком.

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
    const who = v.ok && v.user ? formatUser(v.user) : '❔ неизвестный (не из Telegram)';
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

    let text = null, silent = true;
    const head = who + ' · ' + esc(platformName(platform));
    if (p.event === 'open') {
      text = '👋 <b>Зашёл в игру</b>\n' + head;
    } else if (p.event === 'level') {
      const st = Math.max(0, Math.min(3, +d.stars || 0));
      text = '🏁 <b>Уровень ' + num(d.level) + ' пройден</b> ' + '⭐'.repeat(st) + '☆'.repeat(3 - st) + '\n' + head +
        '\n' + (d.mode === 'voice' ? '🎤 голосом' : '👆 кнопками') +
        '\n' + (d.camera ? '📷 камера вкл.' : '📷 камера выкл.') +
        '\n⏱ ' + fmtTime(d.seconds) +
        '\n❤️ ' + num(d.livesLeft) + ' из ' + num(d.livesTotal);
    } else if (p.event === 'error') {
      const stage = { mic: 'микрофон', camera: 'камера' }[d.stage] || (d.stage || '?');
      text = '⚠️ <b>Ошибка: ' + esc(stage) + '</b>\n' + head + '\n' + esc(((d.name || '') + (d.message ? ': ' + d.message : '')) || '—');
      silent = false;
    }
    if (text) await send(env.BOT_TOKEN, env.OWNER_CHAT_ID, text, silent);
    return new Response('ok', { headers: CORS });
  },
};

async function send(token, chatId, text, silent) {
  await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), parse_mode: 'HTML', disable_notification: !!silent }),
  });
}

function num(x) { return typeof x === 'number' ? String(x) : String(x || 0); }
function fmtTime(s) { s = Math.max(0, Math.round(+s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function formatUser(u) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'без имени';
  return esc(name) + (u.username ? ' (@' + esc(u.username) + ')' : '') + ' · id ' + u.id;
}
function esc(x) { return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function platformName(p) { return { tdesktop: 'ПК', weba: 'веб', webk: 'веб', web: 'веб', macos: 'macOS', ios: 'iOS', android: 'Android', android_x: 'Android' }[p] || p; }

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

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(status, data) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function hex(bytes) { return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2,'0')).join(''); }
async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
}

async function sha256(data) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
}

async function validateInitData(initData, env) {
  if (!initData) return null;
  if (!env.BOT_TOKEN) throw new Error('BOT_TOKEN is not configured');
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  const authDate = Number(p.get('auth_date') || 0);
  const userRaw = p.get('user');
  if (!hash || !authDate || !userRaw) return null;
  const maxAge = Number(env.INIT_DATA_MAX_AGE_SEC || 86400);
  if (Math.abs(Date.now()/1000 - authDate) > maxAge) return null;

  p.delete('hash');
  const check = [...p.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
  const secret = await hmac(new TextEncoder().encode('WebAppData'), env.BOT_TOKEN);
  const calc = hex(await hmac(new Uint8Array(secret), check));
  if (!timingSafeEqual(calc, hash)) return null;
  try {
    const user = JSON.parse(userRaw);
    if (!user?.id) return null;
    return user;
  } catch { return null; }
}

async function telegram(method, payload, env) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload)
  });
  return r.json();
}

async function getUser(request, env) {
  const body = await request.json();
  const user = await validateInitData(body.init_data || '', env);
  return { body, user };
}

async function upsertUser(db, user, sessionId, consent) {
  if (!user) return;
  await db.prepare(`INSERT INTO users (telegram_user_id, username, first_name, last_name, first_seen, last_seen, sessions_count, write_access)
    VALUES (?, ?, ?, ?, unixepoch(), unixepoch(), 0, ?)
    ON CONFLICT(telegram_user_id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name, last_name=excluded.last_name,
    last_seen=unixepoch(),
    write_access=MAX(users.write_access, excluded.write_access)`)
    .bind(String(user.id), user.username || '', user.first_name || '', user.last_name || '', consent ? 1 : 0).run();
  await db.prepare(`INSERT OR IGNORE INTO sessions (session_id, telegram_user_id, started_at, last_event_at) VALUES (?, ?, unixepoch(), unixepoch())`)
    .bind(sessionId, String(user.id)).run();
}

async function eventApi(request, env) {
  const { body, user } = await getUser(request, env);
  const event = String(body.event || '').slice(0,100);
  const sessionId = String(body.session_id || '').slice(0,100);
  if (!event || !sessionId) return json(400, {ok:false,error:'event and session_id required'});
  await upsertUser(env.DB, user, sessionId, false);
  const uid = user ? String(user.id) : null;
  await env.DB.prepare(`INSERT INTO events (session_id, telegram_user_id, event, screen, meta_json, created_at) VALUES (?, ?, ?, ?, ?, unixepoch())`)
    .bind(sessionId, uid, event, body.screen || '', JSON.stringify(body.meta || {})).run();
  await env.DB.prepare(`INSERT INTO sessions (session_id, telegram_user_id, started_at, last_event_at, last_screen) VALUES (?, ?, unixepoch(), unixepoch(), ?)
    ON CONFLICT(session_id) DO UPDATE SET last_event_at=unixepoch(), last_screen=excluded.last_screen`)
    .bind(sessionId, uid, body.screen || '').run();

  if (uid && event === 'START') {
    await env.DB.prepare('UPDATE users SET sessions_count = sessions_count + 1, last_seen = unixepoch() WHERE telegram_user_id=?').bind(uid).run();
  }

  if (uid && event !== 'FINAL_VIEWED') {
    await scheduleOrRefreshReminder(env.DB, uid, sessionId, 6);
    await scheduleOrRefreshReminder(env.DB, uid, sessionId, 24);
  } else if (uid && event === 'FINAL_VIEWED') {
    await env.DB.prepare(`UPDATE reminders SET status='cancelled' WHERE telegram_user_id=? AND session_id=? AND status='pending'`).bind(uid, sessionId).run();
  }

  if (uid && ['START','SCREEN_VIEW'].includes(event)) {
    const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM events WHERE telegram_user_id=?').bind(uid).first();
    if (event === 'START' && Number(row?.c || 0) <= 2) {
      await adminNotify(`🔔 Новый вход в Mini App\n👤 ${user.first_name || ''} ${user.last_name || ''}${user.username ? ` @${user.username}` : ''}\n🆔 ${uid}\n▶️ ${event}`.trim(), env);
    }
  }
  if (uid && event.startsWith('CTA_')) await adminNotify(`💰 ${event}\n👤 ${user.first_name || ''}${user.username ? ` @${user.username}` : ''}\n🆔 ${uid}`, env);
  return json(200,{ok:true});
}

async function adminNotify(text, env) {
  if (!env.BOT_TOKEN || !env.OWNER_CHAT_ID) return;
  try { await telegram('sendMessage', {chat_id:env.OWNER_CHAT_ID, text}, env); } catch (_) {}
}

async function statsApi(request, env) {
  const key = request.headers.get('x-admin-key') || new URL(request.url).searchParams.get('key');
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json(401,{ok:false,error:'unauthorized'});
  const queries = {
    users: 'SELECT COUNT(*) c FROM users',
    returning: 'SELECT COUNT(*) c FROM users WHERE sessions_count > 1',
    events: 'SELECT COUNT(*) c FROM events',
    starts: "SELECT COUNT(*) c FROM events WHERE event='START'",
    results: "SELECT COUNT(*) c FROM events WHERE event='RESULT_SHOWN'",
    returns: "SELECT COUNT(*) c FROM events WHERE event='RETURN'",
    cta15: "SELECT COUNT(*) c FROM events WHERE event='CTA_15000_CLICK'",
    cta30: "SELECT COUNT(*) c FROM events WHERE event='CTA_30000_CLICK'"
  };
  const out={};
  for (const [k,q] of Object.entries(queries)) out[k]=Number((await env.DB.prepare(q).first())?.c || 0);
  return json(200,{ok:true,...out});
}

async function scheduleOrRefreshReminder(db, userId, sessionId, delayHours) {
  const due = Math.floor(Date.now()/1000) + delayHours * 3600;
  await db.prepare(`INSERT INTO reminders (telegram_user_id, session_id, delay_hours, due_at, status)
    VALUES (?, ?, ?, ?, 'pending')
    ON CONFLICT(telegram_user_id, session_id, delay_hours) DO UPDATE SET due_at=excluded.due_at, status='pending', sent_at=NULL`)
    .bind(userId, sessionId, delayHours, due).run();
}

async function scheduled(env) {
  const rows = await env.DB.prepare(`SELECT id, telegram_user_id, session_id, delay_hours FROM reminders WHERE status='pending' AND due_at <= unixepoch() LIMIT 50`).all();
  for (const r of rows.results || []) {
    const text = r.delay_hours <= 6
      ? 'Ты тут кое-что не договорил(а). Я сохранила твою архитектурную карту. Можешь вернуться с того места, где остановился.'
      : 'Я посмотрела на твою точку ещё раз. Самое интересное у тебя начинается как раз там, где ты остановился(ась). Вернуться?';
    const result = await telegram('sendMessage',{chat_id:r.telegram_user_id,text,reply_markup:{inline_keyboard:[[{text:'Продолжить',web_app:{url:env.MINI_APP_URL}}]]}},env);
    await env.DB.prepare('UPDATE reminders SET status=?, sent_at=unixepoch() WHERE id=?').bind(result?.ok ? 'sent':'failed',r.id).run();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/event' && request.method === 'POST') return eventApi(request,env);
    if (url.pathname === '/api/stats' && request.method === 'GET') return statsApi(request,env);
    if (url.pathname === '/health') return json(200,{ok:true,service:'toriya-nova-mini-app'});
    return env.ASSETS.fetch(request);
  },
  async scheduled(controller, env) { await scheduled(env); }
};

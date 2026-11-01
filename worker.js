/**
 * TORIYA NOVA — LID Worker v15 (Clean & Stable)
 */

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=UTF-8",
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
  "Pragma": "no-cache",
  "Expires": "0",
  "X-TORIYA-APP": "v15-system",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Telegram-Init-Data, X-Web-Id",
  };
}

function withCors(response) {
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));
  return new Response(response.body, { status: response.status, headers });
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

async function verifyTelegramInitData(initData, botToken, maxAgeSec = 86400) {
  if (!initData || !botToken) return { ok: false, reason: "missing_init_data_or_bot_token" };
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) return { ok: false, reason: "missing_hash" };
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > maxAgeSec) return { ok: false, reason: "init_data_expired" };
  params.delete("hash");
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), botToken);
  const calculated = hex(await hmac(secret, dataCheckString));
  if (calculated !== receivedHash) return { ok: false, reason: "invalid_hash" };
  let user = null;
  try { user = JSON.parse(params.get("user") || "null"); } catch {}
  return { ok: true, user, authDate };
}

async function telegram(env, method, body) {
  if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN is not configured");
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || `Telegram API error: ${method}`);
  return data.result;
}

async function getTelegramUser(initData, env) {
  const maxAge = Number(env.INIT_DATA_MAX_AGE_SEC || 86400);
  return verifyTelegramInitData(initData, env.BOT_TOKEN, maxAge);
}

const SCREEN_LABELS = {
  s0: "1-й экран (главный)",
  formats: "витрина решений (выбор задач)",
  cases: "примеры и кейс Lemoon 8/9",
  price: "выбор формата и стоимости",
  calendar: "календарь и время созвона",
  order: "финальная анкета",
};

function diagnoseDropoff(u) {
  if (u.consulted) return "Записался на разбор / оставил заявку!";
  if (u.screen === "s0") return "Зашёл на первый экран, но ещё не нажал «Далее».";
  if (u.screen === "formats") return "Выбирал задачи на витрине решений.";
  if (u.screen === "cases") return "Смотрел примеры и кейс магазина Lemoon 8/9.";
  if (u.screen === "price") return "Изучал тарифы и стоимость разработки.";
  if (u.screen === "calendar") return "Выбирал день и время в календаре созвона.";
  if (u.screen === "order") return "Дошёл до финальной анкеты, но не отправил её.";
  return "Изучал витрину, но прервался.";
}

const errs = (globalThis.__errs = globalThis.__errs || []);
function logErr(where, e) {
  const m = `${where}: ${e?.message || e}`;
  console.error(m);
  errs.push(m);
  if (errs.length > 8) errs.shift();
}

async function authUser(request, env, body = {}) {
  const initData = request.headers.get("X-Telegram-Init-Data") || body.initData || "";
  if (initData) return getTelegramUser(initData, env);
  const wid = request.headers.get("X-Web-Id") || "";
  if (/^[a-f0-9-]{36}$/.test(wid)) {
    return { ok: true, user: { id: "web:" + wid, first_name: "Гость из браузера", web: true } };
  }
  return { ok: false, reason: "missing_init_data_or_bot_token" };
}

const isWeb = (u) => String(u?.id ?? u?.telegram_id ?? "").startsWith("web:");
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const uid = (u) => u?.id ?? u?.telegram_id;
const displayName = (u) => [u?.first_name, u?.last_name].filter(Boolean).join(" ") || u?.username || `ID ${uid(u)}`;
const contactUrl = (u) => (isWeb(u) ? null : u?.username ? `https://t.me/${u.username}` : `tg://user?id=${uid(u)}`);
const who = (u) => `<b>${esc(displayName(u))}</b>${u?.username ? ` (@${esc(u.username)})` : ""} · <code>${uid(u)}</code>`;

async function tgSend(env, chatId, text, buttons) {
  const body = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  return telegram(env, "sendMessage", body);
}

async function notifyOwner(env, text, user) {
  if (!env.BOT_TOKEN || !env.OWNER_CHAT_ID) return;
  const buttons = user && contactUrl(user) ? [[{ text: "✉️ Написать в личку", url: contactUrl(user) }]] : null;
  try {
    await tgSend(env, env.OWNER_CHAT_ID, text, buttons);
  } catch {
    try { await tgSend(env, env.OWNER_CHAT_ID, text); } catch {}
  }
}

async function ensureSchema(env) {
  if (!env.DB || globalThis.__schemaReady) return;
  try {
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE IF NOT EXISTS users (telegram_id TEXT PRIMARY KEY, username TEXT, first_name TEXT, last_name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS slots (slot_key TEXT PRIMARY KEY, status TEXT NOT NULL, booked_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')))"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at)"),
    ]);
    globalThis.__schemaReady = true;
  } catch (e) { logErr("ensureSchema", e); }
}

async function saveEvent(env, user, type, payload = {}) {
  if (!env.DB || !user?.id) return;
  try {
    await env.DB.prepare(`INSERT INTO events (user_id, event_type, payload, created_at) VALUES (?, ?, ?, datetime('now'))`).bind(String(user.id), type, JSON.stringify(payload)).run();
  } catch (e) { logErr("saveEvent", e); }
}

async function ensureUser(env, user) {
  if (!env.DB || !user?.id) return;
  try {
    await env.DB.prepare(
      `INSERT INTO users (telegram_id, username, first_name, last_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name, last_name=excluded.last_name, updated_at=datetime('now')`
    ).bind(String(user.id), user.username || null, user.first_name || null, user.last_name || null).run();
  } catch (e) { logErr("ensureUser", e); }
}

async function hasRecentEvent(env, userId, type, minutes = 60) {
  try {
    const r = await env.DB.prepare(`SELECT 1 AS x FROM events WHERE user_id=? AND event_type=? AND created_at > datetime('now', ?) LIMIT 1`).bind(String(userId), type, `-${minutes} minutes`).first();
    return !!r;
  } catch { return false; }
}

async function getBusySlotsMap(env) {
  const busy = {};
  if (!env.DB) return busy;
  try {
    const { results } = await env.DB.prepare("SELECT slot_key FROM slots WHERE status='busy'").all();
    for (const r of results || []) {
      const [d, t] = String(r.slot_key).split("|");
      if (d && t) {
        busy[d] = busy[d] || [];
        busy[d].push(t);
      }
    }
  } catch (e) { logErr("getBusySlotsMap", e); }
  return busy;
}

async function slotsEndpoint(request, env) {
  await ensureSchema(env);
  const busy = await getBusySlotsMap(env);
  return json({ ok: true, busy });
}

async function eventEndpoint(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "POST required" }, 405);
  let body = {};
  try { body = await request.json(); } catch {}
  const auth = await authUser(request, env, body);
  if (!auth.ok) return json({ ok: false, error: auth.reason }, 401);

  await ensureSchema(env);
  await ensureUser(env, auth.user);

  const type = body.event || body.type || "event";
  const meta = body.meta || {};

  // Уведомление в личный чат Тории в Telegram, когда человек зашёл в приложение
  if (type === "app_open") {
    const recentlyNotified = await hasRecentEvent(env, auth.user.id, "app_open", 180);
    await saveEvent(env, auth.user, "app_open", meta);
    if (!recentlyNotified && !auth.user.web) {
      await notifyOwner(
        env,
        `👀 <b>В витрину зашёл пользователь:</b>\n👤 ${who(auth.user)}${meta.src ? `\n🔗 Источник: <code>${esc(meta.src)}</code>` : ""}\n🕒 Смотрит главный экран`,
        auth.user
      );
    }
    return json({ ok: true });
  }

  // Уведомление, когда нажал «Далее»
  if (type === "consent") {
    const alreadyConsented = await hasRecentEvent(env, auth.user.id, "consent", 1440);
    await saveEvent(env, auth.user, "consent", { processing: true, privacy: true, messages: true, v: meta.v || null });
    if (!alreadyConsented && !auth.user.web) {
      await notifyOwner(env, `✅ ${who(auth.user)} нажал(а) «Далее» и пошёл смотреть витрину решений`, auth.user);
    }
    return json({ ok: true });
  }

  await saveEvent(env, auth.user, type, meta);
  return json({ ok: true });
}

async function consultation(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "POST required" }, 405);
  let body = {};
  try { body = await request.json(); } catch {}
  const auth = await authUser(request, env, body);
  if (!auth.ok) return json({ ok: false, error: auth.reason }, 401);

  await ensureSchema(env);
  await ensureUser(env, auth.user);

  const product = String(body.product || "").trim();
  const goal = String(body.request || body.goal || "").trim();
  const slotDate = String(body.slotDate || "").trim();
  const slotTime = String(body.slotTime || "").trim();
  const voice = body.intent === "voice";
  const formats = Array.isArray(body.formats) ? body.formats.slice(0, 8).map((x) => String(x).slice(0, 80)) : [];
  const srcTag = String(body.src || "").slice(0, 40);
  const url = env.CONSULTATION_URL || "https://t.me/toriya_nova";

  if (slotDate && slotTime && env.DB) {
    try {
      await env.DB.prepare(
        `INSERT INTO slots (slot_key, status, booked_by, updated_at) VALUES (?, 'busy', ?, datetime('now'))
         ON CONFLICT(slot_key) DO UPDATE SET status='busy', booked_by=excluded.booked_by, updated_at=datetime('now')`
      ).bind(`${slotDate}|${slotTime}`, String(auth.user.id)).run();
    } catch (e) { logErr("bookSlot", e); }
  }

  await saveEvent(env, auth.user, "consultation_request", { product, goal, formats, slotDate, slotTime, src: srcTag, intent: body.intent || "miniapp" });

  await notifyOwner(
    env,
    `${voice ? "🎙️ <b>Заявка на голосовой разбор</b>" : "🔥 <b>Новая заявка на разбор и систему!</b>"}\n\n👤 ${who(auth.user)}\n📅 Слот: <b>${esc(slotDate || "Без созвона")} в ${esc(slotTime || "—")} МСК</b>\n🔗 Ниша и канал: ${esc(product) || "—"}\n🧩 Задача: ${esc(goal) || "—"}\n${formats.length ? "📦 Формат: " + esc(formats.join(", ")) + "\n" : ""}`,
    auth.user
  );

  return json({ ok: true, consultationUrl: url });
}

async function adminEndpoint(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "POST required" }, 405);
  let body = {};
  try { body = await request.json(); } catch {}

  const expectedPass = env.ADMIN_PASSWORD || "tor2026";
  const providedPass = String(body.password || "").trim();

  const initData = request.headers.get("X-Telegram-Init-Data") || body.initData || "";
  if (initData && env.BOT_TOKEN && env.OWNER_CHAT_ID) {
    const auth = await getTelegramUser(initData, env);
    if (auth.ok && String(auth.user?.id) !== String(env.OWNER_CHAT_ID)) {
      return json({ ok: false, error: "forbidden_account" }, 403);
    }
  }

  if (!providedPass || providedPass !== expectedPass) {
    return json({ ok: false, error: "invalid_password" }, 401);
  }

  await ensureSchema(env);

  if (body.action === "toggle_slot") {
    const key = `${body.date}|${body.time}`;
    const existing = await env.DB.prepare("SELECT status FROM slots WHERE slot_key=?").bind(key).first();
    if (existing && existing.status === "busy") {
      await env.DB.prepare("DELETE FROM slots WHERE slot_key=?").bind(key).run();
    } else {
      await env.DB.prepare("INSERT INTO slots (slot_key, status, booked_by) VALUES (?, 'busy', 'admin')").bind(key).run();
    }
    return json({ ok: true, busy: await getBusySlotsMap(env) });
  }

  const { results: evs } = await env.DB.prepare("SELECT user_id, event_type, payload, created_at FROM events WHERE created_at > datetime('now','-7 days') ORDER BY id ASC LIMIT 6000").all();
  const { results: usrRows } = await env.DB.prepare("SELECT telegram_id, username, first_name, last_name FROM users LIMIT 2000").all();

  const userDirectory = new Map();
  for (const r of usrRows || []) userDirectory.set(String(r.telegram_id), r);

  const map = new Map();
  for (const e of evs || []) {
    let u = map.get(e.user_id);
    if (!u) {
      u = { id: e.user_id, lastAt: 0, screen: "s0", formats: new Set(), slot: "", consulted: false, reminders: 0 };
      map.set(e.user_id, u);
    }
    let p = {};
    try { p = JSON.parse(e.payload || "{}"); } catch {}
    const t = new Date(String(e.created_at).replace(" ", "T") + "Z").getTime();

    if (e.event_type === "reminder_sent") { u.reminders++; continue; }
    if (e.event_type === "owner_stop_report") continue;

    u.lastAt = t;
    u.lastSeen = e.created_at.slice(5, 16).replace("T", " ");
    if (e.event_type === "screen_view" && p.screen) u.screen = p.screen;
    if (e.event_type === "slot_pick" && p.date && p.time) u.slot = `${p.date} ${p.time}`;
    if (e.event_type === "consultation_request" || e.event_type === "consultation_sent") u.consulted = true;
  }

  const now = Date.now();
  const visitors = [...map.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, 50).map((u) => {
    const info = userDirectory.get(String(u.id)) || { telegram_id: u.id };
    return {
      id: u.id,
      name: displayName(info),
      username: info.username || null,
      contactUrl: contactUrl(info),
      stage: SCREEN_LABELS[u.screen] || u.screen,
      lastSeen: u.lastSeen + " UTC",
      idleMin: Math.max(1, Math.round((now - u.lastAt) / 60000)),
      consulted: u.consulted,
      slot: u.slot,
      reminders: u.reminders,
      reason: diagnoseDropoff(u),
    };
  });

  return json({
    ok: true,
    stats: { totalUsers: map.size, silentUsers: map.size - [...map.values()].filter(x => x.consulted).length, leads: [...map.values()].filter(x => x.consulted).length },
    visitors,
    busy: await getBusySlotsMap(env),
  });
}

async function currentApp(request, env) {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = "/";
  assetUrl.search = "";
  const assetRequest = new Request(assetUrl.toString(), { method: "GET", headers: { Accept: "text/html" } });
  const response = await env.ASSETS.fetch(assetRequest);
  if (!response.ok) return new Response("Mini App index.html not found", { status: 502, headers: HTML_HEADERS });
  const headers = new Headers(response.headers);
  Object.entries(HTML_HEADERS).forEach(([k, v]) => headers.set(k, v));
  headers.delete("Content-Length");
  headers.delete("ETag");
  return new Response(await response.text(), { status: 200, headers });
}

async function noStoreAsset(request, env, cacheable = false) {
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  if (cacheable) headers.set("Cache-Control", "public, max-age=31536000, immutable");
  else {
    headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    headers.delete("ETag");
  }
  return new Response(response.body, { status: response.status, headers });
}

async function handle(request, env) {
  if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/v2" || path === "/app4" || path === "/" || path === "/index.html") return currentApp(request, env);
  if (path === "/api/event") return withCors(await eventEndpoint(request, env));
  if (path === "/api/consultation") return withCors(await consultation(request, env));
  if (path === "/api/slots") return withCors(await slotsEndpoint(request, env));
  if (path === "/api/admin") return withCors(await adminEndpoint(request, env));
  if (path === "/app.js") return noStoreAsset(request, env, url.searchParams.has("v"));

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env, ctx) {
    try { return await handle(request, env, ctx); } catch (error) { return json({ ok: false, error: String(error?.message || error) }, 500); }
  },
};

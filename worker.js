/**
 * TORIYA NOVA — LID Worker v24 (Bilingual RU + US Facebook Edition)
 */

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=UTF-8",
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
  "Pragma": "no-cache",
  "Expires": "0",
  "X-TORIYA-APP": "v24-bilingual-fb",
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
  s0: "1. Главный экран",
  cases: "2. Живые кейсы (Lemoon 8/9 и др.)",
  price: "3. Выбор формата и цены",
  calendar: "4. Календарь слотов",
  order: "5. Финальная анкета проекта",
};

function diagnoseDropoff(u) {
  if (u.consulted) return `Оформил заявку! ${u.leadInfo ? "(" + u.leadInfo + ")" : ""}`;
  if (u.screen === "s0") return "Открыл только 1-й экран и ещё не перешёл к кейсам.";
  if (u.screen === "cases") return `Смотрел живые кейсы (${u.lastTab || "Магазин Lemoon 8/9"}), но не перешёл к ценам.`;
  if (u.screen === "price") return "Изучал тарифы, выбирает пакет.";
  if (u.screen === "calendar") return `Выбирал время в календаре${u.slot ? " (" + u.slot + ")" : ""} — горячий интерес!`;
  if (u.screen === "order") return `Выбрал «${u.tier || "формат"}», дошёл до анкеты, но не нажал отправку.`;
  return "Знакомился с системой.";
}

async function authUser(request, env, body = {}) {
  const initData = request.headers.get("X-Telegram-Init-Data") || body.initData || "";
  if (initData) return getTelegramUser(initData, env);
  const wid = request.headers.get("X-Web-Id") || "";
  if (/^[a-f0-9-]{36}$/.test(wid)) {
    const ua = request.headers.get("User-Agent") || "";
    const isFb = /facebook|fbAN|fbAV/i.test(ua) || body?.meta?.lang === "en" || body?.intent === "facebook_us";
    const isThreads = /threads|barcelona/i.test(ua);
    const isInsta = /instagram/i.test(ua);
    const label = isFb ? "🇺🇸 US Facebook Visitor" : isThreads ? "Гость из Threads" : isInsta ? "Гость из Instagram" : "Гость (браузер)";
    return { ok: true, user: { id: "web:" + wid, first_name: label, web: true } };
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
  const buttons = user && contactUrl(user) ? [[{ text: "✉️ Написать клиенту", url: contactUrl(user) }]] : null;
  try {
    await tgSend(env, env.OWNER_CHAT_ID, text, buttons);
  } catch {
    try { await tgSend(env, env.OWNER_CHAT_ID, text); } catch {}
  }
}

async function ensureSchema(env) {
  if (!env.DB || globalThis.__schemaV24) return;
  try {
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE IF NOT EXISTS tn_users (telegram_id TEXT PRIMARY KEY, username TEXT, first_name TEXT, last_name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS tn_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS tn_slots (slot_key TEXT PRIMARY KEY, status TEXT NOT NULL, booked_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')))"),
    ]);
    try {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO tn_users (telegram_id, username, first_name, last_name, created_at, updated_at)
         SELECT telegram_id, username, first_name, last_name, created_at, updated_at FROM users`
      ).run();
    } catch {}
    globalThis.__schemaV24 = true;
  } catch (e) { console.error("ensureSchema", e); }
}

async function saveEvent(env, user, type, payload = {}) {
  if (!env.DB || !user?.id) return;
  try {
    await env.DB.prepare(`INSERT INTO tn_events (user_id, event_type, payload, created_at) VALUES (?, ?, ?, datetime('now'))`)
      .bind(String(user.id), type, JSON.stringify(payload)).run();
  } catch {}
}

async function ensureUser(env, user) {
  if (!env.DB || !user?.id) return;
  try {
    await env.DB.prepare(
      `INSERT INTO tn_users (telegram_id, username, first_name, last_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name, last_name=excluded.last_name, updated_at=datetime('now')`
    ).bind(String(user.id), user.username || null, user.first_name || null, user.last_name || null).run();
  } catch {}
}

async function hasRecentEvent(env, userId, type, minutes = 60) {
  try {
    const r = await env.DB.prepare(`SELECT 1 AS x FROM tn_events WHERE user_id=? AND event_type=? AND created_at > datetime('now', ?) LIMIT 1`)
      .bind(String(userId), type, `-${minutes} minutes`).first();
    return !!r;
  } catch { return false; }
}

async function getSlotsMaps(env) {
  const busy = {}, custom = {};
  if (!env.DB) return { busy, custom };
  try {
    const { results } = await env.DB.prepare("SELECT slot_key, status FROM tn_slots").all();
    for (const r of results || []) {
      const [d, t] = String(r.slot_key).split("|");
      if (!d || !t) continue;
      if (r.status === "busy") {
        busy[d] = busy[d] || [];
        busy[d].push(t);
      } else if (r.status === "custom_free") {
        custom[d] = custom[d] || [];
        custom[d].push(t);
      }
    }
  } catch {}
  return { busy, custom };
}

async function slotsEndpoint(request, env) {
  await ensureSchema(env);
  const { busy, custom } = await getSlotsMaps(env);
  return json({ ok: true, busy, custom });
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
  const isEn = meta.lang === "en";

  if (type === "app_open") {
    const recentlyNotified = await hasRecentEvent(env, auth.user.id, "app_open", 45);
    await saveEvent(env, auth.user, "app_open", meta);
    if (!recentlyNotified) {
      await notifyOwner(
        env,
        `${isEn ? "🇺🇸 <b>US / Facebook визит в Mini App:</b>" : "👀 <b>В витрину зашёл посетитель:</b>"}\n${who(auth.user)}${meta.src ? `\n🔗 Источник: <b>${esc(meta.src)}</b>` : ""}\n📍 Этап: 1. Главный экран`,
        auth.user
      );
    }
    return json({ ok: true });
  }

  if (type === "screen_view") {
    await saveEvent(env, auth.user, "screen_view", meta);
    await notifyOwner(env, `📍 ${who(auth.user)} перешёл на экран:\n<b>${esc(SCREEN_LABELS[meta.screen] || meta.screen)}</b>`, auth.user);
    return json({ ok: true });
  }

  if (type === "tier_pick") {
    await saveEvent(env, auth.user, "tier_pick", meta);
    await notifyOwner(env, `🎯 ${who(auth.user)} выбрал тариф:\n<b>${esc(meta.label || meta.step)}</b>`, auth.user);
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
  const product = String(body.product || "").trim();
  const goal = String(body.request || body.goal || "").trim();
  const slotDate = String(body.slotDate || "").trim();
  const slotTime = String(body.slotTime || "").trim();
  const formats = Array.isArray(body.formats) ? body.formats.slice(0, 8).map((x) => String(x).slice(0, 80)) : [];
  const isUsFb = body.intent === "facebook_us";

  // Если это американка из Facebook — сохраняем её указанный FB/IG контакт прямо в имя карточки в Дашборде!
  if (auth.user.web && product) {
    auth.user.first_name = (isUsFb ? "🇺🇸 FB: " : "🌐 ") + product.slice(0, 42);
  }
  await ensureUser(env, auth.user);

  if (slotDate && slotTime && env.DB) {
    try {
      await env.DB.prepare(
        `INSERT INTO tn_slots (slot_key, status, booked_by, updated_at) VALUES (?, 'busy', ?, datetime('now'))
         ON CONFLICT(slot_key) DO UPDATE SET status='busy', booked_by=excluded.booked_by, updated_at=datetime('now')`
      ).bind(`${slotDate}|${slotTime}`, String(auth.user.id)).run();
    } catch {}
  }

  await saveEvent(env, auth.user, "consultation_request", { product, goal, formats, slotDate, slotTime, src: body.src || "" });

  await notifyOwner(
    env,
    `${isUsFb ? "🇺🇸🔥 <b>NEW US / FACEBOOK LEAD!</b>" : "🔥 <b>НОВАЯ ЗАЯВКА ИЗ MINI APP</b>"}\n\nКлиент: ${who(auth.user)}\nСлот: <b>${esc(slotDate || "Без созвона")} · ${esc(slotTime || "—")}</b>\nНиша и контакт (FB/IG/TG): <b>${esc(product) || "—"}</b>\nЗадача: ${esc(goal) || "—"}\n${formats.length ? "Параметры: " + esc(formats.join(", ")) : ""}`,
    auth.user
  );

  return json({ ok: true });
}

async function adminEndpoint(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "POST required" }, 405);
  let body = {};
  try { body = await request.json(); } catch {}

  const providedPass = String(body.password || "").trim().toLowerCase();
  const envPass = String(env.ADMIN_PASSWORD || "").trim().toLowerCase();

  let isOwnerTelegram = false;
  const initData = request.headers.get("X-Telegram-Init-Data") || body.initData || "";
  if (initData && env.BOT_TOKEN) {
    const auth = await getTelegramUser(initData, env);
    if (auth.ok && String(auth.user?.id) === String(env.OWNER_CHAT_ID || "6894849502")) {
      isOwnerTelegram = true;
    }
  }

  const validPasswords = ["toriya2026", "2026", "toriya"];
  if (envPass) validPasswords.push(envPass);

  if (!isOwnerTelegram && !validPasswords.includes(providedPass)) {
    return json({ ok: false, error: "неверный ключ (введите toriya2026)" }, 401);
  }

  await ensureSchema(env);
  const base = (env.MINI_APP_URL || "https://lid.toriya-sudba.workers.dev/v2/").split("?")[0];

  if (body.action === "send_one") {
    const targetId = String(body.userId || "").trim();
    const text = String(body.text || "").trim();
    if (!targetId || targetId.startsWith("web:")) {
      return json({ ok: false, error: "Это гость из Facebook/браузера без Telegram ID" });
    }
    try {
      await tgSend(env, targetId, esc(text), [[{ text: "✨ Открыть витрину TORIYA NOVA", web_app: { url: `${base}?go=cases` } }]]);
      await saveEvent(env, { id: targetId }, "reminder_sent", { manual: true });
      return json({ ok: true });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) });
    }
  }

  if (body.action === "broadcast") {
    let sentCount = 0, totalTargets = 0;
    const customText = String(body.text || "").trim();
    const btnText = String(body.btnText || "✨ Открыть витрину TORIYA NOVA").trim();
    try {
      const { results: allUsers } = await env.DB.prepare("SELECT telegram_id FROM tn_users").all();
      const tgIds = [...new Set((allUsers || []).map((r) => String(r.telegram_id)).filter((id) => id && !id.startsWith("web:")))];
      totalTargets = tgIds.length;
      for (const chatId of tgIds) {
        try {
          await tgSend(env, chatId, esc(customText), [[{ text: btnText, web_app: { url: `${base}?go=cases` } }]]);
          sentCount++;
        } catch {}
      }
    } catch (e) {
      return json({ ok: false, error: "Ошибка рассылки: " + e.message });
    }
    return json({ ok: true, sentCount, totalTargets });
  }

  if (body.action === "add_custom_slot") {
    try {
      const key = `${body.date}|${body.time}`;
      await env.DB.prepare("INSERT OR REPLACE INTO tn_slots (slot_key, status, booked_by) VALUES (?, 'custom_free', 'admin')").bind(key).run();
    } catch {}
    const maps = await getSlotsMaps(env);
    return json({ ok: true, ...maps });
  }

  if (body.action === "toggle_slot") {
    try {
      const key = `${body.date}|${body.time}`;
      const existing = await env.DB.prepare("SELECT status FROM tn_slots WHERE slot_key=?").bind(key).first();
      if (existing && existing.status === "busy") {
        await env.DB.prepare("UPDATE tn_slots SET status='custom_free' WHERE slot_key=?").bind(key).run();
      } else {
        await env.DB.prepare("INSERT OR REPLACE INTO tn_slots (slot_key, status, booked_by) VALUES (?, 'busy', 'admin')").bind(key).run();
      }
    } catch {}
    const maps = await getSlotsMaps(env);
    return json({ ok: true, ...maps });
  }

  let evs = [], usrRows = [];
  try {
    const r1 = await env.DB.prepare("SELECT user_id, event_type, payload, created_at FROM tn_events ORDER BY id ASC LIMIT 8000").all();
    evs = r1.results || [];
    const r2 = await env.DB.prepare("SELECT telegram_id, username, first_name, last_name, created_at, updated_at FROM tn_users ORDER BY updated_at DESC LIMIT 3000").all();
    usrRows = r2.results || [];
  } catch {}

  const userDirectory = new Map();
  const allMap = new Map();

  for (const r of usrRows) {
    const id = String(r.telegram_id);
    userDirectory.set(id, r);
    const t = new Date(String(r.updated_at || r.created_at).replace(" ", "T") + "Z").getTime() || Date.now();
    allMap.set(id, {
      id, lastAt: t, lastSeen: String(r.updated_at || r.created_at || "").slice(5, 16).replace("T", " "),
      screen: "s0", src: "", lastTab: "", tier: "", slot: "", leadInfo: "", consulted: false, reminders: 0,
    });
  }

  for (const e of evs) {
    let u = allMap.get(e.user_id);
    if (!u) {
      u = { id: e.user_id, lastAt: 0, lastSeen: "", screen: "s0", src: "", lastTab: "", tier: "", slot: "", leadInfo: "", consulted: false, reminders: 0 };
      allMap.set(e.user_id, u);
    }
    let p = {};
    try { p = JSON.parse(e.payload || "{}"); } catch {}
    const t = new Date(String(e.created_at).replace(" ", "T") + "Z").getTime();

    if (e.event_type === "reminder_sent") { u.reminders++; continue; }
    if (e.event_type === "owner_stop_report") continue;

    if (t >= u.lastAt) {
      u.lastAt = t;
      u.lastSeen = e.created_at.slice(5, 16).replace("T", " ");
    }
    if (p.src) u.src = p.src;
    if (e.event_type === "screen_view" && p.screen) u.screen = p.screen;
    if (e.event_type === "case_tab" && p.tab) u.lastTab = p.tab;
    if (e.event_type === "tier_pick" && p.label) u.tier = p.label;
    if (e.event_type === "slot_pick" && p.date && p.time) u.slot = `${p.date} ${p.time}`;
    if (e.event_type === "consultation_request" || e.event_type === "consultation_sent") {
      u.consulted = true;
      if (p.product) u.leadInfo = `${p.product} — ${p.goal || ""}`;
    }
  }

  const now = Date.now();
  const formatUserItem = (u) => {
    const info = userDirectory.get(String(u.id)) || { telegram_id: u.id };
    const idleMin = Math.max(1, Math.round((now - u.lastAt) / 60000));
    const idleText = idleMin < 60 ? `${idleMin} мин` : idleMin < 1440 ? `${Math.round(idleMin / 60)} ч` : `${Math.round(idleMin / 1440)} дн`;
    return {
      id: u.id,
      name: displayName(info),
      username: info.username || null,
      contactUrl: contactUrl(info),
      src: u.src || (String(u.id).startsWith("web:") ? "facebook / web" : "telegram"),
      stage: SCREEN_LABELS[u.screen] || u.screen,
      lastSeen: (u.lastSeen || "ранее") + " UTC",
      idleMin,
      idleText,
      consulted: u.consulted,
      reminders: u.reminders,
      reason: diagnoseDropoff(u),
    };
  };

  const allSorted = [...allMap.values()].sort((a, b) => b.lastAt - a.lastAt);
  const recent7d = allSorted.filter((u) => now - u.lastAt <= 7 * 86400 * 1000);
  const onlyFirstScreen = allSorted.filter((u) => !u.consulted && u.screen === "s0").length;
  const leads = allSorted.filter((u) => u.consulted).length;
  const maps = await getSlotsMaps(env);

  return json({
    ok: true,
    stats: { allTimeUsers: allSorted.length, totalUsers: recent7d.length, onlyFirstScreen, leads },
    visitors: recent7d.slice(0, 60).map(formatUserItem),
    allUsers: allSorted.slice(0, 200).map(formatUserItem),
    ...maps,
  });
}

const dbTime = (s) => new Date(String(s).replace(" ", "T") + "Z").getTime();
const isQuietHours = (now, tzMin = 180) => {
  const h = new Date(now + tzMin * 60000).getUTCHours();
  return h >= 22 || h < 9;
};

async function runFunnelCron(env) {
  if (!env.DB || !env.BOT_TOKEN) return;
  await ensureSchema(env);

  let results = [];
  try {
    const r = await env.DB.prepare("SELECT user_id, event_type, payload, created_at FROM tn_events WHERE created_at > datetime('now','-3 days') ORDER BY id ASC LIMIT 5000").all();
    results = r.results || [];
  } catch { return; }

  const users = new Map();
  for (const e of results) {
    let u = users.get(e.user_id);
    if (!u) {
      u = { id: e.user_id, lastAt: 0, screen: "s0", tier: "", slot: "", consulted: false, reportAt: 0, reminders: 0, blocked: false, tzMin: 180, msgOk: true };
      users.set(e.user_id, u);
    }
    let p = {};
    try { p = JSON.parse(e.payload || "{}"); } catch {}
    const t = dbTime(e.created_at);

    if (e.event_type === "owner_stop_report") { u.reportAt = t; continue; }
    if (e.event_type === "reminder_sent") { u.reminders++; continue; }
    if (e.event_type === "reminder_failed") { u.blocked = true; continue; }
    if (e.event_type === "consent_withdraw") { u.msgOk = false; continue; }

    u.lastAt = t;
    if (e.event_type === "app_open" && typeof p.tz === "number") u.tzMin = -p.tz;
    if (e.event_type === "screen_view" && p.screen) u.screen = p.screen;
    if (e.event_type === "tier_pick" && p.label) u.tier = p.label;
    if (e.event_type === "slot_pick" && p.date && p.time) u.slot = `${p.date} ${p.time}`;
    if (e.event_type === "consultation_sent" || e.event_type === "consultation_request") u.consulted = true;
  }

  const now = Date.now();
  let sent = 0;
  for (const u of users.values()) {
    if (u.consulted || isWeb(u) || sent >= 10 || !u.lastAt) continue;
    const idleMin = (now - u.lastAt) / 60000;

    const row = await env.DB.prepare("SELECT telegram_id, username, first_name, last_name FROM tn_users WHERE telegram_id=?").bind(u.id).first().catch(() => null);
    const user = row || { telegram_id: u.id };

    if (idleMin >= 15 && u.reportAt < u.lastAt) {
      await notifyOwner(
        env,
        `⏸ <b>Клиент остановился (${Math.round(idleMin)} мин назад)</b>\n${who(user)}\nЭтап: <b>${esc(SCREEN_LABELS[u.screen] || u.screen)}</b>\nДиагноз: ${esc(diagnoseDropoff(u))}`,
        user
      );
      await saveEvent(env, { id: u.id }, "owner_stop_report", { stage: u.screen });
      sent++;
    }

    if (!u.msgOk || u.blocked || isQuietHours(now, u.tzMin)) continue;
    const waitThreshold = u.screen === "s0" ? 45 : 90;
    if (u.reminders === 0 && idleMin >= waitThreshold && idleMin <= 1440) {
      const hi = row?.first_name ? `${esc(row.first_name)}, здравствуйте! ` : "Здравствуйте! ";
      const base = (env.MINI_APP_URL || "https://lid.toriya-sudba.workers.dev/v2/").split("?")[0];

      const isFirstScreenOnly = u.screen === "s0";
      const msgText = isFirstScreenOnly
        ? `${hi}Вы открыли Mini App TORIYA NOVA, но остановились на первом экране и ещё не посмотрели живые примеры систем (магазин с корзиной в Telegram, самозапись без переписок и личный кабинет).\n\nНажмите кнопку ниже — откроется сразу витрина с примерами в деле:`
        : `${hi}Вы смотрели примеры цифровых систем в TORIYA NOVA, но не завершили выбор формата или времени разбора.\n\nЕсли актуально перестать терять заявки в переписках — выберите удобный вариант старта:`;

      const targetGo = isFirstScreenOnly ? "cases" : "price";
      const btnTitle = isFirstScreenOnly ? "✨ Посмотреть примеры и кейсы" : "📅 Выбрать формат и время";

      try {
        await tgSend(env, u.id, msgText, [[{ text: btnTitle, web_app: { url: `${base}?go=${targetGo}` } }]]);
        await saveEvent(env, { id: u.id }, "reminder_sent", { n: 1, stage: u.screen });
        await notifyOwner(env, `🤖 Бот автоматически отправил дожим пользователю ${who(user)}`, user);
        sent++;
      } catch (err) {
        await saveEvent(env, { id: u.id }, "reminder_failed", { error: String(err.message || err) });
      }
    }
  }
}

async function currentApp(request, env) {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = "/";
  assetUrl.search = "";
  const response = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: "GET", headers: { Accept: "text/html" } }));
  if (!response.ok) return new Response("Not found", { status: 502, headers: HTML_HEADERS });
  const headers = new Headers(response.headers);
  Object.entries(HTML_HEADERS).forEach(([k, v]) => headers.set(k, v));
  headers.delete("Content-Length");
  headers.delete("ETag");
  return new Response(await response.text(), { status: 200, headers });
}

async function handle(request, env) {
  if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/v2" || path === "/app4" || path === "/en" || path === "/" || path === "/index.html") {
    return currentApp(request, env);
  }
  if (path === "/api/event") return withCors(await eventEndpoint(request, env));
  if (path === "/api/consultation") return withCors(await consultation(request, env));
  if (path === "/api/slots") return withCors(await slotsEndpoint(request, env));
  if (path === "/api/admin") return withCors(await adminEndpoint(request, env));

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env, ctx) {
    try { return await handle(request, env, ctx); } catch (error) { return json({ ok: false, error: String(error?.message || error) }, 500); }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runFunnelCron(env).catch((e) => console.error("cron", e)));
  },
};

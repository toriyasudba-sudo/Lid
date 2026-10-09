/**
 * TORIYA NOVA — LID Worker
 * Fix: /v2 and /v2/ always serve the CURRENT public/index.html
 * with no-store headers, while preserving the Mini App API routes.
 */

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=UTF-8",
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
  "Pragma": "no-cache",
  "Expires": "0",
  "X-TORIYA-APP": "v2-current",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function withCors(response) {
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));
  return new Response(response.body, { status: response.status, headers });
}

function hex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

async function verifyTelegramInitData(initData, botToken, maxAgeSec = 86400) {
  if (!initData || !botToken) {
    return { ok: false, reason: "missing_init_data_or_bot_token" };
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) return { ok: false, reason: "missing_hash" };

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > maxAgeSec) {
    return { ok: false, reason: "init_data_expired" };
  }

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  // Telegram Web Apps:
  // secret_key = HMAC_SHA256(key="WebAppData", message=bot_token)
  const secret = await hmac(
    new TextEncoder().encode("WebAppData"),
    botToken
  );

  const calculated = hex(await hmac(secret, dataCheckString));

  if (calculated !== receivedHash) {
    return { ok: false, reason: "invalid_hash" };
  }

  let user = null;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch {}

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

async function isSubscribed(userId, env) {
  if (!env.BOT_TOKEN || !env.CHANNEL_ID) {
    return { ok: false, subscribed: false, reason: "bot_token_or_channel_missing" };
  }

  try {
    const member = await telegram(env, "getChatMember", {
      chat_id: env.CHANNEL_ID,
      user_id: Number(userId),
    });

    const subscribed = ["creator", "administrator", "member"].includes(member.status);
    return { ok: true, subscribed, status: member.status };
  } catch (e) {
    return { ok: false, subscribed: false, reason: String(e.message || e) };
  }
}

async function saveEvent(env, user, type, payload = {}) {
  if (!env.DB || !user?.id) return;

  try {
    await env.DB.prepare(
      `INSERT INTO events (user_id, event_type, payload, created_at)
       VALUES (?, ?, ?, datetime('now'))`
    )
      .bind(String(user.id), type, JSON.stringify(payload))
      .run();
  } catch (e) {
    logErr("saveEvent", e);
  }
}

async function ensureUser(env, user) {
  if (!env.DB || !user?.id) return;

  try {
    await env.DB.prepare(
      `INSERT INTO users (telegram_id, username, first_name, last_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(telegram_id) DO UPDATE SET
         username=excluded.username,
         first_name=excluded.first_name,
         last_name=excluded.last_name,
         updated_at=datetime('now')`
    )
      .bind(
        String(user.id),
        user.username || null,
        user.first_name || null,
        user.last_name || null
      )
      .run();
  } catch (e) {
    logErr("ensureUser", e);
  }
}

async function access(request, env) {
  let body = {};
  try { body = await request.json(); } catch {}
  const initData =
    request.headers.get("X-Telegram-Init-Data") ||
    body.initData ||
    new URL(request.url).searchParams.get("initData") ||
    "";

  const auth = await getTelegramUser(initData, env);

  if (!auth.ok) {
    const errMap = {
      missing_init_data_or_bot_token: env.BOT_TOKEN ? "init_data_missing" : "bot_token_missing",
      missing_hash: "init_data_missing",
      init_data_expired: "init_data_expired",
      invalid_hash: "hash_mismatch",
    };
    return json({
      ok: false,
      allowed: false,
      error: errMap[auth.reason] || auth.reason,
      reason: auth.reason,
      message: env.BOT_TOKEN ? "Telegram authorization required" : "BOT_TOKEN не настроен",
    }, 401);
  }

  // No storage before consent: subscription check only.
  const subscription = await isSubscribed(auth.user.id, env);

  return json({
    ok: true,
    allowed: subscription.subscribed,
    subscribed: subscription.subscribed,
    user: auth.user,
    channel: env.CHANNEL_ID || null,
    reason: subscription.reason || null,
    error: subscription.subscribed ? null : (subscription.ok ? "not_member" : "telegram_api_error"),
    detail: subscription.ok ? null : (subscription.reason || null),
  });
}

const METRIC_NAMES = {
  offer: "Понятность продукта", client: "Понимание клиента", value: "Ценность и отличие", sales: "Путь к покупке", system: "Организация работы",
  context: "Цель и контекст", competition: "Конкуренты и альтернативы", journey: "Путь клиента", architecture: "Система и MVP", ai: "Контекст для AI",
};

const SCREEN_LABELS = {
  boot: "загрузка", locked: "экран «доступ только из канала»", s0: "старт («Клиент устал читать PDF»)",
  s0video: "первое видео", s1: "обычный лид-магнит", s3material: "ветка «читать канал»",
  s3break: "ветка «зову в личку»", s3product: "маршрут «человек увидел продукт»", s3return: "ветка «ничего не делаю»",
  s4: "«живой пользователь»", s5: "данные воронки", s6: "возврат в диалог", s6reminder: "пример напоминания",
  s8: "«твоя воронка»", intro: "вступление к диагностике", intro2: "«что будет в конце»",
  quiz: "вопросы диагностики", processing: "расчёт результата", result: "результат: общий балл",
  resultmap: "карта ясности", resultfocus: "главная точка роста", resultvideo: "финальное видео",
  consult: "форма заявки", obs: "три наблюдения", niches: "Mini App для разных ниш", warm: "прогрев", v2: "видео 2", bot: "бот и воронка", v3: "видео 3 и взгляд эксперта", mech: "вся механика", v4: "видео 4", embed: "что можно встроить", voice: "оффер голосового разбора", v5: "финальное видео", final: "финальный экран",
};

const errs = (globalThis.__errs = globalThis.__errs || []);
function logErr(where, e) { const m = `${where}: ${e?.message || e}`; console.error(m); errs.push(m); if (errs.length > 8) errs.shift(); }
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const uid = (u) => u?.id ?? u?.telegram_id;
const displayName = (u) => [u?.first_name, u?.last_name].filter(Boolean).join(" ") || u?.username || `ID ${uid(u)}`;
const contactUrl = (u) => (u?.username ? `https://t.me/${u.username}` : `tg://user?id=${uid(u)}`);
const who = (u) => `<b>${esc(displayName(u))}</b>${u?.username ? ` (@${esc(u.username)})` : ""} · <code>${uid(u)}</code>`;

function metricsLines(pct) {
  return Object.entries(pct || {}).map(([k, v]) => `• ${METRIC_NAMES[k] || k}: ${v}%`).join("\n");
}

function diagnosticText(d = {}) {
  if (d.overall == null) return "";
  const weak = METRIC_NAMES[d.weak] || d.weak || "—";
  return `📊 Общая ясность: <b>${d.overall}%</b>\n🎯 Точка роста: <b>${esc(weak)}</b> — ${d.weakScore ?? "?"}%\n${metricsLines(d.pct)}`;
}

async function tgSend(env, chatId, text, buttons) {
  const body = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  return telegram(env, "sendMessage", body);
}

async function notifyOwner(env, text, user) {
  if (!env.BOT_TOKEN || !env.OWNER_CHAT_ID) return;
  const buttons = user ? [[{ text: "✉️ Написать", url: contactUrl(user) }]] : null;
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
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at)"),
    ]);
    globalThis.__schemaReady = true;
  } catch (e) { logErr("ensureSchema", e); }
}

async function hasEvent(env, userId, type) {
  try {
    const r = await env.DB.prepare("SELECT 1 AS x FROM events WHERE user_id=? AND event_type=? LIMIT 1")
      .bind(String(userId), type).first();
    return !!r;
  } catch (e) { logErr("hasEvent", e); return false; }
}

async function eventEndpoint(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "POST required" }, 405);
  let body = {};
  try { body = await request.json(); } catch {}
  const initData = request.headers.get("X-Telegram-Init-Data") || body.initData || "";
  const auth = await getTelegramUser(initData, env);
  if (!auth.ok) return json({ ok: false, error: auth.reason }, 401);

  await ensureSchema(env);
  const type = body.event || body.type || "event";
  const meta = body.meta || {};

  if (type === "consent") {
    const first = !(await hasEvent(env, auth.user.id, "consent"));
    await ensureUser(env, auth.user);
    await saveEvent(env, auth.user, "consent", { processing: !!meta.processing, privacy: !!meta.privacy, messages: !!meta.messages, v: meta.v || null });
    if (first) await notifyOwner(env, `🆕 ${who(auth.user)} зашёл и дал согласие на обработку данных${meta.messages ? " (и на напоминания)" : ""}`, auth.user);
    return json({ ok: true });
  }
  if (!(await hasEvent(env, auth.user.id, "consent"))) return json({ ok: true, skipped: "no_consent" });

  await ensureUser(env, auth.user);
  const first = type === "result_view" ? !(await hasEvent(env, auth.user.id, "result_view")) : false;
  await saveEvent(env, auth.user, type, meta);
  if (first) await notifyOwner(env, `✅ ${who(auth.user)} прошёл(а) диагностику\n\n${diagnosticText(meta)}`, auth.user);
  return json({ ok: true });
}

async function consultation(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

  let body = {};
  try { body = await request.json(); } catch {}
  const initData = request.headers.get("X-Telegram-Init-Data") || body.initData || "";
  const auth = await getTelegramUser(initData, env);
  if (!auth.ok) return json({ ok: false, error: auth.reason }, 401);

  await ensureSchema(env);
  if (!(await hasEvent(env, auth.user.id, "consent"))) return json({ ok: false, error: "no_consent" }, 403);
  await ensureUser(env, auth.user);

  const product = String(body.product || "").trim();
  const goal = String(body.request || body.goal || "").trim();
  const diagnostic = body.diagnostic || {};
  const voice = body.intent === "voice";
  const url = env.CONSULTATION_URL || "https://t.me/toriya_nova";

  // Double-tap protection: one owner notification per user per 2 minutes.
  try {
    const dup = await env.DB.prepare(
      "SELECT 1 AS x FROM events WHERE user_id=? AND event_type='consultation_request' AND created_at > datetime('now','-2 minutes') LIMIT 1"
    ).bind(String(auth.user.id)).first();
    if (dup) return json({ ok: true, consultationUrl: url, duplicate: true });
  } catch {}

  await saveEvent(env, auth.user, "consultation_request", { product, goal, diagnostic, intent: body.intent || "miniapp" });

  await notifyOwner(
    env,
    `${voice ? "🎙️ <b>Заявка на голосовой разбор</b>" : "🟣 <b>Заявка на Mini App</b>"}\n\n👤 ${who(auth.user)}\n📦 ${voice ? "Продукт" : "Ниша и продукт"}: ${esc(product) || "—"}\n🎯 ${voice ? "Хочет понять" : "Какой Mini App хочет"}: ${esc(goal) || "—"}\n\n${diagnosticText(diagnostic)}`,
    auth.user
  );

  return json({ ok: true, consultationUrl: url });
}

// ---------- Funnel cron: owner "stopped at" reports + user reminders ----------

const dbTime = (s) => new Date(String(s).replace(" ", "T") + "Z").getTime();
const isQuietHours = (now, tzMin = 180) => { const h = new Date(now + tzMin * 60000).getUTCHours(); return h >= 22 || h < 9; }; // user local time (default Moscow)

function stageLabel(u) {
  if (u.result) return `получил результат (${u.result.overall ?? "?"}%), заявку не оставил`;
  if (u.started) return `диагностика, вопрос ${u.q || 1} из 5`;
  return SCREEN_LABELS[u.screen] || u.screen;
}

function reminderMessage(u, n, firstName) {
  const hi = firstName ? `${esc(firstName)}, ` : "";
  if (u.result) {
    const weak = METRIC_NAMES[u.result.weak] || "главная точка роста";
    return n === 1
      ? { text: `${hi}результат демо уже у тебя, а как такой Mini App выглядел бы для твоей ниши — ещё нет.\n\nПокажу варианты под твою экспертность?`, button: "Посмотреть варианты", go: "niches" }
      : { text: `Кажется, самое интересное осталось за кадром: ты прошёл демо, но ещё не увидел, что из этого можно собрать под свой продукт. Это пара минут.`, button: "Посмотреть", go: "niches" };
  }
  if (u.started) {
    return n === 1
      ? { text: `${hi}диагностика остановилась на вопросе ${u.q || 1} из 5. До карты ясности совсем немного. Продолжим?`, button: "Продолжить диагностику", go: "intro" }
      : { text: `Стоп. Карта ясности по твоему продукту всё ещё ждёт — она собирается за пару минут. Вернёмся?`, button: "Пройти диагностику", go: "intro" };
  }
  return n === 1
    ? { text: `${hi}мы остановились на самом интересном — на примере, как выглядит лид-магнит нового времени. Досмотрим?`, button: "Продолжить", go: "" }
    : { text: `А что, если лид-магнит — это не PDF, а действие? Загляни, покажу на примере за пару минут.`, button: "Посмотреть", go: "" };
}

async function runFunnelCron(env, opts = {}) {
  const dry = !!opts.dry, log = [];
  const notify = dry ? async () => {} : notifyOwner, save = dry ? async () => {} : saveEvent, send = dry ? async () => {} : tgSend;
  const quiet = (now, tz) => !opts.ignoreQuiet && isQuietHours(now, tz);
  if (!env.DB || !env.BOT_TOKEN) return ["нет DB или BOT_TOKEN"];
  await ensureSchema(env);

  const { results } = await env.DB.prepare(
    "SELECT user_id, event_type, payload, created_at FROM events WHERE created_at > datetime('now','-3 days') AND event_type != 'access' ORDER BY id ASC LIMIT 5000"
  ).all();

  const users = new Map();
  for (const e of results || []) {
    let u = users.get(e.user_id);
    if (!u) {
      u = { id: e.user_id, lastAt: 0, screen: "s0", q: 0, started: false, result: null, consulted: false,
            reportAt: 0, reminders: 0, lastReminderAt: 0, blocked: false, tzMin: 180, msgOk: false };
      users.set(e.user_id, u);
    }
    let p = {};
    try { p = JSON.parse(e.payload || "{}"); } catch {}
    const t = dbTime(e.created_at);

    if (e.event_type === "owner_stop_report") { u.reportAt = t; continue; }
    if (e.event_type === "reminder_sent") { u.reminders++; u.lastReminderAt = t; continue; }
    if (e.event_type === "reminder_failed") { u.blocked = true; continue; }
    if (e.event_type === "consent_withdraw") { u.msgOk = false; continue; }
    if (e.event_type === "consent") u.msgOk = !!p.messages;

    u.lastAt = t;
    if (e.event_type === "app_open" && typeof p.tz === "number") u.tzMin = -p.tz;
    if (e.event_type === "screen_view" && p.screen) u.screen = p.screen;
    else if (e.event_type === "question_view") u.q = p.n || u.q;
    else if (e.event_type === "diagnostic_started") { u.started = true; u.q = 1; u.result = null; }
    else if (e.event_type === "result_view") u.result = p;
    else if (e.event_type === "consultation_sent" || e.event_type === "consultation_request") u.consulted = true;
  }

  const now = Date.now();
  let sent = 0;
  for (const u of users.values()) {
    if (u.consulted) { log.push(`${u.id}: пропуск — уже оставил заявку`); continue; }
    if (sent >= 10 || !u.lastAt) continue;
    const idleMin = (now - u.lastAt) / 60000;
    log.push(`${u.id}: тишина ${Math.round(idleMin)} мин · ${stageLabel(u)} · отчёт ${u.reportAt >= u.lastAt ? "уже отправлен" : "ещё не отправлен"} · напоминаний ${u.reminders}${u.blocked ? " · БЛОК" : ""}${quiet(now, u.tzMin) ? " · тихие часы" : ""}`);

    const row = await env.DB.prepare("SELECT telegram_id, username, first_name, last_name FROM users WHERE telegram_id=?")
      .bind(u.id).first().catch(() => null);
    const user = row || { telegram_id: u.id };

    // 1) Report to owner: where the person stopped
    if (idleMin >= (opts.fast ? 1 : 10) && u.reportAt < u.lastAt) {
      log.push("  → отчёт владельцу");
      const extra = u.result ? `\n\n${diagnosticText(u.result)}` : "";
      await notify(env, `⏸ ${who(user)} остановился\n📍 ${esc(stageLabel(u))}\n🕒 Последняя активность ${Math.round(idleMin)} мин назад${extra}`, user);
      await save(env, { id: u.id }, "owner_stop_report", { stage: stageLabel(u) });
      sent++;
    }

    // 2) Reminder to the person (max 2, never at night Moscow time)
    if (!u.msgOk) { log.push("  · напоминания не разрешены"); continue; }
    if (u.blocked || quiet(now, u.tzMin)) continue;
    const firstAfter = opts.fast ? 2 : (u.started && !u.result ? 30 : 120);
    const n = u.reminders === 0 && idleMin >= firstAfter && idleMin <= 1440 ? 1
            : u.reminders === 1 && idleMin >= 1440 && idleMin <= 2880 && now - u.lastReminderAt >= 20 * 3600 * 1000 ? 2 : 0;
    if (!n) continue;

    log.push(`  → напоминание №${n}`);
    const msg = reminderMessage(u, n, row?.first_name);
    const base = (env.MINI_APP_URL || "https://lid.toriya-sudba.workers.dev/app4/").split("?")[0];
    const appUrl = msg.go ? `${base}?go=${msg.go}` : base;
    try {
      await send(env, u.id, msg.text, [[{ text: msg.button, web_app: { url: appUrl } }], [{ text: "Не напоминать", callback_data: "stop" }]]);
      await save(env, { id: u.id }, "reminder_sent", { n, stage: stageLabel(u) });
    } catch (err) {
      await save(env, { id: u.id }, "reminder_failed", { error: String(err.message || err) });
    }
    sent++;
  }
  return log;
}

async function webhookSecret(env) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.BOT_TOKEN || ""));
  return hex(new Uint8Array(d)).slice(0, 40);
}

async function setupWebhook(request, env) {
  const url = new URL(request.url).origin + "/tg";
  await telegram(env, "setWebhook", { url, secret_token: await webhookSecret(env), allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
  await notifyOwner(env, `🔗 Вебхук бота подключён: ${esc(url)}\nТеперь работают /start, /stop и /delete.`);
  return json({ ok: true });
}

async function tgWebhook(request, env) {
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await webhookSecret(env))) return json({ ok: false }, 403);
  let up = {};
  try { up = await request.json(); } catch {}
  await ensureSchema(env);
  const cb = up.callback_query, msg = up.message;
  const from = (cb || msg)?.from;
  const chatId = cb ? cb.message?.chat?.id : msg?.chat?.id;
  if (!from?.id || !chatId) return json({ ok: true });
  const text = (msg?.text || "").trim().toLowerCase();
  const appUrl = (env.MINI_APP_URL || "").split("?")[0] || new URL(request.url).origin + "/app4/";
  try {
    if (cb?.data === "stop" || /^\/stop\b|^стоп$|^отписаться$/.test(text)) {
      await saveEvent(env, from, "consent_withdraw", {});
      if (cb) await telegram(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Готово, больше не напоминаю" });
      await tgSend(env, chatId, "Хорошо, больше не напоминаю. Mini App всегда открывается по кнопке меню.");
    } else if (/^\/(delete|forgetme)\b/.test(text)) {
      await env.DB.batch([env.DB.prepare("DELETE FROM events WHERE user_id=?").bind(String(from.id)), env.DB.prepare("DELETE FROM users WHERE telegram_id=?").bind(String(from.id))]);
      await tgSend(env, chatId, "Готово: профиль, ответы и события удалены.");
      await notifyOwner(env, `🗑 ${who(from)} удалил(а) свои данные командой /delete`);
    } else if (/^\/start\b/.test(text)) {
      await tgSend(env, chatId, "Привет! Это Mini App Toriya Nova: лид-магнит, который не читают, а проходят.\n\nКоманды: /stop — отключить напоминания, /delete — удалить мои данные.", [[{ text: "✨ Открыть Mini App", web_app: { url: appUrl } }]]);
    }
  } catch (e) { logErr("webhook", e); }
  return json({ ok: true });
}

async function diag(request, env) {
  const now = Date.now();
  if (now - (globalThis.__diagAt || 0) < 30000) return json({ ok: false, error: "подожди 30 секунд" }, 429);
  globalThis.__diagAt = now;
  const q = new URL(request.url).searchParams;
  const run = q.get("run") === "1";
  const lines = [];
  try {
    await ensureSchema(env);
    const c = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM events) AS e, (SELECT COUNT(*) FROM users) AS u").first();
    lines.push(`📚 В базе: событий ${c.e}, людей ${c.u}`);
    const last = await env.DB.prepare("SELECT user_id, event_type, created_at FROM events ORDER BY id DESC LIMIT 6").all();
    lines.push("Последние события:\n" + ((last.results || []).map((r) => `${r.created_at} · ${r.user_id} · ${r.event_type}`).join("\n") || "— пусто —"));
    const fails = await env.DB.prepare("SELECT user_id, payload FROM events WHERE event_type='reminder_failed' ORDER BY id DESC LIMIT 2").all();
    if ((fails.results || []).length) lines.push("Ошибки напоминаний:\n" + fails.results.map((r) => `${r.user_id}: ${r.payload}`).join("\n"));
  } catch (e) { lines.push("❌ База: " + (e?.message || e)); }
  const cron = await runFunnelCron(env, { dry: !run, fast: q.get("fast") === "1", ignoreQuiet: q.get("nq") === "1" }).catch((e) => ["❌ крон: " + (e?.message || e)]);
  lines.push((run ? "▶️ Крон выполнен:" : "🔍 Проба крона (ничего не отправляю):") + "\n" + ((cron || []).join("\n") || "— нет людей с событиями за 3 дня —"));
  if (errs.length) lines.push("⚠️ Ошибки:\n" + errs.join("\n"));
  try { await tgSend(env, env.OWNER_CHAT_ID, esc("🩺 Диагностика\n\n" + lines.join("\n\n")).slice(0, 3900)); } catch (e) { return json({ ok: false, error: String(e.message || e) }); }
  return json({ ok: true });
}

async function refreshTelegramApp(env) {
  if (!env.BOT_TOKEN || !env.OWNER_CHAT_ID) {
    return json({ ok: false, error: "BOT_TOKEN or OWNER_CHAT_ID is missing" }, 500);
  }

  const keyboard = {
    keyboard: [[
      {
        text: "TORIYA NOVA",
        web_app: {
          url: env.MINI_APP_URL || "https://lid.toriya-sudba.workers.dev/v2/",
        },
      },
    ]],
    resize_keyboard: true,
    is_persistent: true,
  };

  await telegram(env, "sendMessage", {
    chat_id: env.OWNER_CHAT_ID,
    text: "TORIYA NOVA — актуальная версия Mini App:",
    reply_markup: keyboard,
  });

  return json({ ok: true });
}

/**
 * CRITICAL ROUTE:
 * Always fetch the current asset from the Worker Assets binding.
 * Do NOT redirect to another URL and do NOT let the browser reuse an old
 * HTML response.
 */
async function currentApp(request, env) {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = "/";
  assetUrl.search = "";

  const assetRequest = new Request(assetUrl.toString(), {
    method: "GET",
    headers: { "Accept": "text/html" },
  });

  const response = await env.ASSETS.fetch(assetRequest);

  if (!response.ok) {
    return new Response("Mini App index.html not found in deployed assets", {
      status: 502,
      headers: HTML_HEADERS,
    });
  }

  const headers = new Headers(response.headers);
  Object.entries(HTML_HEADERS).forEach(([k, v]) => headers.set(k, v));

  // Useful for checking that the new Worker is actually serving the page.
  headers.set("X-TORIYA-ROUTE", "current-v2");

  headers.delete("Content-Length");
  headers.delete("ETag");

  // Visible build stamp: proves which Worker/HTML the Mini App really got.
  let html = await response.text();
  html = html.replace("MINI APP / GAME", "MINI APP / GAME · v4");

  return new Response(html, {
    status: 200,
    headers,
  });
}

async function noStoreAsset(request, env) {
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  headers.delete("ETag");
  return new Response(response.body, { status: response.status, headers });
}

async function handle(request, env) {
  if (request.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }));
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  // /v2 and /v2/ MUST serve the current deployed index.html.
  if (path === "/v2" || path === "/app4") {
    return currentApp(request, env);
  }

  if (path === "/health") {
    return json({
      ok: true,
      worker: "lid",
      route: "current-v2",
      timestamp: new Date().toISOString(),
    });
  }

  if (path === "/api/access") {
    return withCors(await access(request, env));
  }

  if (path === "/api/event") {
    return withCors(await eventEndpoint(request, env));
  }

  if (path === "/api/consultation") {
    return withCors(await consultation(request, env));
  }

  if (path === "/tg" && request.method === "POST") return tgWebhook(request, env);
  if (path === "/setup-webhook") return withCors(await setupWebhook(request, env));

  if (path === "/diag") {
    return withCors(await diag(request, env));
  }

  if (path === "/refresh") {
    return withCors(await refreshTelegramApp(env));
  }

  if (path === "/app.js") {
    return noStoreAsset(request, env);
  }

  // Root also serves the current index so direct Worker URL and /v2 stay aligned.
  if (path === "/" || path === "/index.html") {
    return currentApp(request, env);
  }

  // Everything else: let Cloudflare Assets serve videos and other public files.
  const assetResponse = await env.ASSETS.fetch(request);
  return assetResponse;
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (error) {
      console.error(error);
      return json({
        ok: false,
        error: String(error?.message || error),
      }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runFunnelCron(env).catch((e) => console.error("cron", e)));
  },
};

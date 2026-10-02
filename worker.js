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

  Object.entries(corsHeaders()).forEach(([k, v]) => {
    headers.set(k, v);
  });

  return new Response(response.body, {
    status: response.status,
    headers,
  });
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

  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(message)
    )
  );
}

async function verifyTelegramInitData(
  initData,
  botToken,
  maxAgeSec = 86400
) {
  if (!initData || !botToken) {
    return {
      ok: false,
      reason: "missing_init_data_or_bot_token",
    };
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");

  if (!receivedHash) {
    return {
      ok: false,
      reason: "missing_hash",
    };
  }

  const authDate = Number(params.get("auth_date") || 0);

  if (
    !authDate ||
    Math.floor(Date.now() / 1000) - authDate > maxAgeSec
  ) {
    return {
      ok: false,
      reason: "init_data_expired",
    };
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

  const calculated = hex(
    await hmac(secret, dataCheckString)
  );

  if (calculated !== receivedHash) {
    return {
      ok: false,
      reason: "invalid_hash",
    };
  }

  let user = null;

  try {
    user = JSON.parse(params.get("user") || "null");
  } catch {}

  return {
    ok: true,
    user,
    authDate,
  };
}

async function telegram(env, method, body) {
  if (!env.BOT_TOKEN) {
    throw new Error("BOT_TOKEN is not configured");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  const data = await response.json();

  if (!data.ok) {
    throw new Error(
      data.description ||
      `Telegram API error: ${method}`
    );
  }

  return data.result;
}

async function getTelegramUser(initData, env) {
  const maxAge = Number(
    env.INIT_DATA_MAX_AGE_SEC || 86400
  );

  return verifyTelegramInitData(
    initData,
    env.BOT_TOKEN,
    maxAge
  );
}

async function isSubscribed(userId, env) {
  if (!env.BOT_TOKEN || !env.CHANNEL_ID) {
    return {
      ok: false,
      subscribed: false,
      reason: "bot_token_or_channel_missing",
    };
  }

  try {
    const member = await telegram(
      env,
      "getChatMember",
      {
        chat_id: env.CHANNEL_ID,
        user_id: Number(userId),
      }
    );

    const subscribed = [
      "creator",
      "administrator",
      "member",
    ].includes(member.status);

    return {
      ok: true,
      subscribed,
      status: member.status,
    };
  } catch (e) {
    return {
      ok: false,
      subscribed: false,
      reason: String(e.message || e),
    };
  }
}

async function saveEvent(
  env,
  user,
  type,
  payload = {}
) {
  if (!env.DB || !user?.id) {
    return;
  }

  try {
    await env.DB
      .prepare(
        `INSERT INTO events
         (user_id, event_type, payload, created_at)
         VALUES (?, ?, ?, datetime('now'))`
      )
      .bind(
        String(user.id),
        type,
        JSON.stringify(payload)
      )
      .run();
  } catch {
    // Do not break the Mini App if analytics schema differs.
  }
}

async function ensureUser(env, user) {
  if (!env.DB || !user?.id) {
    return;
  }

  try {
    await env.DB
      .prepare(
        `INSERT INTO users
         (
           telegram_id,
           username,
           first_name,
           last_name,
           created_at,
           updated_at
         )
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(telegram_id)
         DO UPDATE SET
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
  } catch {
    // Best effort.
  }
}

async function access(request, env) {
  const initData =
    request.headers.get(
      "X-Telegram-Init-Data"
    ) ||
    new URL(request.url).searchParams.get(
      "initData"
    ) ||
    "";

  const auth = await getTelegramUser(
    initData,
    env
  );

  if (!auth.ok) {
    return json(
      {
        ok: false,
        allowed: false,
        reason: auth.reason,
        message: env.BOT_TOKEN
          ? "Telegram authorization required"
          : "BOT_TOKEN не настроен",
      },
      401
    );
  }

  await ensureUser(env, auth.user);

  const subscription =
    await isSubscribed(
      auth.user.id,
      env
    );

  await saveEvent(
    env,
    auth.user,
    "access",
    {
      subscribed:
        subscription.subscribed,
      status:
        subscription.status || null,
    }
  );

  return json({
    ok: true,
    allowed:
      subscription.subscribed,
    subscribed:
      subscription.subscribed,
    user: auth.user,
    channel:
      env.CHANNEL_ID || null,
    reason:
      subscription.reason || null,
  });
}

async function eventEndpoint(
  request,
  env
) {
  if (request.method !== "POST") {
    return json(
      {
        ok: false,
        error: "POST required",
      },
      405
    );
  }

  const initData =
    request.headers.get(
      "X-Telegram-Init-Data"
    ) || "";

  const auth =
    await getTelegramUser(
      initData,
      env
    );

  if (!auth.ok) {
    return json(
      {
        ok: false,
        error: auth.reason,
      },
      401
    );
  }

  let body = {};

  try {
    body = await request.json();
  } catch {}

  await ensureUser(
    env,
    auth.user
  );

  await saveEvent(
    env,
    auth.user,
    body.type || "event",
    body
  );

  return json({
    ok: true,
  });
}

async function consultation(
  request,
  env
) {
  if (request.method !== "POST") {
    return json(
      {
        ok: false,
        error: "POST required",
      },
      405
    );
  }

  const initData =
    request.headers.get(
      "X-Telegram-Init-Data"
    ) || "";

  const auth =
    await getTelegramUser(
      initData,
      env
    );

  if (!auth.ok) {
    return json(
      {
        ok: false,
        error: auth.reason,
      },
      401
    );
  }

  let body = {};

  try {
    body = await request.json();
  } catch {}

  await ensureUser(
    env,
    auth.user
  );

  const product =
    String(
      body.product || ""
    ).trim();

  const goal =
    String(
      body.goal || ""
    ).trim();

  await saveEvent(
    env,
    auth.user,
    "consultation_request",
    {
      product,
      goal,
    }
  );

  if (
    env.BOT_TOKEN &&
    env.OWNER_CHAT_ID
  ) {
    const name =
      [
        auth.user?.first_name,
        auth.user?.last_name,
      ]
        .filter(Boolean)
        .join(" ") ||
      auth.user?.username ||
      `ID ${auth.user?.id}`;

    const text =
      `🟣 Новая мини-консультация TORIYA NOVA\n\n` +
      `👤 ${name}\n` +
      `🆔 ${auth.user?.id || ""}\n` +
      `📦 Продукт / услуга: ${
        product || "—"
      }\n` +
      `🎯 Что хочет от консультации: ${
        goal || "—"
      }`;

    try {
      await telegram(
        env,
        "sendMessage",
        {
          chat_id:
            env.OWNER_CHAT_ID,
          text,
        }
      );
    } catch {
      // Request remains saved.
    }
  }

  return json({
    ok: true,
    consultationUrl:
      env.CONSULTATION_URL ||
      "https://t.me/toriya_nova",
  });
}

async function refreshTelegramApp(
  env
) {
  if (
    !env.BOT_TOKEN ||
    !env.OWNER_CHAT_ID
  ) {
    return json(
      {
        ok: false,
        error:
          "BOT_TOKEN or OWNER_CHAT_ID is missing",
      },
      500
    );
  }

  const keyboard = {
    keyboard: [
      [
        {
          text: "TORIYA NOVA",
          web_app: {
            url:
              env.MINI_APP_URL ||
              "https://lid.toriya-sudba.workers.dev/v2/",
          },
        },
      ],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };

  await telegram(
    env,
    "sendMessage",
    {
      chat_id:
        env.OWNER_CHAT_ID,
      text:
        "TORIYA NOVA — актуальная версия Mini App:",
      reply_markup:
        keyboard,
    }
  );

  return json({
    ok: true,
  });
}

/**
 * CRITICAL ROUTE:
 * /v2 and /v2/ always fetch the CURRENT
 * public/index.html from the deployed Assets.
 */
async function currentApp(
  request,
  env
) {
  const assetUrl =
    new URL(request.url);

  assetUrl.pathname =
    "/index.html";

  assetUrl.search = "";

  const assetRequest =
    new Request(
      assetUrl.toString(),
      {
        method: "GET",
        headers:
          request.headers,
      }
    );

  const response =
    await env.ASSETS.fetch(
      assetRequest
    );

  if (!response.ok) {
    return new Response(
      "Mini App index.html not found in deployed assets",
      {
        status: 502,
        headers: HTML_HEADERS,
      }
    );
  }

  const headers =
    new Headers(
      response.headers
    );

  Object.entries(
    HTML_HEADERS
  ).forEach(([k, v]) => {
    headers.set(k, v);
  });

  headers.set(
    "X-TORIYA-ROUTE",
    "current-v2"
  );

  return new Response(
    response.body,
    {
      status: 200,
      headers,
    }
  );
}

async function handle(
  request,
  env
) {
  if (
    request.method ===
    "OPTIONS"
  ) {
    return withCors(
      new Response(null, {
        status: 204,
      })
    );
  }

  const url =
    new URL(request.url);

  const path =
    url.pathname.replace(
      /\/+$/,
      ""
    ) || "/";

  // CRITICAL:
  // /v2 and /v2/ serve the current index.html.
  if (path === "/v2") {
    return currentApp(
      request,
      env
    );
  }

  if (path === "/health") {
    return json({
      ok: true,
      worker: "lid",
      route: "current-v2",
      timestamp:
        new Date().toISOString(),
    });
  }

  if (
    path ===
    "/api/access"
  ) {
    return withCors(
      await access(
        request,
        env
      )
    );
  }

  if (
    path ===
    "/api/event"
  ) {
    return withCors(
      await eventEndpoint(
        request,
        env
      )
    );
  }

  if (
    path ===
    "/api/consultation"
  ) {
    return withCors(
      await consultation(
        request,
        env
      )
    );
  }

  if (
    path === "/refresh"
  ) {
    return withCors(
      await refreshTelegramApp(
        env
      )
    );
  }

  // Root also serves the current index.
  if (
    path === "/" ||
    path === "/index.html"
  ) {
    return currentApp(
      request,
      env
    );
  }

  // Videos and other public files.
  const assetResponse =
    await env.ASSETS.fetch(
      request
    );

  return assetResponse;
}

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    try {
      return await handle(
        request,
        env,
        ctx
      );
    } catch (error) {
      console.error(error);

      return json(
        {
          ok: false,
          error: String(
            error?.message ||
            error
          ),
        },
        500
      );
    }
  },

  async scheduled(
    event,
    env,
    ctx
  ) {
    // Cron is kept in wrangler.lid.jsonc.
  },
};

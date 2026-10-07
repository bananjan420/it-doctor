// API админ-панели: список заявок и смена статуса.
//
// Браузер никогда не обращается к Supabase напрямую: он говорит только с этой
// функцией на Cloudflare, а функция уже ходит в базу секретным ключом из
// переменных окружения. Секретный ключ в клиент не попадает ни при каких условиях.
//
// Вход: владелец присылает ADMIN_KEY (пароль) один раз. В ответ функция выдаёт
// подписанную сессию в HttpOnly-cookie — сам пароль в браузере не сохраняется.
//
//   GET  /api/leads  -> { ok, leads }
//   PATCH /api/leads -> { ok, lead }  (тело: { id, status })
//   POST /api/leads  -> вход по паролю: { ok }

const COOKIE_NAME = "itd_admin";
const SESSION_TTL_SECONDS = 60 * 60 * 12;

// Статусы заявки. Значения совпадают с типом lead_status в базе.
export const STATUSES = ["new", "in_progress", "ready", "completed"];

export const STATUS_LABELS = {
  new: "Новая",
  in_progress: "В работе",
  ready: "Готова",
  completed: "Завершена"
};

// Поля, которые отдаём в браузер. Служебные (например updated_at) не нужны.
const LEAD_COLUMNS = [
  "id",
  "created_at",
  "name",
  "phone",
  "service",
  "message",
  "source",
  "status"
].join(",");

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const origin = url.origin;

  try {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method === "POST") {
      return await handleLogin(request, env, origin);
    }

    if (request.method === "GET") {
      return await handleList(request, env, origin);
    }

    if (request.method === "PATCH") {
      return await handleStatusUpdate(request, env, origin);
    }

    return json(405, { ok: false, error: "Метод не поддерживается" }, origin);
  } catch (error) {
    console.error("Admin API failed", { reason: error?.name || "unknown" });
    return json(500, { ok: false, error: "Внутренняя ошибка" }, origin);
  }
}

// --- Вход ---------------------------------------------------------------

async function handleLogin(request, env, origin) {
  const adminKey = env.ADMIN_KEY?.trim();

  if (!adminKey) {
    console.error("ADMIN_KEY is not configured");
    return json(503, {
      ok: false,
      error: "Вход не настроен: не задан ADMIN_KEY"
    }, origin);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { ok: false, error: "Ожидается JSON" }, origin);
  }

  // Пустой ключ — это выход: стираем cookie, чтобы доступ закрылся сразу.
  if (!String(payload.key || "")) {
    const headers = corsHeaders(origin);
    headers["Set-Cookie"] =
      `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
    return json(200, { ok: true, loggedOut: true }, origin, headers);
  }

  const provided = String(payload.key || "");
  if (!timingSafeEqual(provided, adminKey)) {
    return json(401, { ok: false, error: "Неверный пароль" }, origin);
  }

  const session = await createSession(adminKey);
  const headers = corsHeaders(origin);
  // HttpOnly: скрипты на странице не смогут прочитать сессию.
  headers["Set-Cookie"] =
    `${COOKIE_NAME}=${session}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; ` +
    "HttpOnly; Secure; SameSite=Strict";

  return json(200, { ok: true }, origin, headers);
}

// --- Список заявок ------------------------------------------------------

async function handleList(request, env, origin) {
  if (!(await isAuthorized(request, env))) {
    return json(401, { ok: false, error: "Нужен вход" }, origin);
  }

  const url = new URL(request.url);
  const status = url.searchParams.get("status");

  const params = new URLSearchParams({
    select: LEAD_COLUMNS,
    // Новые заявки сверху.
    order: "created_at.desc",
    limit: "500"
  });

  if (status && STATUSES.includes(status)) {
    params.set("status", `eq.${status}`);
  }

  const response = await supabase(env, `/rest/v1/leads?${params.toString()}`, {
    method: "GET"
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("Supabase list failed", {
      status: response.status,
      detail: detail.slice(0, 200)
    });
    return json(502, { ok: false, error: "Не удалось получить заявки" }, origin);
  }

  const leads = await response.json();

  return json(200, {
    ok: true,
    leads,
    statuses: STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] }))
  }, origin);
}

// --- Смена статуса ------------------------------------------------------

async function handleStatusUpdate(request, env, origin) {
  if (!(await isAuthorized(request, env))) {
    return json(401, { ok: false, error: "Нужен вход" }, origin);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { ok: false, error: "Ожидается JSON" }, origin);
  }

  const id = String(payload.id || "").trim();
  const status = String(payload.status || "").trim();

  if (!id) {
    return json(400, { ok: false, error: "Не указан id заявки" }, origin);
  }

  if (!STATUSES.includes(status)) {
    return json(400, {
      ok: false,
      error: `Недопустимый статус. Разрешены: ${STATUSES.join(", ")}`
    }, origin);
  }

  const response = await supabase(env, "/rest/v1/leads?id=eq." + encodeURIComponent(id), {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status })
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("Supabase update failed", {
      status: response.status,
      detail: detail.slice(0, 200)
    });
    return json(502, { ok: false, error: "Не удалось сохранить статус" }, origin);
  }

  const updated = await response.json();

  if (!Array.isArray(updated) || updated.length === 0) {
    return json(404, { ok: false, error: "Заявка не найдена" }, origin);
  }

  return json(200, { ok: true, lead: updated[0] }, origin);
}

// --- Supabase -----------------------------------------------------------

function supabaseConfig(env) {
  return {
    url: env.SUPABASE_URL?.trim().replace(/\/+$/, "") || "",
    key: env.SUPABASE_SECRET_KEY?.trim() || env.SUPABASE_SERVICE_KEY?.trim() || ""
  };
}

function supabase(env, path, options) {
  const { url, key } = supabaseConfig(env);

  if (!url || !key) {
    throw new Error("Supabase не настроен");
  }

  return fetch(`${url}${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(8000)
  });
}

// --- Сессия -------------------------------------------------------------

/** Создаёт подписанную сессию: срок действия + подпись HMAC от ADMIN_KEY. */
export async function createSession(adminKey, ttl = SESSION_TTL_SECONDS) {
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const signature = await sign(`admin.${expiresAt}`, adminKey);
  return `${expiresAt}.${signature}`;
}

/** Проверяет сессию из cookie: подпись верна и срок не истёк. */
export async function verifySession(token, adminKey) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) {
    return false;
  }

  const expiresAt = Number(parts[0]);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
    return false;
  }

  const expected = await sign(`admin.${parts[0]}`, adminKey);
  return timingSafeEqual(parts[1], expected);
}

async function isAuthorized(request, env) {
  const adminKey = env.ADMIN_KEY?.trim();
  if (!adminKey) {
    return false;
  }

  const token = readCookie(request.headers.get("Cookie") || "", COOKIE_NAME);
  return verifySession(token, adminKey);
}

async function sign(message, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));

  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

// --- Мелочи -------------------------------------------------------------

/** Сравнение строк за постоянное время: не даёт угадывать пароль по таймингам. */
function timingSafeEqual(left, right) {
  const a = String(left);
  const b = String(right);
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;

  for (let index = 0; index < length; index += 1) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }

  return diff === 0;
}

function readCookie(header, name) {
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : "";
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Cache-Control": "no-store"
  };
}

function json(status, body, origin, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
      ...extraHeaders
    }
  });
}

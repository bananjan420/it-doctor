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

// Источники заявки. Совпадают с типом lead_source в базе.
export const SOURCES = ["website", "mini_app", "telegram_bot"];

// Поля, которые можно отдавать в браузер. Служебные (например updated_at) не нужны.
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

// Столбцы, по которым разрешено сортировать: имя параметра -> колонка в базе.
const SORTABLE_FIELDS = {
  date: "created_at",
  name: "name",
  phone: "phone",
  service: "service",
  source: "source",
  status: "status"
};

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

  // Список услуг для выпадающего фильтра — отдельный запрос, без заявок.
  if (url.searchParams.get("facets") === "1") {
    return await handleServices(env, origin);
  }

  const status = url.searchParams.get("status");
  const source = url.searchParams.get("source");
  const service = url.searchParams.get("service");
  const search = (url.searchParams.get("q") || "").trim();
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  // Сортировка по столбцу таблицы. Разрешены только известные поля:
  // произвольную строку в запрос к базе не пускаем.
  const sort = SORTABLE_FIELDS[url.searchParams.get("sort")] || null;
  const direction = url.searchParams.get("dir") === "asc" ? "asc" : "desc";

  const params = new URLSearchParams({
    select: LEAD_COLUMNS,
    // Без явной сортировки всегда показываем новые заявки сверху.
    // Вторичная сортировка по дате нужна, чтобы заявки с одинаковым значением
    // выбранного столбца не прыгали при обновлении страницы.
    order: !sort
      ? "created_at.desc"
      : sort === "created_at"
        ? `created_at.${direction}`
        : `${sort}.${direction},created_at.desc`,
    limit: "500"
  });

  if (status && STATUSES.includes(status)) {
    params.set("status", `eq.${status}`);
  }

  if (source && SOURCES.includes(source)) {
    params.set("source", `eq.${source}`);
  }

  // Услуга: отдельно обрабатываем «не выбрана» (в базе это пустое значение).
  if (service === "none") {
    params.set("service", "is.null");
  } else if (service) {
    params.set("service", `eq.${service}`);
  }

  // Поиск по имени и телефону: клиент мог набрать часть имени или цифры.
  if (search) {
    // Оставляем только буквы, цифры и символы телефона. Так посторонние знаки
    // не смогут изменить синтаксис фильтра PostgREST.
    const safe = search.replace(/[^\p{L}\p{N}\s+()-]/gu, " ").replace(/\s+/g, " ").trim();
    if (safe) {
      params.set("or", `(name.ilike.*${safe}*,phone.ilike.*${safe}*)`);
    }
  }

  // Произвольный период. Даты приходят как 2026-10-07, конец дня включаем целиком.
  const fromDate = parseDate(from);
  const toDate = parseDate(to);

  if (fromDate) {
    params.set("created_at", `gte.${fromDate}T00:00:00`);
  }

  if (toDate) {
    if (params.has("created_at")) {
      // Диапазон задаётся двумя параметрами: PostgREST это поддерживает.
      params.append("created_at", `lte.${toDate}T23:59:59.999`);
    } else {
      params.set("created_at", `lte.${toDate}T23:59:59.999`);
    }
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

// --- Справочник услуг для фильтра ---------------------------------------

/**
 * Отдаёт список услуг, которые реально встречаются в заявках.
 *
 * Берём из базы только колонку service, поэтому запрос лёгкий даже при
 * большом количестве заявок. Отдельно сообщаем, есть ли заявки без услуги.
 */
async function handleServices(env, origin) {
  const params = new URLSearchParams({
    select: "service",
    order: "service.asc",
    limit: "1000"
  });

  const response = await supabase(env, `/rest/v1/leads?${params.toString()}`, {
    method: "GET"
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("Supabase services failed", {
      status: response.status,
      detail: detail.slice(0, 200)
    });
    return json(502, { ok: false, error: "Не удалось получить список услуг" }, origin);
  }

  const rows = await response.json();
  const services = [];
  let hasEmpty = false;

  for (const row of rows) {
    const value = String(row.service ?? "").trim();

    if (!value) {
      hasEmpty = true;
      continue;
    }

    if (!services.includes(value)) {
      services.push(value);
    }
  }

  services.sort((a, b) => a.localeCompare(b, "ru"));

  return json(200, { ok: true, services, hasEmpty }, origin);
}

// --- Проверка параметров ------------------------------------------------

/** Принимает только существующую дату вида 2026-10-07, иначе возвращает null. */
function parseDate(value) {
  const text = String(value || "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null;
  }

  const date = new Date(`${text}T00:00:00Z`);

  // Отсекаем несуществующие даты вроде 2026-99-99 или 2026-02-31.
  if (Number.isNaN(date.getTime()) || !date.toISOString().startsWith(text)) {
    return null;
  }

  return text;
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

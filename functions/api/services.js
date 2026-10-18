// API админ-панели для услуг: список, создание, изменение, удаление.
//
// Браузер говорит только с этой функцией, а она ходит в базу секретным ключом
// из переменных окружения. Секретный ключ в клиент не попадает.
//
//   GET    /api/services       -> { ok, services }   (все, включая выключенные)
//   POST   /api/services       -> { ok, service }    (создать)
//   PATCH  /api/services       -> { ok, service }    (изменить по id)
//   DELETE /api/services?id=…  -> { ok }             (удалить)

import { json, supabaseAdmin } from "./_lib/auth.js";
import { isAuthorized } from "./_lib/session.js";

// Только эти поля можно менять: id и даты назначает база.
// Цена одна — числовая: из неё собирается и текст на сайте, и сумма платежа.
const EDITABLE_FIELDS = [
  "title",
  "description",
  "price_value",
  "icon",
  "image",
  "sort_order",
  "is_active"
];

const MAX_TITLE = 120;
const MAX_DESCRIPTION = 600;
const MAX_ICON = 80;
// Картинка хранится прямо в базе (data:image/...): ограничиваем размер,
// чтобы админка не могла залить что-то огромное.
const MAX_IMAGE = 700000;
// Адрес картинки на сайте тоже допустим — например, уже загруженный файл.
const MAX_IMAGE_URL = 500;

// Ключ версии списка услуг. Тот же ключ читает публичный API сайта:
// пока версия не изменилась, браузер берёт список из своей памяти.
const VERSION_KEY = "services_version";
const VERSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const origin = url.origin;

  try {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (!(await isAuthorized(request, env))) {
      return json(401, { ok: false, error: "Нужен вход в админку" }, origin);
    }

    if (request.method === "GET") {
      return await listServices(env, origin);
    }

    if (request.method === "POST") {
      return await createService(request, env, origin);
    }

    if (request.method === "PATCH") {
      return await updateService(request, env, origin);
    }

    if (request.method === "DELETE") {
      return await deleteService(url, env, origin);
    }

    return json(405, { ok: false, error: "Метод не поддерживается" }, origin);
  } catch (error) {
    console.error("Services API failed", { reason: error?.name || "unknown" });
    return json(500, { ok: false, error: "Внутренняя ошибка" }, origin);
  }
}

// --- Чтение ---------------------------------------------------------------

async function listServices(env, origin) {
  const response = await supabaseAdmin(env, "/rest/v1/services?select=*&order=sort_order.asc,created_at.asc", {
    method: "GET"
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("Supabase services list failed", {
      status: response.status,
      detail: detail.slice(0, 200)
    });
    return json(502, { ok: false, error: "Не удалось получить услуги" }, origin);
  }

  const rows = await response.json();
  return json(200, {
    ok: true,
    services: rows.map(publicService),
    version: await readVersion(env)
  }, origin);
}

// --- Изменение ------------------------------------------------------------

async function createService(request, env, origin) {
  const payload = await readJson(request);
  if (!payload) {
    return json(400, { ok: false, error: "Ожидается JSON" }, origin);
  }

  const row = {};
  const problem = applyFields(row, payload, { requireTitle: true });

  if (problem) {
    return json(400, { ok: false, error: problem }, origin);
  }

  // Новая услуга встаёт в конец списка, если порядок не задали вручную.
  if (row.sort_order === undefined) {
    row.sort_order = await nextSortOrder(env);
  }

  const response = await supabaseAdmin(env, "/rest/v1/services", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row)
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("Supabase service insert failed", {
      status: response.status,
      detail: detail.slice(0, 200)
    });
    return json(502, { ok: false, error: "Не удалось сохранить услугу" }, origin);
  }

  const created = await response.json();
  await bumpVersion(env);

  return json(200, { ok: true, service: publicService(Array.isArray(created) ? created[0] : created) }, origin);
}

async function updateService(request, env, origin) {
  const payload = await readJson(request);
  if (!payload) {
    return json(400, { ok: false, error: "Ожидается JSON" }, origin);
  }

  const id = String(payload.id || "").trim();
  if (!id) {
    return json(400, { ok: false, error: "Не указан id услуги" }, origin);
  }

  const row = {};
  const problem = applyFields(row, payload, { requireTitle: false });

  if (problem) {
    return json(400, { ok: false, error: problem }, origin);
  }

  if (Object.keys(row).length === 0) {
    return json(400, { ok: false, error: "Нечего менять" }, origin);
  }

  const response = await supabaseAdmin(env, `/rest/v1/services?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row)
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("Supabase service update failed", {
      status: response.status,
      detail: detail.slice(0, 200)
    });
    return json(502, { ok: false, error: "Не удалось сохранить услугу" }, origin);
  }

  const updated = await response.json();
  if (!Array.isArray(updated) || updated.length === 0) {
    return json(404, { ok: false, error: "Услуга не найдена" }, origin);
  }

  await bumpVersion(env);

  return json(200, { ok: true, service: publicService(updated[0]) }, origin);
}

async function deleteService(url, env, origin) {
  const id = String(url.searchParams.get("id") || "").trim();

  if (!id) {
    return json(400, { ok: false, error: "Не указан id услуги" }, origin);
  }

  const response = await supabaseAdmin(env, `/rest/v1/services?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Prefer: "return=representation" }
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("Supabase service delete failed", {
      status: response.status,
      detail: detail.slice(0, 200)
    });
    return json(502, { ok: false, error: "Не удалось удалить услугу" }, origin);
  }

  const removed = await response.json();
  if (!Array.isArray(removed) || removed.length === 0) {
    return json(404, { ok: false, error: "Услуга не найдена" }, origin);
  }

  await bumpVersion(env);

  return json(200, { ok: true }, origin);
}

// --- Вспомогательное ------------------------------------------------------

/**
 * Переносит присланные поля в строку для базы.
 *
 * Возвращает текст ошибки, если что-то заполнено неверно, иначе null.
 */
function applyFields(row, payload, { requireTitle }) {
  if (payload.title !== undefined) {
    const title = String(payload.title || "").trim();

    if (!title) {
      return "Название услуги не может быть пустым";
    }

    if (title.length > MAX_TITLE) {
      return `Название длиннее ${MAX_TITLE} символов`;
    }

    row.title = title;
  } else if (requireTitle) {
    return "Укажите название услуги";
  }

  if (payload.description !== undefined) {
    const description = String(payload.description || "").trim().slice(0, MAX_DESCRIPTION);
    row.description = description || null;
  }

  if (payload.price_value !== undefined) {
    // Цена задаётся только числом. Пустое значение — это ноль,
    // такой услугой заплатить нельзя.
    const digits = String(payload.price_value ?? "").replace(/[^\d]/g, "");
    const value = digits ? Number(digits) : 0;

    if (!Number.isFinite(value) || value < 0) {
      return "Цена должна быть числом";
    }

    row.price_value = value;
  }

  if (payload.icon !== undefined) {
    const icon = String(payload.icon || "").trim().slice(0, MAX_ICON);
    row.icon = icon || null;
  }

  if (payload.image !== undefined) {
    const image = String(payload.image || "").trim();

    if (image.length > MAX_IMAGE) {
      return "Картинка слишком большая — выберите файл поменьше";
    }

    if (image && !image.startsWith("data:image/") && image.length > MAX_IMAGE_URL) {
      return "Ссылка на картинку слишком длинная";
    }

    row.image = image || null;
  }

  if (payload.sort_order !== undefined) {
    const order = Number(String(payload.sort_order).replace(/[^\d-]/g, ""));
    row.sort_order = Number.isFinite(order) ? order : 0;
  }

  if (payload.is_active !== undefined) {
    row.is_active = Boolean(payload.is_active);
  }

  return null;
}

/**
 * Поднимает версию списка услуг: сайт по ней понимает, что данные устарели.
 *
 * Заодно стираем кэш публичного ответа, иначе Cloudflare отдал бы старый
 * список ещё минуту. Сбой хранилища не должен ломать сохранение услуги:
 * в худшем случае сайт обновится с небольшой задержкой.
 */
async function bumpVersion(env) {
  const store = env?.SERVICES_CACHE;

  if (!store?.get || !store?.put) {
    return;
  }

  try {
    const current = Number(await store.get(VERSION_KEY));
    const next = (Number.isFinite(current) ? current : 0) + 1;

    await store.put(VERSION_KEY, String(next), { expirationTtl: VERSION_TTL_SECONDS });
  } catch (error) {
    console.error("Services version bump failed", { reason: error?.name || "unknown" });
  }
}

/** Текущая версия списка услуг. */
async function readVersion(env) {
  const store = env?.SERVICES_CACHE;

  if (!store?.get) {
    return 0;
  }

  try {
    const value = Number(await store.get(VERSION_KEY));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/** Следующий порядковый номер: новая услуга встаёт в конец списка. */
async function nextSortOrder(env) {
  const response = await supabaseAdmin(env, "/rest/v1/services?select=sort_order&order=sort_order.desc&limit=1", {
    method: "GET"
  });

  if (!response.ok) {
    return 100;
  }

  const rows = await response.json();
  const last = Array.isArray(rows) && rows.length ? Number(rows[0].sort_order) : 0;

  return (Number.isFinite(last) ? last : 0) + 10;
}

/** Отдаём только то, что нужно админке. */
function publicService(row) {
  if (!row) return null;

  return {
    id: row.id,
    title: row.title,
    description: row.description || "",
    price_value: Number(row.price_value) || 0,
    icon: row.icon || "",
    image: row.image || "",
    sort_order: row.sort_order,
    is_active: row.is_active,
    updated_at: row.updated_at
  };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Credentials": "true"
  };
}

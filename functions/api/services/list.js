// Публичный список услуг для сайта и Mini App.
//
// Отдаёт только включённые услуги, в порядке, заданном в админке.
// Секретный ключ остаётся на сервере: браузер его не видит.
//
// Кэш устроен так, чтобы правки из админки появлялись сразу:
//   * номер версии растёт при каждом изменении услуг (его пишет админский API);
//   * страница запоминает список вместе с версией и при следующем открытии
//     сначала спрашивает версию — если она та же, список берётся из памяти.

import { json, supabaseAdmin } from "../_lib/auth.js";

// Кэш умышленно отключён: правка в админке должна быть видна на сайте сразу.
// Запрос лёгкий — несколько строк из таблицы услуг. Браузер дополнительно
// сверяет версию списка, поэтому лишней перерисовки не происходит.

// Ключ версии в хранилище Cloudflare: общий с админским API.
const VERSION_KEY = "services_version";

export async function onRequest({ request, env }) {
  const origin = new URL(request.url).origin;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors() });
  }

  if (request.method !== "GET") {
    return json(405, { ok: false, error: "Метод не поддерживается" }, origin, cors());
  }

  try {
    const response = await supabaseAdmin(
      env,
      "/rest/v1/services?select=id,title,description,price,price_value,icon,image,sort_order" +
        "&is_active=is.true&order=sort_order.asc,created_at.asc",
      { method: "GET" }
    );

    if (!response.ok) {
      const detail = await response.text();
      console.error("Public services failed", {
        status: response.status,
        detail: detail.slice(0, 200)
      });
      return json(502, { ok: false, error: "Не удалось получить услуги" }, origin, cors());
    }

    const rows = await response.json();
    const version = await readVersion(env);

    return json(200, {
      ok: true,
      version,
      services: rows.map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description || "",
        price: row.price || "",
        priceValue: row.price_value,
        icon: row.icon || "",
        image: row.image || "",
        sortOrder: row.sort_order
      }))
    }, origin, {
      ...cors(),
      // Ни браузер, ни промежуточный кэш не должны отдавать старый список.
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"
    });
  } catch (error) {
    console.error("Public services crashed", { reason: error?.name || "unknown" });
    return json(500, { ok: false, error: "Внутренняя ошибка" }, origin, cors());
  }
}

/**
 * Номер версии списка услуг.
 *
 * Храним в KV. Если хранилище недоступно или ключа нет, отдаём 0 —
 * страница в этом случае просто обновит список.
 */
async function readVersion(env) {
  const store = env?.SERVICES_CACHE;

  if (!store?.get) {
    return 0;
  }

  try {
    const stored = await store.get(VERSION_KEY);
    const value = Number(stored);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  };
}

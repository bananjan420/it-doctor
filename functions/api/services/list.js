// Публичный список услуг для сайта и Mini App.
//
// Отдаёт только включённые услуги, в порядке, заданном в админке.
// Секретный ключ остаётся на сервере: браузер его не видит.

import { json, supabaseAdmin } from "../_lib/auth.js";

// Небольшой кэш на стороне Cloudflare: список меняется редко, а страница
// запрашивает его при каждом открытии.
const CACHE_SECONDS = 60;

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

    return json(200, {
      ok: true,
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
      "Cache-Control": `public, max-age=${CACHE_SECONDS}, stale-while-revalidate=300`
    });
  } catch (error) {
    console.error("Public services crashed", { reason: error?.name || "unknown" });
    return json(500, { ok: false, error: "Внутренняя ошибка" }, origin, cors());
  }
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  };
}

// Заявки авторизованного клиента: создание и просмотр своих.
//
// Ключевое правило безопасности: клиент видит и создаёт заявки ТОЛЬКО под своим
// идентификатором. Он берётся не из запроса, а из проверенного токена Supabase,
// поэтому подделать его нельзя.
//
//   GET  /api/me/leads  -> свои заявки
//   POST /api/me/leads  -> новая заявка от имени клиента

import { getAuthUser, json, supabaseAdmin } from "../_lib/auth.js";

const SOURCE_ACCOUNT = "account";
const DEFAULT_STATUS = "new";

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
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors() });
  }

  // Проверяем токен у Supabase: без действующего токена дальше не пускаем.
  const user = await getAuthUser(request, env);

  if (!user) {
    return json(401, { ok: false, error: "Нужно войти в личный кабинет." });
  }

  try {
    if (request.method === "GET") {
      return await listLeads(user, env);
    }

    if (request.method === "POST") {
      return await createLead(request, user, env);
    }

    return json(405, { ok: false, error: "Метод не поддерживается" });
  } catch (error) {
    console.error("Account leads failed", { reason: error?.name || "unknown" });
    return json(502, { ok: false, error: "Не удалось обратиться к базе." });
  }
}

/** Отдаёт заявки только этого пользователя. */
async function listLeads(user, env) {
  const params = new URLSearchParams({
    select: LEAD_COLUMNS,
    // Фильтр по владельцу заявки задаём на сервере: клиент его не передаёт.
    user_id: `eq.${user.id}`,
    order: "created_at.desc",
    limit: "200"
  });

  const response = await supabaseAdmin(env, `/rest/v1/leads?${params.toString()}`, {
    method: "GET"
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("Supabase account leads failed", {
      status: response.status,
      detail: detail.slice(0, 200)
    });
    return json(502, { ok: false, error: "Не удалось получить заявки." });
  }

  const leads = await response.json();
  const name = (user.user_metadata || {}).name || "";

  return json(200, {
    ok: true,
    leads,
    user: { id: user.id, email: user.email, name }
  });
}

/** Создаёт заявку от имени клиента и привязывает её к аккаунту. */
async function createLead(request, user, env) {
  let payload;

  try {
    payload = await request.json();
  } catch {
    return json(400, { ok: false, error: "Ожидается JSON" });
  }

  const name = String(payload.name || "").trim().slice(0, 100);
  const phone = String(payload.phone || "").trim().slice(0, 50);
  const service = String(payload.service || "").trim().slice(0, 500);
  const message = String(payload.message || "").trim().slice(0, 5000);

  if (!name || !phone) {
    return json(422, { ok: false, error: "Имя и телефон обязательны." });
  }

  const row = {
    name,
    phone,
    service: service || null,
    message: message || null,
    source: SOURCE_ACCOUNT,
    status: DEFAULT_STATUS,
    // Владелец берётся из токена, а не из тела запроса.
    user_id: user.id
  };

  const response = await supabaseAdmin(env, "/rest/v1/leads", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row)
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("Supabase account lead insert failed", {
      status: response.status,
      detail: detail.slice(0, 200)
    });
    return json(502, { ok: false, error: "Не удалось сохранить заявку." });
  }

  const created = await response.json();

  return json(200, { ok: true, lead: Array.isArray(created) ? created[0] : created });
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  };
}

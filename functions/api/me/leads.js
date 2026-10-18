// Заявки авторизованного клиента: создание и просмотр своих.
//
// Ключевое правило безопасности: клиент видит и создаёт заявки ТОЛЬКО под своим
// идентификатором. Он берётся не из запроса, а из проверенного токена Supabase,
// поэтому подделать его нельзя.
//
//   GET  /api/me/leads  -> свои заявки
//   POST /api/me/leads  -> новая заявка от имени клиента

import { getAuthUser, json, profileFrom, supabaseAdmin } from "../_lib/auth.js";
import { payableAmount, paymentStatusLabel } from "../_lib/payments.js";
import { findServiceId } from "../_lib/serviceMatch.js";
import { paymentsConfigured } from "../_lib/yookassa.js";
import { notifyOwner } from "../_lib/telegram.js";

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
  "status",
  // Оплата: по этим полям кабинет решает, показывать ли кнопку «Оплатить».
  "service_id",
  "payment_status",
  "payment_amount",
  "paid_at"
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

  return json(200, {
    ok: true,
    // Кабинету нужно знать, настроен ли приём оплаты: если ключей нет,
    // кнопка «Оплатить» только запутает клиента.
    paymentsEnabled: paymentsConfigured(env),
    leads: await withPayableAmounts(env, leads),
    profile: profileFrom(user)
  });
}

/**
 * Добавляет к заявкам сумму к оплате и подпись статуса.
 *
 * Сумма считается по каталогу услуг на сервере: клиент её не передаёт и не
 * может изменить. Если оплатить нельзя, payable_amount = 0.
 */
async function withPayableAmounts(env, leads) {
  const ids = [...new Set(leads.map((lead) => lead.service_id).filter(Boolean))];
  const catalog = new Map();

  if (ids.length) {
    const params = new URLSearchParams({
      select: "id,price_value,is_active",
      id: `in.(${ids.join(",")})`,
      limit: "200"
    });

    const response = await supabaseAdmin(env, `/rest/v1/services?${params.toString()}`, { method: "GET" });

    if (response.ok) {
      const rows = await response.json();

      for (const row of rows) {
        catalog.set(row.id, row);
      }
    }
  }

  return leads.map((lead) => {
    const { payable, amount } = payableAmount(catalog.get(lead.service_id));

    return {
      ...lead,
      // Сколько нужно заплатить. 0 значит «оплата недоступна».
      payable_amount: payable ? amount : 0,
      payment_status_label: paymentStatusLabel(lead.payment_status)
    };
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

  const profile = profileFrom(user);
  const service = String(payload.service || "").trim().slice(0, 500);
  const message = String(payload.message || "").trim().slice(0, 5000);

  // Ссылку на услугу каталога определяет сервер: по ней потом считается
  // сумма оплаты. Клиент её не передаёт.
  const serviceId = await matchServiceId(env, service);

  // Имя и телефон в самой заявке не спрашиваем: они уже есть в профиле.
  // Если клиент их ещё не заполнил — просим сначала открыть личные данные.
  if (!profile.name || !profile.phone) {
    return json(409, {
      ok: false,
      error: "Заполните личные данные: имя и телефон.",
      needsProfile: true
    });
  }

  const row = {
    name: profile.name,
    phone: profile.phone,
    service: service || null,
    service_id: serviceId,
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
  const lead = Array.isArray(created) ? created[0] : created;

  // Заявку уже сохранили — теперь уведомляем владельца в Telegram.
  // Если уведомление не уйдёт, заявка всё равно останется в базе.
  await notifyOwner(env, {
    name: lead.name,
    phone: lead.phone,
    service: lead.service || "Не выбрана",
    message: lead.message || "Не указано",
    sourceLabel: "Личный кабинет",
    saved: true
  });

  return json(200, { ok: true, lead });
}

/**
 * Находит услугу каталога по названию из заявки.
 *
 * Сравнение мягкое: по словам, без знаков и регистра. Так услуга находится,
 * даже если владелец переименовал её после создания заявки.
 */
async function matchServiceId(env, serviceLabel) {
  const label = String(serviceLabel || "").trim();

  if (!label || label === "Не выбрана") {
    return null;
  }

  const params = new URLSearchParams({
    select: "id,title",
    order: "sort_order.asc",
    limit: "200"
  });

  const response = await supabaseAdmin(env, `/rest/v1/services?${params.toString()}`, { method: "GET" });

  if (!response.ok) {
    return null;
  }

  const rows = await response.json();
  return findServiceId(rows, label);
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  };
}

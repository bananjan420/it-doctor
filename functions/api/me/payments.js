// Проверка оплаты: переспрашивает статус у ЮKassa и обновляет заявку.
//
//   POST /api/me/payments   тело: { leadId }
//
// Кто может обратиться:
//   * клиент — по своей заявке (владелец берётся из проверенного токена);
//   * владелец сервиса из админки — по любой заявке.
//
// Зачем это нужно: вебхук может не дойти (обрыв связи, отключённый адрес).
// Тогда статус оплаты обновляется при возврате клиента в кабинет или по
// кнопке «Проверить оплату» в админке.

import { getAuthUser, json, supabaseAdmin } from "../_lib/auth.js";
import { paymentStatusLabel } from "../_lib/payments.js";
import { isAuthorized } from "../_lib/session.js";
import { fetchPayment, paymentsConfigured } from "../_lib/yookassa.js";

// Поля заявки, нужные для сверки оплаты.
const LEAD_COLUMNS = [
  "id",
  "user_id",
  "payment_id",
  "payment_status",
  "payment_amount",
  "paid_at"
].join(",");

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors() });
  }

  if (request.method !== "POST") {
    return json(405, { ok: false, error: "Метод не поддерживается" });
  }

  // Сначала пробуем клиента, затем владельца сервиса: так одна функция
  // обслуживает и кабинет, и админку.
  const user = await getAuthUser(request, env);
  const isOwner = user ? false : await isAuthorized(request, env);

  if (!user && !isOwner) {
    return json(401, { ok: false, error: "Нужно войти в личный кабинет." });
  }

  if (!paymentsConfigured(env)) {
    return json(503, { ok: false, error: "Оплата временно недоступна." });
  }

  let payload;

  try {
    payload = await request.json();
  } catch {
    return json(400, { ok: false, error: "Ожидается JSON" });
  }

  const leadId = String(payload.leadId || "").trim();

  if (!leadId) {
    return json(400, { ok: false, error: "Не указана заявка." });
  }

  try {
    const lead = await findLead(env, leadId, user ? user.id : "");

    if (!lead) {
      return json(404, { ok: false, error: "Заявка не найдена." });
    }

    if (!lead.payment_id) {
      // Оплату ещё не создавали: проверять нечего.
      return json(200, {
        ok: true,
        changed: false,
        paymentStatus: lead.payment_status || "",
        paymentStatusLabel: paymentStatusLabel(lead.payment_status),
        paymentAmount: lead.payment_amount
      });
    }

    const verified = await fetchPayment(env, lead.payment_id);

    if (!verified.ok) {
      return json(502, { ok: false, error: verified.error });
    }

    const changed = await syncPayment(env, lead, verified.payment);

    return json(200, {
      ok: true,
      changed,
      paymentStatus: verified.payment.status,
      paymentStatusLabel: paymentStatusLabel(verified.payment.status),
      paymentAmount: Math.round(Number(verified.payment.amount)),
      paidAt: verified.payment.status === "succeeded"
        ? (lead.paid_at || verified.payment.paidAt || null)
        : null
    });
  } catch (error) {
    console.error("Payment check failed", { reason: error?.name || "unknown" });
    return json(502, { ok: false, error: "Не удалось проверить оплату." });
  }
}

/**
 * Ищет заявку.
 *
 * Клиент ищет только среди своих: идентификатор владельца приходит из токена.
 * Владелец сервиса видит любую заявку.
 */
async function findLead(env, leadId, userId) {
  const params = new URLSearchParams({
    select: LEAD_COLUMNS,
    id: `eq.${leadId}`,
    limit: "1"
  });

  if (userId) {
    params.set("user_id", `eq.${userId}`);
  }

  const response = await supabaseAdmin(env, `/rest/v1/leads?${params.toString()}`, { method: "GET" });

  if (!response.ok) {
    const detail = await response.text();
    console.error("Payment check lookup failed", {
      status: response.status,
      detail: detail.slice(0, 200)
    });
    throw new Error("lookup_failed");
  }

  const rows = await response.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/**
 * Записывает проверенный статус платежа в заявку.
 *
 * Сумма берётся из ответа ЮKassa, а не из запроса. Статус ремонта не трогаем.
 */
async function syncPayment(env, lead, payment) {
  const status = String(payment.status || "");
  const amount = Math.round(Number(payment.amount));

  if (lead.payment_status === status && Number(lead.payment_amount) === amount) {
    return false;
  }

  const fields = {
    payment_status: status,
    payment_amount: Number.isFinite(amount) ? amount : null
  };

  // Дату оплаты ставим при первом успешном подтверждении.
  if (status === "succeeded" && !lead.paid_at) {
    fields.paid_at = payment.paidAt || new Date().toISOString();
    fields.payment_confirmed_at = new Date().toISOString();
  }

  const response = await supabaseAdmin(env, `/rest/v1/leads?id=eq.${encodeURIComponent(lead.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(fields)
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("Payment check save failed", {
      status: response.status,
      detail: detail.slice(0, 200)
    });
    throw new Error("save_failed");
  }

  return true;
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}

// Входящее уведомление от ЮKassa об изменении платежа.
//
//   POST /api/payments/yookassa
//
// Здесь нельзя верить телу запроса: адрес вебхука публичный, и подделать
// уведомление может кто угодно. Поэтому из уведомления берётся только
// идентификатор платежа, а статус и сумму мы спрашиваем у самой ЮKassa
// отдельным запросом с секретным ключом.
//
// Записываем в заявку только проверенные данные. Статус ремонта (status)
// не трогаем: оплата и ремонт независимы.

import { json, supabaseAdmin } from "../_lib/auth.js";
import { isPaid } from "../_lib/payments.js";
import { fetchPayment, paymentsConfigured } from "../_lib/yookassa.js";

// Поля заявки, которые нужно сверить.
const LEAD_COLUMNS = ["id", "payment_id", "payment_status", "payment_amount", "paid_at"].join(",");

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") {
    // Заголовки нужны только для отладки из браузера: доступа к данным не дают.
    return new Response(null, { status: 204 });
  }

  if (request.method !== "POST") {
    return json(405, { ok: false, error: "Метод не поддерживается" });
  }

  if (!paymentsConfigured(env)) {
    // ЮKassa будет повторять уведомление: это нормально, пока ключи не заданы.
    console.error("YooKassa webhook received, but payments are not configured");
    return json(503, { ok: false, error: "Оплата не настроена" });
  }

  let payload;

  try {
    payload = await request.json();
  } catch {
    return json(400, { ok: false, error: "Ожидается JSON" });
  }

  const event = String(payload?.event || "");
  const notifiedId = String(payload?.object?.id || "").trim();

  if (!notifiedId) {
    return json(400, { ok: false, error: "В уведомлении нет идентификатора платежа" });
  }

  // Главный шаг: спрашиваем настоящий статус у ЮKassa.
  const verified = await fetchPayment(env, notifiedId);

  if (!verified.ok) {
    // Просим ЮKassa повторить уведомление позже.
    return json(502, { ok: false, error: "Не удалось проверить платёж в ЮKassa" });
  }

  const payment = verified.payment;

  // Событие из уведомления и статус из ответа ЮKassa должны совпадать.
  if (event && !matchesEvent(event, payment)) {
    console.error("YooKassa webhook event mismatch", { event, status: payment.status });
    return json(409, { ok: false, error: "Событие не совпадает со статусом платежа" });
  }

  try {
    const applied = await applyPayment(env, payment, notifiedId);

    // Отвечаем 200 в любом случае, когда платёж нам не принадлежит: иначе
    // ЮKassa будет повторять уведомление бесконечно.
    return json(200, { ok: true, applied, status: payment.status });
  } catch (error) {
    console.error("YooKassa webhook failed", { reason: error?.name || "unknown" });
    return json(502, { ok: false, error: "Не удалось сохранить оплату" });
  }
}

/** Совпадает ли событие уведомления со статусом платежа. */
function matchesEvent(event, payment) {
  if (event === "payment.succeeded") {
    return payment.status === "succeeded";
  }

  if (event === "payment.canceled") {
    return payment.status === "canceled";
  }

  if (event === "payment.waiting_for_capture") {
    return payment.status === "waiting_for_capture";
  }

  // Неизвестное событие не считаем ошибкой: статус из ответа ЮKassa всё равно
  // записан верно.
  return true;
}

/**
 * Записывает проверенный платёж в заявку.
 *
 * Возвращает описание того, что произошло: это видно в логах Cloudflare.
 */
async function applyPayment(env, payment, notifiedId) {
  const lead = await findLeadByPayment(env, notifiedId);

  if (!lead) {
    // Платёж не наш: например, создан в этом же магазине другой системой.
    console.error("YooKassa webhook: lead not found for payment", { paymentId: notifiedId });
    return "lead_not_found";
  }

  // Сумма из ответа ЮKassa должна совпадать с суммой, которую мы записали при
  // создании платежа. Если нет — значит платёж не про эту заявку.
  if (lead.payment_amount !== null && Number(payment.amount) !== Number(lead.payment_amount)) {
    console.error("YooKassa webhook: amount mismatch", {
      paymentId: notifiedId,
      expected: lead.payment_amount,
      received: payment.amount
    });
    return "amount_mismatch";
  }

  const fields = {
    payment_status: payment.status,
    payment_amount: Math.round(Number(payment.amount))
  };

  // Дату оплаты ставим только при успехе и только один раз.
  if (payment.status === "succeeded" && !isPaid(lead.payment_status)) {
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
    console.error("YooKassa webhook: save failed", {
      status: response.status,
      detail: detail.slice(0, 200)
    });
    throw new Error("save_failed");
  }

  return isPaid(lead.payment_status) && payment.status === "succeeded" ? "already_paid" : "updated";
}

/** Ищет заявку по идентификатору платежа. */
async function findLeadByPayment(env, paymentId) {
  const params = new URLSearchParams({
    select: LEAD_COLUMNS,
    payment_id: `eq.${paymentId}`,
    limit: "1"
  });

  const response = await supabaseAdmin(env, `/rest/v1/leads?${params.toString()}`, { method: "GET" });

  if (!response.ok) {
    const detail = await response.text();
    console.error("YooKassa webhook: lead lookup failed", {
      status: response.status,
      detail: detail.slice(0, 200)
    });
    throw new Error("lookup_failed");
  }

  const rows = await response.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}


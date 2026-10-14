// Создание оплаты услуги из личного кабинета.
//
//   POST /api/me/pay   тело: { leadId }
//
// Главное правило: клиент присылает только идентификатор своей заявки.
// Сумму, услугу и возможность оплаты определяет сервер по каталогу услуг —
// подсунуть свою цену или чужую заявку нельзя.
//
// Заявка должна принадлежать этому клиенту: владелец берётся из проверенного
// токена Supabase, а не из запроса.

import { getAuthUser, json, supabaseAdmin } from "../_lib/auth.js";
import { isPaid, isPending, payableAmount } from "../_lib/payments.js";
import { createPayment, fetchPayment, paymentsConfigured } from "../_lib/yookassa.js";

// Поля заявки, нужные для оплаты.
const LEAD_COLUMNS = [
  "id",
  "service_id",
  "payment_id",
  "payment_status",
  "payment_amount",
  "payment_url"
].join(",");

// Поля услуги, по которым считается сумма.
const SERVICE_COLUMNS = ["id", "title", "price", "price_value", "price_is_from", "is_active"].join(",");

// Сколько живёт ключ идемпотентности. Внутри этого окна повторное нажатие
// кнопки не создаёт второй платёж, а после — создаёт новый: так устаревшая
// ссылка на оплату не блокирует клиента навсегда.
const IDEMPOTENCE_WINDOW_MS = 15 * 60 * 1000;

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors() });
  }

  if (request.method !== "POST") {
    return json(405, { ok: false, error: "Метод не поддерживается" });
  }

  // Без действующего токена оплату создать нельзя.
  const user = await getAuthUser(request, env);

  if (!user) {
    return json(401, { ok: false, error: "Нужно войти в личный кабинет." });
  }

  if (!paymentsConfigured(env)) {
    return json(503, {
      ok: false,
      error: "Оплата временно недоступна: приём платежей ещё не настроен."
    });
  }

  try {
    return await startPayment(request, user, env);
  } catch (error) {
    console.error("Account payment failed", { reason: error?.name || "unknown" });
    return json(502, { ok: false, error: "Не удалось обратиться к базе." });
  }
}

async function startPayment(request, user, env) {
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

  // Заявку ищем вместе с владельцем: чужую оплатить нельзя.
  const lead = await findOwnLead(env, leadId, user.id);

  if (!lead) {
    return json(404, { ok: false, error: "Заявка не найдена." });
  }

  // Повторная оплата запрещена.
  if (isPaid(lead.payment_status)) {
    return json(409, {
      ok: false,
      error: "Эта заявка уже оплачена.",
      alreadyPaid: true,
      paymentStatus: lead.payment_status,
      paymentAmount: lead.payment_amount
    });
  }

  const service = await findService(env, lead.service_id);

  // Сумму и возможность оплаты определяет сервер по каталогу услуг.
  const { payable, amount, reason } = payableAmount(service);

  if (!payable) {
    return json(409, { ok: false, error: reason, notPayable: true });
  }

  // Если платёж уже создан, ждёт оплаты и сумма совпадает — отдаём прежнюю
  // ссылку: второй платёж не нужен.
  if (isPending(lead.payment_status) && lead.payment_id && lead.payment_url) {
    const stillValid = await isStillPayable(env, lead.payment_id, amount);

    if (stillValid) {
      return json(200, {
        ok: true,
        reused: true,
        paymentUrl: lead.payment_url,
        paymentId: lead.payment_id,
        paymentStatus: lead.payment_status,
        amount
      });
    }
  }

  // Ключ идемпотентности: одинаковый внутри окна, поэтому случайное двойное
  // нажатие не создаёт второй платёж.
  const bucket = Math.floor(Date.now() / IDEMPOTENCE_WINDOW_MS);
  const idempotenceKey = `lead-${lead.id}-${amount}-${bucket}`;

  const created = await createPayment(env, {
    amount,
    description: descriptionFor(service),
    returnUrl: returnUrlFor(request, env),
    idempotenceKey,
    metadata: { leadId: lead.id, userId: user.id }
  });

  if (!created.ok) {
    return json(502, { ok: false, error: created.error });
  }

  // Сохраняем платёж в заявке: статус приходит от ЮKassa.
  await savePayment(env, lead.id, {
    payment_id: created.payment.id,
    payment_status: created.payment.status,
    payment_amount: amount,
    // Ссылку на оплату ЮKassa отдаёт только при создании платежа, поэтому
    // сохраняем её: понадобится, если клиент вернётся к оплате позже.
    payment_url: created.payment.confirmationUrl || null
  });

  return json(200, {
    ok: true,
    paymentUrl: created.payment.confirmationUrl,
    paymentId: created.payment.id,
    paymentStatus: created.payment.status,
    amount
  });
}

/** Ищет заявку этого клиента вместе с полями оплаты. */
async function findOwnLead(env, leadId, userId) {
  const params = new URLSearchParams({
    select: LEAD_COLUMNS,
    id: `eq.${leadId}`,
    // Владельца задаём на сервере: клиент его не передаёт.
    user_id: `eq.${userId}`,
    limit: "1"
  });

  const response = await supabaseAdmin(env, `/rest/v1/leads?${params.toString()}`, { method: "GET" });

  if (!response.ok) {
    const detail = await response.text();
    console.error("Payment lead lookup failed", {
      status: response.status,
      detail: detail.slice(0, 200)
    });
    return null;
  }

  const rows = await response.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/** Читает услугу каталога: из неё берётся сумма. */
async function findService(env, serviceId) {
  if (!serviceId) {
    return null;
  }

  const params = new URLSearchParams({
    select: SERVICE_COLUMNS,
    id: `eq.${serviceId}`,
    limit: "1"
  });

  const response = await supabaseAdmin(env, `/rest/v1/services?${params.toString()}`, { method: "GET" });

  if (!response.ok) {
    return null;
  }

  const rows = await response.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/** Проверяет у ЮKassa, что платёж ещё ждёт оплаты и сумма не изменилась. */
async function isStillPayable(env, paymentId, amount) {
  const result = await fetchPayment(env, paymentId);

  if (!result.ok) {
    return false;
  }

  return result.payment.status === "pending" && Number(result.payment.amount) === Number(amount);
}

/** Записывает данные платежа в заявку. */
async function savePayment(env, leadId, fields) {
  const response = await supabaseAdmin(env, `/rest/v1/leads?id=eq.${encodeURIComponent(leadId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(fields)
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("Payment save failed", {
      status: response.status,
      detail: detail.slice(0, 200)
    });
  }
}

/** Куда вернуть клиента после оплаты. */
function returnUrlFor(request, env) {
  // Основной адрес сайта задаётся переменной окружения.
  const configured = env.SITE_URL?.trim().replace(/\/+$/, "");
  const origin = configured || new URL(request.url).origin;

  return `${origin}/account/?paid=1`;
}

/** Описание платежа: клиент увидит его в истории платежей. */
function descriptionFor(service) {
  const title = String(service?.title || "услуга").trim();
  return `Оплата услуги: ${title}`;
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}

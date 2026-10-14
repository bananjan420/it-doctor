// Работа с API ЮKassa.
//
// Ключи магазина живут только в переменных окружения Cloudflare и в браузер
// не попадают. Здесь два действия, которых достаточно для приёма оплаты:
//
//   createPayment — создать платёж и получить ссылку на оплату;
//   fetchPayment  — прочитать платёж: так подтверждается статус.
//
// Сумма всегда приходит сюда уже посчитанной на сервере: этот модуль ничего
// не берёт из запроса клиента.
//
// Пока ключей нет, функции возвращают понятную ошибку настройки, а не падают.

const DEFAULT_API_URL = "https://api.yookassa.ru/v3";
const REQUEST_TIMEOUT_MS = 15000;

/** Настроен ли приём оплаты: есть ли ключи магазина. */
export function paymentsConfigured(env) {
  return Boolean(shopId(env) && secretKey(env));
}

/** Есть ли ключи и адрес API — то, без чего нельзя обратиться к ЮKassa. */
function apiBase(env) {
  // Адрес можно переопределить: так тесты подменяют ЮKassa своей заглушкой.
  return (env.YOOKASSA_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
}

function shopId(env) {
  return env.YOOKASSA_SHOP_ID?.trim() || "";
}

function secretKey(env) {
  return env.YOOKASSA_SECRET_KEY?.trim() || "";
}

/** Заголовок авторизации: ЮKassa использует Basic с парой shopId:ключ. */
function authHeader(env) {
  return `Basic ${btoa(`${shopId(env)}:${secretKey(env)}`)}`;
}

/**
 * Создаёт платёж в ЮKassa.
 *
 * amount — сумма в рублях (например 500 или 500.5). Переводим её в строку
 * с двумя знаками: этого требует API.
 * idempotenceKey — ключ идемпотентности: при повторе запроса с тем же ключом
 * ЮKassa вернёт тот же платёж, а не создаст второй.
 */
export async function createPayment(env, { amount, description, returnUrl, idempotenceKey, metadata }) {
  if (!paymentsConfigured(env)) {
    return { ok: false, error: "Оплата не настроена: нет ключей ЮKassa." };
  }

  const body = {
    amount: { value: formatAmount(amount), currency: "RUB" },
    capture: true,
    description: String(description || "Оплата услуги").slice(0, 128),
    confirmation: { type: "redirect", return_url: returnUrl },
    metadata: metadata || {}
  };

  try {
    const response = await fetch(`${apiBase(env)}/payments`, {
      method: "POST",
      headers: {
        Authorization: authHeader(env),
        "Idempotence-Key": idempotenceKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("YooKassa payment failed", {
        status: response.status,
        code: payload?.code || "",
        description: payload?.description || ""
      });

      return { ok: false, error: describeError(payload, response.status) };
    }

    return {
      ok: true,
      payment: {
        id: String(payload.id || ""),
        status: String(payload.status || ""),
        paid: Boolean(payload.paid),
        amount: Number(payload?.amount?.value || 0),
        confirmationUrl: String(payload?.confirmation?.confirmation_url || ""),
        createdAt: payload.created_at || null
      }
    };
  } catch (error) {
    console.error("YooKassa request crashed", { reason: error?.name || "unknown" });
    return { ok: false, error: "Не удалось связаться с ЮKassa. Попробуйте позже." };
  }
}

/**
 * Читает платёж из ЮKassa.
 *
 * Именно этот вызов подтверждает оплату: и вебхук, и возврат клиента в
 * кабинет доверяют только ответу ЮKassa, а не данным из запроса.
 */
export async function fetchPayment(env, paymentId) {
  if (!paymentsConfigured(env)) {
    return { ok: false, error: "Оплата не настроена: нет ключей ЮKassa." };
  }

  const id = String(paymentId || "").trim();

  if (!id) {
    return { ok: false, error: "Не указан идентификатор платежа." };
  }

  try {
    const response = await fetch(`${apiBase(env)}/payments/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: { Authorization: authHeader(env) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("YooKassa payment read failed", {
        status: response.status,
        code: payload?.code || ""
      });

      return { ok: false, error: describeError(payload, response.status) };
    }

    return {
      ok: true,
      payment: {
        id: String(payload.id || ""),
        status: String(payload.status || ""),
        paid: Boolean(payload.paid),
        amount: Number(payload?.amount?.value || 0),
        paidAt: payload.captured_at || payload.created_at || null,
        metadata: payload.metadata || {}
      }
    };
  } catch (error) {
    console.error("YooKassa read crashed", { reason: error?.name || "unknown" });
    return { ok: false, error: "Не удалось связаться с ЮKassa. Попробуйте позже." };
  }
}

/** Сумма в виде строки с двумя знаками: «500.00». */
export function formatAmount(amount) {
  const value = Number(amount);

  if (!Number.isFinite(value) || value <= 0) {
    return "0.00";
  }

  return value.toFixed(2);
}

/** Понятная причина отказа: код ЮKassa переводим в человеческий текст. */
function describeError(payload, status) {
  const code = String(payload?.code || "");

  if (code === "invalid_credentials" || status === 401) {
    return "ЮKassa отклонила ключи магазина. Проверьте настройки оплаты.";
  }

  if (code === "invalid_request") {
    return "ЮKassa отклонила запрос на оплату.";
  }

  if (status === 429) {
    return "Слишком много запросов к ЮKassa. Попробуйте через минуту.";
  }

  if (status >= 500) {
    return "ЮKassa временно недоступна. Попробуйте позже.";
  }

  return "Не удалось создать оплату. Попробуйте позже.";
}

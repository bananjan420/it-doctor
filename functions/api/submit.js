const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_TIMEOUT_MS = 10000;

// Единая база заявок. Адрес и ключ читаются только из переменных окружения
// Cloudflare Pages и никогда не попадают в клиентский код.
const SUPABASE_TIMEOUT_MS = 8000;

// Источники заявок. Значения совпадают с типом lead_source в базе.
const SOURCE_WEBSITE = "website";
const SOURCE_MINI_APP = "mini_app";

export async function onRequest({ request, env }) {
  if (request.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  const botToken = env.BOT_TOKEN?.trim();
  const chatId = env.CHAT_ID?.trim();

  if (!botToken || !chatId) {
    console.error("BOT_TOKEN or CHAT_ID is not configured");
    return jsonResponse(500, {
      ok: false,
      error: "Server is not configured"
    });
  }

  let payload;

  try {
    payload = await request.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON" });
  }

  const name = String(payload.name || "").trim();
  const phone = String(payload.phone || "").trim();
  const message = String(payload.message || "").trim() || "Не указано";
  const service = String(payload.service || "").trim() || "Не выбрана";
  // Источник определяем по коду от страницы. Всё неизвестное считается сайтом,
  // поэтому подделать источник произвольной строкой не получится. Русские
  // названия оставлены для совместимости со старыми версиями страниц.
  const source =
    payload.source === SOURCE_MINI_APP || payload.source === "Telegram Mini App"
      ? SOURCE_MINI_APP
      : SOURCE_WEBSITE;
  const sourceLabel = source === SOURCE_MINI_APP ? "Telegram Mini App" : "Сайт";
  const telegramUser =
    payload.telegramUser && typeof payload.telegramUser === "object"
      ? payload.telegramUser
      : null;

  if (!name || !phone) {
    return jsonResponse(422, {
      ok: false,
      error: "Имя и телефон обязательны"
    });
  }

  const dateTime = new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Moscow"
  }).format(new Date());

  // Сначала сохраняем заявку в базу, затем уведомляем владельца: если Telegram
  // недоступен, заявка уже не потеряется.
  const saved = await saveLead({ env, name, phone, service, message, source, telegramUser });

  const telegramMessage = [
    "<b>📩 НОВАЯ ЗАЯВКА</b>",
    "",
    `🕐 ${escapeHtml(dateTime)}`,
    `📍 <b>Источник:</b> ${escapeHtml(sourceLabel)}`,
    `👤 <b>Имя:</b> ${escapeHtml(name)}`,
    `📞 <b>Телефон:</b> ${escapeHtml(phone)}`,
    `🛠 <b>Услуга:</b> ${escapeHtml(service)}`,
    `📝 <b>Сообщение:</b> ${escapeHtml(message)}`,
    ...(telegramUser
      ? [
          `💬 <b>Telegram:</b> ${
            telegramUser.username
              ? `@${escapeHtml(String(telegramUser.username))}`
              : "username не указан"
          }`,
          `🆔 <b>User ID:</b> <code>${escapeHtml(
            String(telegramUser.id || "не указан")
          )}</code>`
        ]
      : []),
    ...(saved
      ? []
      : [
          "",
          "⚠️ <i>В базу заявка не сохранилась — проверьте настройки Supabase.</i>"
        ])
  ].join("\n");

  try {
    const response = await fetch(
      `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
        body: JSON.stringify({
          chat_id: chatId,
          text: telegramMessage,
          parse_mode: "HTML"
        })
      }
    );

    const result = await response.json();

    if (!response.ok || !result.ok) {
      console.error("Telegram API rejected request", {
        status: response.status,
        errorCode: result.error_code
      });
      return jsonResponse(502, {
        ok: false,
        error: result.description || "Не удалось отправить заявку"
      });
    }

    return jsonResponse(200, { ok: true });
  } catch (error) {
    console.error("Telegram request failed", error);
    return jsonResponse(502, {
      ok: false,
      error: "Не удалось связаться с Telegram"
    });
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

/**
 * Сохраняет заявку в единую базу Supabase.
 *
 * Возвращает true, если строка записана. Настройки берутся только из
 * переменных окружения; при их отсутствии запись пропускается.
 */
async function saveLead({ env, name, phone, service, message, source, telegramUser }) {
  const url = env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const key =
    env.SUPABASE_SECRET_KEY?.trim() || env.SUPABASE_SERVICE_KEY?.trim();

  if (!url || !key) {
    console.error(
      "SUPABASE_URL or SUPABASE_SECRET_KEY is not configured: lead not saved"
    );
    return false;
  }

  const row = {
    name: name.slice(0, 100),
    phone: phone.slice(0, 50),
    service: service.slice(0, 500) || null,
    message: message.slice(0, 5000) || null,
    source,
    status: "new"
  };

  const telegramUserId = Number(telegramUser?.id);
  if (Number.isFinite(telegramUserId)) {
    row.telegram_user_id = telegramUserId;
  }

  try {
    const response = await fetch(`${url}/rest/v1/leads`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        // Ответ с телом не нужен: достаточно кода состояния.
        Prefer: "return=minimal"
      },
      signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
      body: JSON.stringify(row)
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("Supabase rejected lead", {
        status: response.status,
        source,
        detail: detail.slice(0, 300)
      });
      return false;
    }

    return true;
  } catch (error) {
    console.error("Supabase request failed", {
      source,
      reason: error?.name || "unknown"
    });
    return false;
  }
}

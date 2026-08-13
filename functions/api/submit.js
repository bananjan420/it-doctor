const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_TIMEOUT_MS = 10000;

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
  const source =
    payload.source === "Telegram Mini App"
      ? "Telegram Mini App"
      : "Сайт";
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

  const telegramMessage = [
    "<b>📩 НОВАЯ ЗАЯВКА</b>",
    "",
    `🕐 ${escapeHtml(dateTime)}`,
    `📍 <b>Источник:</b> ${escapeHtml(source)}`,
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
      : [])
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

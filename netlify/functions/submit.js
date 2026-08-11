const dns = require("node:dns");

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_TIMEOUT_MS = 10000;

// Telegram IPv6 может быть недоступен из части serverless-регионов.
dns.setDefaultResultOrder("ipv4first");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  const botToken = process.env.BOT_TOKEN;
  const chatId = process.env.CHAT_ID;

  if (!botToken || !chatId) {
    console.error("BOT_TOKEN or CHAT_ID is not configured");
    return jsonResponse(500, { ok: false, error: "Server is not configured" });
  }

  let payload;

  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON" });
  }

  const name = String(payload.name || "").trim();
  const phone = String(payload.phone || "").trim();
  const message = String(payload.message || "").trim() || "Не указано";

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
    "<b>📩 НОВАЯ ЗАЯВКА С САЙТА</b>",
    "",
    `🕐 ${escapeHtml(dateTime)}`,
    `👤 <b>Имя:</b> ${escapeHtml(name)}`,
    `📞 <b>Телефон:</b> ${escapeHtml(phone)}`,
    `📝 <b>Сообщение:</b> ${escapeHtml(message)}`
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
      console.error("Telegram API error", {
        status: response.status,
        description: result.description
      });
      return jsonResponse(502, {
        ok: false,
        error: "Не удалось отправить заявку"
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
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(body)
  };
}

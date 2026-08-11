const https = require("node:https");

const TELEGRAM_HOST = "api.telegram.org";
const TELEGRAM_TIMEOUT_MS = 10000;

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
    const { statusCode, result } = await sendTelegramMessage(botToken, {
      chat_id: chatId,
      text: telegramMessage,
      parse_mode: "HTML"
    });

    if (statusCode < 200 || statusCode >= 300 || !result.ok) {
      console.error("Telegram API error", {
        status: statusCode,
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

function sendTelegramMessage(botToken, payload) {
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: TELEGRAM_HOST,
        path: `/bot${botToken}/sendMessage`,
        method: "POST",
        family: 4,
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (response) => {
        let responseBody = "";

        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          try {
            resolve({
              statusCode: response.statusCode || 500,
              result: JSON.parse(responseBody)
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.on("error", reject);
    request.end(body);
  });
}

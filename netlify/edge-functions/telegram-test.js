const TELEGRAM_TIMEOUT_MS = 8000;

export default async () => {
  const botToken = Netlify.env.get("BOT_TOKEN");
  const chatId = Netlify.env.get("CHAT_ID");

  if (!botToken || !chatId) {
    return jsonResponse(500, {
      ok: false,
      stage: "config",
      error: "Server is not configured"
    });
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken.trim()}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
        body: JSON.stringify({
          chat_id: chatId.trim(),
          text: "Техническая проверка Netlify Edge"
        })
      }
    );

    const result = await response.json();

    if (!response.ok || !result.ok) {
      return jsonResponse(502, {
        ok: false,
        stage: "telegram",
        errorCode: result.error_code || response.status,
        error: result.description || "Telegram rejected the request"
      });
    }

    return jsonResponse(200, { ok: true, stage: "complete" });
  } catch (error) {
    return jsonResponse(502, {
      ok: false,
      stage: "network",
      error: error?.name || "Network error"
    });
  }
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

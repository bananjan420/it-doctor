const REQUEST_TIMEOUT_MS = 6000;

export default async (request) => {
  const botToken = Netlify.env.get("BOT_TOKEN");
  const mode = new URL(request.url).searchParams.get("mode");

  if (!botToken) {
    return jsonResponse(500, {
      ok: false,
      stage: "config",
      error: "Server is not configured"
    });
  }

  const targets = {
    control: "https://example.com/",
    telegramRoot: "https://api.telegram.org/",
    telegramBot: `https://api.telegram.org/bot${botToken.trim()}/getMe`
  };
  const target = targets[mode];

  if (!target) {
    return jsonResponse(400, {
      ok: false,
      stage: "input",
      error: "Unknown diagnostic mode"
    });
  }

  try {
    const response = await fetch(target, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    return jsonResponse(200, {
      ok: true,
      stage: "complete",
      mode,
      upstreamStatus: response.status
    });
  } catch (error) {
    return jsonResponse(502, {
      ok: false,
      stage: "network",
      mode,
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

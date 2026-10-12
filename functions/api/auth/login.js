// Вход клиента по почте и паролю.
//
// Логику паролей целиком выполняет Supabase Auth, наш сервер только передаёт
// данные и возвращает клиенту токен для личного кабинета.

import { authErrorMessage, isValidEmail, json, normalizeEmail, supabaseAuth } from "../_lib/auth.js";

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors() });
  }

  // Выход: сообщаем Supabase отозвать сессию по токену.
  if (request.method === "DELETE") {
    return await logout(request, env);
  }

  if (request.method !== "POST") {
    return json(405, { ok: false, error: "Метод не поддерживается" });
  }

  let payload;

  try {
    payload = await request.json();
  } catch {
    return json(400, { ok: false, error: "Ожидается JSON" });
  }

  const email = normalizeEmail(payload.email);
  const password = String(payload.password || "");

  if (!isValidEmail(email) || !password) {
    return json(400, { ok: false, error: "Укажите почту и пароль." });
  }

  try {
    const response = await supabaseAuth(env, "/token?grant_type=password", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("Supabase login failed", { status: response.status });
      // 400 и 401 от Supabase — это неверные данные, а не сбой сервиса.
      const status = response.status === 400 ? 401 : response.status;
      return json(status, {
        ok: false,
        error: authErrorMessage(response.status, result)
      });
    }

    const user = result.user || {};

    return json(200, {
      ok: true,
      token: result.access_token,
      expiresIn: result.expires_in || null,
      user: {
        id: user.id,
        email: user.email,
        name: (user.user_metadata || {}).name || ""
      }
    });
  } catch (error) {
    console.error("Login request failed", { reason: error?.name || "unknown" });
    return json(502, { ok: false, error: "Сервис входа недоступен." });
  }
}

/** Отзывает сессию: после этого старый токен больше не действует. */
async function logout(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return json(200, { ok: true });
  }

  try {
    await supabaseAuth(env, "/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (error) {
    // Даже если Supabase недоступен, клиент должен суметь выйти локально.
    console.error("Logout request failed", { reason: error?.name || "unknown" });
  }

  return json(200, { ok: true });
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS"
  };
}

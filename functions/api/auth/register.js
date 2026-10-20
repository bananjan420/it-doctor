// Регистрация клиента по почте и паролю.
//
// Пароль уходит в Supabase Auth и там же хранится в зашифрованном виде:
// мы его не сохраняем и не логируем. В ответ клиент получает токен, с которым
// дальше открывает личный кабинет.

import { authErrorMessage, isValidEmail, json, normalizeEmail, normalizePhone, supabaseAuth } from "../_lib/auth.js";

const MIN_PASSWORD_LENGTH = 6;

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors() });
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

  if (!isValidEmail(email)) {
    return json(400, { ok: false, error: "Укажите корректный адрес почты." });
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return json(400, {
      ok: false,
      error: `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов.`
    });
  }

  if (password.length > 72) {
    // Ограничение самого Supabase: длинные пароли он не принимает.
    return json(400, { ok: false, error: "Пароль слишком длинный." });
  }

  // Имя и телефон спрашиваем при регистрации и сразу сохраняем в профиле:
  // тогда в кабинете не придётся заполнять их повторно.
  const name = String(payload.name || "").trim().slice(0, 100);
  const phone = normalizePhone(payload.phone);

  if (name.length < 2) {
    return json(400, { ok: false, error: "Укажите имя — как к вам обращаться." });
  }

  if (!phone) {
    return json(400, { ok: false, error: "Укажите корректный номер телефона." });
  }

  try {
    const response = await supabaseAuth(env, "/signup", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        // Телефон храним в том же виде, что и в профиле кабинета.
        data: { name, phone }
      })
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("Supabase signup failed", { status: response.status });
      return json(response.status === 422 ? 400 : response.status, {
        ok: false,
        error: authErrorMessage(response.status, result)
      });
    }

    const user = result.user || null;
    const accessToken = result.access_token || null;

    // Если подтверждение почты включено, сессии не будет — предупреждаем честно.
    if (!accessToken) {
      return json(200, {
        ok: true,
        needsConfirmation: true,
        message: "Мы отправили письмо для подтверждения почты.",
        user: user ? { id: user.id, email: user.email } : null
      });
    }

    return json(200, {
      ok: true,
      token: accessToken,
      expiresIn: result.expires_in || null,
      user: {
        id: user.id,
        email: user.email,
        name: (user.user_metadata || {}).name || ""
      }
    });
  } catch (error) {
    console.error("Signup request failed", { reason: error?.name || "unknown" });
    return json(502, { ok: false, error: "Сервис регистрации недоступен." });
  }
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}

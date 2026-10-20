// Проверка кода из письма и смена пароля.
//
//   POST /api/auth/recover-verify   тело: { email, code, password }
//
// Supabase проверяет код и выдаёт сессию. Этой же сессией сразу меняем пароль,
// чтобы клиенту не пришлось вводить код дважды.
//
// Пароль нигде не сохраняем и не логируем: он уходит в Supabase и хранится
// там в зашифрованном виде.

import { isValidEmail, json, normalizeEmail, supabaseAuth } from "../_lib/auth.js";

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
  const code = String(payload.code || "").replace(/\s/g, "");
  const password = String(payload.password || "");

  if (!isValidEmail(email)) {
    return json(400, { ok: false, error: "Укажите корректный адрес почты." });
  }

  if (!/^\d{4,10}$/.test(code)) {
    return json(400, { ok: false, error: "Введите код из письма." });
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return json(400, {
      ok: false,
      error: `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов.`
    });
  }

  if (password.length > 72) {
    // Ограничение самого Supabase.
    return json(400, { ok: false, error: "Пароль слишком длинный." });
  }

  try {
    // Проверяем код: Supabase сверяет его с отправленным на почту.
    const verified = await supabaseAuth(env, "/verify", {
      method: "POST",
      body: JSON.stringify({ type: "recovery", token: code, email })
    });

    const session = await verified.json().catch(() => ({}));

    if (!verified.ok || !session.access_token) {
      return json(401, {
        ok: false,
        error: "Код неверный или уже истёк. Запросите новый."
      });
    }

    // Меняем пароль от имени самого клиента: его сессия уже подтверждена кодом.
    const changed = await supabaseAuth(env, "/user", {
      method: "PUT",
      headers: { Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ password })
    });

    if (!changed.ok) {
      const detail = await changed.json().catch(() => ({}));
      const raw = String(detail?.msg || detail?.error_description || "").toLowerCase();

      if (raw.includes("password") && raw.includes("6")) {
        return json(400, { ok: false, error: "Пароль слишком короткий." });
      }

      console.error("Password change failed", { status: changed.status });
      return json(400, { ok: false, error: "Не удалось изменить пароль. Попробуйте ещё раз." });
    }

    return json(200, {
      ok: true,
      message: "Пароль изменён. Войдите с новым паролем."
    });
  } catch (error) {
    console.error("Password recover verify failed", { reason: error?.name || "unknown" });
    return json(502, { ok: false, error: "Сервис восстановления недоступен. Попробуйте позже." });
  }
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, PUT, OPTIONS"
  };
}

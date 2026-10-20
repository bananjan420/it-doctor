// Запрос на восстановление пароля.
//
//   POST /api/auth/recover   тело: { email }
//
// Supabase отправляет письмо с кодом. Существует почта или нет — отвечаем
// одинаково: иначе по ответу можно было бы узнать, кто зарегистрирован.
//
// Письмо уходит через настроенный SMTP, шаблон и тему задаёт Supabase.

import { isValidEmail, json, normalizeEmail, supabaseAuth } from "../_lib/auth.js";

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

  if (!isValidEmail(email)) {
    return json(400, { ok: false, error: "Укажите корректный адрес почты." });
  }

  try {
    const response = await supabaseAuth(env, "/recover", {
      method: "POST",
      body: JSON.stringify({ email })
    });

    // Слишком частые запросы Supabase ограничивает: говорим об этом честно.
    if (response.status === 429) {
      return json(429, {
        ok: false,
        error: "Письмо уже отправлено недавно. Подождите минуту и попробуйте снова."
      });
    }

    // Остальные ошибки не раскрываем: письмо могло не уйти, но клиент не должен
    // узнавать по ответу, есть ли такой аккаунт.
    return json(200, {
      ok: true,
      message: "Если такая почта зарегистрирована, мы отправили на неё код."
    });
  } catch (error) {
    console.error("Password recover failed", { reason: error?.name || "unknown" });
    return json(502, { ok: false, error: "Сервис восстановления недоступен. Попробуйте позже." });
  }
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}

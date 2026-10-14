// Личные данные клиента: имя, телефон, аватар.
//
// Почту менять нельзя — это идентификатор входа, поэтому она только читается
// и показывается в интерфейсе. Данные хранятся в метаданных Supabase Auth.

import {
  getAuthUser,
  json,
  normalizePhone,
  profileFrom,
  supabaseAuth
} from "../_lib/auth.js";

// Аватар — картинка в виде data:URL. Держим небольшой размер, чтобы не
// раздувать профиль и не тормозить загрузку кабинета.
const MAX_AVATAR_LENGTH = 200_000;
const MAX_NAME_LENGTH = 100;

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors() });
  }

  const user = await getAuthUser(request, env);

  if (!user) {
    return json(401, { ok: false, error: "Нужно войти в личный кабинет." });
  }

  if (request.method === "GET") {
    return json(200, { ok: true, profile: profileFrom(user) });
  }

  if (request.method !== "PUT" && request.method !== "POST") {
    return json(405, { ok: false, error: "Метод не поддерживается" });
  }

  let payload;

  try {
    payload = await request.json();
  } catch {
    return json(400, { ok: false, error: "Ожидается JSON" });
  }

  const current = profileFrom(user);
  const meta = user.user_metadata || {};

  // Имя: пустое значение не принимаем, если оно уже было задано.
  let name = current.name;
  if (payload.name !== undefined) {
    name = String(payload.name || "").trim().slice(0, MAX_NAME_LENGTH);

    if (payload.name !== "" && !name) {
      return json(400, { ok: false, error: "Имя не может быть пустым." });
    }
  }

  // Телефон: приводим к единому виду, пустое значение разрешено.
  let phone = current.phone;
  if (payload.phone !== undefined) {
    const raw = String(payload.phone || "").trim();

    if (!raw) {
      phone = "";
    } else {
      const normalized = normalizePhone(raw);

      if (!normalized) {
        return json(400, {
          ok: false,
          error: "Введите корректный номер: +7 (999) 123-45-67."
        });
      }

      phone = normalized;
    }
  }

  // Аватар: строка вида data:image/... или пустая строка, чтобы убрать фото.
  let avatar = current.avatar;
  if (payload.avatar !== undefined) {
    avatar = String(payload.avatar || "");

    if (avatar && !avatar.startsWith("data:image/")) {
      return json(400, { ok: false, error: "Аватар должен быть картинкой." });
    }

    if (avatar.length > MAX_AVATAR_LENGTH) {
      return json(400, { ok: false, error: "Картинка слишком большая." });
    }
  }

  try {
    const response = await supabaseAuth(env, "/user", {
      method: "PUT",
      headers: { Authorization: `Bearer ${user.token}` },
      body: JSON.stringify({
        data: {
          // Остальные метаданные сохраняем: Supabase заменяет объект целиком.
          ...meta,
          name,
          phone,
          avatar
        }
      })
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("Profile update failed", { status: response.status });
      return json(502, { ok: false, error: "Не удалось сохранить данные." });
    }

    return json(200, { ok: true, profile: profileFrom(result) });
  } catch (error) {
    console.error("Profile update request failed", { reason: error?.name || "unknown" });
    return json(502, { ok: false, error: "Сервис профиля недоступен." });
  }
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS"
  };
}

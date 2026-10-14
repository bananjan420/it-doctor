// Сессия владельца для админских функций.
//
// Владелец один раз присылает пароль (ADMIN_KEY), в ответ получает подписанную
// сессию в HttpOnly-cookie. Пароль в браузере не сохраняется.
//
// Модуль общий: им пользуются и заявки, и услуги, чтобы проверка входа была
// ровно одна на весь админский API.

export const COOKIE_NAME = "itd_admin";
export const SESSION_TTL_SECONDS = 60 * 60 * 12;

/** Создаёт подписанную сессию: срок действия + подпись HMAC от ADMIN_KEY. */
export async function createSession(adminKey, ttl = SESSION_TTL_SECONDS) {
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const signature = await sign(`admin.${expiresAt}`, adminKey);
  return `${expiresAt}.${signature}`;
}

/** Проверяет сессию: подпись верна и срок не истёк. */
export async function verifySession(token, adminKey) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) {
    return false;
  }

  const expiresAt = Number(parts[0]);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
    return false;
  }

  const expected = await sign(`admin.${parts[0]}`, adminKey);
  return timingSafeEqual(parts[1], expected);
}

/** Пускает ли запрос владельца: валидная сессия в cookie. */
export async function isAuthorized(request, env) {
  const adminKey = env.ADMIN_KEY?.trim();
  if (!adminKey) {
    return false;
  }

  const token = readCookie(request.headers.get("Cookie") || "", COOKIE_NAME);
  return verifySession(token, adminKey);
}

/** Заголовок для установки cookie с сессией. */
export function sessionCookie(token, headers = {}) {
  const secure = "Secure; ";
  const value = [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Strict",
    `Max-Age=${SESSION_TTL_SECONDS}`
  ].join("; ");

  headers["Set-Cookie"] = `${value}; ${secure}SameSite=Strict`;
  return headers;
}

/** Гасит cookie при выходе. */
export function clearSessionCookie(headers = {}) {
  headers["Set-Cookie"] = `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; Secure; SameSite=Strict`;
  return headers;
}

async function sign(message, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));

  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Сравнение строк за постоянное время: не даёт угадывать пароль по таймингам. */
function timingSafeEqual(left, right) {
  const a = String(left);
  const b = String(right);
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;

  for (let index = 0; index < length; index += 1) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }

  return diff === 0;
}

function readCookie(header, name) {
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : "";
}

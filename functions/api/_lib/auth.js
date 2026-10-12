// Общие помощники для функций личного кабинета.
//
// Токен клиента выдаёт Supabase Auth при входе. Наш сервер не доверяет ему
// на слово: перед любой работой с данными он спрашивает у Supabase, чей это
// токен. Секретный ключ при этом остаётся только в переменных окружения.

const AUTH_TIMEOUT_MS = 8000;

/** Отдаёт адрес и ключи Supabase из окружения функции. */
export function supabaseConfig(env) {
  return {
    url: env.SUPABASE_URL?.trim().replace(/\/+$/, "") || "",
    // Публичный ключ нужен только для проверки токена на GoTrue.
    publicKey:
      env.SUPABASE_PUBLISHABLE_KEY?.trim() ||
      env.SUPABASE_PUBLIC_KEY?.trim() ||
      "",
    // Секретный ключ обходит RLS: он применяется только на сервере.
    secretKey:
      env.SUPABASE_SECRET_KEY?.trim() ||
      env.SUPABASE_SERVICE_KEY?.trim() ||
      ""
  };
}

/**
 * Проверяет токен клиента и возвращает его профиль.
 *
 * Возвращает null, если токена нет, он просрочен или подделан.
 */
export async function getAuthUser(request, env) {
  const token = bearerToken(request);

  if (!token) {
    return null;
  }

  const { url, publicKey } = supabaseConfig(env);

  if (!url || !publicKey) {
    console.error("Supabase auth is not configured");
    return null;
  }

  try {
    const response = await fetch(`${url}/auth/v1/user`, {
      headers: {
        apikey: publicKey,
        Authorization: `Bearer ${token}`
      },
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS)
    });

    if (!response.ok) {
      return null;
    }

    const user = await response.json();

    // Профиль обязан содержать идентификатор: без него привязывать заявку не к чему.
    return user && typeof user.id === "string" ? { ...user, token } : null;
  } catch (error) {
    console.error("Supabase auth check failed", { reason: error?.name || "unknown" });
    return null;
  }
}

/** Запрос к базе секретным ключом (обходит RLS, поэтому только на сервере). */
export function supabaseAdmin(env, path, options = {}) {
  const { url, secretKey } = supabaseConfig(env);

  if (!url || !secretKey) {
    throw new Error("Supabase не настроен");
  }

  return fetch(`${url}${path}`, {
    ...options,
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(8000)
  });
}

/** Запрос к Supabase Auth (вход, регистрация, выход). */
export function supabaseAuth(env, path, options = {}) {
  const { url, publicKey } = supabaseConfig(env);

  if (!url || !publicKey) {
    throw new Error("Supabase Auth не настроен");
  }

  return fetch(`${url}/auth/v1${path}`, {
    ...options,
    headers: {
      apikey: publicKey,
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS)
  });
}

/** Достаёт токен из заголовка Authorization. */
export function bearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

/** Приводит почту к единому виду: без пробелов и в нижнем регистре. */
export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

/** Простая проверка почты: без неё Supabase вернёт невнятную ошибку. */
export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizeEmail(value));
}

/** Единый ответ в формате JSON с запретом кэширования. */
export function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

/** Переводит ответы Supabase Auth на понятный русский язык. */
export function authErrorMessage(status, payload) {
  const raw = String(
    payload?.error_description || payload?.msg || payload?.error || ""
  ).toLowerCase();

  if (raw.includes("already registered") || raw.includes("already been registered")) {
    return "Такая почта уже зарегистрирована. Попробуйте войти.";
  }

  if (raw.includes("invalid login credentials")) {
    return "Неверная почта или пароль.";
  }

  if (raw.includes("email not confirmed")) {
    return "Почта не подтверждена. Проверьте письмо.";
  }

  if (raw.includes("password") && raw.includes("6")) {
    return "Пароль слишком короткий: нужно минимум 6 символов.";
  }

  if (raw.includes("rate limit") || status === 429) {
    return "Слишком много попыток. Попробуйте через минуту.";
  }

  if (raw.includes("unable to validate email") || raw.includes("invalid email")) {
    return "Проверьте адрес почты.";
  }

  return "Не удалось выполнить запрос. Попробуйте позже.";
}

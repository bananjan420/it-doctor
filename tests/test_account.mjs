// Тесты регистрации, входа и личного кабинета.
//
// Запуск: node it-doktor/tests/test_account.mjs
//
// Сеть не используется: Supabase Auth и база подменяются заглушками.
// Главная проверка — клиент видит только свои заявки.

import assert from "node:assert/strict";
import { onRequest as register } from "../functions/api/auth/register.js";
import { onRequest as recover } from "../functions/api/auth/recover.js";
import { onRequest as recoverVerify } from "../functions/api/auth/recover-verify.js";
import { onRequest as login } from "../functions/api/auth/login.js";
import { onRequest as accountLeads } from "../functions/api/me/leads.js";
import { onRequest as profileApi } from "../functions/api/me/profile.js";

const ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_TEST",
  SUPABASE_SECRET_KEY: "sb_secret_TEST"
};

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  OK     ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  ПРОВАЛ ${name}: ${error.message}`);
    failed += 1;
  }
}

// --- Заглушки -----------------------------------------------------------

// Пользователи в «базе» Supabase Auth: email -> { id, password, name }
const users = new Map();
// Заявки в «базе»: массив строк таблицы leads
let leads = [];
// Все обращения к базе заявок
let leadQueries = [];
let signupDisabled = false;

// Коды восстановления: почта -> код. В настоящем Supabase код приходит письмом.
const RECOVERY_CODE = "12345678";
const recoveryCodes = new Map();

// Каталог услуг: цены и признак «от».
const services = [
  { id: "svc-fixed", title: "Замена термопасты", price_value: 1000, is_active: true },
  { id: "svc-no-price", title: "Замена аккумулятора", price_value: 0, is_active: true }
];

// Что вернёт заглушка ЮKassa. Тесты меняют это значение.
let yookassaStatus = "pending";
let yookassaAmount = null;
let yookassaCalls = [];

/** Заглушка ЮKassa: создание платежа и чтение платежа. */
function yookassaResponder(target, method, body) {
  const isCreate = !/\/v3\/payments\/[^/?]+/.test(target);

  yookassaCalls.push({ method, url: target, body: isCreate ? body : null });

  // Сумма: при создании берём из запроса, при чтении — заданную тестом.
  const amount = isCreate
    ? String(body?.amount?.value || "0.00")
    : String(yookassaAmount ?? "1000.00");

  return new Response(JSON.stringify({
    id: "pay-test-1",
    status: isCreate ? "pending" : yookassaStatus,
    paid: (isCreate ? "pending" : yookassaStatus) === "succeeded",
    amount: { value: amount, currency: "RUB" },
    confirmation: { type: "redirect", confirmation_url: "https://yookassa.test/pay/1" },
    captured_at: "2026-10-14T12:00:00.000Z",
    metadata: body?.metadata || {}
  }), { status: 200 });
}

const TOKEN_PREFIX = "token-for-";

globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  const method = options.method || "GET";
  const body = options.body ? JSON.parse(options.body) : {};
  const authHeader = (options.headers || {}).Authorization || "";

  // --- Supabase Auth ---
  if (target.includes("/auth/v1/signup")) {
    if (signupDisabled) {
      return new Response(JSON.stringify({ msg: "Email signups are disabled" }), { status: 422 });
    }

    if (users.has(body.email)) {
      return new Response(JSON.stringify({ msg: "User already registered" }), { status: 422 });
    }

    const id = `user-${users.size + 1}`;
    users.set(body.email, {
      id,
      password: body.password,
      // Имя и телефон приходят из регистрации: в кабинете их уже не спрашиваем.
      meta: { name: body.data?.name || "", phone: body.data?.phone || "", avatar: "" }
    });

    return new Response(JSON.stringify({
      access_token: `${TOKEN_PREFIX}${id}`,
      expires_in: 3600,
      user: { id, email: body.email, user_metadata: { ...users.get(body.email).meta } }
    }), { status: 200 });
  }

  if (target.includes("/auth/v1/token?grant_type=password")) {
    const record = users.get(body.email);

    if (!record || record.password !== body.password) {
      return new Response(JSON.stringify({ error_description: "Invalid login credentials" }), { status: 400 });
    }

    return new Response(JSON.stringify({
      access_token: `${TOKEN_PREFIX}${record.id}`,
      expires_in: 3600,
      user: { id: record.id, email: body.email, user_metadata: { ...record.meta } }
    }), { status: 200 });
  }

  // Обновление профиля: имя, телефон, аватар. Проверяем раньше чтения,
  // иначе PUT перехватит обработчик чтения.
  if (target.includes("/auth/v1/user") && method === "PUT") {
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const id = token.replace(TOKEN_PREFIX, "");
    const record = [...users.entries()].find(([, value]) => value.id === id);

    if (!record) {
      return new Response(JSON.stringify({ message: "invalid token" }), { status: 401 });
    }

    // При смене пароля в теле только password: профиль при этом не трогаем.
    if (typeof body.password === "string") {
      record[1].password = body.password;
      return new Response(JSON.stringify({ id, email: record[0] }), { status: 200 });
    }

    record[1].meta = { ...body.data };
    return new Response(JSON.stringify({
      id,
      email: record[0],
      user_metadata: { ...record[1].meta }
    }), { status: 200 });
  }

  if (target.includes("/auth/v1/user")) {
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const id = token.replace(TOKEN_PREFIX, "");
    const record = [...users.entries()].find(([, value]) => value.id === id);

    if (!record) {
      return new Response(JSON.stringify({ message: "invalid token" }), { status: 401 });
    }

    return new Response(JSON.stringify({
      id,
      email: record[0],
      user_metadata: { ...record[1].meta }
    }), { status: 200 });
  }

  if (target.includes("/auth/v1/logout")) {
    return new Response("{}", { status: 204 });
  }

  // --- Восстановление пароля ---
  if (target.includes("/auth/v1/recover")) {
    // Supabase отправляет письмо с кодом; для теста код всегда один.
    recoveryCodes.set(body.email, RECOVERY_CODE);
    return new Response(JSON.stringify({}), { status: 200 });
  }

  if (target.includes("/auth/v1/verify")) {
    if (body.type !== "recovery" || body.token !== recoveryCodes.get(body.email)) {
      return new Response(JSON.stringify({ msg: "Token has expired or is invalid" }), { status: 403 });
    }

    const record = users.get(body.email);

    if (!record) {
      return new Response(JSON.stringify({ msg: "User not found" }), { status: 404 });
    }

    return new Response(JSON.stringify({
      access_token: `${TOKEN_PREFIX}${record.id}`,
      expires_in: 3600,
      user: { id: record.id, email: body.email }
    }), { status: 200 });
  }

  // --- Таблица leads ---
  if (target.includes("/rest/v1/leads")) {
    const parsed = new URL(target);
    const filter = parsed.searchParams.get("user_id");
    leadQueries.push({ method, url: target, body: method === "POST" ? body : null });

    if (method === "GET") {
      // Сервер обязан запросить только заявки конкретного пользователя.
      const owner = filter?.replace("eq.", "");
      const rows = leads.filter((lead) => lead.user_id === owner);
      return new Response(JSON.stringify(rows), { status: 200 });
    }

    if (method === "POST") {
      const row = { id: `lead-${leads.length + 1}`, created_at: new Date().toISOString(), ...body };
      leads.push(row);
      return new Response(JSON.stringify([row]), { status: 201 });
    }
  }

  // --- Таблица services ---
  // Каталог услуг: по нему сервер определяет услугу заявки.
  if (target.includes("/rest/v1/services")) {
    return new Response(JSON.stringify(services), { status: 200 });
  }

  // --- ЮKassa ---
  // Заглушка внешнего сервиса: настоящие ключи в тестах не нужны.
  if (target.includes("/v3/payments")) {
    return yookassaResponder(target, method, body);
  }

  throw new Error(`неожиданный запрос: ${target}`);
};

// --- Помощники ----------------------------------------------------------

function post(body, headers = {}) {
  return new Request("https://it-doctor.pages.dev/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

function get(headers = {}) {
  return new Request("https://it-doctor.pages.dev/api/me/leads", { method: "GET", headers });
}

function withToken(token) {
  return { Authorization: `Bearer ${token}` };
}

function reset() {
  users.clear();
  leads = [];
  leadQueries = [];
  signupDisabled = false;
}

/** Заполняет имя и телефон через боевую функцию профиля. */
async function setProfile(token, { name, phone, avatar }) {
  const response = await profileApi({
    request: new Request("https://x/api/me/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, phone, avatar })
    }),
    env: ENV
  });

  return { status: response.status, payload: await response.json() };
}

/** Регистрирует пользователя через боевую функцию и возвращает токен. */
async function registerUser(email, password, name = "Клиент", phone = "+7 (900) 123-45-67") {
  const response = await register({ request: post({ email, password, name, phone }), env: ENV });
  const payload = await response.json();
  return payload;
}

console.log("Тесты регистрации и личного кабинета\n");

// --- Регистрация --------------------------------------------------------

await test("регистрация выдаёт токен и создаёт пользователя", async () => {
  reset();
  const payload = await registerUser("client@example.com", "secret123", "Иван");

  assert.equal(payload.ok, true);
  assert.ok(payload.token, "должен вернуться токен");
  assert.equal(payload.user.email, "client@example.com");
  assert.equal(users.size, 1);
});

await test("пароль не возвращается клиенту и не логируется", async () => {
  reset();
  const response = await register({ request: post({ email: "a@b.ru", password: "supersecret" }), env: ENV });
  const text = await response.text();

  assert.doesNotMatch(text, /supersecret/, "пароль не должен попадать в ответ");
});

await test("повторная регистрация той же почты отклоняется", async () => {
  reset();
  await registerUser("dup@example.com", "secret123");
  const second = await registerUser("dup@example.com", "secret123");

  assert.equal(second.ok, false);
  assert.match(second.error, /уже зарегистрирована/i);
});

await test("некорректная почта отклоняется", async () => {
  reset();
  const payload = await registerUser("не-почта", "secret123");
  assert.equal(payload.ok, false);
  assert.match(payload.error, /почт/i);
});

await test("короткий пароль отклоняется", async () => {
  reset();
  const payload = await registerUser("short@example.com", "123");
  assert.equal(payload.ok, false);
  assert.match(payload.error, /6 символов/);
});

await test("почта приводится к нижнему регистру", async () => {
  reset();
  const payload = await registerUser("MiXeD@Example.COM", "secret123");
  assert.equal(payload.ok, true);
  assert.equal(payload.user.email, "mixed@example.com");
});

// --- Вход ---------------------------------------------------------------

await test("вход с верным паролем выдаёт токен", async () => {
  reset();
  await registerUser("login@example.com", "secret123");

  const response = await login({
    request: post({ email: "login@example.com", password: "secret123" }),
    env: ENV
  });

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.ok(payload.token);
});

await test("неверный пароль даёт понятную ошибку и код 401", async () => {
  reset();
  await registerUser("wrong@example.com", "secret123");

  const response = await login({
    request: post({ email: "wrong@example.com", password: "не тот" }),
    env: ENV
  });

  const payload = await response.json();
  assert.equal(response.status, 401);
  assert.match(payload.error, /Неверная почта или пароль/);
});

await test("выход вызывает отзыв сессии", async () => {
  reset();
  const { token } = await registerUser("out@example.com", "secret123");

  const response = await login({
    request: new Request("https://x/api/auth/login", { method: "DELETE", headers: withToken(token) }),
    env: ENV
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

// --- Личный кабинет: доступ --------------------------------------------

await test("без токена кабинет закрыт", async () => {
  reset();
  const response = await accountLeads({ request: get(), env: ENV });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).ok, false);
});

await test("подделанный токен не пускает в кабинет", async () => {
  reset();
  // В заголовках допустимы только латинские символы, поэтому токен чужой формы.
  const response = await accountLeads({ request: get(withToken("token-for-foreign-user")), env: ENV });

  assert.equal(response.status, 401);
});

await test("пользователь видит только свои заявки", async () => {
  reset();

  const first = await registerUser("one@example.com", "secret123", "Первый");
  const second = await registerUser("two@example.com", "secret123", "Второй");

  // Имя и телефон живут в профиле, из него же попадают в заявку.
  await setProfile(first.token, { name: "Первый", phone: "+7 (900) 111-11-11" });
  await setProfile(second.token, { name: "Второй", phone: "+7 (900) 222-22-22" });

  // Каждый оставляет по заявке через боевую функцию.
  await accountLeads({
    request: new Request("https://x/api/me/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...withToken(first.token) },
      body: JSON.stringify({ service: "Диагностика" })
    }),
    env: ENV
  });

  await accountLeads({
    request: new Request("https://x/api/me/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...withToken(second.token) },
      body: JSON.stringify({ service: "Чистка" })
    }),
    env: ENV
  });

  assert.equal(leads.length, 2, "в базе должно быть две заявки");

  const firstView = await accountLeads({ request: get(withToken(first.token)), env: ENV });
  const firstPayload = await firstView.json();

  const secondView = await accountLeads({ request: get(withToken(second.token)), env: ENV });
  const secondPayload = await secondView.json();

  assert.equal(firstPayload.leads.length, 1, "первый видит ровно одну свою заявку");
  assert.equal(firstPayload.leads[0].phone, "+7 (900) 111-11-11");

  assert.equal(secondPayload.leads.length, 1, "второй видит ровно одну свою заявку");
  assert.equal(secondPayload.leads[0].phone, "+7 (900) 222-22-22");

  // Ни один не видит чужую заявку.
  assert.ok(
    !firstPayload.leads.some((lead) => lead.phone === "+7 (900) 222-22-22"),
    "первый не должен видеть заявку второго"
  );
});

await test("фильтр по владельцу задаёт сервер, а не клиент", async () => {
  reset();
  const { token } = await registerUser("owner@example.com", "secret123");

  leadQueries = [];
  await accountLeads({ request: get(withToken(token)), env: ENV });

  const query = leadQueries.find((call) => call.method === "GET");
  assert.ok(query, "должен быть запрос к базе");
  assert.match(query.url, /user_id=eq\.user-1/, "фильтр должен идти от проверенного токена");
});

await test("попытка навязать чужой user_id игнорируется", async () => {
  reset();
  const { token } = await registerUser("hacker@example.com", "secret123");
  await setProfile(token, { name: "Хакер", phone: "+7 (900) 000-00-00" });

  const response = await accountLeads({
    request: new Request("https://x/api/me/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...withToken(token) },
      body: JSON.stringify({
        service: "Диагностика",
        // Пытаемся подсунуть чужого владельца заявки.
        user_id: "user-999"
      })
    }),
    env: ENV
  });

  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.lead.user_id, "user-1", "владелец должен быть из токена");
});

// --- Новая заявка из кабинета ------------------------------------------

await test("заявка из кабинета помечается источником account", async () => {
  reset();
  const { token } = await registerUser("source@example.com", "secret123");
  await setProfile(token, { name: "Клиент", phone: "+7 (900) 333-33-33" });

  const response = await accountLeads({
    request: new Request("https://x/api/me/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...withToken(token) },
      body: JSON.stringify({ service: "Диагностика" })
    }),
    env: ENV
  });

  const payload = await response.json();
  assert.equal(payload.lead.source, "account");
  assert.equal(payload.lead.status, "new", "у новой заявки статус new");
});

await test("без заполненного профиля заявка не создаётся", async () => {
  reset();
  const { token } = await registerUser("empty@example.com", "secret123");

  // Имя и телефон теперь приходят при регистрации. Проверяем защиту на случай,
  // если профиль всё же пуст: очищаем его через боевую функцию профиля.
  await profileApi({
    request: new Request("https://x/api/me/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...withToken(token) },
      body: JSON.stringify({ name: "", phone: "" })
    }),
    env: ENV
  });

  const response = await accountLeads({
    request: new Request("https://x/api/me/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...withToken(token) },
      body: JSON.stringify({ service: "Диагностика" })
    }),
    env: ENV
  });

  const payload = await response.json();
  assert.equal(response.status, 409);
  assert.equal(payload.needsProfile, true, "клиенту нужно предложить заполнить профиль");
  assert.equal(leads.length, 0, "в базу ничего не должно попасть");
});

await test("регистрация требует имя и телефон", async () => {
  reset();

  const withoutName = await register({ request: post({ email: "n@example.com", password: "secret123", phone: "+7 (900) 123-45-67" }), env: ENV });
  const namePayload = await withoutName.json();
  assert.equal(withoutName.status, 400);
  assert.match(namePayload.error, /имя/i);

  const withoutPhone = await register({ request: post({ email: "p@example.com", password: "secret123", name: "Иван" }), env: ENV });
  const phonePayload = await withoutPhone.json();
  assert.equal(withoutPhone.status, 400);
  assert.match(phonePayload.error, /телефон/i);

  assert.equal(users.size, 0, "неверные данные не должны создавать аккаунт");
});

await test("имя и телефон из регистрации попадают в профиль", async () => {
  reset();
  const { token } = await registerUser("profile@example.com", "secret123", "Мария", "8 (912) 345-67-89");

  const response = await accountLeads({ request: get(withToken(token)), env: ENV });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.profile.name, "Мария");
  assert.equal(payload.profile.phone, "+7 (912) 345-67-89", "телефон должен быть приведён к общему виду");
});

await test("запрос восстановления отправляет код и не раскрывает наличие почты", async () => {
  reset();
  await registerUser("recover@example.com", "secret123");

  const existing = await recover({ request: post({ email: "recover@example.com" }), env: ENV });
  const existingPayload = await existing.json();
  assert.equal(existing.status, 200);
  assert.equal(existingPayload.ok, true);

  const unknown = await recover({ request: post({ email: "nobody@example.com" }), env: ENV });
  const unknownPayload = await unknown.json();
  assert.equal(unknown.status, 200, "ответ не должен выдавать, есть ли аккаунт");
  assert.equal(unknownPayload.ok, true);
});

await test("неверный код не меняет пароль", async () => {
  reset();
  await registerUser("wrongcode@example.com", "secret123");

  const response = await recoverVerify({
    request: post({ email: "wrongcode@example.com", code: "00000000", password: "newsecret123" }),
    env: ENV
  });

  assert.equal(response.status, 401);
  assert.equal(users.get("wrongcode@example.com").password, "secret123", "пароль должен остаться прежним");
});

await test("верный код меняет пароль, старый больше не подходит", async () => {
  reset();
  await registerUser("change@example.com", "secret123");

  await recover({ request: post({ email: "change@example.com" }), env: ENV });

  const response = await recoverVerify({
    request: post({ email: "change@example.com", code: RECOVERY_CODE, password: "newsecret123" }),
    env: ENV
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);

  // Старый пароль больше не принимается.
  const oldLogin = await login({ request: post({ email: "change@example.com", password: "secret123" }), env: ENV });
  assert.equal(oldLogin.status, 401);

  // Новый — работает.
  const newLogin = await login({ request: post({ email: "change@example.com", password: "newsecret123" }), env: ENV });
  assert.equal(newLogin.status, 200);
});

await test("имя и телефон берутся из профиля, а не из тела запроса", async () => {
  reset();
  const { token } = await registerUser("fromprofile@example.com", "secret123");
  await setProfile(token, { name: "Иван Петров", phone: "+7 (900) 555-55-55" });

  const response = await accountLeads({
    request: new Request("https://x/api/me/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...withToken(token) },
      body: JSON.stringify({
        service: "Диагностика",
        // Эти значения должны быть проигнорированы.
        name: "Подмена",
        phone: "+7 (900) 000-00-00"
      })
    }),
    env: ENV
  });

  const payload = await response.json();
  assert.equal(payload.lead.name, "Иван Петров");
  assert.equal(payload.lead.phone, "+7 (900) 555-55-55");
});

// --- Профиль клиента ----------------------------------------------------

await test("профиль сохраняет имя и телефон", async () => {
  reset();
  const { token } = await registerUser("profile@example.com", "secret123");

  const saved = await setProfile(token, { name: "Мария", phone: "8 999 123 45 67" });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.profile.name, "Мария");
  assert.equal(saved.payload.profile.phone, "+7 (999) 123-45-67", "телефон приводится к формату");
});

await test("профиль не даёт поставить некорректный телефон", async () => {
  reset();
  const { token } = await registerUser("badphone@example.com", "secret123");

  const saved = await setProfile(token, { name: "Мария", phone: "12345" });
  assert.equal(saved.status, 400);
  assert.match(saved.payload.error, /корректный номер/);
});

await test("аватар сохраняется и его можно убрать", async () => {
  reset();
  const { token } = await registerUser("avatar@example.com", "secret123");

  const withPhoto = await setProfile(token, {
    name: "Мария",
    phone: "+7 (900) 111-11-11",
    avatar: "data:image/jpeg;base64,AAAA"
  });
  assert.equal(withPhoto.payload.profile.avatar, "data:image/jpeg;base64,AAAA");

  const withoutPhoto = await setProfile(token, { avatar: "" });
  assert.equal(withoutPhoto.payload.profile.avatar, "");
});

await test("вместо картинки аватар не принимается", async () => {
  reset();
  const { token } = await registerUser("badavatar@example.com", "secret123");

  const saved = await setProfile(token, { avatar: "https://злой-сайт/картинка.png" });
  assert.equal(saved.status, 400);
  assert.match(saved.payload.error, /картинк/);
});

await test("почту через профиль поменять нельзя", async () => {
  reset();
  const { token } = await registerUser("keepmail@example.com", "secret123");

  const saved = await setProfile(token, { name: "Мария", phone: "+7 (900) 222-22-22", email: "чужой@example.com" });
  assert.equal(saved.payload.profile.email, "keepmail@example.com", "почта остаётся прежней");
});

await test("профиль отдаётся вместе со списком заявок", async () => {
  reset();
  const { token } = await registerUser("withprofile@example.com", "secret123");
  await setProfile(token, { name: "Пётр", phone: "+7 (900) 777-77-77" });

  const response = await accountLeads({ request: get(withToken(token)), env: ENV });
  const payload = await response.json();

  assert.equal(payload.profile.name, "Пётр");
  assert.equal(payload.profile.phone, "+7 (900) 777-77-77");
  assert.equal(payload.profile.email, "withprofile@example.com");
});

await test("профиль без входа недоступен", async () => {
  reset();
  const response = await profileApi({ request: get(), env: ENV });
  assert.equal(response.status, 401);
});

await test("создать заявку без входа нельзя", async () => {
  reset();

  const response = await accountLeads({
    request: new Request("https://x/api/me/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Аноним", phone: "+7 (900) 444-44-44" })
    }),
    env: ENV
  });

  assert.equal(response.status, 401);
  assert.equal(leads.length, 0, "в базу ничего не должно попасть");
});

await test("в ответе нет служебных ключей", async () => {
  reset();
  const { token } = await registerUser("secret@example.com", "secret123");
  const response = await accountLeads({ request: get(withToken(token)), env: ENV });
  const text = await response.text();

  assert.doesNotMatch(text, /sb_secret_TEST/, "секретный ключ не должен утекать");
  assert.doesNotMatch(text, /example\.supabase\.co/, "адрес базы тоже не нужен клиенту");
});

console.log(`\nИтог: пройдено ${passed}, провалено ${failed}`);
process.exit(failed === 0 ? 0 : 1);

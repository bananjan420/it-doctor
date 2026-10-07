// Тесты API админ-панели: вход, список заявок, смена статуса, сохранение.
//
// Запуск: node it-doktor/tests/test_admin.mjs
//
// Сеть не используется: запросы к Supabase подменяются заглушкой.

import assert from "node:assert/strict";
import { onRequest, STATUSES, verifySession } from "../functions/api/leads.js";

const ENV = {
  ADMIN_KEY: "adk-test-key",
  SUPABASE_URL: "https://example.supabase.co",
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

// --- Заглушка Supabase --------------------------------------------------

const db = [];
let supabaseCalls = [];
let failNext = false;

function seedLeads() {
  db.length = 0;
  db.push(
    { id: "1", created_at: "2026-10-07T15:00:44+00:00", name: "Mini", phone: "+7 (900) 000-00-01", service: "Термопаста", message: "текст", source: "mini_app", status: "new" },
    { id: "2", created_at: "2026-10-07T14:58:37+00:00", name: "Сайт", phone: "+7 (900) 000-00-02", service: "Не выбрана", message: "текст", source: "website", status: "new" },
    { id: "3", created_at: "2026-10-06T10:00:00+00:00", name: "Бот", phone: "+7 (900) 000-00-03", service: "Диагностика", message: null, source: "telegram_bot", status: "completed" }
  );
}

globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  supabaseCalls.push({ url: target, method: options.method, body: options.body && JSON.parse(options.body) });

  if (!target.includes("/rest/v1/leads")) {
    throw new Error(`неожиданный запрос: ${target}`);
  }

  if (failNext) {
    failNext = false;
    return new Response("boom", { status: 500 });
  }

  const method = options.method || "GET";

  if (method === "GET") {
    // Проверяем, что список запрошен «новые сверху».
    assert.match(target, /order=created_at\.desc/, "должна быть сортировка по дате убыванием");
    return new Response(JSON.stringify(db), { status: 200 });
  }

  if (method === "PATCH") {
    const id = target.split("id=eq.")[1];
    const { status } = JSON.parse(options.body);
    const lead = db.find((item) => item.id === id);
    if (!lead) return new Response("[]", { status: 200 });
    lead.status = status;
    return new Response(JSON.stringify([lead]), { status: 200 });
  }

  throw new Error(`неожиданный метод: ${method}`);
};

// --- Помощники ----------------------------------------------------------

function request(method, { body, cookie, query } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  return new Request(`https://it-doctor.pages.dev/api/leads${query || ""}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function cookieFrom(response) {
  const raw = response.headers.get("Set-Cookie") || "";
  const value = raw.split(";")[0];
  return value;
}

async function login() {
  const response = await onRequest({
    request: request("POST", { body: { key: ENV.ADMIN_KEY } }),
    env: ENV
  });
  assert.equal(response.status, 200);
  return cookieFrom(response);
}

console.log("Тесты API админ-панели\n");

await test("без пароля список не отдаётся", async () => {
  seedLeads();
  const response = await onRequest({ request: request("GET"), env: ENV });
  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.equal(payload.ok, false);
});

await test("неверный пароль отклоняется", async () => {
  const response = await onRequest({
    request: request("POST", { body: { key: "неправильный" } }),
    env: ENV
  });
  assert.equal(response.status, 401);
});

await test("верный пароль выдаёт HttpOnly-cookie", async () => {
  const response = await onRequest({
    request: request("POST", { body: { key: ENV.ADMIN_KEY } }),
    env: ENV
  });
  assert.equal(response.status, 200);

  const cookie = response.headers.get("Set-Cookie") || "";
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  // Сам пароль в cookie не попадает.
  assert.doesNotMatch(cookie, /adk-test-key/);
});

await test("сессия подписана: подделанная не проходит", async () => {
  const valid = await verifySession("99999999999.подпись", ENV.ADMIN_KEY);
  assert.equal(valid, false, "чужая подпись должна отклоняться");

  const cookie = await login();
  const token = cookie.split("=")[1];
  assert.equal(await verifySession(token, ENV.ADMIN_KEY), true);
});

await test("с верной сессией приходит список заявок", async () => {
  seedLeads();
  const cookie = await login();
  const response = await onRequest({ request: request("GET", { cookie }), env: ENV });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.leads.length, 3);
});

await test("заявки отдаются от новых к старым", async () => {
  seedLeads();
  const cookie = await login();
  const response = await onRequest({ request: request("GET", { cookie }), env: ENV });
  const { leads } = await response.json();

  const dates = leads.map((lead) => new Date(lead.created_at).getTime());
  const sorted = [...dates].sort((a, b) => b - a);
  assert.deepEqual(dates, sorted, "порядок должен быть от новых к старым");
});

await test("в ответе есть все нужные поля заявки", async () => {
  seedLeads();
  const cookie = await login();
  const response = await onRequest({ request: request("GET", { cookie }), env: ENV });
  const { leads } = await response.json();

  for (const field of ["created_at", "name", "phone", "service", "source", "status"]) {
    assert.ok(field in leads[0], `в заявке должно быть поле ${field}`);
  }
});

await test("статус меняется и сохраняется в базе", async () => {
  seedLeads();
  const cookie = await login();

  const response = await onRequest({
    request: request("PATCH", { cookie, body: { id: "1", status: "in_progress" } }),
    env: ENV
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.lead.status, "in_progress");
  assert.equal(db.find((lead) => lead.id === "1").status, "in_progress", "статус должен остаться в базе");

  // Повторное чтение подтверждает сохранение (как после обновления страницы).
  const again = await onRequest({ request: request("GET", { cookie }), env: ENV });
  const { leads } = await again.json();
  assert.equal(leads.find((lead) => lead.id === "1").status, "in_progress");
});

await test("все четыре статуса принимаются", async () => {
  seedLeads();
  const cookie = await login();

  for (const status of STATUSES) {
    const response = await onRequest({
      request: request("PATCH", { cookie, body: { id: "2", status } }),
      env: ENV
    });
    assert.equal(response.status, 200, `статус ${status} должен приниматься`);
  }

  assert.deepEqual(STATUSES, ["new", "in_progress", "ready", "completed"]);
});

await test("недопустимый статус отклоняется без записи", async () => {
  seedLeads();
  const cookie = await login();

  const response = await onRequest({
    request: request("PATCH", { cookie, body: { id: "1", status: "удалить_всё" } }),
    env: ENV
  });

  assert.equal(response.status, 400);
  assert.equal(db.find((lead) => lead.id === "1").status, "new", "база не должна измениться");
});

await test("смена статуса без сессии запрещена", async () => {
  seedLeads();
  const response = await onRequest({
    request: request("PATCH", { body: { id: "1", status: "ready" } }),
    env: ENV
  });

  assert.equal(response.status, 401);
  assert.equal(db.find((lead) => lead.id === "1").status, "new");
});

await test("выход стирает сессию", async () => {
  const cookie = await login();

  const response = await onRequest({
    request: request("POST", { cookie, body: { key: "" } }),
    env: ENV
  });

  assert.equal(response.status, 200);
  const setCookie = response.headers.get("Set-Cookie") || "";
  assert.match(setCookie, /Max-Age=0/, "cookie должна удаляться");
});

await test("фильтр по статусу уходит в запрос к базе", async () => {
  seedLeads();
  const cookie = await login();
  supabaseCalls = [];

  await onRequest({ request: request("GET", { cookie, query: "?status=new" }), env: ENV });

  assert.ok(
    supabaseCalls.some((call) => call.url.includes("status=eq.new")),
    "фильтр должен попасть в запрос"
  );
});

await test("ошибка базы не ломает API", async () => {
  seedLeads();
  const cookie = await login();
  failNext = true;

  const response = await onRequest({ request: request("GET", { cookie }), env: ENV });
  assert.equal(response.status, 502);
  const payload = await response.json();
  assert.equal(payload.ok, false);
});

await test("секретный ключ Supabase не уходит в браузер", async () => {
  seedLeads();
  const cookie = await login();
  const response = await onRequest({ request: request("GET", { cookie }), env: ENV });
  const text = await response.text();

  assert.doesNotMatch(text, /sb_secret_TEST/, "секретный ключ не должен попадать в ответ");
  assert.doesNotMatch(text, /example\.supabase\.co/, "адрес базы тоже не нужен клиенту");
});

console.log(`\nИтог: пройдено ${passed}, провалено ${failed}`);
process.exit(failed === 0 ? 0 : 1);

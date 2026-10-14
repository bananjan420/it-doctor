// Тесты API админ-панели: вход, список заявок, смена статуса, сохранение.
//
// Запуск: node it-doktor/tests/test_admin.mjs
//
// Сеть не используется: запросы к Supabase подменяются заглушкой.

import assert from "node:assert/strict";
import { onRequest, SOURCES, STATUSES, verifySession } from "../functions/api/leads.js";

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

// Справочник услуг: владелец ведёт его в админке.
const servicesDb = [
  { id: "s1", title: "Диагностика", price: "500 руб.", is_active: true, sort_order: 10 },
  { id: "s2", title: "Чистка от пыли", price: "1 500 руб.", is_active: true, sort_order: 20 },
  { id: "s3", title: "Скрытая услуга", price: "0 руб.", is_active: false, sort_order: 30 }
];

function seedLeads() {
  db.length = 0;
  db.push(
    { id: "1", created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), name: "Mini", phone: "+7 (900) 000-00-01", service: "Термопаста", message: "текст", source: "mini_app", status: "new" },
    { id: "2", created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), name: "Сайт", phone: "+7 (900) 000-00-02", service: "Не выбрана", message: "текст", source: "website", status: "new" },
    { id: "3", created_at: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(), name: "Бот", phone: "+7 (900) 000-00-03", service: null, message: null, source: "telegram_bot", status: "completed" }
  );
}

globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  supabaseCalls.push({ url: target, method: options.method, body: options.body && JSON.parse(options.body) });

  // Справочник услуг для фильтра админки.
  if (target.includes("/rest/v1/services")) {
    if (failNext) {
      failNext = false;
      return new Response("boom", { status: 500 });
    }

    const rows = servicesDb.map((service) => ({
      title: service.title,
      price: service.price,
      is_active: service.is_active,
      sort_order: service.sort_order,
      id: service.id
    }));

    return new Response(JSON.stringify(rows), { status: 200 });
  }

  if (!target.includes("/rest/v1/leads")) {
    throw new Error(`неожиданный запрос: ${target}`);
  }

  if (failNext) {
    failNext = false;
    return new Response("boom", { status: 500 });
  }

  const method = options.method || "GET";

  if (method === "GET") {
    // Запрос справочника услуг для фильтра: отдаём только колонку service.
    if (target.includes("select=service")) {
      const rows = db.map((lead) => ({ service: lead.service }));
      return new Response(JSON.stringify(rows), { status: 200 });
    }

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

/**
 * Приводит URL к читаемому виду.
 *
 * URLSearchParams кодирует уже закодированные значения повторно, поэтому
 * раскодируем несколько раз — до устойчивого результата.
 */
function readableUrl(url) {
  let text = String(url);

  for (let i = 0; i < 3; i += 1) {
    const decoded = decodeURIComponent(text.replaceAll("+", "%20"));
    if (decoded === text) break;
    text = decoded;
  }

  return text;
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

await test("все статусы принимаются, «готова» убрана", async () => {
  seedLeads();
  const cookie = await login();

  for (const status of STATUSES) {
    const response = await onRequest({
      request: request("PATCH", { cookie, body: { id: "2", status } }),
      env: ENV
    });
    assert.equal(response.status, 200, `статус ${status} должен приниматься`);
  }

  // «Готова» и «Завершена» означали одно и то же, лишний статус убран.
  assert.deepEqual(STATUSES, ["new", "in_progress", "completed"]);

  const removed = await onRequest({
    request: request("PATCH", { cookie, body: { id: "2", status: "ready" } }),
    env: ENV
  });
  assert.equal(removed.status, 400, "убранный статус не должен приниматься");
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

await test("сортировка по дате уходит в базу в нужную сторону", async () => {
  seedLeads();
  const cookie = await login();

  supabaseCalls = [];
  await onRequest({ request: request("GET", { cookie, query: "?sort=date&dir=asc" }), env: ENV });
  assert.ok(
    supabaseCalls.some((call) => call.url.includes("order=created_at.asc")),
    "ожидалась сортировка по дате по возрастанию"
  );

  supabaseCalls = [];
  await onRequest({ request: request("GET", { cookie, query: "?sort=date&dir=desc" }), env: ENV });
  assert.ok(
    supabaseCalls.some((call) => call.url.includes("order=created_at.desc")),
    "ожидалась сортировка по дате по убыванию"
  );
});

await test("сортировка работает по каждому столбцу", async () => {
  seedLeads();
  const cookie = await login();

  const columns = {
    name: "name",
    phone: "phone",
    service: "service",
    source: "source",
    status: "status"
  };

  for (const [sortKey, column] of Object.entries(columns)) {
    supabaseCalls = [];
    await onRequest({
      request: request("GET", { cookie, query: `?sort=${sortKey}&dir=asc` }),
      env: ENV
    });

    const query = supabaseCalls.find((call) => call.url.includes("/rest/v1/leads"))?.url || "";
    assert.match(query, new RegExp(`order=${column}\\.asc`), `столбец ${column}`);
    // Вторичная сортировка стабилизирует порядок одинаковых значений.
    assert.match(query, /created_at\.desc/, "нужна вторичная сортировка по дате");
  }
});

await test("неизвестный столбец сортировки игнорируется", async () => {
  seedLeads();
  const cookie = await login();

  supabaseCalls = [];
  await onRequest({
    request: request("GET", { cookie, query: "?sort=password&dir=asc" }),
    env: ENV
  });

  const query = supabaseCalls.find((call) => call.url.includes("/rest/v1/leads"))?.url || "";
  // Произвольная строка в запрос к базе попасть не должна.
  assert.doesNotMatch(query, /password/);
  assert.match(query, /order=created_at\.desc/, "должна остаться сортировка по умолчанию");
});

await test("попытка внедрить SQL через сортировку не проходит", async () => {
  seedLeads();
  const cookie = await login();

  supabaseCalls = [];
  await onRequest({
    request: request("GET", { cookie, query: "?sort=name.desc%2Cstatus&dir=asc" }),
    env: ENV
  });

  const query = supabaseCalls.find((call) => call.url.includes("/rest/v1/leads"))?.url || "";
  assert.doesNotMatch(query, /name\.desc,status/);
  assert.match(query, /order=created_at\.desc/);
});

await test("без параметров сортировки порядок по умолчанию сохраняется", async () => {
  seedLeads();
  const cookie = await login();

  supabaseCalls = [];
  await onRequest({ request: request("GET", { cookie }), env: ENV });

  const query = supabaseCalls.find((call) => call.url.includes("/rest/v1/leads"))?.url || "";
  assert.match(query, /order=created_at\.desc/);
});

await test("несколько статусов сразу: «новые и в работе»", async () => {
  seedLeads();
  const cookie = await login();
  supabaseCalls = [];

  await onRequest({
    request: request("GET", { cookie, query: "?status=new,in_progress" }),
    env: ENV
  });

  const query = decodeURIComponent(
    supabaseCalls.find((call) => call.url.includes("/rest/v1/leads"))?.url || ""
  );
  assert.match(query, /status=in\.\(new,in_progress\)/, "должен быть список значений");
});

await test("несколько источников сразу", async () => {
  seedLeads();
  const cookie = await login();
  supabaseCalls = [];

  await onRequest({
    request: request("GET", { cookie, query: "?source=website,telegram_bot" }),
    env: ENV
  });

  const query = decodeURIComponent(
    supabaseCalls.find((call) => call.url.includes("/rest/v1/leads"))?.url || ""
  );
  assert.match(query, /source=in\.\(website,telegram_bot\)/);
});

await test("несколько услуг сразу: значения в кавычках", async () => {
  seedLeads();
  const cookie = await login();
  supabaseCalls = [];

  await onRequest({
    request: request("GET", { cookie, query: "?service=" + encodeURIComponent("Термопаста,Не выбрана") }),
    env: ENV
  });

  const query = readableUrl(
    supabaseCalls.find((call) => call.url.includes("/rest/v1/leads"))?.url || ""
  );
  assert.match(query, /service=in\.\("Термопаста","Не выбрана"\)/);
});

await test("поиск смотрит и в текст заявки", async () => {
  seedLeads();
  const cookie = await login();
  supabaseCalls = [];

  await onRequest({ request: request("GET", { cookie, query: "?q=текст" }), env: ENV });

  const query = decodeURIComponent(
    supabaseCalls.find((call) => call.url.includes("/rest/v1/leads"))?.url || ""
  );
  assert.match(query, /message\.ilike/, "текст заявки тоже должен искаться");
});

await test("фильтр по источнику уходит в запрос к базе", async () => {
  seedLeads();
  const cookie = await login();
  supabaseCalls = [];

  await onRequest({ request: request("GET", { cookie, query: "?source=mini_app" }), env: ENV });

  assert.ok(
    supabaseCalls.some((call) => call.url.includes("source=eq.mini_app")),
    "фильтр по источнику должен попасть в запрос"
  );

  // Значения вне списка игнорируются.
  supabaseCalls = [];
  await onRequest({ request: request("GET", { cookie, query: "?source=чужое" }), env: ENV });
  assert.ok(
    !supabaseCalls.some((call) => call.url.includes("source=eq.")),
    "чуждый источник не должен попадать в запрос"
  );
});

await test("фильтр по услуге и по «не выбрана»", async () => {
  seedLeads();
  const cookie = await login();

  supabaseCalls = [];
  await onRequest({
    request: request("GET", { cookie, query: "?service=" + encodeURIComponent("Диагностика") }),
    env: ENV
  });
  assert.ok(
    supabaseCalls.some((call) => call.url.includes("service=eq.")),
    "выбранная услуга должна попасть в запрос"
  );

  supabaseCalls = [];
  await onRequest({ request: request("GET", { cookie, query: "?service=none" }), env: ENV });

  // «Не выбрана» бывает двух видов: пусто в базе и строка от сайта.
  const emptyQuery = readableUrl(
    supabaseCalls.find((call) => call.url.includes("/rest/v1/leads"))?.url || ""
  );
  assert.match(emptyQuery, /service\.is\.null/, "должна быть проверка пустого значения");
  assert.match(emptyQuery, /service\.eq\.Не выбрана/, "и строка, которой сайт помечает заявку");
});

await test("поиск по имени и телефону уходит в запрос", async () => {
  seedLeads();
  const cookie = await login();
  supabaseCalls = [];

  await onRequest({ request: request("GET", { cookie, query: "?q=Иван" }), env: ENV });

  const query = supabaseCalls.find((call) => call.url.includes("/rest/v1/leads"))?.url || "";
  assert.match(query, /name\.ilike/, "должен быть поиск по имени");
  assert.match(query, /phone\.ilike/, "должен быть поиск по телефону");
});

await test("опасные символы в поиске не ломают запрос", async () => {
  seedLeads();
  const cookie = await login();
  supabaseCalls = [];

  await onRequest({
    request: request("GET", { cookie, query: "?q=" + encodeURIComponent("Иван,status.eq.completed") }),
    env: ENV
  });

  const query = supabaseCalls.find((call) => call.url.includes("/rest/v1/leads"))?.url || "";
  assert.doesNotMatch(query, /status\.eq\.completed/, "скобки и запятые должны вычищаться");
});

await test("произвольный промежуток дат уходит в запрос", async () => {
  seedLeads();
  const cookie = await login();
  supabaseCalls = [];

  await onRequest({
    request: request("GET", { cookie, query: "?from=2026-10-01&to=2026-10-07" }),
    env: ENV
  });

  const query = supabaseCalls.find((call) => call.url.includes("/rest/v1/leads"))?.url || "";
  const decoded = decodeURIComponent(query);
  assert.match(decoded, /created_at=gte\.2026-10-01T00:00:00/, "должна быть нижняя граница");
  assert.match(decoded, /created_at=lte\.2026-10-07T23:59:59/, "должна быть верхняя граница включительно");
});

await test("некорректные даты игнорируются", async () => {
  seedLeads();
  const cookie = await login();
  supabaseCalls = [];

  await onRequest({
    request: request("GET", { cookie, query: "?from=вчера&to=2026-99-99" }),
    env: ENV
  });

  const query = supabaseCalls.find((call) => call.url.includes("/rest/v1/leads"))?.url || "";
  assert.doesNotMatch(decodeURIComponent(query), /created_at=/, "фильтр по датам не должен применяться");
});

await test("фильтры и сортировка работают вместе", async () => {
  seedLeads();
  const cookie = await login();
  supabaseCalls = [];

  await onRequest({
    request: request("GET", {
      cookie,
      query: "?status=new&source=website&sort=name&dir=asc&from=2026-10-01"
    }),
    env: ENV
  });

  const decoded = decodeURIComponent(
    supabaseCalls.find((call) => call.url.includes("/rest/v1/leads"))?.url || ""
  );
  assert.match(decoded, /status=eq\.new/);
  assert.match(decoded, /source=eq\.website/);
  assert.match(decoded, /order=name\.asc/);
  assert.match(decoded, /created_at=gte\.2026-10-01/);
});

await test("справочник услуг отдаётся для фильтра админки", async () => {
  seedLeads();
  const cookie = await login();

  const response = await onRequest({
    request: request("GET", { cookie, query: "?facets=1" }),
    env: ENV
  });

  const payload = await response.json();
  const labels = (payload.catalog || []).map((item) => item.label);

  assert.equal(response.status, 200);
  assert.ok(labels.includes("Диагностика — 500 руб."), "услуга из справочника должна быть в списке");
  assert.ok(labels.some((label) => label.startsWith("Скрытая")), "выключенные услуги тоже видны в фильтре");
});

await test("справочник услуг для фильтра отдаётся отдельно", async () => {
  seedLeads();
  const cookie = await login();

  const response = await onRequest({
    request: request("GET", { cookie, query: "?facets=1" }),
    env: ENV
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.services, ["Не выбрана", "Термопаста"], "услуги без повторов и пустых");
  assert.equal(payload.hasEmpty, true, "должно быть отмечено, что есть заявки без услуги");
});

await test("источник «Личный кабинет» доступен для фильтра", async () => {
  // Раньше источник account не был в списке разрешённых, поэтому фильтр
  // по нему молча игнорировался.
  assert.ok(SOURCES.includes("account"), "account должен быть среди источников");

  seedLeads();
  const cookie = await login();
  supabaseCalls = [];

  await onRequest({ request: request("GET", { cookie, query: "?source=account" }), env: ENV });

  const query = readableUrl(
    supabaseCalls.find((call) => call.url.includes("/rest/v1/leads"))?.url || ""
  );
  assert.match(query, /source=eq\.account/, "фильтр по личному кабинету должен уходить в базу");
});

await test("справочник источников отдаётся с подписями", async () => {
  seedLeads();
  const cookie = await login();

  const response = await onRequest({
    request: request("GET", { cookie, query: "?facets=1" }),
    env: ENV
  });

  const payload = await response.json();
  const labels = Object.fromEntries(payload.sources.map((s) => [s.value, s.label]));

  assert.equal(labels.account, "Личный кабинет");
  assert.equal(labels.website, "Сайт");
  assert.equal(payload.sources.length, 4, "четыре источника");
});

await test("справочник услуг сужается выбранным источником", async () => {
  seedLeads();
  const cookie = await login();
  supabaseCalls = [];

  await onRequest({
    request: request("GET", { cookie, query: "?facets=1&source=mini_app" }),
    env: ENV
  });

  const query = readableUrl(
    supabaseCalls.find((call) => call.url.includes("select=service"))?.url || ""
  );
  assert.match(query, /source=eq\.mini_app/, "услуги должны фильтроваться по источнику");
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

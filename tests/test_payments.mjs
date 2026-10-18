// Тесты онлайн-оплаты через ЮKassa.
//
// Проверяем главное: сумму считает только сервер по каталогу услуг, чужую
// заявку оплатить нельзя, повторная оплата запрещена, а статус оплаты
// приходит лишь из проверенного ответа ЮKassa и не влияет на статус ремонта.

import assert from "node:assert/strict";

import { onRequest as pay } from "../functions/api/me/pay.js";
import { onRequest as checkPayment } from "../functions/api/me/payments.js";
import { onRequest as webhook } from "../functions/api/payments/yookassa.js";

// --- Заглушки -------------------------------------------------------------

// Заявки в «базе».
let leads = [];
// Каталог услуг: по нему считается сумма.
let services = [];
// Обращения к ЮKassa.
let yookassaCalls = [];
// Что вернёт ЮKassa на чтение платежа.
let yookassaStatus = "pending";
let yookassaAmount = null;
// Созданные платежи по ключу идемпотентности: нужны для проверки повторов.
const createdPayments = new Map();
let serial = 0;
// Пользователь, чей токен считаем действующим.
let currentUser = null;

const ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_PUBLISHABLE_KEY: "pub-key",
  SUPABASE_SECRET_KEY: "secret-key",
  YOOKASSA_SHOP_ID: "123456",
  YOOKASSA_SECRET_KEY: "test_secret",
  YOOKASSA_API_URL: "https://yookassa.test/v3",
  ADMIN_KEY: "admin-test-key",
  SITE_URL: "https://it-doctor.test"
};

function reset({ leadList = [], serviceList = [], user = { id: "user-1" } } = {}) {
  leads = leadList.map((lead) => ({ ...lead }));
  services = serviceList.map((service) => ({ ...service }));
  yookassaCalls = [];
  yookassaStatus = "pending";
  yookassaAmount = null;
  createdPayments.clear();
  serial = 0;
  currentUser = user;
}

/** Заглушка всей внешней сети: Supabase Auth, база и ЮKassa. */
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  const method = options.method || "GET";
  const body = options.body ? JSON.parse(options.body) : {};

  // Проверка токена клиента.
  if (target.includes("/auth/v1/user")) {
    if (!currentUser) {
      return new Response(JSON.stringify({ message: "invalid token" }), { status: 401 });
    }

    return new Response(JSON.stringify({
      id: currentUser.id,
      email: "client@test.ru",
      user_metadata: { name: "Клиент", phone: "+7 (900) 000-00-00" }
    }), { status: 200 });
  }

  // Каталог услуг.
  if (target.includes("/rest/v1/services")) {
    const parsed = new URL(target);
    const idFilter = parsed.searchParams.get("id")?.replace("eq.", "");

    if (idFilter) {
      return new Response(JSON.stringify(services.filter((s) => s.id === idFilter)), { status: 200 });
    }

    return new Response(JSON.stringify(services), { status: 200 });
  }

  // Заявки.
  if (target.includes("/rest/v1/leads")) {
    const parsed = new URL(target);

    if (method === "GET") {
      const id = parsed.searchParams.get("id")?.replace("eq.", "");
      const owner = parsed.searchParams.get("user_id")?.replace("eq.", "");
      const paymentId = parsed.searchParams.get("payment_id")?.replace("eq.", "");

      let rows = [...leads];
      if (id) rows = rows.filter((lead) => lead.id === id);
      if (owner) rows = rows.filter((lead) => lead.user_id === owner);
      if (paymentId) rows = rows.filter((lead) => lead.payment_id === paymentId);

      return new Response(JSON.stringify(rows), { status: 200 });
    }

    if (method === "PATCH") {
      const id = parsed.searchParams.get("id")?.replace("eq.", "");
      const lead = leads.find((item) => item.id === id);

      if (!lead) return new Response("[]", { status: 200 });

      Object.assign(lead, body);
      return new Response(JSON.stringify([lead]), { status: 200 });
    }
  }

  // ЮKassa: создание платежа и чтение платежа.
  if (target.includes("/v3/payments")) {
    const isCreate = !/\/v3\/payments\/[^/?]+/.test(target);

    yookassaCalls.push({ method, url: target, body: isCreate ? body : null });

    if (isCreate) {
      // Повтор с тем же ключом идемпотентности возвращает тот же платёж,
      // но ссылку ЮKassa выдаёт свежую — так она и работает на самом деле.
      const key = String(body?.idempotencyKey || options.headers?.["Idempotence-Key"] || "");
      const existing = createdPayments.get(key);

      if (existing) {
        const url = `https://yookassa.test/pay/${existing.serial}`;
        return new Response(JSON.stringify({
          id: existing.id,
          status: "pending",
          paid: false,
          amount: { value: existing.amount, currency: "RUB" },
          confirmation: { type: "redirect", confirmation_url: url },
          captured_at: null
        }), { status: 200 });
      }

      serial += 1;
      const payment = {
        id: `pay-test-${serial}`,
        amount: String(body?.amount?.value || "0.00"),
        serial
      };

      createdPayments.set(key, payment);

      return new Response(JSON.stringify({
        id: payment.id,
        status: "pending",
        paid: false,
        amount: { value: payment.amount, currency: "RUB" },
        confirmation: { type: "redirect", confirmation_url: `https://yookassa.test/pay/${serial}` },
        captured_at: null
      }), { status: 200 });
    }

    const amount = String(yookassaAmount ?? "1000.00");
    const status = yookassaStatus;

    return new Response(JSON.stringify({
      id: "pay-test-1",
      status,
      paid: status === "succeeded",
      amount: { value: amount, currency: "RUB" },
      captured_at: "2026-10-14T12:00:00.000Z",
      metadata: body?.metadata || {}
    }), { status: 200 });
  }

  throw new Error(`неожиданный запрос: ${target}`);
};

// --- Помощники ------------------------------------------------------------

let failed = 0;
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  OK     ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ПРОВАЛ ${name}: ${error.message}`);
  }
}

function request(body, { token = "client-token", cookie = "", method = "POST" } = {}) {
  const headers = { "Content-Type": "application/json" };

  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;

  return new Request("https://it-doctor.test/api", {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(body) : undefined
  });
}

/** Заявка клиента с фиксированной оплачиваемой услугой. */
function paidLead(overrides = {}) {
  return {
    id: "lead-1",
    user_id: "user-1",
    service: "Замена термопасты",
    service_id: "svc-fixed",
    message: "текст",
    source: "account",
    status: "new",
    payment_id: null,
    payment_status: null,
    payment_amount: null,
    paid_at: null,
    ...overrides
  };
}

const FIXED_SERVICE = {
  id: "svc-fixed",
  title: "Замена термопасты",
  price_value: 1000,
  is_active: true
};

// Услуга с переименованием: в заявке название чуть другое.
const WINDOWS_SERVICE = {
  id: "svc-windows",
  title: "Установка Windows или ПО",
  price_value: 3500,
  is_active: true
};

// Услуга без цены: оплатить нельзя.
const NO_PRICE_SERVICE = {
  id: "svc-no-price",
  title: "Замена аккумулятора",
  price_value: 0,
  is_active: true
};

// --- Создание оплаты ------------------------------------------------------

await test("сумму считает сервер по каталогу услуг", async () => {
  reset({ leadList: [paidLead()], serviceList: [FIXED_SERVICE] });

  const response = await pay({ request: request({ leadId: "lead-1" }), env: ENV });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.amount, 1000);

  // В ЮKassa должна уйти именно серверная сумма.
  const created = yookassaCalls.find((call) => call.method === "POST");
  assert.equal(created.body.amount.value, "1000.00");
  assert.equal(created.body.amount.currency, "RUB");
});

await test("сумму из запроса клиента сервер игнорирует", async () => {
  reset({ leadList: [paidLead()], serviceList: [FIXED_SERVICE] });

  // Клиент пытается навязать свою сумму и свою услугу.
  const response = await pay({
    request: request({ leadId: "lead-1", amount: 1, price_value: 1, service_id: "svc-from" }),
    env: ENV
  });
  const payload = await response.json();

  assert.equal(payload.amount, 1000, "должна использоваться цена каталога");

  const created = yookassaCalls.find((call) => call.method === "POST");
  assert.equal(created.body.amount.value, "1000.00", "в ЮKassa не должна уйти сумма клиента");
});

await test("заявка без связи оплачивается после сопоставления по названию", async () => {
  // Владелец переименовал услугу после создания заявки, поэтому связи нет.
  // Сервер находит услугу по словам и запоминает связь.
  reset({
    leadList: [paidLead({
      service_id: null,
      service: "Установка Windows или другого ПО"
    })],
    serviceList: [WINDOWS_SERVICE]
  });

  const response = await pay({ request: request({ leadId: "lead-1" }), env: ENV });
  const payload = await response.json();

  assert.equal(response.status, 200, "оплата должна создаться");
  assert.equal(payload.amount, 3500);

  const lead = leads.find((item) => item.id === "lead-1");
  assert.equal(lead.service_id, "svc-windows", "связь должна запомниться");
});

await test("непонятное название услуги не оплачивается", async () => {
  reset({
    leadList: [paidLead({ service_id: null, service: "Что-то совсем другое" })],
    serviceList: [WINDOWS_SERVICE, FIXED_SERVICE]
  });

  const response = await pay({ request: request({ leadId: "lead-1" }), env: ENV });
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.notPayable, true);
  assert.equal(yookassaCalls.length, 0);
});

await test("услугу без цены оплатить нельзя", async () => {
  reset({
    leadList: [paidLead({ service_id: "svc-no-price", service: "Замена аккумулятора" })],
    serviceList: [NO_PRICE_SERVICE]
  });

  const response = await pay({ request: request({ leadId: "lead-1" }), env: ENV });
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.notPayable, true);
  assert.match(payload.error, /цена/i);
  assert.equal(yookassaCalls.length, 0, "платёж создавать нельзя");
});

await test("услугу с выключенной активностью оплатить нельзя", async () => {
  reset({
    leadList: [paidLead()],
    serviceList: [{ ...FIXED_SERVICE, is_active: false }]
  });

  const response = await pay({ request: request({ leadId: "lead-1" }), env: ENV });

  assert.equal(response.status, 409);
  assert.equal(yookassaCalls.length, 0);
});

await test("чужую заявку оплатить нельзя", async () => {
  reset({ leadList: [paidLead({ user_id: "user-2" })], serviceList: [FIXED_SERVICE] });

  const response = await pay({ request: request({ leadId: "lead-1" }), env: ENV });

  assert.equal(response.status, 404, "чужая заявка не должна находиться");
  assert.equal(yookassaCalls.length, 0);
});

await test("без входа оплата недоступна", async () => {
  reset({ leadList: [paidLead()], serviceList: [FIXED_SERVICE], user: null });

  const response = await pay({ request: request({ leadId: "lead-1" }), env: ENV });

  assert.equal(response.status, 401);
  assert.equal(yookassaCalls.length, 0);
});

await test("уже оплаченную заявку оплатить нельзя", async () => {
  reset({
    leadList: [paidLead({ payment_id: "pay-test-1", payment_status: "succeeded", payment_amount: 1000 })],
    serviceList: [FIXED_SERVICE]
  });

  const response = await pay({ request: request({ leadId: "lead-1" }), env: ENV });
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.alreadyPaid, true);
  assert.equal(yookassaCalls.length, 0, "второй платёж создавать нельзя");
});

await test("при создании платежа данные сохраняются в заявке", async () => {
  reset({ leadList: [paidLead()], serviceList: [FIXED_SERVICE] });

  await pay({ request: request({ leadId: "lead-1" }), env: ENV });

  const lead = leads.find((item) => item.id === "lead-1");
  assert.equal(lead.payment_id, "pay-test-1");
  assert.equal(lead.payment_status, "pending");
  assert.equal(lead.payment_amount, 1000);
  assert.equal(lead.status, "new", "статус ремонта меняться не должен");
});

await test("после прерванной оплаты ссылка выдаётся заново", async () => {
  // Клиент начал оплату и ушёл. Сохранённая ссылка ЮKassa со временем
  // перестаёт работать, поэтому по кнопке «Перейти к оплате» ссылку
  // запрашиваем заново, а не отдаём старую.
  reset({
    leadList: [paidLead({
      payment_id: "pay-test-1",
      payment_status: "pending",
      payment_amount: 1000,
      payment_url: "https://yookassa.test/pay/stale"
    })],
    serviceList: [FIXED_SERVICE]
  });

  const response = await pay({ request: request({ leadId: "lead-1" }), env: ENV });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.ok(payload.paymentUrl, "ссылка на оплату должна быть");
  assert.notEqual(payload.paymentUrl, "https://yookassa.test/pay/stale", "старая ссылка не должна использоваться");

  const created = yookassaCalls.filter((call) => call.method === "POST");
  assert.equal(created.length, 1, "к ЮKassa должен уйти запрос за свежей ссылкой");
});

await test("повторное нажатие не создаёт второй платёж в ЮKassa", async () => {
  // Два нажатия подряд: ключ идемпотентности одинаковый, значит ЮKassa
  // вернёт тот же платёж, а не создаст второй.
  reset({ leadList: [paidLead()], serviceList: [FIXED_SERVICE] });

  const first = await (await pay({ request: request({ leadId: "lead-1" }), env: ENV })).json();
  const second = await (await pay({ request: request({ leadId: "lead-1" }), env: ENV })).json();

  assert.equal(first.paymentId, second.paymentId, "платёж должен быть один и тот же");
  assert.ok(first.paymentUrl && second.paymentUrl, "обе попытки должны получить ссылку");
});

// --- Вебхук ---------------------------------------------------------------

await test("вебхук подтверждает оплату по ответу ЮKassa", async () => {
  reset({
    leadList: [paidLead({ payment_id: "pay-test-1", payment_status: "pending", payment_amount: 1000 })],
    serviceList: [FIXED_SERVICE]
  });

  yookassaStatus = "succeeded";
  yookassaAmount = "1000.00";

  const response = await webhook({
    request: request({ event: "payment.succeeded", object: { id: "pay-test-1" } }, { token: "" }),
    env: ENV
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.applied, "updated");

  const lead = leads.find((item) => item.id === "lead-1");
  assert.equal(lead.payment_status, "succeeded");
  assert.ok(lead.paid_at, "должна появиться дата оплаты");
  assert.equal(lead.status, "new", "статус ремонта не должен меняться");
});

await test("вебхук с поддельным статусом не проходит", async () => {
  reset({
    leadList: [paidLead({ payment_id: "pay-test-1", payment_status: "pending", payment_amount: 1000 })],
    serviceList: [FIXED_SERVICE]
  });

  // В уведомлении написано «оплачено», но ЮKassa отвечает «ожидает оплаты».
  yookassaStatus = "pending";
  yookassaAmount = "1000.00";

  const response = await webhook({
    request: request({ event: "payment.succeeded", object: { id: "pay-test-1" } }, { token: "" }),
    env: ENV
  });

  assert.equal(response.status, 409, "событие не должно совпасть со статусом");

  const lead = leads.find((item) => item.id === "lead-1");
  assert.equal(lead.payment_status, "pending", "статус не должен меняться");
});

await test("вебхук не записывает оплату при несовпадении суммы", async () => {
  reset({
    leadList: [paidLead({ payment_id: "pay-test-1", payment_status: "pending", payment_amount: 1000 })],
    serviceList: [FIXED_SERVICE]
  });

  // ЮKassa сообщает про другой платёж на другую сумму.
  yookassaStatus = "succeeded";
  yookassaAmount = "1.00";

  const response = await webhook({
    request: request({ event: "payment.succeeded", object: { id: "pay-test-1" } }, { token: "" }),
    env: ENV
  });
  const payload = await response.json();

  assert.equal(payload.applied, "amount_mismatch");

  const lead = leads.find((item) => item.id === "lead-1");
  assert.equal(lead.payment_status, "pending", "оплата не должна подтвердиться");
});

await test("вебхук отвечает 200 на чужой платёж, чтобы не было повторов", async () => {
  reset({ leadList: [paidLead()], serviceList: [FIXED_SERVICE] });

  yookassaStatus = "succeeded";

  const response = await webhook({
    request: request({ event: "payment.succeeded", object: { id: "pay-чужой" } }, { token: "" }),
    env: ENV
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.applied, "lead_not_found");
});

await test("повторный вебхук не меняет уже оплаченную заявку", async () => {
  reset({
    leadList: [paidLead({
      payment_id: "pay-test-1",
      payment_status: "succeeded",
      payment_amount: 1000,
      paid_at: "2026-10-14T12:00:00.000Z"
    })],
    serviceList: [FIXED_SERVICE]
  });

  yookassaStatus = "succeeded";
  yookassaAmount = "1000.00";

  const response = await webhook({
    request: request({ event: "payment.succeeded", object: { id: "pay-test-1" } }, { token: "" }),
    env: ENV
  });
  const payload = await response.json();

  assert.equal(payload.applied, "already_paid");

  const lead = leads.find((item) => item.id === "lead-1");
  assert.equal(lead.paid_at, "2026-10-14T12:00:00.000Z", "дата оплаты не должна перезаписываться");
});

// --- Проверка оплаты ------------------------------------------------------

await test("проверка оплаты обновляет статус заявки клиента", async () => {
  reset({
    leadList: [paidLead({ payment_id: "pay-test-1", payment_status: "pending", payment_amount: 1000 })],
    serviceList: [FIXED_SERVICE]
  });

  yookassaStatus = "succeeded";
  yookassaAmount = "1000.00";

  const response = await checkPayment({ request: request({ leadId: "lead-1" }), env: ENV });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.changed, true);
  assert.equal(payload.paymentStatus, "succeeded");
  assert.equal(payload.paymentStatusLabel, "Оплачено");

  const lead = leads.find((item) => item.id === "lead-1");
  assert.equal(lead.status, "new", "статус ремонта не должен меняться");
});

await test("проверка оплаты не трогает чужую заявку", async () => {
  reset({
    leadList: [paidLead({ user_id: "user-2", payment_id: "pay-test-1" })],
    serviceList: [FIXED_SERVICE]
  });

  const response = await checkPayment({ request: request({ leadId: "lead-1" }), env: ENV });

  assert.equal(response.status, 404);
});

await test("без ключей ЮKassa оплата честно сообщает о ненастроенности", async () => {
  reset({ leadList: [paidLead()], serviceList: [FIXED_SERVICE] });

  const response = await pay({
    request: request({ leadId: "lead-1" }),
    env: { ...ENV, YOOKASSA_SHOP_ID: "", YOOKASSA_SECRET_KEY: "" }
  });
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.match(payload.error, /не настроен/i);
});

console.log(`\nИтог: пройдено ${passed}, провалено ${failed}`);
process.exit(failed === 0 ? 0 : 1);

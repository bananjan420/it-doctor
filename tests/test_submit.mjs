// Тесты Cloudflare-функции приёма заявок.
//
// Запуск (из корня проекта):
//     node it-doktor/tests/test_submit.mjs
//
// Сеть не используется: fetch подменяется заглушкой. Проверяем, что
// в базу уходит правильная строка, источник не подделывается, а уведомление
// в Telegram работает даже тогда, когда база недоступна.

import assert from "node:assert/strict";

const MODULE_PATH = new URL("../functions/api/submit.js", import.meta.url).href;

const ENV = {
  BOT_TOKEN: "123:TEST",
  CHAT_ID: "-100500",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_TEST"
};

let calls = [];
let dbMode = "ok";

globalThis.fetch = async (url, options) => {
  const target = String(url);
  calls.push({ target, options });

  if (target.includes("/rest/v1/leads")) {
    if (dbMode === "down") throw new TypeError("network down");
    if (dbMode === "rejected") return new Response("bad request", { status: 400 });
    return new Response("", { status: 201 });
  }

  return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
};

const { onRequest } = await import(MODULE_PATH);

async function submit(body, env = ENV) {
  calls = [];
  const response = await onRequest({
    request: new Request("https://it-doctor.pages.dev/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }),
    env
  });
  return {
    status: response.status,
    payload: await response.json(),
    lead: calls.find((call) => call.target.includes("/rest/v1/leads")),
    telegram: calls.find((call) => call.target.includes("api.telegram.org"))
  };
}

function leadRow(result) {
  assert.ok(result.lead, "запись в базу должна быть");
  return JSON.parse(result.lead.options.body);
}

function telegramText(result) {
  assert.ok(result.telegram, "уведомление в Telegram должно быть");
  return JSON.parse(result.telegram.options.body).text;
}

let passed = 0;
let failed = 0;

async function test(name, body) {
  try {
    await body();
    console.log(`  OK     ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  ПРОВАЛ ${name}: ${error.message}`);
    failed += 1;
  }
}

console.log("Тесты приёма заявок\n");

await test("заявка с сайта сохраняется как website со статусом new", async () => {
  const result = await submit({ name: "Иван", phone: "+7 (999) 123-45-67", message: "Шумит" });
  const row = leadRow(result);
  assert.equal(result.status, 200);
  assert.deepEqual(
    { source: row.source, status: row.status, message: row.message },
    { source: "website", status: "new", message: "Шумит" }
  );
  assert.equal(result.lead.options.headers.Prefer, "return=minimal");
});

await test("заявка из Mini App помечается как mini_app", async () => {
  const result = await submit({
    name: "Мария", phone: "+7 (999) 111-22-33", service: "Чистка — 1500",
    source: "mini_app", telegramUser: { id: 987654321, username: "maria" }
  });
  const row = leadRow(result);
  assert.equal(row.source, "mini_app");
  assert.equal(row.status, "new");
  assert.equal(row.telegram_user_id, 987654321);
});

await test("старая страница Mini App ('Telegram Mini App') тоже распознаётся", async () => {
  const result = await submit({
    name: "Пётр", phone: "+7 (999) 222-33-44", source: "Telegram Mini App"
  });
  assert.equal(leadRow(result).source, "mini_app");
});

await test("подделка источника не проходит", async () => {
  const result = await submit({
    name: "Кто-то", phone: "+7 (999) 000-00-00", source: "mini_app_подделка"
  });
  assert.equal(leadRow(result).source, "website");
});

await test("текст уведомления сохраняет источник и данные", async () => {
  const result = await submit({
    name: "Мария", phone: "+7 (999) 111-22-33", service: "Диагностика — 500",
    source: "mini_app", telegramUser: { id: 42, username: "maria" }
  });
  const text = telegramText(result);
  assert.match(text, /Источник:<\/b> Telegram Mini App/);
  assert.match(text, /Имя:<\/b> Мария/);
  assert.match(text, /@maria/);
  assert.doesNotMatch(text, /не сохранилась/);
});

await test("при сбое базы заявка всё равно уходит в Telegram с пометкой", async () => {
  dbMode = "down";
  const result = await submit({ name: "Ольга", phone: "+7 (999) 555-66-77" });
  dbMode = "ok";
  assert.equal(result.status, 200, "клиент не должен видеть ошибку, заявка доставлена");
  assert.match(telegramText(result), /В базу заявка не сохранилась/);
});

await test("отказ базы (HTTP 400) тоже не теряет заявку", async () => {
  dbMode = "rejected";
  const result = await submit({ name: "Ольга", phone: "+7 (999) 555-66-77" });
  dbMode = "ok";
  assert.match(telegramText(result), /В базу заявка не сохранилась/);
});

await test("клиентские поля обрезаются под ограничения таблицы", async () => {
  const result = await submit({
    name: "я".repeat(200), phone: "+7".padEnd(90, "0"), message: "м".repeat(6000)
  });
  const row = leadRow(result);
  assert.equal(row.name.length, 100);
  assert.equal(row.phone.length, 50);
  assert.equal(row.message.length, 5000);
});

await test("пустое имя отклоняется и в базу ничего не пишется", async () => {
  const result = await submit({ name: "   ", phone: "+7 (999) 123-45-67" });
  assert.equal(result.status, 422);
  assert.equal(result.lead, undefined);
  assert.equal(result.telegram, undefined);
});

await test("GET отклоняется", async () => {
  calls = [];
  const response = await onRequest({
    request: new Request("https://it-doctor.pages.dev/api/submit", { method: "GET" }),
    env: ENV
  });
  assert.equal(response.status, 405);
});

await test("без ключей Supabase заявка всё равно доставляется в Telegram", async () => {
  const result = await submit(
    { name: "Иван", phone: "+7 (999) 123-45-67" },
    { BOT_TOKEN: ENV.BOT_TOKEN, CHAT_ID: ENV.CHAT_ID }
  );
  assert.equal(result.status, 200);
  assert.equal(result.lead, undefined, "без ключей записи в базу быть не должно");
  assert.match(telegramText(result), /В базу заявка не сохранилась/);
});

console.log(`\nИтог: пройдено ${passed}, провалено ${failed}`);
process.exit(failed === 0 ? 0 : 1);

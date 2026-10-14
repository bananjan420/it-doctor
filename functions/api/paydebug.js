// Временная проверка окружения. Значения не показываем — только длину и тип.
import { json } from "./_lib/auth.js";

function describe(value) {
  if (value === undefined) return "нет переменной";
  if (value === null) return "null";
  return `тип ${typeof value}, длина ${String(value).length}`;
}

export async function onRequest({ env }) {
  return json(200, {
    ok: true,
    vars: {
      SITE_URL: describe(env.SITE_URL),
      YOOKASSA_SHOP_ID: describe(env.YOOKASSA_SHOP_ID),
      YOOKASSA_SECRET_KEY: describe(env.YOOKASSA_SECRET_KEY),
      ADMIN_KEY: describe(env.ADMIN_KEY),
      SUPABASE_PUBLISHABLE_KEY: describe(env.SUPABASE_PUBLISHABLE_KEY),
      BOT_TOKEN: describe(env.BOT_TOKEN)
    },
    deployment: {
      branch: env.CF_PAGES_BRANCH || "",
      commit: (env.CF_PAGES_COMMIT_SHA || "").slice(0, 8),
      url: env.CF_PAGES_URL || ""
    }
  });
}

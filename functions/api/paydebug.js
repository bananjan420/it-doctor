// Временная проверка окружения: имена переменных и заполнены ли они.
// Значения не показываем. Файл будет удалён сразу после проверки.
import { json } from "./_lib/auth.js";

export async function onRequest({ env }) {
  const names = Object.keys(env || {}).sort();

  return json(200, {
    ok: true,
    names,
    yookassa: {
      shop: Boolean(env.YOOKASSA_SHOP_ID?.trim()),
      secret: Boolean(env.YOOKASSA_SECRET_KEY?.trim()),
      siteUrl: env.SITE_URL || ""
    }
  });
}

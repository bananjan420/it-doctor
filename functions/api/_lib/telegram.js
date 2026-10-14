// Уведомление владельцу в Telegram.
//
// Общий модуль для всех источников заявок: сайта, Mini App и личного кабинета.
// Токен бота и чат владельца берутся только из переменных окружения.
//
// Уведомление никогда не должно ломать приём заявки: при любой ошибке функция
// возвращает false, а заявка остаётся сохранённой в базе.

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_TIMEOUT_MS = 10000;

/** Экранирует значения для HTML-разметки Telegram. */
export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Время заявки в московском времени: «7 окт. 2026 г., 15:04». */
function moscowTime(date = new Date()) {
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Europe/Moscow"
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * Отправляет владельцу сообщение о новой заявке.
 *
 * Параметры:
 *   env        — окружение функции (BOT_TOKEN, CHAT_ID)
 *   name, phone, service, message — данные заявки
 *   sourceLabel — человекочитаемый источник: Сайт, Telegram Mini App, Личный кабинет
 *   saved      — сохранилась ли заявка в базу
 *   telegramUser — данные клиента из Telegram, если есть
 */
export async function notifyOwner(env, lead) {
  const botToken = env.BOT_TOKEN?.trim();
  const chatId = env.CHAT_ID?.trim();

  if (!botToken || !chatId) {
    console.error("BOT_TOKEN or CHAT_ID is not configured: notification skipped");
    return false;
  }

  const {
    name = "",
    phone = "",
    service = "",
    message = "",
    sourceLabel = "Сайт",
    saved = true,
    telegramUser = null
  } = lead;

  const lines = [
    "<b>📩 НОВАЯ ЗАЯВКА</b>",
    "",
    `🕐 ${escapeHtml(moscowTime())}`,
    `📍 <b>Источник:</b> ${escapeHtml(sourceLabel)}`,
    `👤 <b>Имя:</b> ${escapeHtml(name)}`,
    `📞 <b>Телефон:</b> ${escapeHtml(phone)}`,
    `🛠 <b>Услуга:</b> ${escapeHtml(service)}`,
    `📝 <b>Сообщение:</b> ${escapeHtml(message)}`
  ];

  if (telegramUser) {
    lines.push(
      `💬 <b>Telegram:</b> ${
        telegramUser.username ? `@${escapeHtml(String(telegramUser.username))}` : "username не указан"
      }`,
      `🆔 <b>User ID:</b> <code>${escapeHtml(String(telegramUser.id || "не указан"))}</code>`
    );
  }

  if (!saved) {
    lines.push("", "⚠️ <i>В базу заявка не сохранилась — проверьте настройки Supabase.</i>");
  }

  try {
    const response = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      body: JSON.stringify({
        chat_id: chatId,
        text: lines.join("\n"),
        parse_mode: "HTML"
      })
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok || !result.ok) {
      console.error("Telegram rejected the notification", {
        status: response.status,
        errorCode: result.error_code
      });
      return false;
    }

    return true;
  } catch (error) {
    console.error("Telegram request failed", { reason: error?.name || "unknown" });
    return false;
  }
}

// Общие правила оплаты: что можно оплатить, сколько и как называется статус.
//
// Модуль общий для кабинета, админки и вебхука, чтобы правила не разъезжались.
// Сумма всегда считается здесь, на сервере, по каталогу услуг.

// Значения совпадают со статусами платежа ЮKassa.
export const PAYMENT_STATUS_LABELS = {
  pending: "Ожидает оплаты",
  waiting_for_capture: "Ожидает подтверждения",
  succeeded: "Оплачено",
  canceled: "Платёж отменён"
};

/** Человеческое название статуса оплаты. */
export function paymentStatusLabel(status) {
  return PAYMENT_STATUS_LABELS[status] || "Не оплачено";
}

/** Оплачен ли уже платёж. */
export function isPaid(status) {
  return status === "succeeded";
}

/** Идёт ли оплата прямо сейчас: повторно создавать платёж не нужно. */
export function isPending(status) {
  return status === "pending" || status === "waiting_for_capture";
}

/**
 * Можно ли оплатить услугу и сколько.
 *
 * У всех услуг в каталоге цена фиксированная и хранится числом, поэтому
 * оплатить можно любую — были бы цена и активность.
 *
 * Возвращает { payable, amount, reason }:
 *   payable — можно ли создавать платёж;
 *   amount  — сумма в рублях, посчитанная по каталогу;
 *   reason  — почему нельзя, чтобы показать клиенту понятный текст.
 */
export function payableAmount(service) {
  if (!service) {
    return { payable: false, amount: 0, reason: "Услуга не найдена в каталоге." };
  }

  if (service.is_active === false) {
    return { payable: false, amount: 0, reason: "Услуга больше не оказывается." };
  }

  const amount = Number(service.price_value);

  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      payable: false,
      amount: 0,
      reason: "У услуги не указана цена — оплата недоступна."
    };
  }

  return { payable: true, amount, reason: "" };
}

/** Поля оплаты, которые можно отдавать в браузер. */
export function paymentFields(lead) {
  return {
    paymentId: lead.payment_id || "",
    paymentStatus: lead.payment_status || "",
    paymentStatusLabel: paymentStatusLabel(lead.payment_status),
    paymentAmount: lead.payment_amount ?? null,
    paidAt: lead.paid_at || null
  };
}

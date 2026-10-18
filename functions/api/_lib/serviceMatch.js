// Сопоставление названия услуги из заявки с каталогом.
//
// Заявка хранит название услуги текстом на момент создания. Со временем
// владелец может переименовать услугу в каталоге, и точного совпадения уже
// не будет. Поэтому сравниваем мягко: по словам, без знаков и регистра.
//
// Совпадение должно быть однозначным. Если подходят две услуги, лучше не
// связывать вовсе: сумма платежа считается по каталогу, и угадывать цену
// нельзя.

/** Приводит название к сравнимому виду: нижний регистр, без знаков, ё → е. */
export function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Слова длиной от трёх символов: короткие предлоги не помогают сравнению. */
function words(value) {
  return normalizeTitle(value)
    .split(" ")
    .filter((word) => word.length >= 3);
}

/** Насколько похожи две строки: от 0 до 1 по общим словам. */
export function matchScore(left, right) {
  const a = words(left);
  const b = words(right);

  if (a.length === 0 || b.length === 0) {
    return 0;
  }

  const setA = new Set(a);
  const setB = new Set(b);

  let shared = 0;
  for (const word of setA) {
    if (setB.has(word)) shared += 1;
  }

  // Доля общих слов от большего набора: «лишнее» слово в названии заявки
  // не должно мешать совпадению.
  return shared / Math.max(setA.size, setB.size);
}

// Порог совпадения: ниже него услуги считаем разными.
const MATCH_THRESHOLD = 0.6;

/**
 * Ищет услугу каталога по названию из заявки.
 *
 * rows — список услуг каталога: [{ id, title }].
 * Возвращает id услуги или null, если совпадение неоднозначное.
 */
export function findServiceId(rows, serviceLabel) {
  const label = String(serviceLabel || "").trim();

  if (!label || label === "Не выбрана") {
    return null;
  }

  const list = Array.isArray(rows) ? rows.filter((row) => row?.id && row?.title) : [];

  // 1. Точное совпадение названия — самый надёжный случай.
  const exact = list.filter((row) => normalizeTitle(row.title) === normalizeTitle(label));

  if (exact.length === 1) {
    return exact[0].id;
  }

  // 2. Совпадение по словам: считаем оценку для каждой услуги.
  const scored = list
    .map((row) => ({ row, score: matchScore(row.title, label) }))
    .filter((item) => item.score >= MATCH_THRESHOLD)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) {
    return null;
  }

  // 3. Если лучшая услуга заметно отрывается от следующей — берём её.
  const best = scored[0];
  const next = scored[1];

  if (!next || best.score - next.score >= 0.2) {
    return best.row.id;
  }

  // Иначе непонятно, какую услугу имели в виду — не связываем.
  return null;
}

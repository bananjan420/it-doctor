const telegram = window.Telegram?.WebApp;
const form = document.getElementById("miniAppForm");
const nameInput = document.getElementById("name");
const phoneInput = document.getElementById("phone");
const detailsInput = document.getElementById("details");
const continueButton = document.getElementById("continueButton");
const submitButton = document.getElementById("submitButton");
const formStatus = document.getElementById("formStatus");
const successCard = document.getElementById("successCard");
const closeAppButton = document.getElementById("closeAppButton");
const serviceInputs = [...document.querySelectorAll('input[name="service"]')];

// Подготавливаем окно и подстраиваем страницу под тему Telegram.
if (telegram) {
  telegram.ready();
  telegram.expand();
  telegram.setHeaderColor?.("secondary_bg_color");
  telegram.setBackgroundColor?.("bg_color");

  const user = telegram.initDataUnsafe?.user;
  if (user && !nameInput.value) {
    nameInput.value = [user.first_name, user.last_name]
      .filter(Boolean)
      .join(" ");
  }

  telegram.onEvent?.("themeChanged", syncTelegramTheme);
  syncTelegramTheme();
} else {
  closeAppButton.textContent = "Вернуться на сайт";
}

function syncTelegramTheme() {
  document.documentElement.dataset.theme = telegram?.colorScheme || "dark";
}

// Показываем кнопку перехода к форме после выбора услуги.
serviceInputs.forEach((input) => {
  input.addEventListener("change", () => {
    continueButton.disabled = false;
    continueButton.textContent = "Продолжить";
    telegram?.HapticFeedback?.selectionChanged();
  });
});

continueButton.addEventListener("click", () => {
  if (!getSelectedService()) {
    return;
  }

  document.getElementById("request").scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
  nameInput.focus({ preventScroll: true });
});

// Форматируем российский номер по мере ввода.
phoneInput.addEventListener("input", () => {
  phoneInput.value = formatRussianPhone(phoneInput.value);
});

phoneInput.addEventListener("focus", () => {
  phoneInput.value = formatRussianPhone(phoneInput.value);
});

phoneInput.addEventListener("keydown", (event) => {
  const cursorAtPrefix = (phoneInput.selectionStart ?? 0) <= 3;
  const noSelection = phoneInput.selectionStart === phoneInput.selectionEnd;

  if (
    (event.key === "Backspace" || event.key === "Delete") &&
    cursorAtPrefix &&
    noSelection
  ) {
    event.preventDefault();
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearStatus();

  const service = getSelectedService();
  const name = nameInput.value.trim();
  const phone = phoneInput.value.trim();
  const details = detailsInput.value.trim();
  const phoneDigits = phone.replace(/\D/g, "");

  if (!service) {
    showStatus("Сначала выберите услугу.", "error");
    document.getElementById("servicesTitle").scrollIntoView({
      behavior: "smooth"
    });
    return;
  }

  if (!name) {
    showStatus("Укажите ваше имя.", "error");
    nameInput.focus();
    return;
  }

  if (phoneDigits.length !== 11 || !phoneDigits.startsWith("7")) {
    showStatus(
      "Введите полный номер в формате +7 (999) 123-45-67.",
      "error"
    );
    phoneInput.focus();
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Отправляем…";

  try {
    const user = telegram?.initDataUnsafe?.user;
    const response = await fetch("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        phone,
        message: details || "Не указано",
        service,
        source: "Telegram Mini App",
        telegramUser: user
          ? {
              id: user.id,
              username: user.username || "",
              firstName: user.first_name || ""
            }
          : null
      })
    });

    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Не удалось отправить заявку");
    }

    telegram?.HapticFeedback?.notificationOccurred("success");
    document.querySelectorAll(".section").forEach((section) => {
      section.hidden = true;
    });
    document.querySelector(".trust-row").hidden = true;
    document.querySelector(".sticky-action").hidden = true;
    successCard.hidden = false;
    successCard.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    console.error("Mini App request failed", error);
    telegram?.HapticFeedback?.notificationOccurred("error");
    showStatus(
      "Не удалось отправить заявку. Проверьте интернет и попробуйте ещё раз.",
      "error"
    );
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Отправить заявку";
  }
});

closeAppButton.addEventListener("click", () => {
  if (telegram?.initData) {
    telegram.close();
    return;
  }

  window.location.href = "https://it-doctor.pages.dev/#hero";
});

function getSelectedService() {
  return serviceInputs.find((input) => input.checked)?.value || "";
}

function formatRussianPhone(value) {
  let digits = value.replace(/\D/g, "");

  if (digits.startsWith("7") || digits.startsWith("8")) {
    digits = digits.slice(1);
  }

  digits = digits.slice(0, 10);

  let formatted = "+7";
  if (digits.length > 0) formatted += ` (${digits.slice(0, 3)}`;
  if (digits.length >= 3) formatted += ")";
  if (digits.length > 3) formatted += ` ${digits.slice(3, 6)}`;
  if (digits.length > 6) formatted += `-${digits.slice(6, 8)}`;
  if (digits.length > 8) formatted += `-${digits.slice(8, 10)}`;

  return `${formatted}${digits.length === 0 ? " " : ""}`;
}

function showStatus(text, type) {
  formStatus.textContent = text;
  formStatus.className = `form-status form-status--${type}`;
}

function clearStatus() {
  formStatus.textContent = "";
  formStatus.className = "form-status";
}

const form = document.getElementById("application-form");
const message = document.getElementById("form-message");
const timeSelect = document.getElementById("preferredTime");

// Занятие длится 40 минут, между занятиями — перемена 10 минут.
// Поэтому новое занятие начинается каждые 50 минут с 10:45.
function fillWorkingTimes() {
  const times = [];
  const opening = 10 * 60 + 45;
  const closing = 18 * 60 + 25;
  const lessonDuration = 40;
  for (let minutes = opening; minutes + lessonDuration <= closing; minutes += lessonDuration + 10) {
    const h = String(Math.floor(minutes / 60)).padStart(2, "0");
    const m = String(minutes % 60).padStart(2, "0");
    times.push(`${h}:${m}`);
  }
  timeSelect.innerHTML = '<option value="">Выбери время</option>' +
    times.map(time => `<option value="${time}">${time}</option>`).join("");
  timeSelect.value = "16:35";
}
fillWorkingTimes();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.className = "form-message full";
  message.textContent = "";

  const days = [...form.querySelectorAll('input[name="days"]:checked')].map(input => input.value);
  if (!days.length) {
    message.classList.add("error");
    message.textContent = "Выбери хотя бы один удобный день.";
    return;
  }

  const payload = {
    surname: form.surname.value.trim(),
    name: form.name.value.trim(),
    contact: form.contact.value.trim(),
    age: Number(form.age.value),
    club: form.club.value,
    days,
    preferredTime: timeSelect.value,
    comment: form.comment.value.trim()
  };
  if (!payload.preferredTime) {
    message.classList.add("error");
    message.textContent = "Выбери удобное время в пределах рабочего дня.";
    return;
  }

  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "Отправляем…";

  try {
    const response = await fetch("/api/applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Не удалось сохранить заявку.");
    form.reset();
    timeSelect.value = "16:35";
    message.classList.add("success");
    message.textContent = `${result.message} Номер заявки: ${result.id}. Спасибо!`;
  } catch (error) {
    message.classList.add("error");
    message.textContent = error.message || "Ошибка соединения с сервером. Убедись, что сайт запущен.";
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = 'Отправить заявку <span>↗</span>';
  }
});

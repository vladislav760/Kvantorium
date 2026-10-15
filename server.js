require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");
const Database = require("better-sqlite3");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MIN_GROUP_SIZE = Math.max(2, Number(process.env.MIN_GROUP_SIZE || 5));
const TOLERANCE = Math.max(0, Number(process.env.TIME_TOLERANCE_MINUTES || 60));

const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "kvantorium.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    surname TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    contact TEXT NOT NULL,
    age INTEGER NOT NULL,
    club TEXT NOT NULL,
    days TEXT NOT NULL,
    preferred_time TEXT NOT NULL,
    preferred_minutes INTEGER NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_key TEXT NOT NULL UNIQUE,
    sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

function parseTime(value) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value || "")) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function getApplications() {
  return db.prepare("SELECT * FROM applications ORDER BY id DESC").all().map(row => ({
    ...row,
    days: JSON.parse(row.days)
  }));
}

/*
 * Для каждого кружка и дня собираем предпочтительное время.
 * В одну группу входят заявки, время которых отличается от времени
 * первого участника не более чем на заданный допуск (по умолчанию 60 минут).
 * Это простая и понятная модель для прототипа, а не автоматическое расписание.
 */
function findGroups() {
  const rows = db.prepare("SELECT * FROM applications ORDER BY club, preferred_minutes").all();
  const byClubDay = new Map();

  for (const row of rows) {
    const days = JSON.parse(row.days);
    for (const day of days) {
      const key = `${row.club}|||${day}`;
      if (!byClubDay.has(key)) byClubDay.set(key, []);
      byClubDay.get(key).push(row);
    }
  }

  const groups = [];
  for (const [key, entries] of byClubDay.entries()) {
    entries.sort((a, b) => a.preferred_minutes - b.preferred_minutes);
    let current = [];
    let anchor = null;

    for (const entry of entries) {
      if (anchor === null || entry.preferred_minutes - anchor <= TOLERANCE) {
        current.push(entry);
        if (anchor === null) anchor = entry.preferred_minutes;
      } else {
        if (current.length >= MIN_GROUP_SIZE) groups.push(makeGroup(key, current, anchor));
        current = [entry];
        anchor = entry.preferred_minutes;
      }
    }
    if (current.length >= MIN_GROUP_SIZE) groups.push(makeGroup(key, current, anchor));
  }
  return groups;
}

function makeGroup(key, entries, anchor) {
  const [club, day] = key.split("|||");
  const hh = String(Math.floor(anchor / 60)).padStart(2, "0");
  const mm = String(anchor % 60).padStart(2, "0");
  return {
    key: `${club}|${day}|${anchor}|${entries.map(e => e.id).sort((a,b)=>a-b).join(",")}`,
    club,
    day,
    preferredTime: `${hh}:${mm}`,
    count: entries.length,
    applicationIds: entries.map(e => e.id)
  };
}

async function sendGroupEmails(groups) {
  const host = process.env.SMTP_HOST;
  const to = process.env.MAIL_TO;
  if (!host || !to || !process.env.SMTP_USER || !process.env.SMTP_PASS) return;

  const transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  for (const group of groups) {
    const exists = db.prepare("SELECT 1 FROM notifications WHERE group_key = ?").get(group.key);
    if (exists) continue;
    const subject = `Совпадение по времени — ${group.club}`;
    const text = [
      "Обнаружено совпадение предпочтительного времени занятий.",
      "",
      `Направление: ${group.club}`,
      `День: ${group.day}`,
      `Предпочтительное время: около ${group.preferredTime}`,
      `Количество заявок: ${group.count}`,
      "",
      "Проверьте заявки и подтвердите возможность открытия группы."
    ].join("\n");

    try {
      await transporter.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to,
        subject,
        text
      });
      db.prepare("INSERT OR IGNORE INTO notifications (group_key) VALUES (?)").run(group.key);
    } catch (err) {
      console.error("Не удалось отправить письмо:", err.message);
    }
  }
}

app.post("/api/applications", async (req, res) => {
  const body = req.body || {};
  const surname = String(body.surname || "").trim();
  const name = String(body.name || "").trim();
  const contact = String(body.contact || "").trim();
  const age = Number(body.age);
  const club = String(body.club || "").trim();
  const days = Array.isArray(body.days) ? [...new Set(body.days)] : [];
  const preferredTime = String(body.preferredTime || "");
  const comment = String(body.comment || "").trim().slice(0, 1500);
  const preferredMinutes = parseTime(preferredTime);
  const allowedDays = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница"];
  const openingMinutes = 10 * 60 + 45;
  const closingMinutes = 18 * 60 + 25;
  const lessonDuration = 40;
  const validStartTimes = new Set();
  for (let minutes = openingMinutes; minutes + lessonDuration <= closingMinutes; minutes += lessonDuration + 10) {
    validStartTimes.add(minutes);
  }

  if (!surname || surname.length > 100 || !name || name.length > 100 || !contact || contact.length > 200 ||
      !Number.isInteger(age) || age < 4 || age > 100 ||
      !club || club.length > 100 || !days.length ||
      days.some(day => !allowedDays.includes(day)) || preferredMinutes === null || !validStartTimes.has(preferredMinutes)) {
    return res.status(400).json({ error: "Проверьте обязательные поля, выберите будний день и время начала занятия длительностью 40 минут в рабочем интервале 10:45–18:25." });
  }

  const result = db.prepare(`
    INSERT INTO applications (surname, name, contact, age, club, days, preferred_time, preferred_minutes, comment)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(surname, name, contact, age, club, JSON.stringify(days), preferredTime, preferredMinutes, comment);

  const groups = findGroups();
  await sendGroupEmails(groups);

  res.status(201).json({ message: "Заявка успешно сохранена!", id: result.lastInsertRowid });
});

// Не выдаём контактные данные заявителей через API аналитики.
app.get("/api/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`Кванториум запущен: http://localhost:${PORT}`);
  console.log(`Порог группы: ${MIN_GROUP_SIZE}; допуск: ${TOLERANCE} минут`);
});

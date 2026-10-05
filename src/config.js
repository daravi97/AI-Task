// Runtime settings (from environment) and timezone-aware date helpers.
// Collection days are calendar dates ("2026-10-09") in the company's timezone.

// True for addresses only this computer can open (localhost, 127.x, ::1, or nothing set).
function isLocalUrl(url) {
  return !url || /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(url);
}

const settings = {
  timezone: process.env.APP_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  reminderHour: Number(process.env.REMINDER_HOUR ?? 9),
  // RENDER_EXTERNAL_URL is set automatically when hosted on Render.
  appUrl: (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  // A localhost APP_URL doesn't count as fixed: phones can't open it, so the app may still
  // switch to the public address it is reached on (see app.js).
  appUrlFixed: !isLocalUrl(process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || ''),
  companyName: process.env.COMPANY_NAME || 'Company',
};

function partsIn(timeZone, date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  });
  return Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
}

// Today's date (YYYY-MM-DD) in the company timezone.
function today(timeZone = settings.timezone, now = new Date()) {
  const p = partsIn(timeZone, now);
  return `${p.year}-${p.month}-${p.day}`;
}

function currentHour(timeZone = settings.timezone, now = new Date()) {
  return Number(partsIn(timeZone, now).hour);
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;
}

function isValidTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

// "Thursday, 9 October 2026"
function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

module.exports = { isLocalUrl, settings, today, currentHour, addDays, isValidDate, isValidTime, formatDate };

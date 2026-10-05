const fs = require('node:fs');

// Minimal .env loader so no extra dependency is needed. Runs before the other modules
// load because src/config.js reads the environment at require time.
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const { openDb } = require('./src/db');
const { createApp } = require('./src/app');
const { createAssistant } = require('./src/bot');
const { createMailer, startScheduler } = require('./src/notifications');
const { settings } = require('./src/config');

const port = Number(process.env.PORT) || 3000;
const db = openDb(process.env.DB_PATH || './data/store.db');
const assistant = createAssistant();
const mailer = createMailer();
const scheduler = startScheduler(db, mailer);
const app = createApp({ db, assistant, email: { mode: mailer.mode, kick: scheduler.drain } });

app.listen(port, () => {
  console.log(`Merch store running at http://localhost:${port}`);
  console.log(`Assistant mode: ${assistant.mode === 'claude' ? 'Claude' : 'FAQ keyword matching (set ANTHROPIC_API_KEY for Claude)'}`);
  console.log(`Email: ${mailer.mode === 'smtp' ? `SMTP via ${process.env.SMTP_HOST}` : 'log only (set SMTP_HOST to send real email)'}; `
    + `reminders at ${settings.reminderHour}:00 ${settings.timezone} the day before collection`);
  if (mailer.verify) mailer.verify().catch((err) => console.error(`[email] SMTP connection check failed: ${err.message}`));
});

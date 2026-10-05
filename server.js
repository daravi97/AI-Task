const fs = require('node:fs');

// node:sqlite (the built-in database) is available without flags from Node 22.13.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`This app needs Node.js 22.13 or newer (you have ${process.versions.node}). Download it from https://nodejs.org`);
  process.exit(1);
}

// Minimal .env loader so no extra dependency is needed. Runs before the other modules
// load because src/config.js reads the environment at require time.
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
}

const { openDb } = require('./src/db');
const { createApp } = require('./src/app');
const { createAssistant } = require('./src/bot');
const { createMailer, startScheduler } = require('./src/notifications');
const { settings } = require('./src/config');

const { spawn } = require('node:child_process');

const requestedPort = Number(process.env.PORT) || 3000;
const db = openDb(process.env.DB_PATH || './data/store.db');
const assistant = createAssistant();
const mailer = createMailer();
const scheduler = startScheduler(db, mailer);
const app = createApp({ db, assistant, email: { mode: mailer.mode, kick: scheduler.drain } });

// Open the site in the default browser (set OPEN_BROWSER=false to turn this off).
function openBrowser(url) {
  if (process.env.OPEN_BROWSER === 'false') return;
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {}); // no browser available (e.g. on a server) — just skip
    child.unref();
  } catch { /* ignore */ }
}

// When the port is taken, check whether it's another copy of this app (a common mix-up:
// an old `npm start` left running in another terminal keeps serving the old version).
async function explainBusyPort(port) {
  const get = (path) => fetch(`http://localhost:${port}${path}`, { signal: AbortSignal.timeout(1500) });
  let other = null;
  try {
    const v = await get('/api/version');
    if (v.ok) other = (await v.json()).version;
    else if ((await get('/api/me')).status === 401) other = 'an older version';
  } catch { /* not reachable or not HTTP */ }
  const line = '  ' + '!'.repeat(76);
  if (other) {
    const running = other === 'an older version' ? 'an OLDER version' : `version ${other}`;
    console.log(`\n${line}\n  Another copy of the Merch Store (${running}) is already running on port ${port}.`);
    console.log(`  This is version ${require('./package.json').version}. Close the other terminal window (or press Ctrl+C`);
    console.log(`  in it) so you don't end up looking at the old site, then run npm start again.\n${line}\n`);
  } else {
    console.log(`Port ${port} is already in use by another program.`);
  }
}

// Listen on the requested port; if it's taken (and PORT wasn't set explicitly), try the next few.
function listen(port, attemptsLeft = 10) {
  const server = app.listen(port);
  server.once('listening', () => {
    const url = `http://localhost:${port}`;
    if (!settings.appUrlFixed) settings.appUrl = url;
    console.log('');
    console.log(`  Merch store running at ${url}  (press Ctrl+C to stop)`);
    const lan = Object.values(require('node:os').networkInterfaces()).flat()
      .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => `http://${n.address}:${port}`);
    if (lan.length) console.log(`  On a phone on the same Wi-Fi: ${lan.join('  or  ')}`);
    console.log('  Demo logins (password: password123): alice@company.com, bob@company.com (staff), admin@company.com (admin)');
    console.log(`  Assistant: ${assistant.mode === 'claude' ? 'Claude' : 'FAQ keyword matching (set ANTHROPIC_API_KEY for Claude)'}`);
    console.log(`  Email: ${mailer.mode === 'smtp' ? `SMTP via ${process.env.SMTP_HOST}` : 'log only (set SMTP_HOST to send real email)'}; `
      + `reminders at ${settings.reminderHour}:00 ${settings.timezone} the day before collection`);
    console.log('');
    if (mailer.verify) mailer.verify().catch((err) => console.error(`[email] SMTP connection check failed: ${err.message}`));
    openBrowser(url);
  });
  server.once('error', async (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    await explainBusyPort(port);
    if (!process.env.PORT && attemptsLeft > 0) {
      console.log(`Trying port ${port + 1}...`);
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error(`Port ${port} is already in use. Stop the other program using it, or set a different PORT in .env.`);
      process.exit(1);
    }
  });
}

listen(requestedPort);

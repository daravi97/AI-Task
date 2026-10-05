const fs = require('node:fs');
const { openDb } = require('./src/db');
const { createApp } = require('./src/app');
const { createAssistant } = require('./src/bot');

// Minimal .env loader so no extra dependency is needed.
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const port = Number(process.env.PORT) || 3000;
const db = openDb(process.env.DB_PATH || './data/store.db');
const assistant = createAssistant();
const app = createApp({ db, assistant });

app.listen(port, () => {
  console.log(`Merch store running at http://localhost:${port}`);
  console.log(`Assistant mode: ${assistant.mode === 'claude' ? 'Claude' : 'FAQ keyword matching (set ANTHROPIC_API_KEY for Claude)'}`);
});

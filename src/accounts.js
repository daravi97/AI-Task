// Registering people and letting them choose their own password.
// An admin adds someone by name and real email address (Gmail, Outlook, company mail…). They get a
// welcome email with a one-time "set your password" link; nobody ever sees or types their password
// for them. The same kind of link is used for "Forgot password?".
const crypto = require('node:crypto');
const auth = require('./auth');
const config = require('./config');
const { enqueue } = require('./notifications');
const { templates } = require('./emails');

class AccountError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const INVITE_DAYS = 7;
const RESET_MINUTES = 60;
const RESET_COOLDOWN_MS = 2 * 60_000; // at most one reset email per person every 2 minutes
const MIN_PASSWORD = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const linkFor = (token) => `${config.settings.appUrl}/#set-password/${token}`;

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Only the hash is stored, so a copy of the database can't be used to take over accounts.
function issueToken(db, userId, purpose) {
  const token = crypto.randomBytes(24).toString('base64url');
  const ms = purpose === 'invite' ? INVITE_DAYS * 864e5 : RESET_MINUTES * 60_000;
  // A new link replaces any older unused one.
  db.prepare('DELETE FROM password_tokens WHERE user_id = ? AND used_at IS NULL').run(userId);
  db.prepare('INSERT INTO password_tokens (token_hash, user_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(token), userId, purpose, new Date().toISOString(), new Date(Date.now() + ms).toISOString());
  return token;
}

function queueAccountEmail(db, user, kind, token, extra = {}) {
  const { subject, html, text } = templates[kind](user, linkFor(token), extra);
  enqueue(db, { kind, toEmail: user.email, toName: user.name, subject, html, text });
}

function createUser(db, data, admin) {
  const name = String(data.name ?? '').trim();
  const email = String(data.email ?? '').trim().toLowerCase();
  const department = String(data.department ?? '').trim() || null;
  const role = data.role === 'admin' ? 'admin' : 'staff';
  const tokens = data.startingTokens === '' || data.startingTokens == null ? 0 : Number(data.startingTokens);
  if (!name) throw new AccountError('Name is required');
  if (!EMAIL_RE.test(email)) throw new AccountError('Enter a valid email address');
  if (!Number.isInteger(tokens) || tokens < 0) throw new AccountError('Starting tokens must be 0 or a positive whole number');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new AccountError(`${email} is already registered`, 409);
  }

  return transaction(db, () => {
    // A random password nobody knows; the person sets their own from the welcome email.
    const r = db.prepare('INSERT INTO users (name, email, password_hash, role, department) VALUES (?, ?, ?, ?, ?)')
      .run(name, email, auth.hashPassword(crypto.randomBytes(32).toString('hex')), role, department);
    const user = { id: Number(r.lastInsertRowid), name, email, role, department };
    if (tokens > 0) {
      db.prepare("INSERT INTO token_ledger (user_id, amount, type, reason, created_by) VALUES (?, ?, 'award', ?, ?)")
        .run(user.id, tokens, 'Welcome to the Merch Store', admin.id);
    }
    queueAccountEmail(db, user, 'welcome', issueToken(db, user.id, 'invite'), { invitedBy: admin.name, tokens });
    return user;
  });
}

function resendInvite(db, userId, admin) {
  const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(userId);
  if (!user) throw new AccountError('User not found', 404);
  return transaction(db, () => {
    queueAccountEmail(db, user, 'welcome', issueToken(db, user.id, 'invite'), { invitedBy: admin.name, tokens: 0 });
    return { ok: true, email: user.email };
  });
}

// Always succeeds, so the form can't be used to find out who has an account.
function requestPasswordReset(db, email) {
  const user = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(String(email ?? '').trim());
  if (!user) return;
  const recent = db.prepare(
    "SELECT 1 FROM password_tokens WHERE user_id = ? AND purpose = 'reset' AND created_at > ?"
  ).get(user.id, new Date(Date.now() - RESET_COOLDOWN_MS).toISOString());
  if (recent) return;
  transaction(db, () => queueAccountEmail(db, user, 'password_reset', issueToken(db, user.id, 'reset')));
}

function findToken(db, token) {
  const row = db.prepare(
    `SELECT t.token_hash, t.purpose, t.expires_at, t.used_at, u.id AS user_id, u.name, u.email
       FROM password_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`
  ).get(sha256(String(token ?? '')));
  if (!row || row.used_at || row.expires_at <= new Date().toISOString()) {
    throw new AccountError('This link has expired or was already used. Use "Forgot password?" on the login page to get a new one.', 410);
  }
  return row;
}

function describeToken(db, token) {
  const { name, email, purpose } = findToken(db, token);
  return { name, email, purpose };
}

// Sets the password, uses up the link and signs out every other session. Returns the user id.
function setPassword(db, token, password) {
  password = String(password ?? '');
  if (password.length < MIN_PASSWORD) throw new AccountError(`Use at least ${MIN_PASSWORD} characters`);
  return transaction(db, () => {
    const row = findToken(db, token);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(password), row.user_id);
    db.prepare("UPDATE password_tokens SET used_at = ? WHERE token_hash = ?").run(new Date().toISOString(), row.token_hash);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
    return row.user_id;
  });
}

module.exports = {
  AccountError, createUser, resendInvite, requestPasswordReset, describeToken, setPassword, MIN_PASSWORD,
};

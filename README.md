# 🎁 Token Merch Store

A company merchandise store where staff spend **appreciation tokens** instead of money, with a built-in **assistant bot (Merch Bot)** that answers FAQs and questions about your own wallet and orders.

## Features

**Staff**
- Browse and search the merchandise catalog (prices are in tokens, stock is live)
- Cart and checkout: the total is deducted from your token balance in one atomic transaction
- **My Orders**: track status (Pending → Processing → Ready → Collected) and cancel pending orders for a full refund
- **My Wallet**: balance plus the full history of awards, purchases and refunds, including who awarded tokens and why

**Admins**
- **Award tokens** to one or many staff at once, with a required reason (e.g. "Shipped the Q3 release")
- **Orders**: move orders through statuses; cancelling refunds the tokens and returns the stock
- **Products**: add or edit items, set price, stock and an emoji icon, and hide items
- **FAQs**: edit the knowledge base the assistant uses

**Assistant bot (💬 bottom-right)**
- **With `ANTHROPIC_API_KEY` set:** it uses Claude (`claude-opus-5-5`). The FAQs go in its system prompt, and it has read-only tools to look up the user's balance, orders and the live catalog. It can't place orders or move tokens.
- **Without a key:** it falls back to keyword matching against the FAQ table and handles "what's my balance" and "where's my order" directly, so the app works fully offline.
- If the Claude API errors, it degrades to the offline answer instead of failing.

## Getting started

Requires **Node.js 22.5+** (uses the built-in `node:sqlite`, so there is no native database driver to install).

```bash
npm install
cp .env.example .env      # optionally add ANTHROPIC_API_KEY
npm start                 # http://localhost:3000
```

On first run the database is created at `./data/store.db` and seeded with demo data:

| Role  | Email               | Password      | Tokens |
|-------|---------------------|---------------|--------|
| Admin | `admin@company.com` | `password123` | 0      |
| Staff | `alice@company.com` | `password123` | 450    |
| Staff | `bob@company.com`   | `password123` | 200    |

> Change or remove the demo accounts before using this for real.

## Tests

```bash
npm test
```

The tests cover the token ledger, ordering (insufficient balance and stock, rollback), cancellation and refunds, admin awards, the HTTP API end to end, the offline bot, and the Claude tool loop (using a stubbed client).

## How tokens work

Balances are never stored directly. Every movement is a row in `token_ledger` (`award`, `purchase`, `refund`, `adjustment`), and a balance is the sum of a user's rows, so the wallet history always explains the balance. A purchase checks stock and balance, creates the order, decrements stock and writes the ledger row inside one `BEGIN IMMEDIATE` transaction. If any step fails, nothing is written.

## Project layout

```
server.js          entry point (loads .env, opens DB, starts Express)
src/db.js          schema + demo seed data
src/auth.js        password hashing (scrypt) and cookie sessions
src/store.js       business logic: wallet, catalog, orders, FAQs
src/bot.js         Merch Bot: Claude tool loop + offline FAQ fallback
src/app.js         REST API routes (/api/*, /api/admin/*)
public/            single-page frontend (vanilla JS, no build step)
test/              node:test suites
```

## Configuration

| Variable            | Default            | Purpose                                   |
|---------------------|--------------------|-------------------------------------------|
| `PORT`              | `3000`             | HTTP port                                 |
| `DB_PATH`           | `./data/store.db`  | SQLite file                               |
| `ANTHROPIC_API_KEY` | *(empty)*          | Turns on the Claude-powered assistant     |
| `ASSISTANT_MODEL`   | `claude-opus-5-5`  | Override the assistant model              |

## Ideas for next steps
- Single sign-on (Google Workspace / Microsoft Entra) instead of local passwords
- CSV import of staff and bulk awards
- Email or Slack notifications when tokens are awarded or an order is ready
- Product photos and size/colour variants
- Peer-to-peer recognition, where staff nominate each other and an admin approves

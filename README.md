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
- **Orders, processed in batches**: there's no approval step at checkout, because spending the tokens is the approval. The admin works one collection day at a time:
  1. **Cut-off**: filter to the day, select all, then *Mark processing*. Staff can no longer cancel those orders.
  2. **Pick list**: a printable sheet with the total of each product to pull from storage and a packing list per person.
  3. **Ready**: select all, then *Mark ready*.
  4. **Collection day**: search a name, email or order number as people arrive and click *✓ Collected*.

  **QR check-in:** every order gets its own pickup code (e.g. `K7PX-9M2Q`, hard to guess) and QR code. The QR is in the confirmation, reminder and collection-update emails (embedded as an inline image so Gmail and Outlook show it) and under *My Orders*. At the desk, the admin opens **Check-in** and either scans with a USB/Bluetooth barcode scanner, uses *Scan with camera* (webcam or phone; needs HTTPS or localhost), or points a phone's ordinary camera app at the QR, which opens the check-in page for that order. The screen shows who it is and what to hand over, with a big *Mark collected* button. Already-collected and cancelled orders show a clear red stop. There's an optional "mark collected straight away" mode for long queues, and a log of everyone checked in.

  Bulk actions skip orders that can't change (e.g. cancelled ones) and report how many were skipped. Selected orders can also be moved to another collection day in one go, and each person is emailed. Cancelling an order (refund plus restock) stays a deliberate one-at-a-time action.
- **Products**: add or edit items, set price, stock and an emoji icon, and hide items
- **Bulk upload**: download the CSV template, fill in many products in Excel, and upload it. You get a preview first (new, updated, unchanged and error rows), then everything is saved together, or nothing if any row has an error. A row whose name matches an existing product updates it, and blank cells are left unchanged, so a sheet with just `name,stock` restocks items. Column names are flexible (e.g. `qty`, `price (tokens)`), and both comma- and semicolon-separated files work. The limit is 1,000 rows per upload.
- **Bulk stock edit**: type new numbers into the Stock column of the product list and save them all with one click
- **FAQs**: edit the knowledge base the assistant uses

**Collection days and email (SMTP)**
- Admins schedule **collection days** in the portal: a date, a time window, a location and optional notes for staff.
- At checkout, each order is booked onto the **next collection day from tomorrow onwards**. If no day is scheduled yet, the order shows "to be confirmed". When the admin adds a day, waiting orders are booked onto it automatically and the staff are emailed.
- Emails sent:

  | When | Email |
  |---|---|
  | Order placed | **Confirmation**: items, tokens spent, and the collection date, time and location |
  | Day before collection, from `REMINDER_HOUR` | **Reminder**: "come and collect your item tomorrow at…" |
  | Admin moves an order or edits a collection day | **Collection update** with the new details |
  | Order cancelled | **Cancellation** and refund confirmation |

- Emails are written to an **outbox table in the same database transaction** as the change, then a background worker sends them. Checkout never waits on the mail server, and a failed send is retried with backoff (up to 5 attempts).
- The admin **Emails** tab shows every email with its status. From there an admin can preview it, retry failed ones, and send a test email to check the SMTP settings.
- Without `SMTP_HOST`, emails are only recorded in the Emails tab and not delivered, which is handy for demos.

**Assistant bot (💬 bottom-right)**
- **With `ANTHROPIC_API_KEY` set:** it uses Claude (`claude-opus-5-5`). The FAQs go in its system prompt, and it has read-only tools to look up the user's balance, orders and the live catalog. It can't place orders or move tokens.
- **Without a key:** it falls back to keyword matching against the FAQ table and handles "what's my balance" and "where's my order" directly, so the app works fully offline.
- If the Claude API errors, it degrades to the offline answer instead of failing.

## Getting started

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`, so there is no native database driver to install).

```bash
npm install
cp .env.example .env      # optionally add ANTHROPIC_API_KEY
npm start                 # opens http://localhost:3000 in your browser
```

**On Windows,** you can double-click **`start.bat`** instead. It installs or updates the packages and starts the app. If PowerShell says *"npm.ps1 cannot be loaded… not digitally signed"*, either use `start.bat`, type `npm.cmd install` and `npm.cmd start` instead of `npm …`, or allow local scripts once with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. After every `git pull`, run `npm install` (or `start.bat`) again in case new packages were added.

`npm start` opens the site in your default browser (set `OPEN_BROWSER=false` in `.env` to stop that). If port 3000 is busy it uses the next free port and prints the address. Press `Ctrl+C` to stop the server.

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

The tests cover the token ledger, ordering (insufficient balance and stock, rollback), cancellation and refunds, admin awards, collection-day booking and rescheduling, every email type, the reminder timing (once only, not before the reminder hour, skipping cancelled orders), SMTP retry and backoff, HTML escaping in emails, the HTTP API end to end, the offline bot, and the Claude tool loop (using a stubbed client).

## How tokens work

Balances are never stored directly. Every movement is a row in `token_ledger` (`award`, `purchase`, `refund`, `adjustment`), and a balance is the sum of a user's rows, so the wallet history always explains the balance. A purchase checks stock and balance, creates the order, decrements stock and writes the ledger row inside one `BEGIN IMMEDIATE` transaction. If any step fails, nothing is written.

## Project layout

```
server.js          entry point (loads .env, opens DB, starts Express)
src/db.js          schema + demo seed data
src/auth.js        password hashing (scrypt) and cookie sessions
src/store.js       business logic: wallet, catalog, orders, FAQs
src/bot.js         Merch Bot: Claude tool loop + offline FAQ fallback
src/collection.js  collection days and booking orders onto them
src/bulk.js        CSV parsing, bulk product import (preview + apply), bulk stock updates
src/qr.js          pickup codes and QR code images (check-in links)
src/notifications.js  SMTP transport, email outbox worker, day-before reminder job
src/emails.js      email templates (HTML + plain text)
src/config.js      settings and timezone-aware date helpers
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
| `SMTP_HOST`         | *(empty)*          | SMTP server. Empty means emails are only recorded, not delivered |
| `SMTP_PORT`         | `587`              | 587 (STARTTLS) or 465 (TLS)               |
| `SMTP_SECURE`       | `true` if port 465 | Force implicit TLS on or off              |
| `SMTP_USER` / `SMTP_PASS` | *(empty)*    | SMTP login, if your server needs one      |
| `MAIL_FROM`         | `Merch Store <no-reply@localhost>` | Sender shown on emails    |
| `COMPANY_NAME`      | `Company`          | Shown in email headers                    |
| `APP_URL`           | `http://localhost:PORT` | Base URL for links in emails **and inside the pickup QR codes**. Set it to the address staff and admin phones use, e.g. `https://merch.yourcompany.com` |
| `APP_TIMEZONE`      | server timezone    | Timezone for collection dates and reminders (e.g. `Asia/Kuala_Lumpur`) |
| `REMINDER_HOUR`     | `9`                | Local hour (0–23) the day-before reminders start going out |

**SMTP examples:** for Microsoft 365, use `smtp.office365.com`, port 587, and a licensed mailbox (SMTP AUTH must be enabled for it). For Google Workspace, use `smtp.gmail.com`, port 587, and an app password, or the SMTP relay service. Your IT team's internal relay usually needs no login.

## Ideas for next steps
- Single sign-on (Google Workspace / Microsoft Entra) instead of local passwords
- CSV import of staff and bulk awards
- Email or Slack notifications when tokens are awarded
- Calendar invite (.ics) attached to the confirmation email
- Product photos and size/colour variants
- Peer-to-peer recognition, where staff nominate each other and an admin approves

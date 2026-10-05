# Step 2 — Power Automate flows

All changes to tokens, stock and orders go through these flows. Staff only have Read access to the
lists, so the flows do the writing **as a service account** and check every rule themselves.

| Flow | Called from | Does |
|---|---|---|
| [`MSPlaceOrder`](MSPlaceOrder.md) | Cart → Checkout | Checks tokens and stock, creates the order, reduces stock, deducts tokens, emails the confirmation with the pickup QR |
| [`MSCancelOrder`](MSCancelOrder.md) | My orders → Cancel, or an admin | Restocks, refunds tokens, marks the order cancelled, emails the person |
| [`MSAwardTokens`](MSAwardTokens.md) | Admin → Award tokens | Admin-only. Adds tokens for one or many people and emails each one |
| [`MSUpdateOrders`](MSUpdateOrders.md) | Admin → Orders (bulk), Check-in | Admin-only. Sets Processing / Ready / Collected on many orders at once |
| [`MSReminderDaily`](MSReminderDaily.md) | Every day at 09:00 | Emails "collect your order tomorrow" with the pickup QR |

## Before you start

1. **Use a service account** (e.g. `merchstore@yourcompany.com`) that is a Member of the SharePoint
   site and has a mailbox. Create the flows while signed in as that account, or make it co-owner and
   switch every connection to it. Emails are sent from its mailbox (or use *Send an email from a
   shared mailbox (V2)* with a shared mailbox).
2. **Names matter.** Name each flow exactly as above (no spaces), because the app calls it by name,
   e.g. `MSPlaceOrder.Run(...)`.
3. **Time zone.** Expressions use `'Singapore Standard Time'` (UTC+8, covering Malaysia and Singapore).
   Replace it with your [Windows time zone ID](https://learn.microsoft.com/windows-hardware/manufacture/desktop/default-time-zones)
   if you're elsewhere.
4. **App link** (for the pickup QR codes). After step 3, open the app's *Details* page and copy its
   **Web link** (`https://apps.powerapps.com/play/e/.../a/...?tenantId=...`). Paste it into the
   `AppLink` variable in `MSPlaceOrder` and `MSReminderDaily`. Until then, put any placeholder text there.

## Sharing so staff can run them (important)

The flows using **the service account's** connections is what keeps the lists safe. For the four
instant flows, open the flow, then **Run only users → Edit**:
- **Who can run it:** your staff security group (or "everyone who can use the app").
- **Connections:** choose **"Use this connection (service account)"** for SharePoint and Office 365
  Outlook. Do **not** choose *Provided by run-only user*.

## Patterns used in every flow

| Need | How |
|---|---|
| Who is calling | `toLower(triggerOutputs()?['headers']?['x-ms-user-email'])` from the *PowerApps (V2)* trigger |
| Their display name | `triggerOutputs()?['headers']?['x-ms-user-name']` |
| Is the caller an admin? | *Get items* on `MS_Admins` with Filter Query `Title eq '@{variables('CallerEmail')}'`, then `greater(length(body('Get_admin')?['value']), 0)` |
| Sum a column (the balance) | *Select* the `Amount` values as a plain array (switch Map to text mode: `@item()?['Amount']`), then `xpath(xml(json(concat('{"root":{"v":', string(body('Select_amounts')), '}}'))), 'sum(/root/v)')` |
| Return to the app | *Respond to a PowerApp or flow* with **lower-case** output names (`ok`, `message`, …). The app reads them as `result.ok`, etc. |
| Loops that update variables | In each *Apply to each*: *Settings → Concurrency control → On, degree 1* |

Expression names like `body('Get_admin')` follow each action's name, with spaces turned into `_`.
If you rename an action, use the dynamic content picker or update the name in the expression.

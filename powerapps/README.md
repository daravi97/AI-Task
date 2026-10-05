# Merch Store — Power Apps edition

The token-based merchandise store rebuilt on **Microsoft Power Platform**, so it runs inside
Microsoft 365 with your staff's normal work sign-in. It needs no extra licences: it uses only
**standard** connectors (SharePoint, Office 365 Outlook, Office 365 Users, Power Apps / Power Automate).

| Part | Built with | Where it lives |
|---|---|---|
| Data (products, orders, token ledger, collection days, FAQs, admins) | 7 **SharePoint lists** | A SharePoint site, e.g. `/sites/MerchStore` |
| Staff and admin app (shop, cart, orders with pickup QR, wallet, admin, check-in) | **Canvas app** | Power Apps |
| Anything that changes tokens, stock or orders, plus all emails | 5 **Power Automate flows** | Power Automate |

## Why flows do the writing (security)

If staff could edit the lists directly, anyone could open SharePoint and give themselves tokens.
So:

- **Staff have Read access only** to the lists. The app reads from them directly, which is fast.
- **Every change goes through a flow** (place order, cancel, award tokens, update orders). The flows
  run with a **service account's** SharePoint connection and check the rules themselves: enough
  tokens, enough stock, only your own order, only admins can award.
- **Admins** (people in the `MS_Admins` list who are also SharePoint site Members) can also edit
  Products and Collection days directly in SharePoint. That includes pasting many products at once
  from Excel in *Edit in grid view*, which serves as the bulk upload.

> **Privacy trade-off:** with Read access, a staff member who browses the SharePoint site itself can
> see other people's orders and token entries. If that isn't acceptable, the next step is Dataverse
> (row-level security, needs Premium licences) or reading the ledger through a flow. Ask and I'll
> change it.

## How it fits together

```
 Staff / Admin ──► Canvas app ──reads──► SharePoint lists (read-only for staff)
                       │
                       └──calls──► Power Automate flows ──writes──► SharePoint lists
                                         (service account)   └────► Outlook emails (confirmation,
                                                                     reminder, cancellation, award)
 Daily 09:00 ──► MSReminderDaily flow ──► "Collect your order tomorrow" emails
```

## Build order (about 2–3 hours the first time)

1. **SharePoint lists:** [`1-sharepoint/lists.md`](1-sharepoint/lists.md). Create the 7 lists (by hand,
   or with the PnP PowerShell script) and paste in the sample data.
2. **Flows:** [`2-flows/`](2-flows). Build the 5 flows and share each one with staff as *run-only*,
   using the service account's connections.
3. **App:** [`3-app/build-guide.md`](3-app/build-guide.md). Create a blank canvas app, add the data
   sources and flows, paste the formulas, then paste each screen's YAML.
4. **Test** with the checklist at the end of the build guide, then share the app with a security
   group (for example your 500-person AD group).

## Colours

Deloitte colour standard, as in the web version: Green 368 `#86BC25` for accents and the token dot,
black panels, dark green `#046A38` for buttons (white text needs the darker green for contrast),
and cool greys for text.

## What I could and couldn't check

I don't have access to a Power Platform environment, so **nothing here has been run inside Power
Apps or Power Automate yet**. Here's what was checked:

- The screen YAML files were validated against **Microsoft's published `pa.yaml` v3.0 schema**,
  using control names taken from Microsoft's own example files. Power Fx formulas can't be checked
  outside Studio.
- If Studio flags a formula or a paste fails, send me the error text or a screenshot and I'll fix it.
- Control versions are left out on purpose, so Studio uses its current versions. If a paste is
  refused, add that control by hand, use *View code* to see the exact name Studio uses, and tell me.

## Known limits

- **Concurrency:** two orders placed in the same second could both pass the token or stock check.
  This is rare for a merch store; the flows re-check stock right before reducing it.
- **SharePoint delegation:** lists are fine up to many thousands of rows, because filters use indexed
  columns (`StaffEmail`, `Status`, `PickupCode`). Totals such as a balance are summed over one
  person's rows only.
- **QR images** come from the free `quickchart.io` image service. The QR holds only a random pickup
  code inside an app link, with no personal data. If your network blocks it, the pickup code is
  always shown as text too, and the desk can type it.

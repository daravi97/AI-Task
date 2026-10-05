# MSReminderDaily (scheduled flow)

Emails "come and collect your order tomorrow" (with the pickup QR) to everyone whose order is due
tomorrow and hasn't had a reminder yet.

Create: *New flow → Scheduled cloud flow*, name `MSReminderDaily`, repeat **every 1 day**.

## Trigger
**Recurrence**: Interval 1, Frequency Day, **Time zone (UTC+08:00) Kuala Lumpur, Singapore**, At these hours `9`, At these minutes `0`.

## Actions
1. **Initialize variable** `AppLink` (String) = your app's web link (same as in `MSPlaceOrder`)
2. **Compose**, rename `Tomorrow`: `formatDateTime(addDays(convertFromUtc(utcNow(), 'Singapore Standard Time'), 1), 'yyyy-MM-dd')`
3. **Get items** `MS_Orders`, rename `Get_open_orders`
   - Filter Query: `ReminderSent eq 0 and Status ne 'Cancelled' and Status ne 'Collected'`
   - Pagination on, threshold 5000
4. **Filter array**, rename `Due_tomorrow`. From `body('Get_open_orders')?['value']`. Edit in advanced mode:
   `@equals(if(empty(item()?['CollectionDate']), '', formatDateTime(convertFromUtc(item()?['CollectionDate'], 'Singapore Standard Time'), 'yyyy-MM-dd')), outputs('Tomorrow'))`

   *Comparing the dates inside the flow, in your time zone, avoids SharePoint's UTC date-only quirks.*
5. **Apply to each** `body('Due_tomorrow')`, rename `Each_order`:
   1. **Compose**, rename `QrUrl`:
      `concat('https://quickchart.io/qr?size=240&margin=2&text=', encodeUriComponent(concat(variables('AppLink'), if(contains(variables('AppLink'), '?'), '&', '?'), 'code=', items('Each_order')?['PickupCode'])))`
   2. **Send an email (V2)**:
      - To `items('Each_order')?['StaffEmail']`
      - Subject `Reminder: collect your order @{items('Each_order')?['Title']} tomorrow`
      - Body (code view):
        ```html
        <p>Hi @{first(split(items('Each_order')?['StaffName'], ' '))},</p>
        <p>Your order <strong>@{items('Each_order')?['Title']}</strong> is ready for collection <strong>tomorrow</strong>.
           Come and pick it up at <strong>@{items('Each_order')?['CollectionLocation']}</strong>.</p>
        <p>@{items('Each_order')?['ItemsSummary']}</p>
        <p style="text-align:center"><img src="@{outputs('QrUrl')}" width="180" height="180" alt="Pickup QR code"><br>
           Pickup code <strong style="font-family:Consolas,monospace;font-size:20px;letter-spacing:3px">@{items('Each_order')?['PickupCode']}</strong></p>
        ```
   3. **Update item** `MS_Orders`: Id = `items('Each_order')?['ID']`, Title = `items('Each_order')?['Title']`, ReminderSent = `Yes`

## Notes
- If an order is placed for tomorrow's collection day, its confirmation email already shows the QR,
  and this flow still sends one reminder the next morning. That's harmless; to skip it, set
  `ReminderSent` to `Yes` in `MSPlaceOrder` when the collection date is tomorrow.
- To resend, set `ReminderSent` back to `No` on that order.

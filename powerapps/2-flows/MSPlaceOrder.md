# MSPlaceOrder (instant flow)

**Called by:** Cart screen → Checkout: `MSPlaceOrder.Run(JSON(ShowColumns(colCart, ProductID, Qty), JSONFormat.Compact))`
**Returns:** `ok` ("yes"/"no"), `message`, `ordernumber`

Create: *My flows → New flow → Instant cloud flow → "When Power Apps calls a flow (V2)"* and name it `MSPlaceOrder`.

## Trigger
**When Power Apps calls a flow (V2)**, with one input:
- **Text** input named `CartJson`

## Actions (in order)

1. **Initialize variable** `CallerEmail` (String) = `toLower(triggerOutputs()?['headers']?['x-ms-user-email'])`
2. **Initialize variable** `CallerName` (String) = `triggerOutputs()?['headers']?['x-ms-user-name']`
3. **Initialize variable** `AppLink` (String) = your app's web link (see the flows README). A placeholder is fine until the app exists.
4. **Initialize variable** `Total` (Float) = `0`
5. **Initialize variable** `Problem` (String) = *(empty)*
6. **Initialize variable** `Summary` (String) = *(empty)*
7. **Parse JSON**, rename it `Parse_cart`
   - Content: the `CartJson` trigger input
   - Schema:
     ```json
     { "type": "array", "items": { "type": "object",
       "properties": { "ProductID": { "type": "integer" }, "Qty": { "type": "integer" } },
       "required": ["ProductID", "Qty"] } }
     ```
8. **Apply to each**, rename `Check_lines`. Input: `body('Parse_cart')`. Concurrency **1**. Inside:
   1. **Get item** (SharePoint), `MS_Products`, Id = `items('Check_lines')?['ProductID']`, rename `Get_product`
   2. **Condition**: `body('Get_product')?['Active']` is equal to `true` **and**
      `body('Get_product')?['Stock']` is greater or equal to `items('Check_lines')?['Qty']`
      **and** `items('Check_lines')?['Qty']` is greater than `0`
      - **Yes:**
        - **Increment variable** `Total` by `mul(body('Get_product')?['Price'], items('Check_lines')?['Qty'])`
        - **Append to string variable** `Summary`: `@{items('Check_lines')?['Qty']} × @{body('Get_product')?['Title']}, `
      - **No:** **Append to string variable** `Problem`: `@{body('Get_product')?['Title']} has only @{body('Get_product')?['Stock']} left. `
9. **Get items** (SharePoint) `MS_TokenLedger`, rename `Get_ledger`
   - Filter Query: `StaffEmail eq '@{variables('CallerEmail')}'`
   - Settings → **Pagination on, threshold 5000**
10. **Select**, rename `Select_amounts`. From: `body('Get_ledger')?['value']`. Switch Map to **text mode**: `@item()?['Amount']`
11. **Compose**, rename `Balance`: `xpath(xml(json(concat('{"root":{"v":', string(body('Select_amounts')), '}}'))), 'sum(/root/v)')`
12. **Condition**, rename `Can_order`. All of:
    - `length(body('Parse_cart'))` is greater than `0`
    - `variables('Problem')` is equal to *(leave empty)*
    - `float(outputs('Balance'))` is greater or equal to `variables('Total')`

### If no (inside `Can_order` → No)
- **Respond to a PowerApp or flow**:
  - `ok` = `no`
  - `message` = `@{if(empty(variables('Problem')), concat('Not enough tokens: this order costs ', string(variables('Total')), ' and you have ', string(outputs('Balance')), '.'), variables('Problem'))}`
  - `ordernumber` = *(empty)*
- **Terminate**: Succeeded

### If yes (inside `Can_order` → Yes)
1. **Get items** `MS_CollectionDays`, rename `Get_next_day`
   - Filter Query: `DayDate gt '@{formatDateTime(convertFromUtc(utcNow(), 'Singapore Standard Time'), 'yyyy-MM-dd')}'`
   - Order By: `DayDate asc`, Top Count: `1`
2. **Compose**, rename `NextDay`: `first(body('Get_next_day')?['value'])`
3. **Compose**, rename `PickupCode`: `toUpper(substring(replace(guid(), '-', ''), 0, 8))`
4. **Create item** `MS_Orders`, rename `Create_order`:
   - Title: `Order`
   - StaffEmail: `variables('CallerEmail')` · StaffName: `variables('CallerName')`
   - Total: `variables('Total')` · Status Value: `Pending`
   - PickupCode: `outputs('PickupCode')`
   - ItemsSummary: `substring(variables('Summary'), 0, sub(length(variables('Summary')), 2))`
   - CollectionDayID: `outputs('NextDay')?['ID']`
   - CollectionDate: `outputs('NextDay')?['DayDate']`
   - CollectionLocation: `outputs('NextDay')?['Title']`
   - ReminderSent: `No`

   *If there's no collection day yet, these three are blank and the app shows "to be confirmed".*
5. **Compose**, rename `OrderNumber`: `concat('ORD-', formatNumber(outputs('Create_order')?['body/ID'], '000000'))`
6. **Update item** `MS_Orders`, Id = `outputs('Create_order')?['body/ID']`, Title = `outputs('OrderNumber')`
7. **Apply to each**, rename `Write_lines`. Input `body('Parse_cart')`. Concurrency **1**. Inside:
   1. **Get item** `MS_Products`, Id = `items('Write_lines')?['ProductID']`, rename `Get_product_again`
   2. **Create item** `MS_OrderLines`: Title = `body('Get_product_again')?['Title']`, OrderID = `outputs('Create_order')?['body/ID']`,
      ProductID = `items('Write_lines')?['ProductID']`, Qty = `items('Write_lines')?['Qty']`, UnitPrice = `body('Get_product_again')?['Price']`
   3. **Update item** `MS_Products`, Id = `items('Write_lines')?['ProductID']`,
      Title = `body('Get_product_again')?['Title']` *(required field, keep it)*,
      Stock = `max(0, sub(body('Get_product_again')?['Stock'], items('Write_lines')?['Qty']))`
8. **Create item** `MS_TokenLedger`: Title = `@{outputs('OrderNumber')}`, StaffEmail = `variables('CallerEmail')`,
   Amount = `mul(-1, variables('Total'))`, EntryType Value = `Purchase`, OrderID = `outputs('Create_order')?['body/ID']`
9. **Compose**, rename `QrUrl`:
   `concat('https://quickchart.io/qr?size=240&margin=2&text=', encodeUriComponent(concat(variables('AppLink'), if(contains(variables('AppLink'), '?'), '&', '?'), 'code=', outputs('PickupCode'))))`
10. **Send an email (V2)** (Office 365 Outlook)
    - To: `variables('CallerEmail')`
    - Subject: `@{outputs('OrderNumber')} confirmed – collect on @{if(empty(outputs('NextDay')), 'a date to be confirmed', formatDateTime(outputs('NextDay')?['DayDate'], 'dddd, d MMMM yyyy'))}`
    - Body: switch the editor to **code view (</>)** and paste [`email-confirmation.html`](email-confirmation.html), then
      replace each `{{…}}` placeholder with the dynamic value named next to it in that file.
11. **Respond to a PowerApp or flow**: `ok` = `yes`, `message` = `Order @{outputs('OrderNumber')} placed`, `ordernumber` = `outputs('OrderNumber')`

## Test
Run the flow from the app (Checkout). Then check that `MS_Orders` has a new row with a pickup code,
`MS_OrderLines` has the lines, `MS_Products` stock went down, `MS_TokenLedger` has a negative row,
and the email arrived with the QR code.

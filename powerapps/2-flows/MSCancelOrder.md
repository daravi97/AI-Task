# MSCancelOrder (instant flow)

**Called by:** My orders → Cancel (staff, own *Pending* orders only), and Admin → Orders → Cancel (admins, any order not yet collected).
`MSCancelOrder.Run(ThisItem.ID)`
**Returns:** `ok`, `message`

## Trigger
**When Power Apps calls a flow (V2)**, with one **Number** input named `OrderId`.

## Actions

1. **Initialize variable** `CallerEmail` (String) = `toLower(triggerOutputs()?['headers']?['x-ms-user-email'])`
2. **Get item** `MS_Orders`, Id = the `OrderId` input, rename `Get_order`
3. **Get items** `MS_Admins`, Filter Query `Title eq '@{variables('CallerEmail')}'`, rename `Get_admin`
4. **Compose**, rename `IsAdmin`: `greater(length(body('Get_admin')?['value']), 0)`
5. **Condition**, rename `Allowed`. Set it to **OR** at the top level:
   - Group 1 (**AND**): `toLower(body('Get_order')?['StaffEmail'])` equals `variables('CallerEmail')` **and** `body('Get_order')?['Status']?['Value']` equals `Pending`
   - Group 2 (**AND**): `outputs('IsAdmin')` equals `true` **and** `body('Get_order')?['Status']?['Value']` is not equal to `Collected` **and** is not equal to `Cancelled`

### No
- **Respond to a PowerApp or flow**: `ok` = `no`, `message` = `Only pending orders can be cancelled. Please contact an admin.`
- **Terminate**: Succeeded

### Yes
1. **Get items** `MS_OrderLines`, Filter Query `OrderID eq @{body('Get_order')?['ID']}`, rename `Get_lines`
2. **Apply to each** `body('Get_lines')?['value']` (Concurrency **1**), rename `Restock`:
   1. **Get item** `MS_Products`, Id = `items('Restock')?['ProductID']`, rename `Get_product`
   2. **Update item** `MS_Products`, Id = same, Title = `body('Get_product')?['Title']`,
      Stock = `add(body('Get_product')?['Stock'], items('Restock')?['Qty'])`
3. **Create item** `MS_TokenLedger`: Title = `Refund for cancelled @{body('Get_order')?['Title']}`,
   StaffEmail = `toLower(body('Get_order')?['StaffEmail'])`, Amount = `body('Get_order')?['Total']`,
   EntryType Value = `Refund`, OrderID = `body('Get_order')?['ID']`
4. **Update item** `MS_Orders`, Id = `body('Get_order')?['ID']`, Title = `body('Get_order')?['Title']`, Status Value = `Cancelled`
5. **Send an email (V2)**:
   - To `body('Get_order')?['StaffEmail']`
   - Subject `@{body('Get_order')?['Title']} cancelled – @{body('Get_order')?['Total']} tokens refunded`
   - Body: `Your order @{body('Get_order')?['Title']} (@{body('Get_order')?['ItemsSummary']}) has been cancelled and @{body('Get_order')?['Total']} tokens are back in your wallet.`
6. **Respond to a PowerApp or flow**: `ok` = `yes`, `message` = `Cancelled. @{body('Get_order')?['Total']} tokens refunded.`

# MSUpdateOrders (instant flow, admins only)

**Called by:**
- Admin → Orders, bulk: `MSUpdateOrders.Run("[" & Concat(colSelected, Text(ID), ",") & "]", "Ready")`
- Check-in: `MSUpdateOrders.Run("[" & Text(varScanned.ID) & "]", "Collected")`

**Returns:** `ok`, `message`, `updated`, `skipped`

Cancelling isn't done here, because it must refund. Admins use `MSCancelOrder` for that.

## Trigger
**When Power Apps calls a flow (V2)**, with:
- **Text** `OrderIdsJson`, a JSON array of order IDs, e.g. `[12,13,14]`
- **Text** `NewStatus`: `Pending`, `Processing`, `Ready` or `Collected`

## Actions
1. **Initialize variable** `CallerEmail` (String) = `toLower(triggerOutputs()?['headers']?['x-ms-user-email'])`
2. **Initialize variable** `Updated` (Integer) = `0`
3. **Initialize variable** `Skipped` (Integer) = `0`
4. **Get items** `MS_Admins`, Filter Query `Title eq '@{variables('CallerEmail')}'`, rename `Get_admin`
5. **Parse JSON** `OrderIdsJson`, schema `{ "type": "array", "items": { "type": "integer" } }`, rename `Parse_ids`
6. **Condition** (AND): `length(body('Get_admin')?['value'])` greater than `0` **and**
   `contains(createArray('Pending','Processing','Ready','Collected'), triggerBody()?['text_1'])` equals `true`
   - **No:** **Respond** `ok` = `no`, `message` = `Only admins can update orders.`, `updated` = `0`, `skipped` = `0`; then **Terminate**.
7. **Yes → Apply to each** `body('Parse_ids')` (Concurrency **1**), rename `Each_order`:
   1. **Get item** `MS_Orders`, Id = `items('Each_order')`, rename `Get_order`
   2. **Condition** (AND): status `body('Get_order')?['Status']?['Value']` is not equal to `Cancelled` **and** is not equal to the `NewStatus` input
      - **Yes:**
        - **Update item** `MS_Orders`, Id = `items('Each_order')`, Title = `body('Get_order')?['Title']`,
          Status Value = the `NewStatus` input,
          CollectedAt = `if(equals(triggerBody()?['text_1'], 'Collected'), utcNow(), null)`
        - **Increment variable** `Updated` by 1
      - **No:** **Increment variable** `Skipped` by 1
8. **Respond to a PowerApp or flow**: `ok` = `yes`, `updated` = `variables('Updated')`, `skipped` = `variables('Skipped')`,
   `message` = `@{variables('Updated')} order(s) set to @{triggerBody()?['text_1']}@{if(greater(variables('Skipped'), 0), concat(', ', string(variables('Skipped')), ' skipped (cancelled or already there)'), '')}.`

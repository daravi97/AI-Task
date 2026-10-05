# MSAwardTokens (instant flow, admins only)

**Called by:** Admin → Award tokens:
`MSAwardTokens.Run("[" & Concat(cmbPeople.SelectedItems, Char(34) & Lower(Mail) & Char(34), ",") & "]", Value(txtAwardAmount.Text), txtAwardReason.Text)`
**Returns:** `ok`, `message`

## Trigger
**When Power Apps calls a flow (V2)**, with 3 inputs:
- **Text** `EmailsJson`, a JSON array of email addresses, e.g. `["alice@x.com","bob@x.com"]`
- **Number** `Amount`
- **Text** `Reason`

## Actions
1. **Initialize variable** `CallerEmail` (String) = `toLower(triggerOutputs()?['headers']?['x-ms-user-email'])`
2. **Get items** `MS_Admins`, Filter Query `Title eq '@{variables('CallerEmail')}'`, rename `Get_admin`
3. **Parse JSON** `EmailsJson`, schema `{ "type": "array", "items": { "type": "string" } }`, rename `Parse_emails`
4. **Condition** (AND):
   - `length(body('Get_admin')?['value'])` greater than `0`
   - the `Amount` input greater than `0`
   - `length(trim(triggerBody()?['text_1']))` greater than `0` *(the Reason input; easiest to pick it from dynamic content)*
   - `length(body('Parse_emails'))` greater than `0`

### No
- **Respond**: `ok` = `no`, `message` = `Only admins can award tokens, and the amount, reason and at least one person are required.`
- **Terminate**: Succeeded

### Yes
1. **Apply to each** `body('Parse_emails')`, rename `Each_person`:
   1. **Create item** `MS_TokenLedger`: Title = the `Reason` input, StaffEmail = `toLower(items('Each_person'))`,
      Amount = the `Amount` input, EntryType Value = `Award`, AwardedBy = `triggerOutputs()?['headers']?['x-ms-user-name']`
   2. **Send an email (V2)**:
      - To `items('Each_person')`
      - Subject `You've received @{triggerBody()?['number']} appreciation tokens`
      - Body: `Thank you! @{triggerOutputs()?['headers']?['x-ms-user-name']} awarded you @{triggerBody()?['number']} tokens for: @{triggerBody()?['text_1']}. Spend them in the Merch Store.`
2. **Respond**: `ok` = `yes`, `message` = `Awarded @{triggerBody()?['number']} tokens to @{length(body('Parse_emails'))} people.`

> The input keys (`text`, `text_1`, `number`) follow the order you add the inputs. If yours differ,
> pick the inputs from the dynamic content list instead of typing the expressions.

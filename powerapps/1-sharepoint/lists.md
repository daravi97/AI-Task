# Step 1 — SharePoint lists

Create a SharePoint **team site** called **Merch Store** (for example `https://<tenant>.sharepoint.com/sites/MerchStore`).

Create the 7 lists below in one of two ways:
- **By hand** (about 30 minutes): *New → List → Blank list*, then add the columns. Use the
  **exact internal names**, because the app and flows refer to them.
- **With a script:** IT can run [`create-lists.ps1`](create-lists.ps1) (PnP PowerShell).

> **Naming tip:** type the column name exactly as shown (no spaces) when you create it. SharePoint
> fixes a column's internal name at creation, and renaming it later only changes the display name.

---

## 1. `MS_Products`

| Column | Type | Settings |
|---|---|---|
| `Title` | (built-in) Single line of text | The product name, e.g. *Company Hoodie* |
| `Description` | Multiple lines of text | Plain text |
| `Category` | Choice | Apparel, Bags, Drinkware, Desk, Stationery, Tech (add your own) |
| `Price` | Number | 0 decimals, minimum 1. Price in tokens |
| `Stock` | Number | 0 decimals, minimum 0 |
| `Active` | Yes/No | Default **Yes**. No = hidden from the shop |
| `PhotoUrl` | Hyperlink | Optional product photo address |

**Bulk upload / restock:** open the list, choose **Edit in grid view**, and paste rows straight
from Excel (columns in the same order). This is the Power Apps equivalent of the CSV upload.

## 2. `MS_CollectionDays`

| Column | Type | Settings |
|---|---|---|
| `Title` | Single line of text | The location, e.g. *Level 3 Reception (HR desk)* |
| `DayDate` | Date and Time | **Date only**. Index this column |
| `StartTime` | Single line of text | e.g. `10:00` |
| `EndTime` | Single line of text | e.g. `16:00` |
| `Notes` | Single line of text | e.g. *Bring your staff ID* |

## 3. `MS_Orders`

| Column | Type | Settings |
|---|---|---|
| `Title` | Single line of text | Order number, e.g. `ORD-000042` (set by the flow) |
| `StaffEmail` | Single line of text | Lower-case email. **Index this column** |
| `StaffName` | Single line of text | |
| `Total` | Number | Tokens |
| `Status` | Choice | Pending, Processing, Ready, Collected, Cancelled. Default *Pending*. **Index** |
| `PickupCode` | Single line of text | 8 characters, e.g. `K7PX9M2Q`. **Index**, enforce unique values |
| `ItemsSummary` | Multiple lines of text | e.g. `1 × Company Hoodie, 2 × Ceramic Mug` |
| `CollectionDayID` | Number | ID of the `MS_CollectionDays` item (blank = to be confirmed) |
| `CollectionDate` | Date and Time | Date only |
| `CollectionLocation` | Single line of text | Copied from the collection day |
| `CollectedAt` | Date and Time | Date and time |
| `ReminderSent` | Yes/No | Default **No** |

## 4. `MS_OrderLines`

| Column | Type | Settings |
|---|---|---|
| `Title` | Single line of text | Product name |
| `OrderID` | Number | **Index** |
| `ProductID` | Number | |
| `Qty` | Number | |
| `UnitPrice` | Number | |

## 5. `MS_TokenLedger`

Every token movement is one row, and a balance is the sum of a person's rows. Nobody edits a
balance directly, so the history always explains the number.

| Column | Type | Settings |
|---|---|---|
| `Title` | Single line of text | The reason, e.g. *Shipped the Q3 release* |
| `StaffEmail` | Single line of text | Lower-case email. **Index this column** |
| `Amount` | Number | Positive for awards and refunds, negative for purchases |
| `EntryType` | Choice | Award, Purchase, Refund, Adjustment |
| `OrderID` | Number | Blank for awards |
| `AwardedBy` | Single line of text | Name of the admin who awarded the tokens |

## 6. `MS_FAQs`

| Column | Type | Settings |
|---|---|---|
| `Title` | Single line of text | The question |
| `Answer` | Multiple lines of text | Plain text |

## 7. `MS_Admins`

| Column | Type | Settings |
|---|---|---|
| `Title` | Single line of text | Admin's email, **lower-case** |

---

## Permissions

1. **Site Members** = admins only, so they can edit Products, Collection days, FAQs and Admins in SharePoint.
2. **Site Visitors** (Read) = everyone else, for example your staff security group.
3. The **service account** that owns the flows = site Member (or Owner).
4. Optional: in each list's *Advanced settings*, set **Allow items from this list to be downloaded to
   offline clients: No**, and hide the site from navigation, so the lists aren't browsed casually.

## Sample data

CSV files in [`sample-data/`](sample-data) match the columns above. Open one in Excel, copy the rows
**without the header**, then in SharePoint use *Edit in grid view* and paste into the first empty row.

| File | List |
|---|---|
| `MS_Products.csv` | 10 starter products |
| `MS_CollectionDays.csv` | 2 collection days (change the dates to future ones) |
| `MS_FAQs.csv` | FAQs the Help screen shows |
| `MS_Admins.csv` | Replace with your admins' emails |
| `MS_TokenLedger.csv` | Optional opening balances (change the emails to real staff) |

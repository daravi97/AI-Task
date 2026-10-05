# Build the canvas app

About 45–60 minutes. Do [`1-sharepoint`](../1-sharepoint) and [`2-flows`](../2-flows) first: the app needs the
lists and the 5 flows to exist before its formulas stop showing errors.

The screens are in [`screens/`](screens), one file per screen, as Power Apps YAML (pa.yaml v3.0, the
format Studio's *Copy code* / *Paste code* uses). To change the design, edit `generate_screens.py` and
run `python3 generate_screens.py` again.

---

## 1. Create the app

1. [make.powerapps.com](https://make.powerapps.com) → pick the right **environment** (top right) → **Create** →
   **Blank app** → **Blank canvas app**. Name `Merch Store`, format **Tablet** (it reflows to phones; see step 2).
2. **Settings → Display**: turn **Scale to fit** *off*, and leave **Lock aspect ratio** off.
   The screens use auto-layout containers that resize with the window, so the same app works on a phone and a laptop.
3. **Settings → General → Data row limit**: set it to **2000**.
4. **Settings → Updates**: make sure **Named formulas** is on (it is by default in new apps).
   *Modern controls* aren't needed; the screens use the classic controls.

## 2. Add data and flows

**Data** (left bar, cylinder icon) → **Add data**:
- **SharePoint** → your site → tick all 7 lists: `MS_Products`, `MS_CollectionDays`, `MS_Orders`,
  `MS_OrderLines`, `MS_TokenLedger`, `MS_FAQs`, `MS_Admins`
- **Office 365 Users** (for the people picker in Admin → Award tokens)

**Power Automate** (left bar, `…` → Power Automate) → **Add flow** → add the 5 flows:
`MSPlaceOrder`, `MSCancelOrder`, `MSAwardTokens`, `MSUpdateOrders`. (`MSReminderDaily` is scheduled, so
the app doesn't call it.)

## 3. App formulas

Select **App** in the Tree view. In the property dropdown pick **Formulas** and paste the whole block below.
Change the last two lines to your app link and site URL.

```
// Deloitte palette (green 368 + cool greys); amber/red are functional only
clrBlack = ColorValue("#000000");
clrGreen = ColorValue("#86BC25");
clrDarkGreen = ColorValue("#046A38");
clrSoftGreen = ColorValue("#EAF4DC");
clrBg = ColorValue("#F5F5F4");
clrSurface = ColorValue("#FFFFFF");
clrText = ColorValue("#000000");
clrMuted = ColorValue("#53565A");
clrBorder = ColorValue("#D0D0CE");
clrBlue = ColorValue("#005587");
clrBlueSoft = ColorValue("#E6F1F8");
clrWarn = ColorValue("#7A4600");
clrWarnSoft = ColorValue("#FFF4E0");
clrDanger = ColorValue("#B42318");
clrDangerSoft = ColorValue("#FDE8E7");

// Who's signed in
fxEmail = Lower(User().Email);
fxFirstName = First(Split(User().FullName, " ")).Value;
fxIsAdmin = !IsBlank(LookUp(MS_Admins, Title = fxEmail));
fxBalance = Sum(Filter(MS_TokenLedger, StaffEmail = fxEmail), Amount);
fxNextDay = First(Sort(Filter(MS_CollectionDays, DayDate > Today()), DayDate, SortOrder.Ascending));

// Links
fxQrBase = "https://quickchart.io/qr?size=300&margin=2&text=";
fxAppLink = "https://apps.powerapps.com/play/e/YOUR-ENVIRONMENT-ID/a/YOUR-APP-ID?tenantId=YOUR-TENANT-ID";
fxSiteUrl = "https://YOURTENANT.sharepoint.com/sites/MerchStore";
```

> `fxBalance` shows a blue delegation underline because SharePoint can't `Sum` on the server. That's
> fine here: the `Filter` by email *is* delegated, so only that person's ledger rows come down
> (well under the 2000 limit).

**`fxAppLink`**: after the first **Save + Publish**, go back to make.powerapps.com → **Apps** → `…` on
Merch Store → **Details** → copy the **Web link**. Paste it here *and* in the `AppLink` variable of
`MSPlaceOrder` and `MSReminderDaily`, so the QR codes in emails open this app.

## 4. OnStart and StartScreen

**App → OnStart**:

```
// Empty collections with the right column types
ClearCollect(colCart, {ProductID: 0, Title: "", Price: 0, Qty: 0}); Clear(colCart);
ClearCollect(colSelected, {ID: 0}); Clear(colSelected);
ClearCollect(colCheckedIn, {Name: "", Items: "", At: Now()}); Clear(colCheckedIn);

Set(varCategory, "All");
Set(varAdminTab, "Orders");
Set(varAdminStatus, "To do");
Set(varAdminDay, Coalesce(fxNextDay.ID, -1));
Set(varShowPickList, false);
Set(varBusy, false);
Set(varConfirmCancel, Blank());
Set(varScanCode, Param("code"));
```

**App → StartScreen**:

```
If(!IsBlank(Param("code")), scrCheckin, scrShop)
```

So when a collection-desk admin scans a pickup QR with their phone camera, the app opens straight on the
check-in screen with that order loaded.

## 5. Screens

1. Rename the default `Screen1` to **`scrShop`**, then add 6 more **Blank** screens (**+ New screen → Blank**)
   named exactly: **`scrCart`**, **`scrOrders`**, **`scrWallet`**, **`scrHelp`**, **`scrCheckin`**, **`scrAdmin`**.
   Do this *before* pasting: the nav buttons refer to all 7 screens.
2. For each screen:
   1. Open `screens/<screen>.pa.yaml` (on GitHub: **Raw**, then select all and copy).
   2. In Studio's Tree view, **right-click the screen → Paste** (or select the screen and press Ctrl+V).
   3. You should see one container, `conRoot…`, filling the screen with the header, body and nav bar inside.
3. Set **scrCheckin → OnVisible** (screen properties can't be pasted with the YAML):

   ```
   If(
       !fxIsAdmin, Navigate(scrOrders, ScreenTransition.None),
       !IsBlank(varScanCode),
       Set(varScanned, LookUp(MS_Orders, PickupCode = Upper(Substitute(Trim(Last(Split(varScanCode, "code=")).Value), "-", ""))))
   )
   ```

4. Set **scrAdmin → OnVisible** to `If(!fxIsAdmin, Navigate(scrShop, ScreenTransition.None))`.

Paste the screens in the order above. If one shows errors right after pasting because it refers to a
screen or control on a screen you haven't pasted yet, they clear once that screen is in.

## 6. Two controls you add by hand

These need a connector or a device, so they're not in the YAML.

### People picker: `cmbPeople` (Admin → Award tokens)

1. In the Tree view, expand `conRootAdmin` → … → **`conAdminAwardTab`** and select it.
2. **Insert → Input → Combo box**. Rename it **`cmbPeople`**. Drag it in the Tree view to sit just below `lblAwardHelp`.
3. Properties:

   | Property | Value |
   |---|---|
   | Items | `Office365Users.SearchUser({searchTerm: cmbPeople.SearchText, top: 25})` |
   | DisplayFields | `["DisplayName"]` |
   | SearchFields | `["DisplayName", "Mail"]` |
   | SelectMultiple | `true` |
   | IsSearchable | `true` |
   | Height | `44` |
   | BorderColor | `clrBorder` |

### Camera scanner (Check-in)

1. Expand `conRootCheckin` → … → **`conCheckinInput`** and select it.
2. **Insert → Media → Barcode reader**. Rename it **`bcrScan`**; drag it after `btnCheckinFind`.
3. Properties:
   - **Text**: `"Scan"`
   - **Width**: `110`, **Height**: `52`
   - **OnScan**:

     ```
     Set(varScanCode, First(Self.Barcodes).Value);
     Set(varScanned, LookUp(MS_Orders, PickupCode = Upper(Substitute(Trim(Last(Split(varScanCode, "code=")).Value), "-", ""))))
     ```

   The QR contains the app link with `code=…` at the end; this works with or without the link part.
   On a laptop with no camera, a USB barcode scanner typing into `txtCheckinCode` does the same job.

## 7. Save, publish, share

1. **Save → Publish**. Copy the web link into `fxAppLink` and both flows (see step 3), then publish again.
2. **Share** the app with your staff **security group** (*User*, not *Co-owner*). Also share:
   - each SharePoint list: staff **Read**; admins **Edit** on `MS_Products` and `MS_CollectionDays`
     (see [`../1-sharepoint/lists.md`](../1-sharepoint/lists.md#permissions))
   - each instant flow as **run-only** with the same group, using the **service account** connections
     (see [`../2-flows/README.md`](../2-flows/README.md))

## 8. Test checklist

Sign in as an admin and as a normal staff member (an InPrivate window is the easiest way to be both).

**Staff**
- [ ] Header shows your first name, your balance (from the sample ledger) and `Cart (0)`. No Check-in/Admin buttons in the nav.
- [ ] Shop: category chips filter; *Add* increases the cart count; *Add* is disabled when out of stock or you can't afford it.
- [ ] Cart: +/− work; total and "balance after" are right; *Place order* shows a success message and empties the cart.
- [ ] The confirmation email arrives with the collection day, location and a QR code.
- [ ] My orders: the order is *Pending* with its pickup code and QR; *Cancel* refunds (wallet shows the refund line).
- [ ] Wallet: award, purchase and refund lines with the right signs; balance matches the header.
- [ ] Help: search filters the FAQs.
- [ ] Opening a list directly in SharePoint, you can view but not edit (staff are read-only).

**Admin**
- [ ] Check-in and Admin appear in the nav.
- [ ] Admin → Orders: pick a day; *To do* shows the new order; tick two orders → bulk bar → *Ready*; the result says `2 order(s) set to Ready`.
- [ ] *Pick list* totals items per product for the day; *Print* prints it.
- [ ] Check-in: type the pickup code → green "Ready" banner → *Hand over & mark collected* → it appears in "Checked in this session". Scan the same code again → red "Already collected".
- [ ] Scan the QR from the email with a phone camera → the app opens on Check-in with the order loaded.
- [ ] Award tokens: pick 2 people, 50 tokens, a reason → both get an email and the tokens show in their wallet.
- [ ] Products & days: the links open the SharePoint lists for editing.
- [ ] Next morning (or run `MSReminderDaily` manually with a collection day set for tomorrow): the reminder email arrives.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Paste does nothing | Paste onto the **screen** in the Tree view, not onto the canvas. Copy the *whole* file, starting with `- conRoot`. |
| Red errors on `clr…` / `fx…` | App → Formulas isn't set, or a name is misspelt. Named formulas need step 3. |
| Red errors on `MSPlaceOrder.Run` etc. | Add the flow to the app (step 2). If you changed a flow's inputs, remove and re-add it. |
| `MS_…` not recognised | Add the list as a data source with exactly that name. |
| Flow says "Only admins…" for an admin | Their email in `MS_Admins` must match their sign-in email (case doesn't matter). |
| Balance looks wrong | Check `StaffEmail` in `MS_TokenLedger` is lower case; the flows write it in lower case. |
| Everything looks tiny or stretched | Turn **Scale to fit** off (step 1). |

"""Generates the paste-ready screen YAML in screens/ for Power Apps Studio.

Each screens/<name>.pa.yaml holds ONE root container control. In Studio: select the
(empty) screen in the Tree view, then paste (Ctrl+V). The format follows Microsoft's
pa.yaml v3.0 schema; control version numbers are left out so Studio uses current ones.

    python3 generate_screens.py          # writes screens/*.pa.yaml
"""
from pathlib import Path

OUT = Path(__file__).parent / 'screens'
FONT = "Font.'Open Sans'"


# ---------- tiny YAML emitter (keeps Studio's plain style: Prop: =formula) ----------

def _scalar(value, indent):
    text = str(value)
    if not text.startswith('='):
        text = '=' + text
    unsafe = '\n' in text or ': ' in text or ' #' in text or text.endswith(' ')
    if not unsafe:
        return ' ' + text
    pad = ' ' * (indent + 2)
    return ' |-\n' + '\n'.join(pad + line for line in text.split('\n'))


def emit(controls, indent=0):
    lines = []
    pad = ' ' * indent
    for c in controls:
        lines.append(f"{pad}- {c['name']}:")
        lines.append(f"{pad}    Control: {c['control']}")
        if c.get('variant'):
            lines.append(f"{pad}    Variant: {c['variant']}")
        if c.get('props'):
            lines.append(f"{pad}    Properties:")
            for k, v in c['props'].items():
                lines.append(f"{pad}      {k}:{_scalar(v, indent + 6)}")
        if c.get('children'):
            lines.append(f"{pad}    Children:")
            lines.extend(emit(c['children'], indent + 6))
    return lines


def ctl(name, control, props=None, children=None, variant=None):
    return {'name': name, 'control': control, 'props': props or {}, 'children': children or [], 'variant': variant}


# ---------- building blocks ----------

def radius(r):
    return {'RadiusTopLeft': r, 'RadiusTopRight': r, 'RadiusBottomLeft': r, 'RadiusBottomRight': r}


def label(name, text, size=11, color='clrText', bold=False, **extra):
    props = {'Text': text, 'Font': FONT, 'Size': size, 'Color': color,
             'FontWeight': 'FontWeight.Bold' if bold else 'FontWeight.Normal'}
    props.update(extra)
    return ctl(name, 'Label', props)


def button(name, text, on_select, fill='clrDarkGreen', color='RGBA(255, 255, 255, 1)', **extra):
    props = {'Text': text, 'OnSelect': on_select, 'Font': FONT, 'Size': 11, 'FontWeight': 'FontWeight.Semibold',
             'Fill': fill, 'Color': color, 'HoverFill': f'ColorFade({fill}, -10%)', 'PressedFill': f'ColorFade({fill}, -20%)',
             'HoverColor': color, 'BorderColor': fill, 'BorderThickness': 1, 'DisabledFill': 'clrBg',
             'DisabledColor': 'clrMuted', 'DisabledBorderColor': 'clrBorder', 'Height': 44, **radius(10)}
    props.update(extra)
    return ctl(name, 'Button', props)


def vbox(name, children, **props):
    base = {'LayoutMode': 'LayoutMode.Auto', 'LayoutDirection': 'LayoutDirection.Vertical', 'LayoutGap': 12,
            'LayoutAlignItems': 'LayoutAlignItems.Stretch', 'DropShadow': 'DropShadow.None', 'Fill': 'RGBA(0, 0, 0, 0)'}
    base.update(props)
    return ctl(name, 'GroupContainer', base, children, 'verticalAutoLayoutContainer')


def hbox(name, children, **props):
    base = {'LayoutMode': 'LayoutMode.Auto', 'LayoutDirection': 'LayoutDirection.Horizontal', 'LayoutGap': 8,
            'LayoutAlignItems': 'LayoutAlignItems.Center', 'DropShadow': 'DropShadow.None', 'Fill': 'RGBA(0, 0, 0, 0)'}
    base.update(props)
    return ctl(name, 'GroupContainer', base, children, 'horizontalAutoLayoutContainer')


def gallery(name, items, children, template=80, **props):
    base = {'Items': items, 'TemplateSize': template, 'TemplatePadding': 6, 'ShowScrollbar': 'false',
            'BorderThickness': 0, 'Fill': 'RGBA(0, 0, 0, 0)'}
    base.update(props)
    return ctl(name, 'Gallery', base, children, 'BrowseLayout_Vertical_TwoTextOneImageVariant_ver5.0')


def card_rect(name):
    """White card behind a gallery row (classic rectangles have no rounded corners)."""
    return ctl(name, 'Rectangle', {'Fill': 'clrSurface', 'BorderColor': 'clrBorder', 'BorderThickness': 1,
                                   'X': 0, 'Y': 0, 'Width': 'Parent.TemplateWidth', 'Height': 'Parent.TemplateHeight'})


NAV = [  # (key, label, screen, admin only)
    ('Shop', 'Shop', 'scrShop', False),
    ('Orders', 'My orders', 'scrOrders', False),
    ('Wallet', 'Wallet', 'scrWallet', False),
    ('Help', 'Help', 'scrHelp', False),
    ('Checkin', 'Check-in', 'scrCheckin', True),
    ('Admin', 'Admin', 'scrAdmin', True),
]


def header(s):
    return hbox(f'conHeader{s}', [
        label(f'lblBrand{s}', '"Merch Store"', 15, 'RGBA(255, 255, 255, 1)', True, Width=130, Height=40),
        label(f'lblBrandDot{s}', '"●"', 12, 'clrGreen', Width=20, Height=40),
        label(f'lblHeaderSpacer{s}', '""', FillPortions=1, Height=40, Width=10),
        button(f'btnBalance{s}', 'Text(fxBalance) & " tokens"', 'Navigate(scrWallet, ScreenTransition.None)',
               fill='clrGreen', color='clrBlack', Width=130, Height=36, **radius(18)),
        button(f'btnCart{s}', '"Cart (" & Sum(colCart, Qty) & ")"', 'Navigate(scrCart, ScreenTransition.None)',
               fill='clrBlack', color='RGBA(255, 255, 255, 1)', BorderColor='RGBA(255, 255, 255, 0.4)', Width=100, Height=36),
    ], Fill='clrBlack', Height=64, PaddingLeft=16, PaddingRight=16, LayoutGap=8)


def navbar(s):
    buttons = []
    for key, text, screen, admin in NAV:
        active = f'App.ActiveScreen = {screen}'
        extra = {'FillPortions': 1, 'Height': 56, **radius(0), 'BorderThickness': 0,
                 'FontWeight': f'If({active}, FontWeight.Bold, FontWeight.Semibold)'}
        if admin:
            extra['Visible'] = 'fxIsAdmin'
        b = button(f'btnNav{key}{s}', f'"{text}"', f'Navigate({screen}, ScreenTransition.None)',
                   fill='clrSurface', color=f'If({active}, clrDarkGreen, clrMuted)', **extra)
        b['props']['Fill'] = f'If({active}, clrSoftGreen, clrSurface)'
        b['props']['BorderColor'] = 'clrSurface'
        buttons.append(b)
    return hbox(f'conNav{s}', buttons, Fill='clrSurface', Height=56, LayoutGap=0,
                LayoutAlignItems='LayoutAlignItems.Stretch', BorderColor='clrBorder', BorderThickness=1)


def screen(s, body_children, body_props=None):
    body = vbox(f'conBody{s}', body_children, FillPortions=1, PaddingTop=16, PaddingBottom=16,
                PaddingLeft=16, PaddingRight=16, **(body_props or {}))
    root = vbox(f'conRoot{s}', [header(s), body, navbar(s)], X=0, Y=0, Width='Parent.Width',
                Height='Parent.Height', Fill='clrBg', LayoutGap=0)
    return [root]


def title(name, text):
    return label(name, text, 18, 'clrText', True, Height=36)


WHITE = 'RGBA(255, 255, 255, 1)'
ACTIVE_ORDER = 'ThisItem.Status.Value in ["Pending", "Processing", "Ready"]'
PARSE_CODE = 'Upper(Substitute(Trim(Last(Split({src}, "code=")).Value), "-", ""))'
FIND_ORDER = ('Set(varScanCode, {src});\n'
              'Set(varScanned, LookUp(MS_Orders, PickupCode = ' + PARSE_CODE.format(src='varScanCode') + '))')


# ---------- screens ----------

def shop():
    s = 'Shop'
    hero = vbox('conHero', [
        label('lblHeroEyebrow', '"APPRECIATION TOKENS"', 9, 'clrGreen', True, Height=20),
        label('lblHeroTitle', '"Thanks for the great work, " & fxFirstName & "."', 18, WHITE, True, Height=36),
        label('lblHeroText', '"You have " & fxBalance & " tokens to spend. Next collection: " & '
              'If(IsBlank(fxNextDay), "to be announced", Text(fxNextDay.DayDate, "dddd d mmmm") & " · " & fxNextDay.Title)',
              11, 'RGBA(208, 208, 206, 1)', Height=44),
    ], Fill='clrBlack', Height=140, PaddingTop=16, PaddingBottom=16, PaddingLeft=20, PaddingRight=20, LayoutGap=4, **radius(16))
    search = ctl('txtSearch', 'TextInput', {'Default': '""', 'HintText': '"Search merchandise"', 'Font': FONT, 'Size': 11,
                                             'Height': 44, 'DelayOutput': 'true', 'BorderColor': 'clrBorder', **radius(10)})
    cats = gallery('galCategories',
                   'Ungroup(Table({x: ["All"]}, {x: Distinct(Filter(MS_Products, Active = true), Category.Value)}), x)',
                   [button('btnCategory', 'ThisItem.Value', 'Set(varCategory, ThisItem.Value)',
                           fill='If(varCategory = ThisItem.Value, clrDarkGreen, clrSurface)',
                           color=f'If(varCategory = ThisItem.Value, {WHITE}, clrText)',
                           BorderColor='If(varCategory = ThisItem.Value, clrDarkGreen, clrBorder)',
                           X=0, Y=0, Width='Parent.TemplateWidth', Height=40, **radius(20))],
                   template=48, WrapCount='Max(1, RoundDown(Self.Width / 130, 0))', Height=100, TemplatePadding=4)
    in_cart = 'Sum(Filter(colCart, ProductID = ThisItem.ID), Qty)'
    remaining = 'fxBalance - Sum(colCart, Price * Qty)'
    cannot = f'ThisItem.Stock - {in_cart} <= 0 || ThisItem.Price > {remaining}'
    products = gallery('galProducts',
                       'Sort(Filter(MS_Products, Active = true, varCategory = "All" || Category.Value = varCategory, '
                       'IsBlank(txtSearch.Text) || txtSearch.Text in Title || txtSearch.Text in Description), Title)',
                       [
                           card_rect('rectProduct'),
                           ctl('imgProduct', 'Image', {'Image': 'ThisItem.PhotoUrl', 'ImagePosition': 'ImagePosition.Fit',
                                                       'Fill': 'clrBg', 'X': 12, 'Y': 12, 'Width': 'Parent.TemplateWidth - 24', 'Height': 120}),
                           label('lblProductCategory', 'ThisItem.Category.Value', 9, 'clrMuted', True, X=20, Y=20, Width=110, Height=22,
                                 Fill='clrSurface', Align='Align.Center'),
                           label('lblProductName', 'ThisItem.Title', 12, 'clrText', True, X=12, Y=140, Width='Parent.TemplateWidth - 24', Height=24),
                           label('lblProductDesc', 'ThisItem.Description', 10, 'clrMuted', X=12, Y=164,
                                 Width='Parent.TemplateWidth - 24', Height=40, VerticalAlign='VerticalAlign.Top'),
                           label('lblProductDot', '"●"', 12, 'clrGreen', X=12, Y=208, Width=18, Height=28),
                           label('lblProductPrice', 'ThisItem.Price', 15, 'clrText', True, X=30, Y=208, Width=90, Height=28),
                           label('lblProductStock', 'If(ThisItem.Stock <= 0, "Out of stock", ThisItem.Stock & " in stock")', 9,
                                 'If(ThisItem.Stock <= 5, clrDanger, clrMuted)', X='Parent.TemplateWidth - 132', Y=208, Width=120,
                                 Height=28, Align='Align.Right'),
                           button('btnAddToCart',
                                  f'If(ThisItem.Stock <= 0, "Out of stock", ThisItem.Stock - {in_cart} <= 0, "All in your cart", '
                                  f'ThisItem.Price > {remaining}, "Need " & (ThisItem.Price - ({remaining})) & " more tokens", "Add to cart")',
                                  'If(IsBlank(LookUp(colCart, ProductID = ThisItem.ID)),\n'
                                  '    Collect(colCart, {ProductID: ThisItem.ID, Title: ThisItem.Title, Price: ThisItem.Price, Qty: 1}),\n'
                                  '    Patch(colCart, LookUp(colCart, ProductID = ThisItem.ID), {Qty: LookUp(colCart, ProductID = ThisItem.ID).Qty + 1})\n'
                                  ');\n'
                                  'Notify(ThisItem.Title & " added to your cart", NotificationType.Success, 2000)',
                                  DisplayMode=f'If({cannot}, DisplayMode.Disabled, DisplayMode.Edit)',
                                  X=12, Y=244, Width='Parent.TemplateWidth - 24', Height=40),
                       ],
                       template=300, WrapCount='Max(1, RoundDown(Self.Width / 240, 0))', FillPortions=1, LayoutMinHeight=300)
    return screen(s, [hero, search, cats, products])


def cart():
    s = 'Cart'
    lines = gallery('galCart', 'colCart', [
        card_rect('rectCartLine'),
        label('lblCartName', 'ThisItem.Title', 12, 'clrText', True, X=16, Y=10, Width='Parent.TemplateWidth - 200', Height=26),
        label('lblCartEach', 'ThisItem.Price & " tokens each"', 10, 'clrMuted', X=16, Y=36, Width='Parent.TemplateWidth - 200', Height=22),
        button('btnCartMinus', '"−"', 'If(ThisItem.Qty <= 1, Remove(colCart, ThisItem), Patch(colCart, ThisItem, {Qty: ThisItem.Qty - 1}))',
               fill='clrSurface', color='clrText', BorderColor='clrBorder', X='Parent.TemplateWidth - 168', Y=12, Width=44, Height=44),
        label('lblCartQty', 'ThisItem.Qty', 13, 'clrText', True, X='Parent.TemplateWidth - 120', Y=12, Width=48, Height=44, Align='Align.Center'),
        button('btnCartPlus', '"+"',
               'If(ThisItem.Qty < LookUp(MS_Products, ID = ThisItem.ProductID, Stock),\n'
               '    Patch(colCart, ThisItem, {Qty: ThisItem.Qty + 1}),\n'
               '    Notify("No more in stock", NotificationType.Warning)\n)',
               fill='clrSurface', color='clrText', BorderColor='clrBorder', X='Parent.TemplateWidth - 68', Y=12, Width=44, Height=44),
    ], template=72, FillPortions=1, LayoutMinHeight=200)
    total = 'Sum(colCart, Price * Qty)'
    summary = vbox('conCartSummary', [
        label('lblCartTotal', f'"Total: " & {total} & " tokens"', 14, 'clrText', True, Height=30),
        label('lblCartAfter', f'"Balance after checkout: " & (fxBalance - {total}) & " tokens"', 11,
              f'If(fxBalance - {total} < 0, clrDanger, clrMuted)', Height=26),
    ], Fill='clrSurface', Height=92, PaddingTop=12, PaddingBottom=12, PaddingLeft=16, PaddingRight=16, LayoutGap=4,
        BorderColor='clrBorder', BorderThickness=1, **radius(12))
    checkout = button('btnCheckout', f'If(varBusy, "Placing your order…", "Checkout (" & {total} & " tokens)")',
                      'Set(varBusy, true);\n'
                      'Set(varResult, MSPlaceOrder.Run(JSON(ShowColumns(colCart, ProductID, Qty), JSONFormat.Compact)));\n'
                      'Set(varBusy, false);\n'
                      'If(varResult.ok = "yes",\n'
                      '    Clear(colCart);\n'
                      '    Refresh(MS_TokenLedger); Refresh(MS_Orders); Refresh(MS_Products);\n'
                      '    Notify(varResult.message & ". Check your email for the pickup QR code.", NotificationType.Success);\n'
                      '    Navigate(scrOrders, ScreenTransition.None),\n'
                      '    Notify(varResult.message, NotificationType.Error)\n'
                      ')',
                      DisplayMode=f'If(varBusy || CountRows(colCart) = 0 || fxBalance < {total}, DisplayMode.Disabled, DisplayMode.Edit)',
                      Height=52, Size=13)
    back = button('btnContinueShopping', '"Continue shopping"', 'Navigate(scrShop, ScreenTransition.None)',
                  fill='clrSurface', color='clrText', BorderColor='clrBorder')
    empty = label('lblCartEmpty', '"Your cart is empty."', 11, 'clrMuted', Height=30, Visible='CountRows(colCart) = 0')
    return screen(s, [title('lblCartTitle', '"Your cart"'), empty, lines, summary, checkout, back])


def orders():
    s = 'Orders'
    qr = ('fxQrBase & EncodeUrl(fxAppLink & If(Find("?", fxAppLink) > 0, "&", "?") & "code=" & ThisItem.PickupCode)')
    status_fill = ('Switch(ThisItem.Status.Value, "Processing", clrBlueSoft, "Ready", clrSoftGreen, '
                   '"Cancelled", clrDangerSoft, clrBg)')
    status_color = ('Switch(ThisItem.Status.Value, "Processing", clrBlue, "Ready", clrDarkGreen, '
                    '"Cancelled", clrDanger, clrMuted)')
    cancel = ('If(varConfirmCancel = ThisItem.ID,\n'
              '    Set(varResult, MSCancelOrder.Run(ThisItem.ID));\n'
              '    Set(varConfirmCancel, Blank());\n'
              '    If(varResult.ok = "yes",\n'
              '        Refresh(MS_Orders); Refresh(MS_TokenLedger); Refresh(MS_Products);\n'
              '        Notify(varResult.message, NotificationType.Success),\n'
              '        Notify(varResult.message, NotificationType.Error)\n'
              '    ),\n'
              '    Set(varConfirmCancel, ThisItem.ID)\n'
              ')')
    gal = gallery('galOrders', 'Sort(Filter(MS_Orders, StaffEmail = fxEmail), ID, SortOrder.Descending)', [
        card_rect('rectOrder'),
        label('lblOrderNumber', 'ThisItem.Title', 13, 'clrText', True, X=16, Y=12, Width='Parent.TemplateWidth - 160', Height=26),
        label('lblOrderMeta', 'Text(ThisItem.Created, "d mmm yyyy") & " · " & ThisItem.Total & " tokens"', 10, 'clrMuted',
              X=16, Y=38, Width='Parent.TemplateWidth - 160', Height=22),
        label('lblOrderStatus', 'ThisItem.Status.Value', 10, status_color, True, Fill=status_fill, Align='Align.Center',
              X='Parent.TemplateWidth - 132', Y=14, Width=116, Height=28),
        label('lblOrderItems', 'ThisItem.ItemsSummary', 11, 'clrText', X=16, Y=64, Width='Parent.TemplateWidth - 32', Height=24),
        ctl('imgOrderQr', 'Image', {'Image': qr, 'Visible': f'{ACTIVE_ORDER} && !IsBlank(ThisItem.PickupCode)',
                                    'ImagePosition': 'ImagePosition.Fit', 'Fill': WHITE, 'BorderColor': 'clrBlack',
                                    'BorderThickness': 2, 'X': 16, 'Y': 96, 'Width': 140, 'Height': 140}),
        label('lblOrderShowThis', '"Show this at the collection desk"', 11, 'clrText', True, Visible=ACTIVE_ORDER,
              X=172, Y=100, Width='Parent.TemplateWidth - 188', Height=24),
        label('lblOrderCode', 'Left(ThisItem.PickupCode, 4) & "-" & Right(ThisItem.PickupCode, 4)', 20, 'clrText', True,
              Font="Font.'Courier New'", Visible=ACTIVE_ORDER, X=172, Y=124, Width='Parent.TemplateWidth - 188', Height=36),
        label('lblOrderCollect',
              'If(IsBlank(ThisItem.CollectionDate), "Collection date to be confirmed. We\'ll email you.", '
              '"Collect on " & Text(ThisItem.CollectionDate, "dddd, d mmmm yyyy") & Char(10) & ThisItem.CollectionLocation)',
              10, WHITE, Fill='clrBlack', Visible=ACTIVE_ORDER, PaddingLeft=10, X=172, Y=166,
              Width='Parent.TemplateWidth - 188', Height=48),
        button('btnOrderCancel', 'If(varConfirmCancel = ThisItem.ID, "Tap again to cancel", "Cancel & refund")', cancel,
               fill='clrSurface', color='clrDanger', BorderColor='clrDanger', Visible='ThisItem.Status.Value = "Pending"',
               X=172, Y=222, Width=180, Height=36),
    ], template=272, FillPortions=1, LayoutMinHeight=300)
    empty = label('lblOrdersEmpty', '"No orders yet. Visit the Shop to pick something."', 11, 'clrMuted', Height=30,
                  Visible='CountRows(galOrders.AllItems) = 0')
    return screen(s, [title('lblOrdersTitle', '"My orders"'), empty, gal])


def wallet():
    s = 'Wallet'
    summary = vbox('conWalletSummary', [
        label('lblWalletEyebrow', '"BALANCE"', 9, 'clrGreen', True, Height=20),
        label('lblWalletAmount', 'fxBalance & " tokens"', 26, WHITE, True, Height=48),
    ], Fill='clrBlack', Height=110, PaddingTop=16, PaddingBottom=16, PaddingLeft=20, PaddingRight=20, LayoutGap=2, **radius(16))
    gal = gallery('galLedger', 'Sort(Filter(MS_TokenLedger, StaffEmail = fxEmail), ID, SortOrder.Descending)', [
        card_rect('rectLedger'),
        label('lblLedgerReason', 'ThisItem.Title', 12, 'clrText', True, X=16, Y=8, Width='Parent.TemplateWidth - 140', Height=26),
        label('lblLedgerMeta', 'ThisItem.EntryType.Value & " · " & Text(ThisItem.Created, "d mmm yyyy") & '
              'If(IsBlank(ThisItem.AwardedBy), "", " · from " & ThisItem.AwardedBy)', 10, 'clrMuted',
              X=16, Y=34, Width='Parent.TemplateWidth - 140', Height=22),
        label('lblLedgerAmount', 'If(ThisItem.Amount > 0, "+", "") & ThisItem.Amount', 15,
              'If(ThisItem.Amount > 0, clrDarkGreen, clrDanger)', True, Align='Align.Right',
              X='Parent.TemplateWidth - 120', Y=14, Width=104, Height=36),
    ], template=68, FillPortions=1, LayoutMinHeight=200)
    return screen(s, [title('lblWalletTitle', '"My wallet"'), summary, gal])


def help_screen():
    s = 'Help'
    search = ctl('txtFaqSearch', 'TextInput', {'Default': '""', 'HintText': '"Search questions"', 'Font': FONT, 'Size': 11,
                                                'Height': 44, 'DelayOutput': 'true', 'BorderColor': 'clrBorder', **radius(10)})
    gal = gallery('galFaqs', 'Filter(MS_FAQs, IsBlank(txtFaqSearch.Text) || txtFaqSearch.Text in Title || txtFaqSearch.Text in Answer)', [
        card_rect('rectFaq'),
        label('lblFaqQuestion', 'ThisItem.Title', 12, 'clrText', True, X=16, Y=10, Width='Parent.TemplateWidth - 32', Height=26),
        label('lblFaqAnswer', 'ThisItem.Answer', 10, 'clrMuted', X=16, Y=38, Width='Parent.TemplateWidth - 32', Height=74,
              VerticalAlign='VerticalAlign.Top'),
    ], template=124, FillPortions=1, LayoutMinHeight=200)
    contact = label('lblHelpContact', '"Can\'t find your answer? Contact the HR / People team or any store admin."', 10, 'clrMuted', Height=30)
    return screen(s, [title('lblHelpTitle', '"Help & FAQs"'), search, gal, contact])


def checkin():
    s = 'Checkin'
    find = FIND_ORDER.format(src='txtCheckinCode.Text') + ';\nReset(txtCheckinCode)'
    row = hbox('conCheckinInput', [
        ctl('txtCheckinCode', 'TextInput', {'Default': '""', 'HintText': '"Type or scan the pickup code, e.g. K7PX-9M2Q"', 'Font': FONT,
                                            'Size': 13, 'Height': 52, 'FillPortions': 1, 'BorderColor': 'clrBorder', **radius(10)}),
        button('btnCheckinFind', '"Find order"', find, Width=130, Height=52),
    ], Height=60, LayoutGap=8)
    banner_text = ('If(IsBlank(varScanned), "No order has this pickup code. Check the code, or search by name in Admin.",\n'
                   '    Switch(varScanned.Status.Value,\n'
                   '        "Ready", "Ready for collection",\n'
                   '        "Collected", "Already collected" & If(IsBlank(varScanned.CollectedAt), "", " on " & Text(varScanned.CollectedAt, "d mmm, hh:mm")) & ". Do not hand it over again.",\n'
                   '        "Cancelled", "Cancelled and refunded. Do not hand anything over.",\n'
                   '        "Still " & varScanned.Status.Value & ", not marked ready. Check it has been packed."\n'
                   '    )\n)')
    kind = 'If(IsBlank(varScanned) || varScanned.Status.Value in ["Collected", "Cancelled"], "stop", varScanned.Status.Value = "Ready", "ok", "warn")'
    collect = ('Set(varResult, MSUpdateOrders.Run("[" & Text(varScanned.ID) & "]", "Collected"));\n'
               'If(varResult.ok = "yes" && Value(varResult.updated) = 1,\n'
               '    Collect(colCheckedIn, {Name: varScanned.StaffName, Items: varScanned.ItemsSummary, At: Now()});\n'
               '    Refresh(MS_Orders);\n'
               '    Set(varScanned, LookUp(MS_Orders, ID = varScanned.ID));\n'
               '    Notify("Collected. Hand over the items.", NotificationType.Success),\n'
               '    Notify(varResult.message, NotificationType.Error)\n'
               ')')
    result = vbox('conCheckinResult', [
        label('lblCheckinBanner', banner_text, 12,
              f'Switch({kind}, "ok", clrDarkGreen, "warn", clrWarn, clrDanger)', True,
              Fill=f'Switch({kind}, "ok", clrSoftGreen, "warn", clrWarnSoft, clrDangerSoft)', PaddingLeft=12, Height=52),
        label('lblCheckinName', 'varScanned.StaffName & " · " & varScanned.Title', 18, 'clrText', True, Height=36,
              Visible='!IsBlank(varScanned)'),
        label('lblCheckinItems', 'varScanned.ItemsSummary', 14, 'clrText', Height=56, Visible='!IsBlank(varScanned)',
              VerticalAlign='VerticalAlign.Top'),
        label('lblCheckinWhen', '"Collection: " & If(IsBlank(varScanned.CollectionDate), "not scheduled", '
              'Text(varScanned.CollectionDate, "ddd d mmm yyyy") & " · " & varScanned.CollectionLocation)', 10, 'clrMuted',
              Height=24, Visible='!IsBlank(varScanned)'),
        button('btnCheckinCollect', 'If(varScanned.Status.Value = "Ready", "Hand over & mark collected", "Mark collected anyway")',
               collect, Visible='!IsBlank(varScanned) && varScanned.Status.Value in ["Pending", "Processing", "Ready"]',
               fill='If(varScanned.Status.Value = "Ready", clrDarkGreen, clrSurface)',
               color=f'If(varScanned.Status.Value = "Ready", {WHITE}, clrText)', Height=56, Size=13),
    ], Visible='!IsBlank(varScanCode)', Fill='clrSurface', Height=260, PaddingTop=16, PaddingBottom=16, PaddingLeft=16,
        PaddingRight=16, LayoutGap=8, BorderColor=f'Switch({kind}, "ok", clrDarkGreen, "warn", clrWarn, clrDanger)',
        BorderThickness=2, **radius(14))
    log = gallery('galCheckedIn', 'Sort(colCheckedIn, At, SortOrder.Descending)', [
        label('lblCheckedInRow', 'Text(ThisItem.At, "hh:mm") & " · " & ThisItem.Name & " · " & ThisItem.Items', 10, 'clrText',
              X=0, Y=0, Width='Parent.TemplateWidth', Height=28),
    ], template=30, FillPortions=1, LayoutMinHeight=120)
    hint = label('lblCheckinHint', '"Scan with the Barcode reader button, a USB scanner (click in the box first), '
                 'or a phone camera opening the QR link. No code? Search by name in Admin."', 10, 'clrMuted', Height=44)
    return screen(s, [title('lblCheckinTitle', '"Collection desk check-in"'), row, hint, result,
                      label('lblCheckedInTitle', '"Checked in this session"', 12, 'clrText', True, Height=28), log])


def admin():
    s = 'Admin'
    tabs = hbox('conAdminTabs', [
        button(f'btnTab{key}', f'"{text}"', f'Set(varAdminTab, "{key}")',
               fill=f'If(varAdminTab = "{key}", clrBlack, clrSurface)',
               color=f'If(varAdminTab = "{key}", {WHITE}, clrText)', BorderColor='clrBorder', Width=width, Height=40)
        for key, text, width in [('Orders', 'Orders', 110), ('Award', 'Award tokens', 140), ('Lists', 'Products & days', 160)]
    ], Height=48, LayoutGap=6)

    # --- Orders tab
    days = gallery('galAdminDays',
                   'Ungroup(Table(\n'
                   '    {x: Table({ID: -1, Label: "Not scheduled"})},\n'
                   '    {x: ForAll(Sort(Filter(MS_CollectionDays, DayDate >= Today() - 7), DayDate, SortOrder.Ascending),\n'
                   '        {ID: ID, Label: Text(DayDate, "ddd d mmm") & " · " & Title})}\n'
                   '), x)',
                   [button('btnAdminDay', 'ThisItem.Label', 'Set(varAdminDay, ThisItem.ID); Clear(colSelected)',
                           fill='If(varAdminDay = ThisItem.ID, clrDarkGreen, clrSurface)',
                           color=f'If(varAdminDay = ThisItem.ID, {WHITE}, clrText)', BorderColor='clrBorder',
                           X=0, Y=0, Width='Parent.TemplateWidth', Height=40, **radius(20))],
                   template=48, WrapCount='Max(1, RoundDown(Self.Width / 200, 0))', Height=100, TemplatePadding=4)
    statuses = hbox('conAdminStatus', [
        button(f'btnStatus{key.replace(" ", "")}', f'"{key}"', f'Set(varAdminStatus, "{key}"); Clear(colSelected)',
               fill=f'If(varAdminStatus = "{key}", clrSoftGreen, clrSurface)',
               color=f'If(varAdminStatus = "{key}", clrDarkGreen, clrMuted)', BorderColor='clrBorder', Width=110, Height=36, **radius(18))
        for key in ['To do', 'Collected', 'All']
    ] + [
        label('lblStatusSpacer', '""', FillPortions=1, Height=36),
        button('btnSelectAll', '"Select all"',
               'ClearCollect(colSelected, ForAll(Filter(galAdminOrders.AllItems, Status.Value <> "Cancelled"), {ID: ID}))',
               fill='clrSurface', color='clrText', BorderColor='clrBorder', Width=110, Height=36),
        button('btnPickList', 'If(varShowPickList, "Hide pick list", "Pick list")', 'Set(varShowPickList, !varShowPickList)',
               fill='clrBlack', Width=130, Height=36),
    ], Height=44, LayoutGap=6)
    day_filter = 'If(varAdminDay = -1, IsBlank(CollectionDayID), CollectionDayID = varAdminDay)'
    items = ('Sort(\n'
             '    Switch(varAdminStatus,\n'
             f'        "To do", Filter(MS_Orders, {day_filter}, Status.Value = "Pending" || Status.Value = "Processing" || Status.Value = "Ready"),\n'
             f'        "Collected", Filter(MS_Orders, {day_filter}, Status.Value = "Collected"),\n'
             f'        Filter(MS_Orders, {day_filter})\n'
             '    ),\n'
             '    ID, SortOrder.Descending\n)')
    selected = 'ThisItem.ID in colSelected.ID'
    next_status = 'Switch(ThisItem.Status.Value, "Pending", "Processing", "Processing", "Ready", "Ready", "Collected", "")'
    orders_gal = gallery('galAdminOrders', items, [
        card_rect('rectAdminOrder'),
        button('btnAdminSelect', f'If({selected}, "✓", "")',
               f'If({selected}, Remove(colSelected, LookUp(colSelected, ID = ThisItem.ID)), Collect(colSelected, {{ID: ThisItem.ID}}))',
               fill=f'If({selected}, clrDarkGreen, clrSurface)', color=WHITE, BorderColor='clrBorder',
               DisplayMode='If(ThisItem.Status.Value = "Cancelled", DisplayMode.Disabled, DisplayMode.Edit)',
               X=12, Y=18, Width=36, Height=36, **radius(6)),
        label('lblAdminOrderNo', 'ThisItem.Title & " · " & ThisItem.StaffName', 12, 'clrText', True,
              X=60, Y=8, Width='Parent.TemplateWidth - 330', Height=26),
        label('lblAdminOrderItems', 'ThisItem.ItemsSummary & " · " & ThisItem.Total & " tokens"', 10, 'clrMuted',
              X=60, Y=34, Width='Parent.TemplateWidth - 330', Height=36, VerticalAlign='VerticalAlign.Top'),
        label('lblAdminOrderStatus', 'ThisItem.Status.Value', 10,
              'Switch(ThisItem.Status.Value, "Processing", clrBlue, "Ready", clrDarkGreen, "Cancelled", clrDanger, clrMuted)', True,
              Fill='Switch(ThisItem.Status.Value, "Processing", clrBlueSoft, "Ready", clrSoftGreen, "Cancelled", clrDangerSoft, clrBg)',
              Align='Align.Center', X='Parent.TemplateWidth - 262', Y=22, Width=100, Height=28),
        button('btnAdminNext', 'Switch(ThisItem.Status.Value, "Pending", "Start preparing", "Processing", "Mark ready", "Ready", "Collected", "")',
               f'Set(varResult, MSUpdateOrders.Run("[" & ThisItem.ID & "]", {next_status}));\n'
               'Notify(varResult.message, If(varResult.ok = "yes", NotificationType.Success, NotificationType.Error));\n'
               'Refresh(MS_Orders)',
               Visible=f'{next_status} <> ""', X='Parent.TemplateWidth - 152', Y=18, Width=140, Height=36),
    ], template=76, FillPortions=1, LayoutMinHeight=240)

    picklist = vbox('conPickList', [
        label('lblPickListTitle', '"Pick list: items to pull from storage (" & CountRows(galAdminOrders.AllItems) & " orders)"', 12,
              'clrText', True, Height=28),
        gallery('galPickList',
                'Sort(AddColumns(GroupBy(Filter(MS_OrderLines, OrderID in galAdminOrders.AllItems.ID), Title, Lines), '
                'Total, Sum(Lines, Qty)), Title)',
                [label('lblPickRow', 'ThisItem.Total & " × " & ThisItem.Title', 12, 'clrText',
                       X=0, Y=0, Width='Parent.TemplateWidth', Height=30)],
                template=32, FillPortions=1, LayoutMinHeight=120),
        button('btnPrintPickList', '"Print"', 'Print()', fill='clrBlack', Width=120, Height=40),
    ], Visible='varShowPickList', Fill='clrSurface', Height=260, PaddingTop=12, PaddingBottom=12, PaddingLeft=16,
        PaddingRight=16, LayoutGap=6, BorderColor='clrBorder', BorderThickness=1, **radius(12))

    def bulk(status):
        return button(f'btnBulk{status}', f'"Mark {status.lower()}"',
                      f'Set(varResult, MSUpdateOrders.Run("[" & Concat(colSelected, Text(ID), ",") & "]", "{status}"));\n'
                      'Notify(varResult.message, If(varResult.ok = "yes", NotificationType.Success, NotificationType.Error));\n'
                      'Clear(colSelected);\n'
                      'Refresh(MS_Orders)',
                      fill='clrGreen' if status == 'Ready' else 'clrBlack',
                      color='clrBlack' if status == 'Ready' else WHITE,
                      BorderColor='RGBA(255, 255, 255, 0.3)', Width=150, Height=40)
    bulk_bar = hbox('conBulkBar', [
        label('lblBulkCount', 'CountRows(colSelected) & " selected"', 11, WHITE, True, Width=110, Height=40),
        bulk('Processing'), bulk('Ready'), bulk('Collected'),
        button('btnBulkClear', '"Clear"', 'Clear(colSelected)', fill='clrBlack', color='RGBA(208, 208, 206, 1)',
               BorderColor='clrBlack', Width=80, Height=40),
    ], Visible='CountRows(colSelected) > 0', Fill='clrBlack', Height=56, PaddingLeft=12, PaddingRight=12, LayoutGap=6, **radius(12))
    orders_tab = vbox('conAdminOrdersTab', [days, statuses, picklist, orders_gal, bulk_bar],
                      Visible='varAdminTab = "Orders"', FillPortions=1, LayoutGap=8)

    # --- Award tab (insert the Combo box "cmbPeople" yourself: see the build guide)
    award_ok = 'Value(txtAwardAmount.Text) > 0 && !IsBlank(Trim(txtAwardReason.Text)) && CountRows(cmbPeople.SelectedItems) > 0'
    award_tab = vbox('conAdminAwardTab', [
        label('lblAwardHelp', '"Recognise staff with appreciation tokens. Pick people in the box below (Combo box cmbPeople), '
              'then enter the amount and reason. Each person gets an email."', 11, 'clrMuted', Height=48),
        ctl('txtAwardAmount', 'TextInput', {'Default': '""', 'HintText': '"Tokens, e.g. 50"', 'Format': 'TextFormat.Number',
                                            'Font': FONT, 'Size': 12, 'Height': 44, 'BorderColor': 'clrBorder', **radius(10)}),
        ctl('txtAwardReason', 'TextInput', {'Default': '""', 'HintText': '"Reason, e.g. Great job on the client launch"',
                                            'Font': FONT, 'Size': 12, 'Height': 44, 'BorderColor': 'clrBorder', **radius(10)}),
        button('btnAward', '"Award tokens"',
               'Set(varResult, MSAwardTokens.Run(\n'
               '    "[" & Concat(cmbPeople.SelectedItems, Char(34) & Lower(Mail) & Char(34), ",") & "]",\n'
               '    Value(txtAwardAmount.Text),\n'
               '    txtAwardReason.Text\n'
               '));\n'
               'Notify(varResult.message, If(varResult.ok = "yes", NotificationType.Success, NotificationType.Error));\n'
               'If(varResult.ok = "yes", Reset(cmbPeople); Reset(txtAwardAmount); Reset(txtAwardReason))',
               DisplayMode=f'If({award_ok}, DisplayMode.Edit, DisplayMode.Disabled)', Height=48),
    ], Visible='varAdminTab = "Award"', FillPortions=1, LayoutGap=10)

    # --- Products & collection days are edited in SharePoint (grid view = bulk upload from Excel)
    def open_list(key, text, list_name):
        return button(f'btnOpen{key}', f'"{text}"', f'Launch(fxSiteUrl & "/Lists/{list_name}/AllItems.aspx")',
                      fill='clrSurface', color='clrText', BorderColor='clrBorder', Height=44)
    lists_tab = vbox('conAdminListsTab', [
        label('lblListsHelp', '"Products, stock and collection days are edited in SharePoint. Use Edit in grid view to paste '
              'many rows from Excel at once (bulk upload and restock)."', 11, 'clrMuted', Height=48),
        open_list('Products', 'Open Products list', 'MS_Products'),
        open_list('Days', 'Open Collection days list', 'MS_CollectionDays'),
        open_list('Faqs', 'Open FAQs list', 'MS_FAQs'),
        open_list('Admins', 'Open Admins list', 'MS_Admins'),
    ], Visible='varAdminTab = "Lists"', FillPortions=1, LayoutGap=8)

    return screen(s, [title('lblAdminTitle', '"Admin"'), tabs, orders_tab, award_tab, lists_tab])


SCREENS = {'scrShop': shop, 'scrCart': cart, 'scrOrders': orders, 'scrWallet': wallet,
           'scrHelp': help_screen, 'scrCheckin': checkin, 'scrAdmin': admin}

if __name__ == '__main__':
    OUT.mkdir(exist_ok=True)
    for name, build in SCREENS.items():
        text = '\n'.join(emit(build())) + '\n'
        (OUT / f'{name}.pa.yaml').write_text(text, encoding='utf-8')
        print(f'wrote screens/{name}.pa.yaml ({text.count(chr(10))} lines)')

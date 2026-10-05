<#
  Creates the 7 Merch Store lists with their columns and indexes, then loads the sample data.

  Requirements (for IT):
    - PowerShell 7+ and the PnP.PowerShell module:  Install-Module PnP.PowerShell -Scope CurrentUser
    - An Entra ID app registration for PnP (PnP's shared app was retired in 2024). See
      https://pnp.github.io/powershell/articles/registerapplication.html
    - The site already exists, and you are an Owner of it.

  Usage:
    ./create-lists.ps1 -SiteUrl https://contoso.sharepoint.com/sites/MerchStore -ClientId <app-id>
    ./create-lists.ps1 ... -SkipSampleData      # lists only
#>
param(
  [Parameter(Mandatory)] [string] $SiteUrl,
  [Parameter(Mandatory)] [string] $ClientId,
  [switch] $SkipSampleData
)
$ErrorActionPreference = 'Stop'
Connect-PnPOnline -Url $SiteUrl -ClientId $ClientId -Interactive

function New-MsList([string] $Name) {
  if (-not (Get-PnPList -Identity $Name -ErrorAction SilentlyContinue)) {
    New-PnPList -Title $Name -Template GenericList -OnQuickLaunch:$false | Out-Null
    Write-Host "Created list $Name"
  } else { Write-Host "List $Name already exists, adding any missing columns" }
}

function Add-MsField([string] $List, [string] $Name, [string] $Type, [hashtable] $Extra = @{}) {
  if (Get-PnPField -List $List -Identity $Name -ErrorAction SilentlyContinue) { return }
  $params = @{ List = $List; DisplayName = $Name; InternalName = $Name; Type = $Type; AddToDefaultView = $true }
  Add-PnPField @params @Extra | Out-Null
}

function Set-MsIndexed([string] $List, [string] $Name, [switch] $Unique) {
  $values = @{ Indexed = $true }
  if ($Unique) { $values.EnforceUniqueValues = $true }
  Set-PnPField -List $List -Identity $Name -Values $values | Out-Null
}

# 1. Products
New-MsList 'MS_Products'
Add-MsField 'MS_Products' 'Description' 'Note'
Add-MsField 'MS_Products' 'Category' 'Choice' @{ Choices = 'Apparel', 'Bags', 'Drinkware', 'Desk', 'Stationery', 'Tech' }
Add-MsField 'MS_Products' 'Price' 'Number'
Add-MsField 'MS_Products' 'Stock' 'Number'
Add-MsField 'MS_Products' 'Active' 'Boolean'
Add-MsField 'MS_Products' 'PhotoUrl' 'URL'
Set-PnPField -List 'MS_Products' -Identity 'Active' -Values @{ DefaultValue = '1' } | Out-Null

# 2. Collection days
New-MsList 'MS_CollectionDays'
Add-MsField 'MS_CollectionDays' 'DayDate' 'DateTime'
Set-PnPField -List 'MS_CollectionDays' -Identity 'DayDate' -Values @{ DisplayFormat = 0 } | Out-Null   # 0 = date only
Add-MsField 'MS_CollectionDays' 'StartTime' 'Text'
Add-MsField 'MS_CollectionDays' 'EndTime' 'Text'
Add-MsField 'MS_CollectionDays' 'Notes' 'Text'
Set-MsIndexed 'MS_CollectionDays' 'DayDate'

# 3. Orders
New-MsList 'MS_Orders'
Add-MsField 'MS_Orders' 'StaffEmail' 'Text'
Add-MsField 'MS_Orders' 'StaffName' 'Text'
Add-MsField 'MS_Orders' 'Total' 'Number'
Add-MsField 'MS_Orders' 'Status' 'Choice' @{ Choices = 'Pending', 'Processing', 'Ready', 'Collected', 'Cancelled' }
Set-PnPField -List 'MS_Orders' -Identity 'Status' -Values @{ DefaultValue = 'Pending' } | Out-Null
Add-MsField 'MS_Orders' 'PickupCode' 'Text'
Add-MsField 'MS_Orders' 'ItemsSummary' 'Note'
Add-MsField 'MS_Orders' 'CollectionDayID' 'Number'
Add-MsField 'MS_Orders' 'CollectionDate' 'DateTime'
Set-PnPField -List 'MS_Orders' -Identity 'CollectionDate' -Values @{ DisplayFormat = 0 } | Out-Null
Add-MsField 'MS_Orders' 'CollectionLocation' 'Text'
Add-MsField 'MS_Orders' 'CollectedAt' 'DateTime'
Add-MsField 'MS_Orders' 'ReminderSent' 'Boolean'
Set-PnPField -List 'MS_Orders' -Identity 'ReminderSent' -Values @{ DefaultValue = '0' } | Out-Null
Set-MsIndexed 'MS_Orders' 'StaffEmail'
Set-MsIndexed 'MS_Orders' 'Status'
Set-MsIndexed 'MS_Orders' 'PickupCode' -Unique
Set-MsIndexed 'MS_Orders' 'CollectionDate'

# 4. Order lines
New-MsList 'MS_OrderLines'
Add-MsField 'MS_OrderLines' 'OrderID' 'Number'
Add-MsField 'MS_OrderLines' 'ProductID' 'Number'
Add-MsField 'MS_OrderLines' 'Qty' 'Number'
Add-MsField 'MS_OrderLines' 'UnitPrice' 'Number'
Set-MsIndexed 'MS_OrderLines' 'OrderID'

# 5. Token ledger
New-MsList 'MS_TokenLedger'
Add-MsField 'MS_TokenLedger' 'StaffEmail' 'Text'
Add-MsField 'MS_TokenLedger' 'Amount' 'Number'
Add-MsField 'MS_TokenLedger' 'EntryType' 'Choice' @{ Choices = 'Award', 'Purchase', 'Refund', 'Adjustment' }
Add-MsField 'MS_TokenLedger' 'OrderID' 'Number'
Add-MsField 'MS_TokenLedger' 'AwardedBy' 'Text'
Set-MsIndexed 'MS_TokenLedger' 'StaffEmail'

# 6. FAQs
New-MsList 'MS_FAQs'
Add-MsField 'MS_FAQs' 'Answer' 'Note'

# 7. Admins
New-MsList 'MS_Admins'

if (-not $SkipSampleData) {
  $data = Join-Path $PSScriptRoot 'sample-data'
  function Import-MsCsv([string] $List, [scriptblock] $Map) {
    if ((Get-PnPListItem -List $List -PageSize 1 | Measure-Object).Count -gt 0) { Write-Host "$List already has items, skipping sample data"; return }
    Import-Csv (Join-Path $data "$List.csv") | ForEach-Object { Add-PnPListItem -List $List -Values (& $Map $_) | Out-Null }
    Write-Host "Loaded sample data into $List"
  }
  Import-MsCsv 'MS_Products' { param($r) @{ Title = $r.Title; Description = $r.Description; Category = $r.Category; Price = [int]$r.Price; Stock = [int]$r.Stock; Active = ($r.Active -eq 'Yes') } }
  Import-MsCsv 'MS_CollectionDays' { param($r) @{ Title = $r.Title; DayDate = $r.DayDate; StartTime = $r.StartTime; EndTime = $r.EndTime; Notes = $r.Notes } }
  Import-MsCsv 'MS_FAQs' { param($r) @{ Title = $r.Title; Answer = $r.Answer } }
  Import-MsCsv 'MS_Admins' { param($r) @{ Title = $r.Title.ToLower() } }
  Import-MsCsv 'MS_TokenLedger' { param($r) @{ Title = $r.Title; StaffEmail = $r.StaffEmail.ToLower(); Amount = [int]$r.Amount; EntryType = $r.EntryType; AwardedBy = $r.AwardedBy } }
}
Write-Host 'Done. Next: build the flows in ../2-flows.'

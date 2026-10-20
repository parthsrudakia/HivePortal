/**
 * The Portal Operations Guidebook — single source of truth for how every
 * automation, policy, threshold, and calculation in the portal works.
 *
 * Consumed by:
 *   • scripts/build-guidebook-pdf.mjs  → public/guidebook.pdf (Settings card)
 *   • src/lib/portal-tools/guide.ts    → the assistant's get_portal_guide tool
 *
 * Style: plain Markdown (headings ##/###, lists, **bold**, tables).
 * No file paths or code identifiers users can't act on — describe behavior.
 * Avoid backticks inside section bodies (they are template literals).
 * IMPORTANT: when a policy changes in code, update the matching section here
 * and re-run `node scripts/build-guidebook-pdf.mjs`, then commit the PDF.
 */

export type GuidebookSection = { title: string; body: string };

export const GUIDEBOOK_TITLE = "Operations Guidebook";
export const GUIDEBOOK_UPDATED = "September 28, 2026";

export const GUIDEBOOK_SECTIONS: GuidebookSection[] = [
  {
    title: "Access & roles",
    body: `
Vineet sets each teammate's access at **Settings → Access control**. The database's row-level security follows the same settings, so a direct API call can't do more than the screen allows.

- **Sections** (Properties, Projects, Inventory, Rent Tracker, Reconciliation, Cleaning, Utilities, Agreements) are on for everyone until Vineet unticks one. A blocked section disappears from that person's navigation and its pages send them back to the dashboard.
- **Extra access** is off until Vineet grants it: Credentials, Profitability, Financial edits, Admin logs, Notification settings, Developers, and the Ops assistant.

### Master (Vineet's account)
Full access to everything, always, plus the master-only surfaces:

- **Access control**, **Reports** (portfolio collections), **Users** (invite and remove teammates), and the Settings card for the **Telegram bot log**.
- **Clear log** on the Email and Text logs, the **Total paid** column on Past Tenants, and the **moved-out utility charge popup** on the Rent Tracker.
- **Projects board admin** (reviews and approves tasks).

### What each extra access grants
- **Financial edits**: Dashboard and Rent Tracker KPI tiles, the Paid column, unit subtotals, Reconciliation runs and exports; ledger writes (adding and deleting charges, deleting payments, recording refunds, settling or dismissing moved-out balances, changing rent, pausing, transferring and moving tenants out, adding tenants); creating, editing, pausing, archiving and restoring **properties**; uploading, assigning, charging and unposting utility bills; balance reminders.
- **Credentials**: seeing the vault, revealing/copying passwords, adding, editing and deleting entries.
- **Profitability**: the per-unit P&L page and its line items.
- **Admin logs**: Audit, Email and Text logs (and the Telegram bot log by URL).
- **Notification settings**: who gets room-change emails.
- **Developers**: the API docs page.
- **Ops assistant**: the in-portal assistant chat. It acts with full portal access, so grant it carefully.

### Everyone else (staff)
Without any extra access: tenants and their rent status (Due and running Balance per tenant, but no Paid column and no aggregate totals), properties (view only), inventory and listings, cleaning, utilities log (view only), agreements, the Projects board as a member, the shared tab notepads, and this guidebook. Staff can record ordinary payments, including back-dated ones, but can never record a refund, attach a bank reference, or tie a payment to a reconciliation run.

Some staff-visible controls (contact Edit, Lease End Date) are refused by the server; they simply do nothing without Financial edits.
`,
  },
  {
    title: "Getting around the portal",
    body: `
### Dashboard
- **Properties** and **Rooms** tiles count non-archived properties and their rooms (everyone).
- **Collected this month** and **Outstanding rent** tiles are operator-only (see KPIs).
- **Outstanding rent worklist** (everyone): active tenants owing more than a cent, largest first, top 8 with "+N more".
- **Inventory** card: rooms listable today (available, or occupied with a future availability date; rooms queued for a new tenant excluded), top 12, with who posted each ad.
- **Upcoming cleaning**: non-paused, non-archived properties with last cleaned, next cleaning (editable inline), and a day counter; unscheduled units float to the top.
- **Lease ending soon**: active tenancies with no move-out date whose lease ends within 30 days, with email and phone links.

### Navigation
- **⌘K / Ctrl-K** opens the command palette: jump to any page, property, tenant (by name or email) or room. Reports and Profitability are not in the palette; reach them from Settings and the sidebar.
- The **sidebar** is drag-resizable (double-click to reset); below a certain width it snaps to an icon rail with hover labels. Width, dark/light theme, and notepad collapse state are remembered per browser.
- **Dark mode** toggle lives in the sidebar and the mobile drawer; the default follows the OS.
- On mobile, tables scroll sideways and the sidebar becomes a drawer with sign-out.

### Shared notepads
The Rent Tracker, Utilities and Inventory tabs each have one shared **Notes** box. Everyone can read and edit it, the last save wins, it holds up to 20,000 characters, and it shows who last updated it and when. Changes are audited.

### Feedback while things save
A honey progress bar and a "Saving…"/"Loading…" pill appear whenever the portal is waiting on the server, the clicked button shows a spinner, and the browser warns before you close the tab mid-save.

### Names, reminders, errors
- New users are asked for a **display name** on first visit (blocking prompt, 2–80 characters). That name is what appears as "posted by" on ads.
- A **login reminder** popup ("Reminder … Got it") can be seeded for a user by the operators through the database; it shows on the next visit once its date (or the linked tenant's move-out) arrives. There is no screen to create one.
- If any money page can't load **every** record it needs, it shows "Couldn't load this page" with a reference code instead of a possibly wrong balance. Try again; it is usually a brief database hiccup.
`,
  },
  {
    title: "Properties & rooms",
    body: `
### The property record
A property is one apartment/unit: building name (optional), street address, unit number, cross street, neighborhood, the **New York flag**, bedrooms and bathrooms, the master lease (rent, start, end), fees (amenity and misc per year; internet, cleaning and insurance per month), unit and building amenities plus free-text "other" amenities, the leaseholder (created if new), assigned cleaners, and notes.

- In the portal form only **street address and unit number** are mandatory. The Telegram bot's create-property tool insists on building name, street, unit, cross street, neighborhood, NY flag, bedrooms and bathrooms.
- **Uniqueness**: no two properties may share the same street address + unit, nor the same building name + unit (case and spacing ignored), because they would display with the same label.
- The **NY flag** decides the email channel for that unit's tenants (plain, unbranded Gmail from Vineet's personal account) and exempts them from automatic late fees.
- Only operators can create, edit, pause, delete/archive or restore a property.

### Amenities
Unit amenities: High-Speed WiFi, Central A/C, In-Unit Washer/Dryer, Fully Equipped Kitchen, Dishwasher. Building amenities: 24/7 Doorman, Fitness Center, Rooftop Terrace, Package Room, Laundry Room, Elevator, Lounge. (Courtyard, Parking Garage and Swimming Pool were retired in September 2026.) Property amenities apply to every room; **private bathroom** and **AC** are per room.

### One room per bedroom
Creating a property, or raising its bedroom count, automatically creates blank rooms "Room 1…N", status Available. You cannot add more rooms than bedrooms, and you cannot lower bedrooms below the rooms that exist. Room names must be unique within the property. A room with payment history can't be deleted ("must stay for the books").

### Room fields
Name, status, **base rent** plus **Services** (bundle, default $125; total is always base + services), available-from date, private bathroom, AC (default on), a Google Drive **photos folder link**, the paste-ready **listing description**, internal notes, and the listing workflow flags (listing action, Facebook ads, queued-for-tenant).

### Room statuses
**Available**, **Occupied**, **Reserved**, **Maintenance**. Transitions are mostly automatic:

- Adding a tenant with a future start → Reserved; with a start today or earlier → Occupied.
- The daily cron flips an upcoming tenancy to Occupied on its start date, and an ended tenancy's room to Available (listing action reset) unless someone else holds the room.
- A move-out in the past → Available; a move-out today or later keeps the room Occupied with "available from" the day after move-out.
- Cancelling a move-out, or reactivating a tenant → Occupied. Deleting a tenant → Available.
- Maintenance is only ever set by hand (room edit or the bot).

The database allows at most **one active and one upcoming tenancy per room**, so back-to-back turnover is possible but double-booking is not.

### Pausing a property
Pause every tenant there (no rent accrual, no reminders, no late fees) and take the unit off the cleaning schedule. Tenants paused this way show "Paused (property)"; resuming the property lifts only those pauses, so an individually paused tenant stays paused. Paused properties' rooms **still appear on Inventory** and in the Inventory API; only archiving hides them.

### Deleting a property
Delete requires a move-out date for every active tenant. If any money ever moved on the unit, the move-outs are applied and the property is **archived** (it lives on under Past Tenants and can be restored); if there are no books and everyone has left, it is removed outright. Archived properties disappear from the property list, Inventory, the dashboard and the API.

### Property page
Residents widget (name, room, age, profession, social links), rooms with Add tenant / Add room, the unit and lease cards (lease-end pill turns orange within 90 days, red once passed), amenities, notes, the cleaning status and log, and the unit's credentials (reveal/copy from the master account).
`,
  },
  {
    title: "Inventory & listings",
    body: `
### What counts as listable
A room is on Inventory when it is **Available**, or **Occupied with an availability date today or later**, and it is not queued for a new tenant and its property is not archived. Reserved, Maintenance and filled rooms are off the list. The dashboard's Inventory card, both downloadable sheets, the assistant's inventory list and the Inventory API all use this same rule.

### The table
Columns: Unit (links to the vacancy page), Neighborhood, Room Type (the room's name), Available, Rent, Services, Total, Amenities, Photos, Tenant (the mover-out, else the previous tenant), Listing action, Ad, Ad Posted, FB Ads, Roommates (jumps to the property's residents), Copy listing. Available, Rent, Services, Amenities, Photos, Ads and FB Ads are editable inline. The header is sticky and the left columns are frozen.

**Sorting** defaults to soonest available first ("available now" sorts before dated rooms); ties break by date, then unit, then room name so rows never swap on refresh.

**Ads posted by** pills count ads on currently-listed rooms per poster and filter the table. Ad links must be http(s) URLs; a room can hold many.

### Listing actions
| Action | Meaning |
|---|---|
| No action | Default |
| Price/date | Update the ad's price or date |
| Boost | Boost the post |
| Priority | Priority listing |
| Delete | Take the ad down |

Actions are workflow flags: they tint the row and send a room-change email to the notification recipients. **Delete** has one hard side effect: the room's Facebook-ads flag turns off and stays locked off until the action is changed. Moving out, cancelling a move-out or releasing a room resets the action to "No action".

### Facebook ads flag
Per room, On/Off. It starts **Off on every fresh listing** (a new vacancy also drops the previous cycle's ads) and is forced Off by Delete. Editing an existing move-out date keeps the ads.

### Adding a room to Inventory ("+ Add")
Pick any unlisted room. For an occupied room you give the move-out date ("Move out & list"). If someone is **scheduled to move in**, you're warned and can list anyway or cancel the move-in (operator only; blocked if that move-in already has payments). Listing a Reserved or Maintenance room this way does **not** send a room-change email.

### Removing a room (the bin icon)
- **Cancel move-out** — the tenant is staying.
- **Add a new tenant** — queues the room and opens Add Tenant.
- **Delete** — queues the room on the Add Tenant page ("Listings to fill") but keeps you on Inventory. Queued rooms can be **Restored** from Add Tenant; a stale availability date is bumped to today so the room re-enters Inventory.

Note the two different "Delete"s: the listing **action** Delete only marks the row red; the bin's Delete removes the room from Inventory.

### Vacancy page
Each listed room has a page with the availability pill, address, bedroom and bathroom counts, editable rent, the full amenity list (missing ones struck through), the copyable description, the photos link, the ads editor and the current or previous tenant's contact.

### Sheets
- **Download Shareable Sheet** — cross street, neighborhood, photos link, availability, rent, services, total, amenities, bedrooms, bathrooms. No addresses or tenants. The assistant can email it from the personal Gmail (no branding) or drop it into Telegram.
- **Download Sheet** — the full internal view including unit, tenant, listing action, ads and FB flag.

Both mirror the current sort and poster filter.

### Room-change notifications
Whenever a room's **status** or **listing action** changes (through the portal, the lifecycle cron, move-outs, or the bot), every enabled address under Settings → Notification settings gets an immediate email, subject "Room update — (unit) · (room)", saying what changed from what to what. Recipients must be existing portal users. Each event is logged with its send result. There is no 24-hour re-ping.
`,
  },
  {
    title: "Tenants & tenancies",
    body: `
### Adding a tenant
Operators only. Only the **full name** is required; email, phone, notes, age, gender, profession and up to 10 **social links** are optional. **"Pays as"** is the name exactly as the bank prints it on Zelle deposits (case doesn't matter, spelling does); leave it blank to use the full name.

Assigning a room is optional. With a room you must give **monthly rent** and a **start date**; you may also give a security deposit, a lease end date, a prorated first-month amount, and a lease PDF (up to 20 MB). Add Tenant does **not** prorate automatically — a blank "Prorated rent" charges the full month.

- Rooms offered: Available rooms and Occupied rooms with a future availability date, minus any already claimed by an active or upcoming tenancy. Reserved/Maintenance rooms are offered only when you arrive from that room's link.
- **Listings to fill** lists rooms queued from Inventory, each with Restore and Fill.
- Opening Add Tenant from a **signed agreement** prefills name, email, rent, deposit and dates and files the signed PDF as the lease.
- **One record per person**: if the email already belongs to a tenant with a closely matching name, that record is reused (phone/pays-as updated, links merged, notes appended). If that person already has an active or upcoming tenancy you're told to use Transfer instead.
- A security deposit greater than zero posts a **security-deposit charge** dated on the start date; the deposit field on the tenancy is for reference only.
- A future start creates an **upcoming** tenancy (room Reserved); otherwise it is active (room Occupied). Double-booking is refused.

### Lifecycle
- **Upcoming move-ins** sit in a collapsed section and don't bill before their start. The daily ops cron activates them on the start date.
- **Move out** takes the tenant's **last day**. A past date ends the tenancy now and frees the room; today or a future date keeps them active and lists the room as "available from" the next day. The room's list price becomes the tenant's rent (base = rent − $125 services). A move-out cleaning is scheduled and competing regular cleanings cleared. Rent bills the whole move-out month (no proration at exit).
- **Upcoming move-outs** are listed in their own collapsed section, and the tenant stays on the tracker with "Moving out (date)".
- **Cancel move-out** clears the date, puts the room back to Occupied and cancels the move-out cleaning. On a past tenancy the same action is **Undo move-out**, which back-bills every month since.
- **Pause / Resume actions**: months that begin on or after the pause bill nothing (the month already underway stays billed); paused tenants get no month-end reminders, balance reminders, late fees or lease-ending emails. They still appear in "Expected this month" and the Due column.
- **Transfer** (active tenants with no scheduled move-out): ends the old tenancy on the transfer date and starts a new one the next day in the new room, with the deposit carried (not charged again) and the balance carried across as a matched settlement/adjustment pair that the combined ledger hides. The old room bills its full final month.
- **Start new tenancy** appears for a tenant with no live tenancy: a new deposit charge is posted and the room reserved/occupied. Gap months are never back-billed, but any old balance or credit carries forward because the tenant has one ledger.
- **Delete tenant** is blocked once any charge or payment exists; move them out instead.

### Rent changes are lease renewals
Changing monthly rent asks for the new lease start and end dates. The new rate applies from the lease-start month (even a past month, which is repriced) and replaces any rate already scheduled for later months. Changing the lease end re-arms the 45/30-day lease-ending emails.

### Past tenants
Everyone who has moved out, grouped by property (archived properties badged "Deleted"), with stay, monthly rent, balance, and a "With balance" filter. Debts dismissed from the Rent Tracker are marked as still on the ledger and can be undone.
`,
  },
  {
    title: "The Rent Tracker & the ledger",
    body: `
### The 27th → 26th rent cycle
Tenants pay from the 27th, so "this month" everywhere (KPIs, Due/Paid, reminders) runs from the **27th of the previous month through the 26th** of the current month. All date math runs in Eastern Time.

### One ledger per tenant
Every tenant has **one running ledger** across all their tenancies, past and present. It is the single source of truth for what they owe.

- **Charges**: monthly rent (one line per month, dated the 1st; the move-in month uses the "first month rent" amount, nothing before the actual start date), plus security deposit, late fee, utility overcharge, settlement, adjustment and "other". Settlements and adjustments act as credits (a negative adjustment as a charge) without recording money received.
- **Payments**: Rent, Security deposit, Late fee, Utility, Refund (subtracts), Other.
- The **net balance carries forward**: underpay in June and the arrears follow into July; overpay and the credit offsets future rent. There is no separate "add credit" — an overpayment simply shows as "Credit $X".
- Rent accrues from **June 2026**. Rent-typed payments dated before **May 27, 2026** are refused and ignored (earlier months are treated as settled); other payment types may carry earlier dates.
- Rent-rate changes are tracked per month, so an old month is always judged by the rate in effect then.
- Every figure is kept and shown **to the cent**.

### Balance vs. "this month"
A tenant's **Balance** is the all-months running number across all their rooms (red when owed, "Credit" when negative, "Paid" at zero). The **Due** and **Paid** columns are this-cycle-only operational figures. Both appear together deliberately.

### The tracker
Rows are grouped by unit (collapsed by default, "Vacant" for empty units); operators also see Paid and unit subtotals. Search covers tenant, email, phone, room, building, address and unit. **Balance due only** switches to a flat list sorted by balance with links opening in new tabs. A **Moved out with balance** section lists ended tenancies still owing, with **Settle** (posts a settlement noting the deposit applied and the remainder written off) and **Dismiss** (hides the row; the debt stays on the ledger).

### On the tenant page
- **Add charge** (operators): Security deposit, Late fee, or Other (description required, and the tenant is emailed — see Emails). Late fees are limited to one per tenancy per month. Same-description "Other" charges merge into one line.
- **Record payment** (anyone): date (not in the future), amount, type, notes. Refunds are operator-only and add to the balance.
- **Delete** (operators): payments and hand-posted charges, with confirmation. Deleting a payment that reconciliation posted also forgets the learned payer alias, so the credit returns to Unassigned. Automatic rent lines can't be deleted; utility overcharges are reversed only by **Unpost** on the Utilities page.
- **Download ledger** produces an Excel statement: header with unit(s) and statement period, a summary (deposit, late fees, rent charged, other charges, balance or credit) and every entry to the cent; utility overcharges link to the bill behind them, as on the portal ledger.
- **Lease PDF** opens a short-lived link to the lease on file (assigned from Agreements or uploaded at Add Tenant).
`,
  },
  {
    title: "KPIs: how the numbers are calculated",
    body: `
All money KPIs are visible to the two financial operators only.

### Rent Tracker & Dashboard
- **Expected this month** — the sum of every active tenancy's rent for the current cycle: the first-month amount in the start month, otherwise the rate in effect for the cycle's end month; tenancies that haven't started count zero. Paused tenancies are **not** excluded from Expected (only their running balance stops accruing).
- **Collected** — rent-typed payments received this cycle, minus refunds, **minus any security-deposit charges applied to that tenant in the cycle** (clamped at zero per tenancy). Why: Zelle can't distinguish rent from deposit money — reconciliation posts every matched bank credit as "rent" — so when a deposit arrives the operator applies a security-deposit charge, and that charge is the marker the KPI subtracts. The dashboard's "Collected this month" tile uses the same formula but counts payments from every tenancy including ended ones, and only through today.
- **Security deposit collected this month** — deposit charges applied this cycle plus payments explicitly typed as security deposit.
- **Total security deposit with you** — the deposit amounts on all active tenancies.
- **Total outstanding** — the sum of positive running balances of tenants with an **active** tenancy (moved-out debt is excluded; see Past Tenants for that).
- The **progress bar** is Collected ÷ Expected, capped at 100%.

Because Collected is deposit-adjusted and cycle-scoped, a tenant paying off *last* month's arrears lowers Total Outstanding but does not inflate this month's Collected beyond what the cycle's rent explains.

### Reconciliation page
- **Total Inward Amount** — every uploaded credit dated in the calendar month, from both the bank file and the other-payments file: assigned, unassigned and dismissed alike. "Money in," not a rent figure.
- **Unassigned** — credits no tenant matched.
- **Match / Mismatch / Missing** — per-tenant comparison of expected rent vs. what arrived (see Reconciliation).

### Reports vs. Profitability vs. the tracker
The three surfaces define "collected" differently, on purpose:

| Surface | Period | Counts | Deposit adjustment |
|---|---|---|---|
| Rent Tracker / Dashboard | 27th → 26th cycle | rent payments − refunds | yes |
| Reports | calendar month | rent payments − refunds | no |
| Profitability | calendar month | every payment type except security deposit, − refunds | n/a |
`,
  },
  {
    title: "Automatic late fees",
    body: `
Runs from the daily ops cron; policy in force since **August 2026**.

### The rule
A tenant still owing **more than $200** on their running balance after the **end of the 6th** of the month gets **one $50 late fee**, applied on the first cron run on/after the 7th (Eastern). A batch marker guarantees the run can't repeat in a month, and a per-month key prevents a tenant ever getting two fees for the same month — an operator (or the bot) hand-charging a fee first simply makes the automatic one skip. If any fee fails to post, the marker is removed so the next day retries.

### Who is exempt
1. **New York units** — never auto-fee'd; only non-NY apartments' tenants are charged.
2. **Balances of $200 or less.**
3. **Move-in month** — anyone whose tenancy started on/after the 1st of the current month, and anyone not yet started.
4. **Moved-out tenants** — tenancies whose move-out date has passed.
5. **Utilities-only balances** — if the balance is within **$10** of the utility overcharges posted on that tenancy in the current month, the previous month, or both combined, the tenant is treated as rent-paid with just a utility share pending: no fee.
6. **Paused tenancies** and tenants who already have a late-fee charge this month.

The fee lands on the ledger as a $50 "late fee" charge noted "Auto — balance unpaid after (month)-06". The tenant is not emailed about the fee itself, but the manual balance-reminder email and text switch wording once a fee is on the account ("a $50 late fee has already been applied … and is included").
`,
  },
  {
    title: "Reconciliation (bank → ledger)",
    body: `
The Reconciliation page turns bank exports into tenant ledger entries, continuously — credits post the moment they match, with no monthly "close". Operators only.

### Uploading statements
Two uploads on "+ Add statement": the **bank statement** (Bank of America CSV/XLSX — only Zelle rows count, including scheduled/recurring Zelle) and an optional **other payments** file (Venmo/cash/ClickPay, where the description column is the payer name). The page shows "covers till" the newest bank date uploaded; overlapping uploads are safe because every transaction has a unique fingerprint (the Zelle confirmation number when present) and known ones are skipped. A row with a missing or future date rejects the whole upload. The **New** filter shows just the latest statement's rows.

### Matching payers to tenants
The payer name is extracted from "Zelle payment from …" and normalized (lower-case, spacing collapsed). It's matched against each tenant's **"pays as"** name (or full name), plus learned aliases. When two tenancies claim the same name, active beats ended, then the newest start date wins. Deposits dated before a tenancy starts still post — prepayments are legitimate.

### What posting means
A matched credit immediately becomes a **rent-typed payment** on the tenant's ledger (method "Reconciliation", carrying the bank fingerprint so it can never post twice). This is why the Collected KPIs deposit-adjust — the bank can't tell rent from deposit money.

### Unassigned, ignored, dismissed
- **Unassigned** — credits no tenant matched. Assigning one to a tenant posts it plus every other unposted credit from the same payer, and normally teaches the portal the alias so that payer matches automatically forever after. **Exception:** if the payer name is another tenant's own "pays as"/full name, the credit posts but the alias is deliberately **not** remembered (it would redirect that other tenant's future rent); you're told so, and further deposits from that payer must be assigned by hand.
- **Ignored payers** — people who send non-rent money; their credits never auto-match and sit in the collapsed "Dismissed" list until un-ignored. Assigning a deposit from an ignored payer un-ignores them.
- **Dismissed** — individual credits marked not-rent. A posted credit can't be dismissed; to undo a posting, delete the payment from the tenant's ledger and the credit returns to Unassigned.

### Reversals (chargebacks)
Negative Zelle rows are flagged as possible reversals and matched against the most recent posted payment with the same payer and amount dated on or before the reversal. The operator either **records the reversal** (a refund posts to that tenant's ledger) or **dismisses** the alert.

### The month table
Every tenancy overlapping the month is compared: **expected** (that month's rate, first-month amount in the start month, zero while paused) vs. **actual** (bank-posted rent from 6 days before the month start through month end, plus manually recorded rent inside the month). **Match** = within a cent; **Missing** = nothing received (so a paused tenancy expecting $0 with nothing in still shows Missing); **Mismatch** = anything else, over- or underpayment alike. The Balance column shows the full running ledger balance, sorted most-owed first. Past months can be viewed and exported.

### Manual entry & export
A bulk form records manual rent payments (one shared date; no future dates, nothing before May 27, 2026; method "Manual"). Two Excel exports — the full month or just Missing & Mismatched — grouped by unit with subtotals; operator-only since the sheets include tenant contact details.
`,
  },
  {
    title: "Utilities & the $200 overage",
    body: `
All utility writes (upload, assign, charge, unpost, delete) are operator-only; staff can view the log.

### Logging a bill
Drop utility statements (PDF, PNG, JPEG or WebP, up to 20 MB, several at once) on the Utilities page. Claude reads each statement and extracts the provider, utility type, account, service address, billing period, and an itemized charge list — **current-cycle charges only**: previous balances, payments received, re-billed older periods, and security-deposit movements are excluded by rule. Late fees and one-offs are kept as separate line items. The unit is matched by service address (including the apartment number); a wrong or missed match can be fixed in the log, and the portal **learns** the account→unit pairing so the next statement assigns itself.

Duplicates are blocked twice: an identical file is refused before extraction, and a second bill for the same account + type overlapping an existing period by more than 7 days is refused (7 days of slack because real consecutive cycles overlap at the meter read). **Manual entry** exists for providers without statements — up to 24 cycles at once with up to 5 screenshots each; files can be attached later. A charged bill can't be reassigned or deleted until it is unposted.

### The $200 rule
When a unit's **electric/gas usage charges** (taxes included, late fees excluded; a bill counts as electric/gas if its lines mention electricity, gas, kWh or therms even when typed "other") exceed **$200 in one billing cycle**, the excess above $200 is billable to the occupants. Water, internet and trash are never charged to tenants.

**The split:** the overage is prorated **per day** across the billing period (end date exclusive) and each day's slice is divided equally among the tenants who lived in an **AC room** that day. Rooms without AC never share. Days with no eligible occupant become an "uncovered" remainder charged to no one. Shares round to the cent so they add up exactly. The operator sees a preview with each tenant's share (editable) before posting; $0 shares aren't posted, and a bill can only ever be charged once. **Unpost** reverses everything.

### What tenants receive
Current occupants who were charged get an email — subject "Utility charge — please include with your (next month) rent" — with their share, the period, a 30-day link to the actual statement, and the note that the overage is divided among tenants with AC in their room. New York tenants get the plain Gmail version; everyone else a branded card sent through the portal's own sender. **Moved-out tenants are charged on their (ended) ledger but never emailed** — instead a popup on the Rent Tracker, shown to the master account, lists them so the operator can collect (e.g. against the deposit) and dismiss.
`,
  },
  {
    title: "Cleaning schedules & cleaners",
    body: `
### The 35-day cadence
Every unit is cleaned on a **35-day cycle**. The next cleaning is scheduled 35 days after the last one; a unit is **due soon** within 7 days of that date and **overdue** past it. When a unit has no future cleaning on the books, the daily morning cron rolls the schedule forward automatically (last date + 35 days, stepped until it lands today or later). Units that have never been scheduled wait for the operator to set the first date; paused and archived properties are skipped entirely.

### Editing dates
Upcoming cleaning dates are directly editable on the Cleaning page and the dashboard's "Upcoming cleaning" card — pick a date to move it, clear it to cancel. Cleanings can also be logged after the fact with who cleaned and notes on each property page.

### Move-outs
Setting a room's availability date (a confirmed move-out) schedules a **move-out cleaning on the availability date** — the day after the tenant's last day — and cancels any competing regular cleaning from today on, so the 35-day cycle restarts from the move-out clean. Paused and archived properties get no automatic move-out cleaning. If the move-out is cancelled, the move-out cleaning is removed, the cleaner is told the reverted date (last clean + 35), and the next morning's roll-forward re-creates the regular date.

### What cleaners receive, and when
Each cleaner is assigned to one or more units on the property form. When a cleaning **in the current week (Sunday–Saturday, ET)** is added, moved, or removed for one of their units — including move-out scheduling — a notice is queued. Once a night (about **9 PM ET**) the queue drains and each affected cleaner gets **one combined notice per week** (debounced — ten edits in a day still mean one message), by **email** (subject "Schedule updated — week of (date)") **and text** where a US/Canada phone is on file:

"Hi (first name), Your cleaning schedule for this week (dates) has been updated. See the latest: (link). Thanks"

The notice deliberately lists nothing — it links to the cleaner's **personal schedule page**, a private tokenized link that never expires and always shows the live truth: their units' cleanings on a calendar with move-out badges, room, leaseholder, occupants, and notes (paused/archived properties hidden). Changes to *future* weeks send nothing; the live page simply reflects them. There is no weekly digest — cleaners hear from us only when the current week changes.

Disabled ("paused") cleaners receive nothing while paused.
`,
  },
  {
    title: "Emails & texts: who gets what, when",
    body: `
### The three mail channels
Every tenant message picks its channel by the unit's **New York flag**:

- **Gmail (Vineet's personal account)** — all New York tenant correspondence. Plain text, no HTML, **no Hive branding anywhere**, signed "Vinny"/"Vineet" (the generic rent reminder signs off just "Thanks").
- **Outlook (work account)** — non-NY rent reminders, balance reminders and agreements, as branded HTML cards. If Outlook is unconfigured these fall back to the portal sender.
- **Portal sender (info@hiveny.com via Resend)** — internal/operator mail, cleaner notices, room-change alerts, lease-ending heads-ups, board emails, and the branded non-NY **utility charge** and **new charge** notices. This channel has a free-tier budget (**90/day, 3,000/month**, shown on the Email log); anything over budget parks in a queue that the daily cron drains oldest-first, so nothing is lost — just delayed. Gmail and Outlook sends never count against it.

Bulk sends always use BCC — tenants never see each other's addresses. Every email and text is recorded in the Settings email/text logs.

### Texts
Texts go out via Zoom Phone — **US/Canada numbers only**; a foreign number is skipped, not failed (a group thread containing one fails entirely). Zoom handles STOP/START itself: a tenant who texts STOP is blocked by Zoom, and later texts to them still show as *sent* in our log but never arrive. The Text log's **Check opt-out** (by number or tenant name, or click a number in the log) asks Zoom for the current status; only the tenant can lift a block, by texting START. The assistant can also check it.

### The daily schedule (Eastern Time)
| When | What runs |
|---|---|
| ~8–9 AM | The daily ops pass: tenancy activations and move-outs, email-queue drain, lease-ending reminders, cleaning cadence roll-forward, board deadline digests and recurring rollover, automatic late fees (on/after the 7th), duplicate-agreement cleanup, signed-agreement alert retries |
| 11 AM, last day of month | Monthly rent reminders (email + text) |
| ~8–9 PM | Cleaner schedule-change notices (one combined notice per cleaner per week) |

### Monthly rent reminders (last day of month, 11 AM ET)
Every active, unpaused, started tenancy with an email and **no move-out date at all** gets exactly one reminder per month (a per-tenant-per-month record makes double-sends impossible):

- **Paid-up tenants** (balance at zero) get the generic "Rent Reminder" as a group BCC: rent is due, pay by the 5th to avoid a $50 late fee, ignore if already paid. NY via Gmail, everyone else via Outlook.
- **Tenants with a balance** instead get a personal email — "Rent reminder — please include your $X balance" — with a mini ledger breaking the balance down line by line (including links to any utility statements behind it), asking for next month's rent plus the balance together by the 5th.
- **Texts**: every eligible tenant with a US/Canada phone also gets an SMS — the generic wording for paid-up tenants, a short "please include your $X balance along with your rent by the 5th" for those owing.

### Balance reminders (manual)
The **Email balance reminders** / **Text balance reminders** buttons on the Rent Tracker (or asking the assistant, which must confirm the channel first) send "Rent balance due — (Month YYYY)" to every active, started, unpaused tenant owing more than a cent whose move-out date hasn't passed, personalized with the balance breakdown. Tenants without an email are skipped on both channels. Once a late fee is on the account, the wording switches from "avoid a $50 late fee" to "a $50 late fee has already been applied and is included." The page shows when this last ran. Note: pressing it twice sends twice — there's no monthly dedupe on the manual buttons.

### Other automatic messages
- **New charge** — posting an "Other" charge emails the tenant: "New charge on your account — please include with your (month) rent", with the description, date and unit; the month is the current one if no payment has been recorded yet this calendar month, otherwise next month. NY via plain Gmail, others as a branded card. Best-effort: a failed email never blocks the charge. Pausing does not suppress it.
- **Lease ending** — an internal heads-up email ("Lease ending in N days — (tenant)") to Vineet at **45 days** and again at **30 days** before a lease ends (per tenancy, each fires once; failures retry the next day; paused tenancies skipped).
- **Room changes** — whenever a room's status or listing action changes, everyone on the notification-recipients list gets an immediate "Room update" email.
- **Cleaner schedule updates**, **utility overage notices**, **Projects board** and **agreement** emails — see their sections.
- **Inventory sheet** — on request via the assistant, the shareable inventory spreadsheet can be emailed from the personal Gmail with no Hive branding, or shared into Telegram.

### Who never gets messaged
Paused tenancies receive no reminders, texts, late fees or lease-ending emails (the new-charge notice is the one exception). Paused/archived properties are excluded from all cleaning notices and scheduling. Tenants without an email on file are skipped silently by every reminder, including the text versions.
`,
  },
  {
    title: "Agreements & lease signing",
    body: `
### Generating and sending
Lease PDFs are generated inside the portal (no external service), pre-signed with the operator signature kept on the Agreements page — **a send fails outright if no operator signature is on file**. The form prefills from any **active or upcoming** tenancy ("moves in (date)") but every field stays editable, and the PDF is always regenerated server-side from the validated values. The cleaning-fee clause states the $100 move-out cleaning fee and a **$25 mattress-protector replacement** charge. The Download buttons produce an *unsigned* copy in the browser; **View PDF** in the tally opens the signed copy when one exists.

An optional **note** (up to 1,000 characters) can be added to the cover email — for example "the earlier agreement was sent by mistake; this one replaces it" — from the form or via the assistant. It goes in the email only: not stored, not in the PDF, and not repeated by a resend.

**Only known properties can be sent to.** The address is resolved to an existing property (by the picker, the property's saved agreement address, or street number + name + unit); anything else is refused with suggestions. The address used is saved as that property's canonical agreement address.

**The room is mandatory.** Every agreement names the specific room ("Room 3, 123 Main St, Apt 4B …" in the PDF's opening paragraph), from the form, the assistant, and any script alike. The room must be one of that property's numbered rooms in the portal — the form offers them as a picker once a property is chosen, the assistant gets them from the address lookup, and a room the unit doesn't have is refused with the list of rooms it does have. A property with no numbered rooms can't be sent to until its rooms are numbered on the property page. The room shows in the signing tally and in the signed-agreement alert, and Add Tenant from a signed agreement preselects it.

The channel follows the NY rule:

- **New York** — plain-text "Agreement" email from the personal Gmail, no letterhead, no Hive branding anywhere, and the send is only reported successful after the message is verified in the Gmail Sent folder.
- **Non-NY** — "Your Hive agreement", branded with the Hive letterhead from the work Outlook account, using a draft-then-send-then-verify flow (an "accepted" response alone is never treated as delivered).

### Signing links
The email carries the PDF plus a signing link valid for **48 hours**. Links live on a neutral, no-"Hive" domain; **New York sends are refused outright if that domain isn't configured** rather than falling back to a branded URL (non-NY links fall back to the portal address). The signing page is unindexed and shows letterhead only for non-NY agreements.

**Resending rotates the link**: the old link dies immediately and a fresh 48-hour window starts. Judge expiry from the latest send, not the original request date.

### After signing
Signing is double-submit-proof. The signed PDF (both signatures + date) is stored, emailed back to the tenant **on the same channel as the original send** ("Signed agreement" / "Your signed Hive agreement"), and the operators are alerted on Telegram — with the daily cron retrying that alert until it's delivered. The signer's IP and signature type (drawn/typed) are recorded. An email hiccup never undoes a signing.

### The tally
Names link to the tenant's profile (matched by assigned tenancy, then unique email, then unique name); people whose tenancies have all ended are marked as past tenants. From the tally you can dismiss requests (the link then behaves like a dead URL), resend, or **assign a signed agreement to a tenancy**, which files the PDF as that tenant's lease (with a confirmation if one is already on file). "Clear this list" on the Signed tab removes only agreements already assigned to a tenancy, so unassigned signed copies stay visible; clearing Dismissed removes all of them.

### Duplicates: latest copy wins
The daily cron de-duplicates requests to the same person (same email, or a close name match): the **newest copy wins and the older ones are permanently deleted**, PDFs included. A signed or assigned copy is only ever superseded by a newer *signed* copy, and the winner takes over the tenancy's lease file.
`,
  },
  {
    title: "The assistant, the Telegram bot & APIs",
    body: `
### One assistant, two doors
The same Claude-powered assistant is available as the **in-portal chat widget** (operators only; draggable, minimisable, history kept per user and reset when a new browser tab opens) and as the **Telegram bot** (private: an allowlist of Telegram user IDs plus a webhook secret; strangers are turned away and logged; duplicate deliveries are ignored). Keep the Telegram allowlist set — with it empty only the webhook secret stands guard. Bot access implies operator-level answers. Telegram remembers the last ~20 turns per chat; **/reset** clears it, **/diag** checks mail accounts without sending.

### What it can do — 46 tools
- **Properties** — list, look up, resolve an address, and **create a unit** (asks for every mandatory field in one message, reads it back, refuses duplicates, creates Room 1…N).
- **Inventory** — list, set listing action, **Facebook ads on/off** (refused while the listing is marked Delete), set room status, update room rent.
- **Tenants & tenancies** — list active tenants, add, update, edit a tenancy, move out, cancel a move-out.
- **Agreements** — send one (same rules as the portal, including the mandatory room), fetch a lease link.
- **Money** — record a payment or charge, list/settle/dismiss moved-out balances.
- **Messaging** — balance reminders (must ask email/text/both and confirm), **free-form texts** ("send_text": to one or many tenants, individual threads or one shared thread, optionally including the operator; it must read back the exact text, recipients and thread mode before sending — "group text with me in it" means individual threads that include you), text opt-out lookup, and sharing/emailing the inventory sheet.
- **Cleaning** — overdue list, log a cleaning, list/update/delete records, manage and assign cleaners.
- **Utilities & credentials** — bills, statement links, stored credentials.
- **Analytics** — profitability (worst units first), add a profitability line item, collections summaries.
- **Read-only SQL** that physically cannot write, capped at 200 rows, with credentials and logs invisible to it.
- **This guidebook**, section by section.

### Trust guards
Every tool call is logged with its real result before the model can summarise it. The assistant cannot claim an email, text, agreement or reminder was sent unless a send tool actually succeeded that turn, can't cite record IDs it didn't look up, and any status claim ("signed", "paid") made without looking is stamped as unverified. When it asks you to confirm a write it prints the exact ID(s) that write needs — and only then, never as a roster. Credentials it fetches are redacted from every log and from its own memory (the password still reaches you in the live reply). The full diagnostic log is in Settings → Telegram bot log.

### The two read-only APIs
- **Inventory API** — bearer-token protected; returns currently-listable rooms (same rule as the Inventory page: no queued rooms, no archived properties) with address, availability, rent breakdown, amenities, photos link, description and the Facebook-ads flag, sortable by unit/neighborhood/availability/price; plus a per-room endpoint. Deliberately **no tenant data, ads, or listing actions**.
- **Tenants API** — a **separate** bearer token because it returns PII (name/email/phone/unit/room of active tenants) with phone lookup on the last 10 digits and a name/email search. Built for the automated text-responder so an inbound SMS can be resolved to a tenant.

Both are documented on the public **/developers** page with fictional example data. When a route changes, the docs must be updated in the same change.
`,
  },
  {
    title: "Projects board",
    body: `
### Roles and workflow
The board has two roles: **admin** (the master account) and everyone else as members. Members create tasks only for themselves and move them not started → in progress → **pending review** (the admin is emailed "Pending Review"); a task in review is locked until the admin approves it (→ completed, "Project Approved" email) or rejects it with a reason ("Revision Needed" email, back to in progress with the reason as a comment). Creating a task for someone else emails them "New Project"; flag or deadline changes send "Project Updated", and admin comments send "New Comment on: …".

### Recurring tasks
A recurring task carries a day-of-month; members can complete it directly with no review, and on completion or approval it rolls to next month's occurrence instead of closing (clamped for short months). If a recurring deadline slips past without completion, the daily cron rolls it forward automatically and records the missed month — unless it's sitting in review, which is left alone.

### Deadline reminders
Every morning the cron emails **one digest per assignee** covering their overdue tasks and anything due tomorrow — "Project deadlines: N overdue, M due tomorrow" (a zero part is left out). Overdue reminders deliberately repeat daily until resolved. Overdue *recurring* tasks are excluded (rollover already handled them). The admin can also send a manual nudge ("Reminder: …"), capped at **2 per project per day** and never for completed or in-review tasks.

All board email respects each user's "Project email notifications" toggle in Settings (default on) and goes through the portal sender, queueing gracefully when over budget. The sidebar badge shows the admin tasks awaiting review or attention, and members their unseen open assignments.
`,
  },
  {
    title: "Credentials",
    body: `
### What's stored
Logins for payment portals, maintenance portals, utilities, internet, building logins and anything else: service name (required), property, username, password, login URL, account number, an "owner" label, and notes. Credentials also appear on the property page they belong to. Search covers every field.

### How passwords are protected
- Passwords are **encrypted at rest** with a key held in the database vault; the plaintext column is permanently wiped and a database rule blanks it on every write, so no screen or export can leak it by accident.
- The list only ever loads a "has password" flag. **Reveal** and **Copy** fetch the secret on demand from the master account, and each reveal or copy is written to an **access log** (who, which credential, when) that only operators can read.
- Adding, editing and deleting is done from the master account; staff can see the non-secret fields.
- The audit log strips passwords from every change record, and the assistant redacts any credential lookup from its logs and memory.
`,
  },
  {
    title: "Profitability & Reports",
    body: `
### Profitability (Profitability access)
A per-unit P&L for a chosen year, with tabs for Summary, Profit, Rent Collection, Rent Paid, Utilities, Internet, Cleaning, Amenity Fees, Misc Fees and Insurance; each tab is a units × months grid grouped by quarter with totals.

- **Revenue** per unit-month is every payment dated in that calendar month except security deposits (refunds subtract), plus any manual revenue line items.
- **Expenses** come from the property record: master-lease rent, internet, cleaning and insurance as flat monthly figures; amenity and misc fees as the yearly figure ÷ 12 — all only inside the unit's lease window. **Utilities** are the bills falling in that month; when a month has no bill, the average for units with the same bedroom count (or all units) is used and shown with a "~" as an estimate.
- **Profit** = revenue − every expense. Cells are blank for months before the books start, for future months, and outside the lease window when there's no revenue.
- **The books start June 2026**: earlier months are dropped from the grid and charts, and the year picker can't go below 2026 or above the current year.
- **Line items** (Summary tab): manual revenue or expense amounts per year with a label; they count in the yearly totals, not in monthly cells. The assistant can add them too.

### Reports (master only)
Reached from Settings. Filters by month range, neighborhood or property. Tiles: expected in range, collected in range with collection rate, outstanding (expected − collected), and all-time collected with the payment count. A collection trend chart, a month-by-month table, and revenue by property with share of total.

Reports uses **calendar months**: expected is the first-month amount in the start month, otherwise the rate in effect that month (zero while paused or outside the tenancy); collected is rent payments minus refunds by payment date, with no deposit adjustment. Per-property expected and outstanding are not yet computed. The same figures are available to the assistant.
`,
  },
  {
    title: "Settings & logs",
    body: `
### Cards
| Card | Who | What |
|---|---|---|
| Portal guidebook | everyone | This document as a PDF |
| Reports | master | Portfolio collections |
| Users | master | Invite by email (the invitee gets a Supabase invite link), see invite/last-sign-in dates, remove anyone other than yourself and the master. An invited account is ordinary staff; operator or master rights require a code change |
| Notification settings | operators | Who gets room-change emails: add an existing portal user by email and name, toggle, remove |
| Audit log | operators | Every create/update/delete across the portal, filterable by table and action, 50 per page. Retained for audit — no clear button |
| Email log | operators | Last 200 emails by type and status (sent/failed), the day's and month's usage against the portal-sender caps, and the queued backlog. Master can clear it |
| Text log | operators | Last 200 texts by type and status (sent/failed/skipped), plus **Check opt-out**. Master can clear it |
| Telegram bot log | master card; operators by URL | Every assistant turn — messages, tool calls, results, errors — newest first, with a "failed only" filter. Retained for audit |

### Everyone's settings
- **Project email notifications** toggle (default on).
- **Change password**: at least 8 characters, must differ from the current one, and the current password is re-verified first.

### Invite troubleshooting
Invites are sent by Supabase Auth using the SMTP account configured in the Supabase dashboard (Authentication → Emails → SMTP). If the portal reports "Error sending invite email", that SMTP login has stopped working (typically a rotated Resend key or app password); fix it there and re-send. A failed invite leaves no half-created account behind.
`,
  },
];

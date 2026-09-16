/**
 * The Portal Operations Guidebook — single source of truth for how every
 * automation, policy, threshold, and calculation in the portal works.
 *
 * Consumed by:
 *   • scripts/build-guidebook-pdf.mjs  → public/guidebook.pdf (Settings card)
 *   • src/lib/portal-tools/guide.ts    → the Telegram bot's get_portal_guide tool
 *
 * Style: plain Markdown (headings ##/###, lists, **bold**, `code`, tables).
 * No file paths or code identifiers users can't act on — describe behavior.
 * IMPORTANT: when a policy changes in code, update the matching section here
 * and re-run `node scripts/build-guidebook-pdf.mjs`, then commit the PDF.
 */

export type GuidebookSection = { title: string; body: string };

export const GUIDEBOOK_TITLE = "Operations Guidebook";
export const GUIDEBOOK_UPDATED = "August 16, 2026";

export const GUIDEBOOK_SECTIONS: GuidebookSection[] = [
  {
    title: "Access & roles",
    body: `
The portal has three effective levels of access.

- **Master (Vineet's account)** — everything, plus a few master-only surfaces: the **Reports** page (portfolio financials), **Users** (inviting teammates), and the **Telegram bot log**.
- **Financial operators (Vineet + Parth)** — all money surfaces: the dashboard and Rent Tracker KPI tiles, per-tenant paid amounts, Reconciliation, Profitability, ledger writes (adding/deleting charges and credits), utility overage charging, the audit/email/text logs, and notification settings. Database row-level security mirrors this list, so even a direct API call can't bypass it.
- **Everyone else (staff)** — the rest of the portal: tenants and their rent status (due, pending balance — but not aggregate totals or paid amounts), inventory, properties, cleaning, utilities log (view only), agreements, credentials, and the Projects board. Staff can record ordinary payments but can never record refunds or backdate/forge bank references.

The Telegram bot is limited to the operators by Telegram user ID, so bot access implies operator-level answers.
`,
  },
  {
    title: "The rent cycle & ledger",
    body: `
### The 27th → 26th rent cycle
Tenants pay from the 27th, so "this month" everywhere in the portal (KPIs, Collected, reminders) runs from the **27th of the previous month through the 26th** of the current month. All date math runs in Eastern Time.

### The carry-forward ledger
Each tenancy has a running ledger — the single source of truth for what a tenant owes:

- **Charges**: monthly rent (prorated by \`first month rent\` in the move-in month, frozen while a tenancy is paused), plus ad-hoc charges — security deposit, late fee, utility overage, settlement, other.
- **Payments**: typed as rent, security deposit, utility, other, or refund (refunds subtract).
- The **net balance** carries forward across months: underpay in June and the arrears follow you into July; overpay and the credit offsets future rent.
- Rent changes are tracked per month, so an old month is always judged by the rate that was in effect then.
- The ledger is anchored in late May 2026 — rent payments can't be dated before **May 27, 2026** (earlier months are treated as settled), and the portal refuses to record any that are.

### Balance vs. "this month"
A tenant's **balance** is the all-months running number. The **Due / Paid** columns on the Rent Tracker are this-cycle-only operational figures. Both appear together deliberately.
`,
  },
  {
    title: "KPIs: how the numbers are calculated",
    body: `
All money KPIs are visible to the two financial operators only.

### Rent Tracker & Dashboard
- **Expected this month** — the sum of every active tenant's rent due for the current cycle (prorated first months included, paused tenancies excluded).
- **Collected** — rent-typed payments received this cycle, **minus any security-deposit charges applied to that tenant in the cycle** (clamped at zero per tenant). Why: Zelle can't distinguish rent from deposit money — reconciliation posts every matched bank credit as "rent" — but when a deposit arrives, the operator applies a security-deposit charge to the tenant, and that charge is the marker the KPI subtracts. Refund payments subtract. The dashboard's "Collected this month" tile uses identical math.
- **Security deposit collected this month** — deposit charges applied this cycle (the marker for Zelle-collected deposits) plus payments explicitly recorded as security deposits.
- **Total security deposit with you** — the sum of the security-deposit amounts on all active tenancies.
- **Total outstanding** — the sum of all positive running balances, across all months (not just this cycle).
- The **progress bar** is Collected ÷ Expected, capped at 100%.

Because Collected is deposit-adjusted and cycle-scoped, a tenant paying off *last* month's arrears lowers Total Outstanding, but does not inflate this month's Collected beyond what the cycle's rent explains.

### Reconciliation page
- **Total Inward Amount** — every bank-statement credit dated in the calendar month: assigned, unassigned, and dismissed alike. This is "money in per the bank," not a rent figure.
- **Match / Mismatch / Missing** — per-tenant comparison of expected rent vs. what actually arrived (see the Reconciliation section).
`,
  },
  {
    title: "Automatic late fees",
    body: `
Runs from the daily cron; policy in force since **August 2026**.

### The rule
A tenant still owing **more than $200** on their running balance after the **end of the 6th** of the month gets **one $50 late fee**, applied on the first cron run on/after the 7th (Eastern). A batch marker guarantees it can never run twice in a month, and a per-month dedupe key prevents a tenant ever getting two fees for the same month — an operator hand-charging a fee first simply makes the automatic one skip.

### Who is exempt
1. **New York units** — never auto-feed; only non-NY apartments' tenants are charged.
2. **Balances of $200 or less** — the fee applies only when more than $200 is owed.
3. **Move-in month** — anyone whose tenancy started on/after the 1st of the current month.
4. **Utilities-only balances** — if the balance is within **$10** of the utility charges posted on the account in the current month, the previous month, or the two combined, the tenant is treated as rent-paid with just a utility share pending: no fee.
5. **Paused tenancies** and tenants who already have a late-fee charge this month.

The fee lands on the ledger as a $50 "late fee" charge noted "Auto — balance unpaid after the 6th." The tenant is not emailed about the fee itself, but the balance-reminder emails switch wording once a fee is on the account ("…which includes a $50 late fee").
`,
  },
  {
    title: "Reconciliation (bank → ledger)",
    body: `
The Reconciliation page turns bank exports into tenant ledger entries, continuously — statements post the moment they match, with no monthly "close".

### Uploading statements
Two uploads on "+ Add statement": the **bank statement** (Bank of America CSV/XLSX — only Zelle credits count) and an optional **other payments** file (Venmo/cash/ClickPay, where the description column is the payer name). The page shows "covers till" the last upload's newest date; overlapping uploads are safe because every transaction has a unique fingerprint (Zelle confirmation number when present) and known ones are skipped. Rows with future dates reject the whole upload.

### Matching payers to tenants
The payer name is extracted from "Zelle payment from …" and normalized. It's matched against each tenant's **"pays as"** name (or full name), plus any learned aliases. **The "pays as" field must be spelled exactly as the bank prints it** — case doesn't matter, spelling does. When two tenancies claim the same name, active beats ended, then the newest start date wins. Deposits dated before a tenancy starts still post — prepayments are legitimate.

### What posting means
A matched credit immediately becomes a **rent-typed payment** on the tenant's ledger (method "Reconciliation", carrying the bank fingerprint so it can never post twice). This is why Collected KPIs must deposit-adjust — the bank can't tell rent from deposit money.

### Unassigned, ignored, dismissed
- **Unassigned** — credits no tenant matched. Assigning one to a tenant also posts every other unposted credit from the same payer, and teaches the portal the alias so that payer matches automatically forever after.
- **Ignored payers** — people who send non-rent money; their credits never auto-match and sit in the collapsed "Dismissed" list until un-ignored. Assigning a deposit from an ignored payer un-ignores them.
- **Dismissed** — individual credits marked not-rent. A posted credit can't be dismissed; to undo a posting, delete the payment from the tenant's ledger and the credit returns to Unassigned.

### Reversals (chargebacks)
Negative Zelle rows are flagged as possible reversals and matched against the most recent posted payment with the same payer and amount. The operator either **records the reversal** (a refund payment posts to that tenant's ledger) or **dismisses** the alert.

### The month table
Every tenancy overlapping the current month is compared: **expected** (that month's rate, prorated first month, zero while paused) vs. **actual** (bank-posted rent from 6 days before the month start through month end, plus manually recorded rent inside the month). **Match** = within a cent; **Missing** = nothing received; **Mismatch** = anything else, over- or underpayment alike. The Balance column shows the full running ledger balance, sorted most-owed first.

### Manual entry & export
A bulk form records manual rent payments (one shared date; no future dates, nothing before the ledger anchor). Two Excel exports — the full month or just Missing & Mismatched — grouped by unit with subtotals; operator-only since the sheets include tenant contact details.
`,
  },
  {
    title: "Utilities & the $200 overage",
    body: `
### Logging a bill
Drop utility statements (PDF or photo, up to 20 MB, several at once) on the Utilities page. Claude reads each statement and extracts the provider, utility type, account, service address, billing period, and an itemized charge list — **current-cycle charges only**: previous balances, payments received, re-billed older periods, and security-deposit movements are excluded by rule. Late fees and one-offs are kept as separate line items. The unit is matched by service address (including the apartment number); a wrong or missed match can be fixed in the log, and the portal **learns** the account→unit pairing so the next statement assigns itself.

Duplicates are blocked twice: an identical file is refused before extraction, and a second bill for the same account + type overlapping an existing period by more than 7 days is refused (7 days of slack because real consecutive cycles overlap at the meter read). Manual entry exists for providers without statements — up to 24 cycles at once with optional screenshots.

### The $200 rule
When a unit's **electric/gas usage charges** (taxes included, late fees excluded) exceed **$200 in one billing cycle**, the excess above $200 is billable to the occupants. Water, internet, and trash are never charged to tenants.

**The split:** the overage is prorated **per day** across the billing period and each day's slice is divided equally among the tenants who lived in an **AC room** that day. Rooms without AC never share. Days with no eligible occupant become an "uncovered" remainder that is charged to no one. The operator sees a preview with each tenant's share (editable) before posting; $0 shares aren't posted, and a bill can only ever be charged once. "Unpost" reverses everything.

### What tenants receive
Current occupants who were charged get an email — subject "Utility charge — please include with your next month's rent" — with their share, the period, a 30-day link to the actual statement, and the note that the overage is divided among tenants with AC in their room. New York tenants get the plain Gmail version; everyone else the branded one. **Moved-out tenants are charged on their ledger but never emailed** — instead a popup on the Rent Tracker alerts the operator to collect (e.g. against the deposit) and dismiss.
`,
  },
  {
    title: "Cleaning schedules & cleaners",
    body: `
### The 35-day cadence
Every unit is cleaned on a **35-day cycle**. The next cleaning is scheduled 35 days after the last one; a unit is **due soon** within 7 days of that date and **overdue** past it. When a unit has no future cleaning on the books, the daily 9 AM cron rolls the schedule forward automatically (last date + 35 days, stepped until it lands in the future). Units that have never been scheduled wait for the operator to set the first date; paused and archived properties are skipped entirely.

### Editing dates
Upcoming cleaning dates are directly editable on the Cleaning page and the dashboard's "Upcoming cleaning" card — pick a date to move it, clear it to cancel. Cleanings can also be logged after the fact with who cleaned and notes on each property page.

### Move-outs
A confirmed move-out schedules a **move-out cleaning on the move-out date** and cancels any competing regular cleaning, so the 35-day cycle restarts from the move-out clean. If the move-out is cancelled, the schedule reverts to last-clean + 35 and the cleaner is told the reverted date.

### What cleaners receive, and when
Each cleaner is assigned to one or more units on the property form. When a cleaning **in the current week (Sunday–Saturday, ET)** is added, moved, or removed for one of their units — including move-out scheduling — a notice is queued. Once a day at **9 PM ET** the queue drains and each affected cleaner gets **one combined notice per week** (debounced — ten edits in a day still mean one message), by **both email and text** where a phone is on file:

"Hi (name), your cleaning schedule for this week (dates) has been updated. See the latest: (link)."

The notice deliberately lists nothing — it links to the cleaner's **personal schedule page**, a private tokenized link that never expires and always shows the live truth: their units' cleanings on a calendar with move-out badges, room, leaseholder, occupants, and notes. Changes to *future* weeks send nothing; the live page simply reflects them. There is no weekly digest — cleaners hear from us only when the current week changes.

Disabled ("paused") cleaners receive nothing while paused.
`,
  },
  {
    title: "Emails & texts: who gets what, when",
    body: `
### The three mail channels
Every message picks its channel by a **New York vs. non-NY** rule (from the unit's NY flag):

- **Gmail (personal)** — all New York tenant correspondence. Plain text, no HTML, **no Hive branding anywhere**, signed "Vinny"/"Vineet".
- **Outlook (work account)** — all non-NY tenant correspondence, as branded HTML cards. If Outlook is ever unconfigured, these fall back to Resend.
- **Resend (info@hiveny.com)** — internal/operator mail, cleaner notices, utility notices, room-change alerts, board emails. Resend has a free-tier budget (**90/day, 3,000/month**); anything over budget parks in a queue that the daily cron drains oldest-first the next day, so nothing is lost — just delayed. Gmail and Outlook sends never count against this budget.

Texts go out via Zoom Phone — **US/Canada numbers only**; foreign numbers are skipped, not failed. Zoom handles STOP/START replies itself: a tenant who texts STOP is blocked by Zoom, and later texts to them still show as *sent* in our log but never arrive. The Text log has a **Check opt-out** lookup (by number or tenant name) that asks Zoom for a number's current status; only the tenant can lift a block, by texting START. Every email and text is recorded in the Settings email/text logs. Bulk sends always use BCC — tenants never see each other's addresses.

### The daily schedule (Eastern Time)
| When | What runs |
|---|---|
| ~8–9 PM | Cleaner schedule-change notices go out (one combined notice per cleaner per week) |
| ~8–9 AM | The daily ops pass: tenancy activations/move-outs, email-queue drain, lease-ending reminders, cleaning cadence roll-forward, board deadline digests, automatic late fees (on/after the 7th), agreement alert retries |
| 11 AM, last day of month | Monthly rent reminders (email + SMS) |

### Monthly rent reminders (last day of month, 11 AM ET)
Every active, unpaused tenant with an email — excluding anyone with a move-out date or a not-yet-started lease — gets exactly one reminder per month (a per-tenant-per-month record makes double-sends impossible):

- **Paid-up tenants** get the generic reminder as a group BCC: "rent is due, pay by the 5th to avoid a $50 late fee, ignore if already paid." NY tenants via Gmail, everyone else via Outlook.
- **Tenants with a balance** instead get a personal email — "Rent reminder — please include your $X balance" — with a mini ledger breaking the balance down line by line (including links to any utility statements behind it), asking for next month's rent plus the balance together by the 5th.
- **Texts**: every eligible tenant with a US/Canada phone also gets an SMS with the same wording as their email.

### Balance reminders (manual)
The buttons on the Rent Tracker (or asking the bot) send a "Rent balance due" email and/or text to every unpaused tenant owing more than a cent, personalized with their balance. Once a late fee is on the account, the wording switches from "avoid a $50 late fee" to "a $50 late fee has already been applied and is included." The page shows when this last ran. Note: pressing it twice sends twice — there's no monthly dedupe on the manual button.

### Other automatic messages
- **Lease ending** — an internal heads-up email to Vineet at **45 days** and again at **30 days** before a lease ends (per tenancy, each fires once; failures retry the next day).
- **Room changes** — whenever a room's status or listing action changes, everyone on the notification-recipients list (Settings → Notification settings) gets an immediate email.
- **Cleaner schedule updates** — see the Cleaning section: one email + text per cleaner per changed week, evenings.
- **Utility overage notices** — see the Utilities section: sent the moment charges post.
- **Projects board** — see the Projects board section.
- **Agreement emails** — see the Agreements section.
- **Inventory sheet** — on request (via the bot), the current room-availability spreadsheet can be emailed from the personal Gmail with no Hive branding, or shared straight into Telegram.

### Who never gets messaged
Paused tenancies receive nothing — no reminders, no texts, no late fees. Paused/archived properties are excluded from all cleaning notices and scheduling. Tenants without an email on file are skipped silently (texts still go out if they have a phone).
`,
  },
  {
    title: "Agreements & lease signing",
    body: `
### Generating and sending
Lease PDFs are generated inside the portal (no external service), pre-signed with the operator signature kept on the Agreements page — **a send fails outright if no operator signature is on file**. The form prefills from any active tenancy but every field stays editable, and the PDF is always regenerated server-side from the validated values.

The channel follows the NY rule:

- **New York** — plain-text email from the personal Gmail, no letterhead, no Hive branding anywhere, and the send is only reported successful after the message is verified in the Gmail Sent folder.
- **Non-NY** — branded email with the Hive letterhead from the work Outlook account, using a draft-then-send-then-verify flow (an "accepted" response alone is never treated as delivered).

### Signing links
The email carries the PDF plus a signing link valid for **48 hours**. Links live on a neutral, no-"Hive" domain; **New York sends are refused outright if that domain isn't configured** rather than falling back to a branded URL. The signing page is unindexed and shows letterhead only for non-NY agreements.

**Resending rotates the link**: the old link dies immediately and a fresh 48-hour window starts. Judge expiry from the latest send, not the original request date.

### After signing
Signing is double-submit-proof. The signed PDF (both signatures + date) is stored, emailed back to the tenant **on the same channel as the original send**, and the operators are alerted on Telegram — with the daily cron retrying that alert until it's delivered. The signer's IP and signature type (drawn/typed) are recorded. An email hiccup never undoes a signing.

From the tally you can dismiss requests (the link then behaves like a dead URL), resend, or **assign a signed agreement to a tenancy**, which files the PDF as that tenant's lease. Duplicate requests to the same person within 15 days are auto-dismissed daily.
`,
  },
  {
    title: "The Telegram bot & APIs",
    body: `
### The Telegram ops bot
Private to the operators (an explicit Telegram user-ID allowlist, plus a webhook secret; unknown users are turned away and logged). It runs on Claude with the full portal toolset — 45 tools across properties (it can add a new unit — building, address, unit, cross street, neighborhood, NY flag, bedrooms and bathrooms are mandatory; rooms are created blank per bedroom), inventory, tenants, tenancies, payments and charges, agreements (it can send one), balance reminders (it must ask which channel and confirm before sending), cleaning management, utility bills, stored credentials, profitability/collections analytics, and a read-only SQL query tool that physically cannot write.

Trust guards: the bot cannot claim an email was sent unless a send tool actually succeeded that turn, can't cite record IDs it didn't look up, and every tool call is logged with its real result before the model can summarize it. Credentials fetched via the bot are redacted from the logs. Conversation memory is per-chat (last ~20 turns; \`/reset\` clears it), and the full diagnostic log lives in Settings → Telegram bot log. The same assistant, with the same tools and guards, is available in-portal to the operators as the chat widget.

### The two read-only APIs
- **Inventory API** — bearer-token protected; returns currently-listable rooms (same rule as the Inventory page) with rent breakdown, amenities, photos link, description, and the Facebook-ads on/off flag — deliberately **no tenant data, ads, or listing actions**. Used by internal scripts and tooling.
- **Tenants API** — a **separate** bearer token because it returns PII (name/email/phone/unit/room of active tenants, with phone lookup matching on the last 10 digits). Built for the automated text-responder so an inbound SMS can be resolved to a tenant.

Both are documented on the public /developers page (with fictional example data). When a route changes, the docs components must be updated in the same change.
`,
  },
  {
    title: "Projects board",
    body: `
### Roles and workflow
The board has two roles: **admin** (the master account) and everyone else as members. A member works only their own tasks and moves them not started → in progress → **pending review**; a task in review is locked until the admin approves it (→ completed, "Project Approved" email) or rejects it with a reason ("Revision Needed" email). Creating a task for someone else emails them "New Project".

### Recurring tasks
A recurring task carries a day-of-month; on completion or approval it rolls to next month's occurrence instead of closing (clamped for short months). If a recurring deadline slips past without completion, the daily cron rolls it forward automatically and records the missed month — unless it's sitting in review, which is left alone.

### Deadline reminders
Every morning the cron emails **one digest per assignee** covering their overdue tasks and anything due tomorrow — "Project deadlines: N overdue, M due tomorrow." Overdue reminders deliberately repeat daily until resolved. Overdue *recurring* tasks are excluded (rollover already handled them). The admin can also send a manual nudge, capped at **2 per project per day**.

All board email respects each user's "email notifications" toggle in Settings (default on) and goes through the metered Resend channel, queueing gracefully when over budget.
`,
  },
];

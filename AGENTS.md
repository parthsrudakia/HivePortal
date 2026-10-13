<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# UI must match hiveny.com

All UI work in this portal must visually align with the public Hive marketing site at https://hiveny.com. The portal is internal, but it shares brand. Use these tokens (defined in `src/app/globals.css` via Tailwind v4's `@theme`):

**Colors (exact, from hiveny.com source):**
- `--color-ink: #1a1a18` — primary text, dark surfaces
- `--color-accent: #d4920b` — honey gold, primary accent / CTAs
- `--color-accent-dark: #b87d09` — accent hover state
- `--color-accent-text: #9a6f08` — accent text on light backgrounds (links)
- `--color-cream: #f5f2ed` — warm off-white background
- `--color-warm: #e8e3db` — warm beige (subtle panels)
- `--color-stone: #c4bdb3` — borders / dividers
- `--color-muted: #8a8378` — muted text
- `--color-white: #fefdfb` — warm white

**Fonts (Google Fonts, loaded in `app/layout.tsx`):**
- Sans (body/UI): **DM Sans** — weights 300, 400, 500, 600
- Serif (display/italic accent): **Cormorant Garamond** — italic 300/400 for emphasis words

**Type usage:**
- Body and form text: DM Sans 400.
- Headings: DM Sans 500–600.
- Italicized accent words within headings (e.g. *"Redefined"*, *"Vacancy"*): Cormorant Garamond italic.

**Spatial rhythm:**
- Generous vertical spacing between sections (py-16 / py-20 desktop).
- Max-content width ~1200px (`max-w-6xl`).
- Cards: warm white background, soft shadow, no hard borders; rounded-xl.
- Buttons: rounded-full or rounded-lg, solid honey for primary, ink outline for secondary.

When designing a new screen, prefer the cream background with white card surfaces and honey accents over generic Tailwind grays.

# Architecture

Internal operations portal for Hive co-living: tenants & rent, properties/rooms, inventory & listings, cleaning, bank reconciliation, lease agreements, and stored credentials.

## Stack

- **Next.js 16** (App Router) + **React 19**, **TypeScript**.
- **Tailwind v4** — tokens via `@theme` in `src/app/globals.css` (see brand guide above). No `tailwind.config.js`.
- **Supabase** — Postgres + Auth + RLS. `@supabase/ssr` for cookie-based sessions.
- **Anthropic SDK** (`@anthropic-ai/sdk`) — drives the Telegram ops bot.
- **Resend** + **Gmail API** + **Microsoft Graph** — transactional email and agreement drafts.
- **exceljs** / **papaparse** — spreadsheet export and reconciliation CSV parsing.
- **zod** for input validation, **sonner** for toasts.

## Layout

- `src/app/(app)/**` — the authenticated portal. One folder per feature (`tenants`, `properties`, `inventory`, `cleaning`, `utilities`, `reconciliation`, `agreements`, `credentials`, `projects`, `reports`, `settings`). Each typically has `page.tsx` (Server Component for reads) + `actions.ts` (`"use server"` mutations) + colocated client components.
- `src/app/login`, `src/app/auth/**` — login, invite acceptance, password reset.
- `src/app/api/**` — `telegram/route.ts` (bot webhook), `cron/{rent-reminders,notification-followups}/route.ts` (Vercel cron, guarded by `CRON_SECRET`), `inventory/**` (read-only inventory API for internal scripts, bearer-token guarded by `INVENTORY_API_KEY`; core listing data only — no tenants/ads/listing actions), `utilities/statements/route.ts` (statement intake for the external statements agent: the agent POSTs the PDF plus the fields it read; the portal verifies them against the PDF text with `src/lib/utility-verify.ts` — no model call — and only falls back to Claude extraction when a check fails; guarded by `UTILITIES_API_KEY`; shares the save path `ingestBill` in `src/lib/utility-ingest.ts` with portal uploads; `utilities/coverage/route.ts` (same key) tells the agent the last billing period logged per unit/account so it only downloads newer statements), and `tenants/route.ts` (read-only tenant contact API for the text-responder bot — name/email/phone/unit/room with `?phone=`/`?q=` lookup; guarded by its own `TENANTS_API_KEY` since it returns PII). API docs live on the public `/developers` page (whitelisted in `proxy.ts` like `/docs`; content components in `src/components/docs/`, shared with the public `/docs/inventory-api` page — example payloads must stay fictional since these pages need no login).
- `src/lib/**` — domain logic (see below).
- `src/lib/supabase/{server,client,proxy}.ts` — Supabase clients. `types.ts` is **generated** — never edit by hand.
- `src/proxy.ts` — middleware (`updateSession`) that refreshes the auth cookie on every request.
- `src/instrumentation.ts` — pins the server runtime to `America/New_York`.

## Conventions

- **Reads** in Server Components via `createClient()` from `@/lib/supabase/server` (respects RLS via the user's cookie session). **Privileged/background** work (cron, Telegram, email logging) uses the service-role key with `createClient` from `@supabase/supabase-js` directly.
- **Mutations** are server actions in `actions.ts`, then `revalidatePath()`.
- Mutate rooms through `updateRoomsWithNotification()` (`src/lib/notifications.ts`), not raw `rooms.update()` — it fires room-change notifications and logs events.
- Dates: server is ET (see `instrumentation.ts`); for date-only "today" math use `todayISO()` from `@/lib/date`, not `toISOString()`.
- `one()` from `@/lib/relations` normalizes PostgREST joins that come back as object-or-array.
- The generated types cover every table — never use `as any` on a Supabase query. After adding a migration, run `npm run db:types` so new tables/columns are typed.
- Access control is a stub: `isMaster()` in `src/lib/access.ts` gates `/reports` to the master operator. No general roles system yet.

## Key domain modules (`src/lib/`)

- `rent.ts` / `rent-data.ts` — carry-forward running rent ledger (single source of truth for balances); anchored at `LEDGER_ANCHOR`.
- `agreements.ts` / `agreement-send.ts` — in-process lease PDF generation (jsPDF) plus the single send path: **every** agreement send (portal UI, Telegram bot, scripts) goes through `sendAgreementRequest`, which refuses any property address that doesn't resolve to an existing `properties` row — agreements can only be sent for units already in the system. The **room is mandatory** on every send (`roomNumber`, optional `roomId`) and must be one of that property's numbered `rooms`; the PDF prints "Room N, <address>" and `agreement_requests` stores `room_id`/`room_number`.
- `google-mail.ts` / `graph-mail.ts` — agreement email drafts: Gmail (personal, NY, no letterhead) vs MS Graph (work account, non-NY, with letterhead).
- `email.ts` / `email-log.ts` — Resend sends + `email_log` audit trail.
- `resend-quota.ts` — Resend free-tier guard. **All Resend mail must go through `sendViaResend()`** (the five `email.ts`/`notifications.ts` senders already do): under the daily/monthly caps it sends now, otherwise it parks the email in `email_queue`. The daily cron drains the backlog (`flushEmailQueue`) FIFO, re-respecting the caps. Caps: `RESEND_DAILY_CAP` (90), `RESEND_MONTHLY_CAP` (3000). Gmail sends use `channel='gmail'` and don't count.
- `charge-notices.ts` — 5-minute correction buffer on the "Other" charge email: `addCharge` parks a `charge_notices` row instead of emailing; deleting the charge cascades it away (no email). Supabase pg_cron pings `/api/cron/charge-notices` every minute when one is due (URL + `CRON_SECRET` in Vault as `portal_url`/`cron_secret`); the daily cron flushes as a safety net. The email is built from the charge at send time.
- `notifications.ts` / `lease-reminders.ts` — room-change emails + lease-ending reminders, both run from the daily follow-up cron.
- `portal-tools.ts` — Claude tool handlers shared by the Telegram bot.
- `utility-extract.ts` — Claude (`claude-opus-4-8`, structured output) reads an uploaded utility statement (PDF/photo) into bill data for `/utilities`: matches the unit by service address, extracts only current-cycle charges (previous balance ignored), late fees/other as separate line items. Tables `utility_bills`/`utility_bill_charges`; originals in the private `utilities` bucket.
- `board.ts` — Projects board (ported from the standalone hiveboard app): task/review workflow, monthly recurring rollover, email notifications, and the daily deadline-reminder pass. Tables `board_tasks`/`board_comments`/`board_prefs`; admin = `isMaster()`, every other portal user is a member.
- `reconciliation/parsers.ts` — Zelle bank-file vs tenant matching rules.
- `analytics/collections.ts` — historic rent-collection reporting for `/reports`.

## Data

Supabase migrations in `supabase/migrations/` (timestamped SQL). Core tables: `properties`, `rooms`, `tenants`, `tenancies`, `leaseholders`, `payments`, plus ledger side-tables (`tenancy_charges`, `credit_allocations`), `cleaning_records`/`cleaners`, `credentials` (+ access log), reconciliation tables, `notification_recipients`/`room_change_events`, rent-reminder batches, `email_log` (+ `channel`), `email_queue` (deferred Resend sends), `audit_log`, `telegram_chat_messages`. RLS is on.

## Commands

- `npm run dev` / `build` / `start` / `lint`
- `npm run db:push` — apply migrations (`supabase db push`)
- `npm run db:types` — regenerate `src/lib/supabase/types.ts` from the linked project

## Environment

See `.env.example`. Required: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. Feature-gated: Resend (`RESEND_*`), Gmail (`GMAIL_*`), MS Graph (`MS_*`), Telegram (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ALLOWED_TELEGRAM_USER_IDS`), `ANTHROPIC_API_KEY`, cron (`CRON_SECRET`), inventory API (`INVENTORY_API_KEY`), tenants API (`TENANTS_API_KEY`), `NEXT_PUBLIC_SITE_URL`, `SIGN_ORIGIN` (neutral no-"hive" domain for lease-signing links; NY sends refuse without it, and that host serves only `/sign/*`).

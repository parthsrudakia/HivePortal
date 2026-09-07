/**
 * Shared core for the Hive ops assistant — the exact same agent brain behind
 * the Telegram bot (src/app/api/telegram/route.ts) and the in-portal support
 * widget (src/app/api/assistant/route.ts). Keeping the system prompt, the
 * anti-hallucination guards, and the turn runner here means BOTH surfaces get
 * identical behavior from one source; there is no second copy to drift.
 */

import Anthropic from "@anthropic-ai/sdk";
import { tools } from "@/lib/portal-tools";
import { getToolContext } from "@/lib/portal-tools/context";

export const SYSTEM_PROMPT = `You are the operations assistant for Hive — a co-living
business in NYC that master-leases apartments and rents rooms individually.
The operator (Vinny) talks to you over Telegram.

You have a set of tools that read and mutate the Hive Portal database. Use them.
Don't ask the operator to look things up themselves — call the right tool.

Style:
- Direct and concise. Short messages — Telegram is a chat, not an email.
- When you list tenants/properties/rooms, show only the fields the operator
  actually needs (name, unit, balance, etc.), never raw UUIDs unless asked.
  The one exception is confirmation questions before a write — see below.
- Format money as $1,234.
- Dates as MM/DD/YY.
- Your replies render as Telegram HTML. The ONLY tags allowed are <b>bold</b>,
  <i>italic</i>, <code>inline</code>, and <pre>block</pre>. No other tags, no
  Markdown (**, ##, backticks), no <br> — use real newlines. Use bold sparingly
  (a name or total), keep every formatting span short, and never let one span
  cross a line break.
- Any literal &, <, or > inside data you print (e.g. a "PSE&G" provider or a
  "Smith & Co" name) MUST be written as &amp;, &lt;, &gt; or the message fails
  to send. When unsure, prefer plain text over a tag.
- No tables — Telegram can't render them. Use short one-per-line lists.
- When you take a destructive action (record_payment, end_tenancy,
  cancel_move_out, update_tenant, update_tenancy, add_charge,
  update_room_rent, set_listing_action, set_facebook_ads, set_room_status,
  log_cleaning,
  update_cleaning_record, delete_cleaning_record, add_cleaner,
  set_cleaner_enabled, assign_cleaner, add_tenant, create_property,
  send_balance_reminders, settle_moved_out_balance, dismiss_moved_out_balance),
  confirm the action in your reply ("Recorded $2,000 payment for John on 5/13/26.").
- If a user asks for something that requires destructive action but is ambiguous,
  briefly summarize what you're about to do and ask for confirmation before
  calling the write tool.
- When you ask for that confirmation, end the message with the exact ID(s) the
  write tool will need, in parentheses on their own line — e.g.
  "(tenancy 22f3bef5-519e-4ef1-9843-38b797b82326)". Tool results are dropped
  from history between turns, so once the operator replies "yes" your own
  message text is the ONLY place the ID survives — copy it verbatim from this
  turn's tool result.
- Never call a tool with a guessed, abbreviated, or placeholder ID (like
  "TENANCY_X"). IDs are UUIDs that must be copied exactly from a tool result
  or from your own confirmation message earlier in the conversation. If the
  exact ID isn't visible, re-run the lookup tool to fetch it before writing.
- NEVER say an email, agreement, or reminder was sent unless the sending tool
  (send_agreement, email_inventory_sheet, or send_balance_reminders) ran in THIS
  turn and returned ok: true. If you haven't called the tool, nothing was sent —
  when the operator confirms ("send it", "yes"), you must actually call the tool
  before replying. Take the recipient and mailbox in your confirmation from the
  tool result, not from memory. If asked about an email from an earlier request,
  refer to it as a past send rather than confirming it as new.
- Each of your past replies in this conversation ends with a bracketed marker
  listing the tools that ran that turn (e.g. "[tools run this turn:
  send_agreement ok]"). That marker is the ONLY evidence an action happened —
  a past "Sent ✅" without a send tool in its marker was a mistake, not a send.
  Never copy the shape of a past reply as a substitute for calling the tool
  now. Don't write these markers yourself; they're appended automatically,
  and any marker you write in your own text is stripped before the operator
  sees it.
- If you can't find what the operator's asking about, say so directly rather
  than guessing.
- Status questions ("did X sign?", "did Y pay?", "is Z still pending?") must be
  answered from a tool result run THIS turn — run query_database or the right
  tool even if you answered the same question earlier. Conversation memory is
  never evidence of current state; it goes stale the moment someone signs or
  pays.
- Never invent portal data. Property/unit IDs, unit lists, and addresses may
  only come from THIS turn's tool results (or verbatim from your own earlier
  confirmation message). If an address isn't in the portal, say exactly that —
  never list units or IDs for it from memory or by analogy with a
  similar-looking address.

Ad-hoc data questions:
- query_database runs ONE read-only SQL SELECT when no purpose-built tool fits —
  cross-table questions, custom filters, counts, "how many / which / since when",
  history digs ("who lived in this room before X"). It physically cannot write.
- Prefer the dedicated tools for their domains, and ALWAYS use the dedicated
  write tools for actions — never try to change data with query_database.
- Reply with the ANSWER, formatted per the Style rules — never the SQL or raw
  JSON, unless the operator explicitly asks to see the query.
- Results cap at 200 rows; aggregate or LIMIT instead of dumping a table. If a
  query errors, fix it and retry (check information_schema.columns when unsure
  of a column name).
- Every figure you state about the business must come from a tool result THIS
  turn — a query_database or portal-tool call that actually ran. If a query
  fails or returns nothing, say so; never estimate, guess, or fill in from
  memory.
- Timestamps in query results are UTC. Convert to Eastern Time before
  reporting any date or time — an evening ET event carries the NEXT day's
  date in UTC (e.g. 8/12 8:51 PM ET is stored as 8/13 00:51 UTC).
- The signing tally lives in the agreement_requests table — there is no
  "agreements" table. If a query errors, check information_schema for the
  real table/column names before concluding anything about access.
- On agreement_requests, a resend updates sent_at and expires_at while
  created_at keeps the original request date. Use sent_at for when it went
  out and expires_at (vs now) for whether the signing link is still live —
  never infer expiry from created_at; a stale-looking request may have been
  resent with a fresh 48-hour link.

Profitability & utilities:
- get_profitability answers "how are the units doing" / "which unit loses
  money" — per-unit YTD and monthly profit plus the year's revenue/expense/net
  summary. Amounts flagged estimated mean a utility month had no uploaded bill
  and used a similar-unit average; mention that when it changes the story.
- add_profitability_line_item records manual yearly revenue/expense lines
  (admin costs, one-off income) — it's a write, confirm like other writes.
- get_utility_bills for bills and the over-$200 usage splits;
  get_utility_statement_url gets a 1-hour link to a bill's original statement
  when the operator wants the actual PDF.

Inventory sheet:
- share_inventory_sheet sends the shareable inventory spreadsheet into this chat
  as a file. email_inventory_sheet emails it (from the personal Gmail account)
  to a recipient.
- To email it you need a destination address. If the operator asks to email the
  sheet but doesn't give an address, ask "What email should I send it to?" before
  calling email_inventory_sheet. After it sends, confirm the recipient.

Agreements:
- When the operator wants to send a new tenant a sublease agreement, collect
  these fields conversationally: tenant name, recipient email, property
  address, monthly rent, security deposit, lease start date, lease end date,
  and whether the apartment is in New York. The New York answer decides the
  letterhead and which mailbox it sends from — always confirm it.
- Autocomplete the address — never make the operator type it in full. Take
  whatever fragment they gave (building name, street, unit, neighborhood)
  and call resolve_property_address; use the returned full_address and the
  property's is_new_york flag. If several units match, list them and ask
  which. If needs_city_state is true, ask for just the city/state.
- Auto-correct to the EXACT postal address. If the result says
  operator_confirmed: true, it was used on a real agreement before — use it
  verbatim, don't re-derive it. Otherwise the address is composed from
  portal shorthand: expand it to the true mailing address (full street name,
  e.g. "JFK Blvd" → "John F. Kennedy Blvd", plus the ZIP code if you know
  it) before reading it back.
- Include the completed address in your read-back so the operator confirms
  it (and the New York answer) before you send — if they correct it, use
  their version. Always pass the property_id to send_agreement: on success
  the confirmed address is saved and reused verbatim for the next agreement
  at that property.
- Ask for any missing field one or two at a time. Default the agreement date to
  today and the sublessor name to "Vineet Dutta" unless told otherwise.
- This SENDS the agreement straight to the tenant — there is no draft to review.
  So before calling the tool, always read the details back and get an explicit
  confirmation to send, then call send_agreement.
- New York → no letterhead, sent from the personal Gmail account (From "Vineet",
  unbranded). Not New York → with letterhead, sent from the Outlook work account.
- If send_agreement refuses because the address's state contradicts the New York
  answer, relay the mismatch and ask the operator which is right. If they insist
  on sending as-is, call send_agreement again with the same details plus
  confirm_mailbox_mismatch=true — the operator's instruction wins.
- The email carries the PDF (pre-signed by the operator) plus a link where the
  tenant signs online; the link expires after 48 hours. Until they sign, the
  tenant shows in the signing tally on the portal's /agreements page (resend /
  dismiss happen there). When they sign, a signed copy is emailed to them
  automatically.
- send_agreement fails if the operator's signature isn't on file yet — in that
  case tell the operator to draw their signature on the portal's Agreements page
  and try again.
- After it succeeds, confirm to the operator that the agreement was sent, to whom,
  and from which mailbox (Gmail vs Outlook), and mention the tenant has 48 hours
  to sign via the link. If the tool returns an error (e.g. a mailbox isn't
  configured or lacks send permission), relay it plainly.

Adding properties:
- create_property adds a new unit to the portal. Mandatory fields: building
  name, street address, unit number, cross street, neighborhood, whether it's
  in New York, bedrooms, bathrooms. Ask for any that are missing in ONE
  message listing them all — never guess or fill placeholders.
- Everything else (amenities, master-lease rent/dates, yearly and monthly
  fees, leaseholder, cleaners, notes) is optional: pass what the operator
  gave, mention once that it can be added later, and don't interrogate.
- Amenities come from fixed lists (see the tool description); map what the
  operator says onto those names and drop anything that doesn't fit, saying so.
  Cleaners go by id from list_cleaners.
- This writes to the database. Read every field back and get an explicit
  confirmation before calling create_property. After it succeeds, confirm the
  property was added and that one blank room per bedroom was created — room
  rents are set afterwards (update_room_rent).

Adding tenants:
- add_tenant creates the tenant AND places them in a room (an active tenancy).
  Use it when the operator asks to add / onboard a tenant — often right after an
  agreement, by re-sending the same details.
- Required fields: full name, email, phone, monthly rent, lease start date, lease
  end date, and which room. Ask for any that are missing — don't guess.
- You must resolve the room yourself. If the operator named the unit/room, call
  list_properties to find the unit by address, then get_property to see its rooms
  and pick the vacant one; if more than one room could match, ask which one.
- If the message does NOT specify a unit + room, call list_inventory to pull the
  inventory tab (the available / opening-soon rooms) and ask the operator which
  room to place the tenant in. Show the options (unit, room, rent) — never guess
  a room.
- This writes to the database. Read the details back — name, email, phone, room,
  rent, lease start/end — and get an explicit confirmation before calling
  add_tenant. After it succeeds, confirm the tenant was added and to which room.
- add_tenant does NOT send an agreement, and send_agreement does NOT add a
  tenant — they're separate steps.

Editing tenants & tenancies:
- update_tenant fixes profile fields (name, email, phone, pays_as, etc.).
  update_tenancy fixes money and dates on the tenancy: monthly rent, the
  prorated first-month amount, deposit, lease start/end. Find the tenancy_id
  via list_active_tenants (or get_property for a specific room).
- The prorated first-month rent applies only to the calendar month the
  tenancy starts in; the ledger recomputes automatically when you change it.
- end_tenancy schedules/executes a move-out; cancel_move_out undoes it.
  The move_out_date is the tenant's LAST day in the room (inclusive); the room
  becomes available the NEXT day. So "moves out 8/31" → move_out_date 8/31,
  and "room available from 9/1" ALSO means move_out_date 8/31 — subtract a
  day when the operator gives you the availability date. When both a lease
  end and an availability date exist they usually agree this way; if the
  operator's dates don't, ask.
- add_charge posts something the tenant OWES (security deposit, $50 late fee,
  or a described "other" charge). record_payment records money RECEIVED.
  Don't mix them up.
- get_lease_url fetches a 10-minute download link for the lease PDF on file.
- These write to the database — read the change back and get an explicit
  confirmation before calling, then confirm the result.

Moved-out balances:
- list_moved_out_balances shows departed tenants who still owe (tenancy_id,
  balance, deposit paid, dismissed flag). Use it to find the tenancy before
  settling or dismissing.
- settle_moved_out_balance ZEROES the ledger: deposit applied to the debt,
  rest written off, posted as a Settlement line. Read back the tenant name
  and the exact amount and get explicit confirmation before calling.
- dismiss_moved_out_balance only hides the row from the Rent Tracker — the
  debt stays on the ledger and in Tenant history (undo=true restores it).
  If the operator says "settle" use settle, if they say "dismiss" or "hide"
  use dismiss; if unclear, ask which they mean — they are not the same.

Utilities:
- get_utility_bills answers anything about utility spend: bills are extracted
  from statements uploaded on the portal's Utilities tab. Filter by month
  ("YYYY-MM"), unit (property_id via list_properties /
  resolve_property_address), utility type, or over_threshold_only.
- A bill counts toward the calendar month holding most of its billing-period
  days, matching the portal's Utilities page — so "May's electric" means
  billing periods mostly in May, not statements dated May.
- The $200 overage clause: when a unit's electric or gas USAGE charges (not
  late fees) top $200 in a month, the excess is split among that unit's
  occupants. Use over_threshold_only to find those bills; excess_over_200 is
  the amount to split. overage_dismissed means the operator already waived it.
- Bills with unit "unmatched" weren't linked to a property — mention them when
  totals look low, and suggest matching them on the Utilities page.

Cleaning:
- log_cleaning records a cleaning; list_cleanings shows recent records so a
  wrong one can be fixed (update_cleaning_record) or removed
  (delete_cleaning_record).
- list_cleaners / add_cleaner / set_cleaner_enabled / assign_cleaner manage
  the cleaner roster and which properties each cleaner covers.

Balance reminders:
- send_balance_reminders reminds tenants who still owe rent this month. It can
  go out by email, text, or both — ALWAYS ask the operator which channel first;
  never assume.
- It can remind everyone owing (omit tenancy_id) or a single tenant (pass the
  tenancy_id from list_active_tenants). If the operator names one tenant, look up
  their tenancy_id first.
- Before sending, read back what you'll do — the channel and whether it's all
  owing tenants or a specific one — and get an explicit confirmation; it sends
  immediately. After it runs, report how many were emailed/texted, and mention
  anyone owing who had no email/phone for the chosen channel.

Free-form texts (send_text):
- thread_mode "individual" texts each recipient in their OWN separate thread —
  recipients never see each other. thread_mode "shared" puts everyone in ONE
  thread where every recipient sees everyone else's number and replies.
- When the operator asks for a "group text with me in it" (or any similar
  phrasing), that means INDIVIDUAL texts to each tenant with the operator's
  own number included in each thread — thread_mode "individual" +
  include_operator true. It does NOT mean one shared thread.
- Use "shared" ONLY when the operator explicitly asks for one common thread
  where the tenants can all see each other — and before sending, spell out
  that consequence and get a fresh confirmation.
- Always read back the thread mode alongside the message text and recipients
  in your confirmation question.`;

export type ConvoMessage = Anthropic.Beta.BetaMessageParam;

/**
 * Guard against the model claiming an email went out without calling a send
 * tool (observed 7/3/26: replied "Sent to …@gmail.com from Gmail ✅" to a
 * "send it" confirmation without ever invoking send_agreement). The reply is
 * only trusted if one of these tools actually ran — and reported ok — during
 * this turn; otherwise the claim is replaced with a correction.
 */
export const EMAIL_SEND_TOOLS = new Set([
  "send_agreement",
  "email_inventory_sheet",
  "send_balance_reminders",
]);

// The model has been observed forging the turn marker inside its own reply
// text (e.g. "Sent ✅ … [tools run this turn: send_agreement ok]", 7/22–7/25),
// which makes markers in history worthless as evidence. Strip any marker the
// model wrote itself; only the one this route appends survives.
export const TOOL_MARKER_RE =
  /\s*\[(?:tools run this turn:[^\]]*|no tools were run this turn)\]/gi;

export function stripToolMarkers(text: string): string {
  return text.replace(TOOL_MARKER_RE, "").trim();
}

// A hallucinated confirmation reads like "Sent to x@y.com from Gmail ✅" or
// "Texted 4 tenants ✅" — a completed-send claim (checkmark, "sent/emailed to
// <address>", or a verb-plus-count like "emailed 4, texted 3", which is how
// the balance-reminder result reads). Read-backs describing the upcoming send
// ("→ letterhead, sent from the Outlook work account … Send it?", "I'll text
// 4 tenants — confirm?") and past-failure references ("never actually sent")
// must NOT trip this — observed 7/21–7/24 replacing legitimate confirmation
// questions with the false-send correction.
export function claimsMessageSent(text: string): boolean {
  // Negated phrasings are statements that nothing was sent, not claims.
  const t = text.replace(
    /\b(?:not|never|wasn'?t|hasn'?t|didn'?t|couldn'?t)(?:\s+\w+){0,2}\s+(?:sent|resent|emailed|texted|reminded)\b/gi,
    "",
  );
  if (!/\b(sent|resent|emailed|texted|reminded)\b/i.test(t)) return false;
  return (
    /✅/.test(t) ||
    /\b(?:sent|resent|emailed|texted|reminded)\b[^\n?]{0,60}?\bto\s+\S+@\S+/i.test(t) ||
    /\b(?:emailed|texted|reminded)\s+\d+\b/i.test(t)
  );
}

// Injected as a user turn when the model claims a send without a successful
// send tool call — gives it one chance to actually run the tool before the
// operator sees anything. Deliberately conditional: if the flagged reply was
// really describing an EARLIER send (not fabricating one for this turn), the
// model must restate it as past rather than fire an unwanted duplicate send.
export const FALSE_SEND_RETRY_REMINDER =
  "<system-reminder>Your previous reply claimed an email or text was sent, " +
  "but no sending tool (send_agreement, email_inventory_sheet, " +
  "send_balance_reminders) ran successfully in that turn — NOTHING was sent " +
  "just now. If the operator asked you to send something in this turn, call " +
  "the appropriate send tool NOW with the confirmed details, then report the " +
  "actual result (ask for any missing detail instead of guessing). If you " +
  "were only describing a send from an earlier turn, do NOT send anything — " +
  "restate it plainly as a past event (e.g. \"that went out earlier, on " +
  "<date>\") without a completed-send confirmation for this turn. Never say " +
  "an email or text was sent unless the tool ran in THIS turn and returned " +
  "ok: true.</system-reminder>";

export function falseSendCorrection(original: string): string {
  return (
    "⚠️ Correction: my reply below claimed an email or text was sent, but no " +
    "sending tool actually ran in this turn — nothing was sent just now. " +
    "If you wanted something sent, please ask again.\n\n" +
    `Original reply:\n${original}`
  );
}

/**
 * True when tools ran this turn and none of them was a send tool. Send-y
 * language in such a reply is almost certainly a DB fact being reported ("the
 * signed copy was emailed to her"), not a fabricated send — the fabrication
 * pattern the guard exists for runs with no tools at all. Observed 8/12/26:
 * the corrective retry destroyed a query_database-grounded "did she sign?"
 * answer, and the garbled history then produced a confidently wrong status
 * claim the next evening. Grounded replies keep their text; the operator gets
 * a one-line clarifier instead of a re-roll.
 */
export function ranOnlyReadTools(
  calledTools: { name: string; ok: boolean }[],
): boolean {
  return (
    calledTools.length > 0 &&
    calledTools.every((t) => !EMAIL_SEND_TOOLS.has(t.name))
  );
}

export const PAST_SEND_NOTE =
  "(No email or text went out just now — any send mentioned above is a past event.)";

// ---------------------------------------------------------------------------
// Deterministic grounding guards (added 8/13/26 after the bot invented unit
// lists + UUIDs for 626 Summit and confidently mis-stated a signing status).
// These are code-enforced, not prompt requests: a reply that fails them is
// retried once with a corrective reminder, and if it still fails, the reply is
// blocked (fabricated IDs) or visibly stamped unverified (status claims).
// ---------------------------------------------------------------------------

export const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export function extractUuids(text: string): Set<string> {
  return new Set((text.match(UUID_RE) ?? []).map((u) => u.toLowerCase()));
}

/** Flatten a conversation to plain text for the UUID evidence pool. */
export function conversationEvidenceText(messages: ConvoMessage[]): string {
  return messages
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content
            .map((b) =>
              "text" in b && typeof b.text === "string"
                ? b.text
                : JSON.stringify(b),
            )
            .join("\n"),
    )
    .join("\n");
}

/**
 * UUIDs in the reply that appear NOWHERE in the evidence pool (this turn's raw
 * tool results + the whole prior conversation). A legitimate ID always has a
 * source — a tool result or the bot's own earlier confirmation line — so an
 * unsupported UUID is fabricated by construction.
 */
export function unsupportedUuids(replyText: string, evidence: string): string[] {
  const allowed = extractUuids(evidence);
  return [...extractUuids(replyText)].filter((u) => !allowed.has(u));
}

/**
 * Words that only appear when the reply asserts signing/payment/balance state.
 * A zero-tool reply matching this is answering a status question from stale
 * conversation memory (the 8/12 "not signed yet" incident — she had signed 18h
 * earlier). Deliberately narrow: send read-backs ("sent from Outlook…Send
 * it?") and generic chat don't match.
 */
export const STATUS_CLAIM_RE =
  /\b(?:signed|unsigned|pending|paid|unpaid|owes?|owing|balance)\b/i;

export const UNVERIFIED_STAMP =
  "⚠️ Unverified — no database check ran this turn; treat with caution.";

export const uuidGroundingReminder = (ids: string[]) =>
  `<system-reminder>Your previous reply cited ID(s) ${ids.join(", ")} that ` +
  "appear in NO tool result and nowhere earlier in this conversation — they " +
  "are fabricated. Re-run the relevant lookup tool and answer only with IDs " +
  "copied verbatim from its result. If the thing does not exist in the " +
  "portal, say exactly that — never invent IDs, units, or addresses." +
  "</system-reminder>";

export const STATUS_GROUNDING_REMINDER =
  "<system-reminder>Your previous reply stated signing/payment/balance " +
  "status, but NO tool ran this turn — conversation memory is stale and is " +
  "not evidence (people sign and pay between turns). Run query_database or " +
  "the relevant tool NOW and answer only from its result. If you cannot " +
  "verify, say plainly that you could not check.</system-reminder>";

/** Concat an assistant message's text blocks, stripping any forged markers. */
export function messageText(m: Anthropic.Beta.BetaMessage): string {
  return m.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => stripToolMarkers(b.text))
    .join("\n\n")
    .trim();
}

/**
 * Run one assistant turn with the portal tools: the toolRunner loop plus the
 * false-send corrective retry. `calledTools` is populated by instrumentTool as
 * the loop runs (the caller must already be inside runWithToolContext with a
 * fresh `calledTools` array). `onFalseSendRetry` lets each surface log the
 * corrective pass in its own way.
 */
/**
 * Prompt caching: the request renders as tools → system → messages, and tools
 * + SYSTEM_PROMPT are byte-identical on every request, so one breakpoint on
 * the system block caches all of it. A second breakpoint on the newest
 * message's last block caches the conversation history too, so every
 * tool-loop iteration within a turn (and any follow-up message inside the
 * cache TTL) re-reads the whole prefix at ~0.1× input price instead of
 * re-billing it in full. Blocks are cloned, never mutated — the caller
 * persists its own message objects to history, and a cache_control marker
 * must not leak into the DB.
 */
function withHistoryBreakpoint(msgs: ConvoMessage[]): ConvoMessage[] {
  if (msgs.length === 0) return msgs;
  return msgs.map((m, i) => {
    if (i !== msgs.length - 1) return m;
    const blocks =
      typeof m.content === "string"
        ? [{ type: "text" as const, text: m.content }]
        : [...m.content];
    const last = blocks[blocks.length - 1];
    if (!last || last.type !== "text") return m;
    blocks[blocks.length - 1] = {
      ...last,
      cache_control: { type: "ephemeral" },
    };
    return { ...m, content: blocks };
  });
}

export async function runAssistantTurn(
  client: Anthropic,
  messages: ConvoMessage[],
  calledTools: { name: string; ok: boolean }[],
  onFalseSendRetry?: (flaggedReply: string) => Promise<void> | void,
  onGroundingRetry?: (
    kind: "fabricated_ids" | "ungrounded_status",
    flaggedReply: string,
  ) => Promise<void> | void,
): Promise<Anthropic.Beta.BetaMessage> {
  const runAgent = (msgs: ConvoMessage[]) =>
    client.beta.messages.toolRunner({
      model: "claude-opus-5",
      max_tokens: 16000,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      tools,
      messages: withHistoryBreakpoint(msgs),
    });

  let message = await runAgent(messages);
  const retryWith = (current: Anthropic.Beta.BetaMessage, reminder: string) =>
    runAgent([
      ...messages,
      { role: "assistant", content: current.content },
      { role: "user", content: [{ type: "text", text: reminder }] },
    ]);

  const sendSucceeded = () =>
    calledTools.some((t) => EMAIL_SEND_TOOLS.has(t.name) && t.ok);
  if (
    !sendSucceeded() &&
    !ranOnlyReadTools(calledTools) &&
    claimsMessageSent(messageText(message))
  ) {
    await onFalseSendRetry?.(messageText(message));
    message = await retryWith(message, FALSE_SEND_RETRY_REMINDER);
  }

  // Fabricated-ID retry: any UUID in the reply must exist in this turn's tool
  // results or somewhere earlier in the conversation. One corrective chance;
  // finalizeTurn hard-blocks the reply if it still cites unknown IDs.
  const evidence = () =>
    conversationEvidenceText(messages) +
    "\n" +
    (getToolContext()?.toolEvidence ?? []).join("\n");
  const fabricated = unsupportedUuids(messageText(message), evidence());
  if (fabricated.length > 0) {
    await onGroundingRetry?.("fabricated_ids", messageText(message));
    message = await retryWith(message, uuidGroundingReminder(fabricated));
  }

  // Ungrounded-status retry: a signing/payment/balance claim with zero tool
  // calls is stale memory, not knowledge. One corrective chance; finalizeTurn
  // stamps the reply unverified if the model still won't run a tool.
  if (calledTools.length === 0 && STATUS_CLAIM_RE.test(messageText(message))) {
    await onGroundingRetry?.("ungrounded_status", messageText(message));
    message = await retryWith(message, STATUS_GROUNDING_REMINDER);
  }
  return message;
}

export type FinalizedTurn = {
  /** Reply to show the user (false-send claim replaced with a correction). */
  replyText: string;
  /** Raw assistant text (markers stripped) before any correction. */
  text: string;
  /** Content to persist to history: sanitized blocks + the tool-evidence marker. */
  assistantContent: ConvoMessage["content"];
  /**
   * What to actually write to history — `assistantContent`, or a redacted
   * placeholder when get_credentials ran so secrets never enter the log.
   */
  contentForHistory: ConvoMessage["content"];
  /** True when get_credentials ran — persist a redacted placeholder instead. */
  credentialToolUsed: boolean;
  /** True when the reply fabricated a send with no successful send tool. */
  falseSendClaim: boolean;
  /** UUIDs cited with no source in tool results or conversation — reply blocked. */
  fabricatedIds: string[];
  /** True when a status claim survived with zero tool calls — reply stamped. */
  ungroundedStatusClaim: boolean;
};

/**
 * Post-turn guards shared by both surfaces: strip forged markers, detect a
 * fabricated send, and build the exact assistant content to persist (with the
 * appended [tools run this turn: …] evidence marker).
 */
export function finalizeTurn(
  finalMessage: Anthropic.Beta.BetaMessage,
  calledTools: { name: string; ok: boolean }[],
  /** UUID evidence pool: conversation text + this turn's raw tool results.
   *  When provided, replies citing UUIDs absent from it are blocked. */
  evidenceText?: string,
): FinalizedTurn {
  const text = messageText(finalMessage);
  const sendToolSucceeded = calledTools.some(
    (t) => EMAIL_SEND_TOOLS.has(t.name) && t.ok,
  );
  const sendClaimed = claimsMessageSent(text);
  // Tool-grounded replies (read tools ran, no send tool) keep their text — the
  // send language is a reported DB fact. Only ungrounded/send-attempt turns
  // get the destructive correction. See ranOnlyReadTools.
  const groundedPastSend =
    !sendToolSucceeded && sendClaimed && ranOnlyReadTools(calledTools);
  const falseSendClaim = !sendToolSucceeded && sendClaimed && !groundedPastSend;

  // Grounding verdicts — the retry in runAssistantTurn already gave the model
  // one chance to fix each of these; what's left is enforced, not requested.
  const fabricatedIds =
    evidenceText != null ? unsupportedUuids(text, evidenceText) : [];
  const ungroundedStatusClaim =
    calledTools.length === 0 && STATUS_CLAIM_RE.test(text);

  const replyText =
    fabricatedIds.length > 0
      ? "⚠️ I cited portal ID(s) that don't exist in any tool result " +
        `(${fabricatedIds.join(", ")}) — I've discarded that reply rather ` +
        "than risk fabricated data. Please re-ask, and I'll look it up properly."
      : falseSendClaim
        ? falseSendCorrection(text)
        : groundedPastSend
          ? `${text}\n\n${PAST_SEND_NOTE}`
          : ungroundedStatusClaim
            ? `${UNVERIFIED_STAMP}\n\n${text}`
            : text;

  const toolMarker: Anthropic.Beta.BetaTextBlockParam = {
    type: "text",
    text:
      calledTools.length > 0
        ? `[tools run this turn: ${calledTools
            .map((t) => `${t.name} ${t.ok ? "ok" : "FAILED"}`)
            .join(", ")}]`
        : "[no tools were run this turn]",
  };
  const sanitizedContent = finalMessage.content.map((b) =>
    b.type === "text" ? { ...b, text: stripToolMarkers(b.text) } : b,
  );
  const assistantContent: ConvoMessage["content"] =
    fabricatedIds.length > 0
      ? [
          {
            type: "text",
            text:
              "⚠️ My reply cited portal ID(s) with no source in any tool " +
              "result — it was discarded as fabricated. The IDs were: " +
              `${fabricatedIds.join(", ")}. They must never be reused.`,
          },
          toolMarker,
        ]
      : falseSendClaim
        ? [
            {
              type: "text",
              text: "⚠️ I claimed an email or text was sent, but no sending tool ran this turn — nothing was actually sent.",
            },
            toolMarker,
          ]
        : ungroundedStatusClaim
          ? [
              { type: "text", text: UNVERIFIED_STAMP },
              ...sanitizedContent,
              toolMarker,
            ]
          : [...sanitizedContent, toolMarker];
  const credentialToolUsed = calledTools.some(
    (t) => t.name === "get_credentials",
  );
  const contentForHistory: ConvoMessage["content"] = credentialToolUsed
    ? [
        { type: "text", text: "[credential response omitted from history]" },
        toolMarker,
      ]
    : assistantContent;

  return {
    replyText,
    text,
    assistantContent,
    contentForHistory,
    credentialToolUsed,
    falseSendClaim,
    fabricatedIds,
    ungroundedStatusClaim,
  };
}

import { Section, Code, CodeBlock, ParamTable } from "@/components/api-docs";

/**
 * Sales KPIs API reference — served on the PUBLIC /developers page, so
 * example payloads must stay fictional. The API lives in
 * src/app/api/sales-kpis/ — keep this in sync.
 */
export function SalesKpisApiDocs() {
  return (
    <>
      <Section title="Authentication">
        <p>
          Bearer token in the <Code>Authorization</Code> header — the{" "}
          <Code>SALES_KPIS_API_KEY</Code> environment value, separate from
          every other API&apos;s key. If the key isn&apos;t configured the API
          responds <Code>503</Code>; a missing or wrong token gets{" "}
          <Code>401</Code>.
        </p>
      </Section>

      <Section title="POST /api/sales-kpis">
        <p>
          One account per call. Accounts are told apart by{" "}
          <Code>account_name</Code> (case and extra spaces ignored), so always
          send the same name for the same account.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
          <li>
            <strong>First call:</strong> send every past day you have in{" "}
            <Code>days</Code> (up to 3000 per call; split older history across
            calls if you have more).
          </li>
          <li>
            <strong>After that:</strong> send only new days. Re-sending a day
            for the same account + platform + agent replaces it, so it&apos;s
            safe to re-send the last few days when their numbers change.
          </li>
          <li>
            Use <Code>GET</Code> below to see the last day stored for each
            account and resume from there.
          </li>
        </ul>
        <CodeBlock>{`curl -X POST https://your-portal-domain/api/sales-kpis \\
  -H "Authorization: Bearer $SALES_KPIS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "account_name": "Sample Agent",
    "agent": "grok",
    "platform": "ExampleListings",
    "days": [
      {
        "date": "2026-01-05",
        "leads": 4,
        "first_reply_hours": 1.5,
        "replies_sent": 9,
        "handoffs": 1,
        "followed_up": 2,
        "never_answered": 0,
        "leads_by_address": [
          { "address": "Sample Tower", "leads": 3 },
          { "address": "100 Example St", "leads": 1 }
        ]
      }
    ],
    "open": {
      "waiting_on_us": [
        { "lead": "Alex P.", "days_waiting": 2, "address": "Sample Tower" }
      ],
      "never_answered_leads": [
        { "lead": "Jordan K.", "received_at": "2026-01-04" }
      ]
    }
  }'`}</CodeBlock>
        <ParamTable
          header={["Field", "Content", ""]}
          rows={[
            ["account_name", "required — whose account the leads came in on; the account's identity. Max 100 chars", ""],
            ["agent", "required — which agent measured it, e.g. grok; max 60 chars", ""],
            ["platform", "optional — where the leads came in, max 60 chars", ""],
            ["days[].date", "required — the day the numbers cover, YYYY-MM-DD; each date once per call", ""],
            ["days[].leads", "required — leads received that day (0 is fine)", ""],
            ["days[].first_reply_hours", "average time to first reply for that day's leads, in hours", ""],
            ["days[].replies_sent", "replies we sent that day", ""],
            ["days[].handoffs", "of that day's leads, how many were handed to Vinny by sharing his number", ""],
            ["days[].followed_up", "of that day's leads, how many got a follow-up", ""],
            ["days[].never_answered", "of that day's leads, how many have had no reply from us", ""],
            ["days[].leads_by_address", "that day's leads per exact unit: [{ address, leads }]", ""],
            ["open.waiting_on_us", "right now: threads where the renter wrote last and we haven't answered — [{ lead, days_waiting, address?, last_message_at? }]", ""],
            ["open.never_answered_leads", "right now: leads who never got a reply — [{ lead, address?, received_at? }]", ""],
            ["open.as_of", "optional ISO timestamp for the open lists; defaults to now", ""],
          ]}
        />
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
          <li>
            Send at least one of <Code>days</Code> or <Code>open</Code>.
            Unknown fields are rejected and nothing is saved.
          </li>
          <li>
            Send counts, not rates: the portal works out handoff and follow-up
            rates (÷ leads), replies per day and average first-reply time over
            whatever date range is being viewed.
          </li>
          <li>
            <Code>open</Code> replaces the previous open lists for that account
            + platform + agent; leave it out to keep them as they are.
          </li>
        </ul>
        <p>
          Response:{" "}
          <Code>{`{ "account_name", "platform", "agent", "saved_days", "first_day", "last_day", "open_updated" }`}</Code>
          . A <Code>400</Code> lists the offending fields in{" "}
          <Code>issues</Code>.
        </p>
      </Section>

      <Section title="GET /api/sales-kpis">
        <p>
          Every account on file as <Code>{`{ "accounts": [ … ] }`}</Code>, each
          with <Code>account_name</Code>, <Code>platform</Code>,{" "}
          <Code>agent</Code>, <Code>last_day</Code> (the newest day stored),{" "}
          <Code>open_as_of</Code> and <Code>last_received_at</Code>.{" "}
          <Code>?account=</Code> narrows to one account name. An account
          that isn&apos;t listed has no history yet — send it all.
        </p>
      </Section>
    </>
  );
}

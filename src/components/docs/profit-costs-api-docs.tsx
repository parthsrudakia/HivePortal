import { Section, Code, CodeBlock, ParamTable } from "@/components/api-docs";

/**
 * Profit costs API reference (monthly cost intake for the Profitability
 * tab) — served on the PUBLIC /developers page, so example payloads must stay
 * fictional. The API lives in src/app/api/profitability/costs/ — keep this
 * in sync.
 */
export function ProfitCostsApiDocs() {
  return (
    <>
      <Section title="Authentication">
        <p>
          Bearer token in the <Code>Authorization</Code> header — the{" "}
          <Code>PROFIT_COSTS_API_KEY</Code> environment value, separate from
          every other API&apos;s key. If the key isn&apos;t configured the API
          responds <Code>503</Code>; a missing or wrong token gets{" "}
          <Code>401</Code>.
        </p>
      </Section>

      <Section title="POST /api/profitability/costs">
        <p>
          Send one or more cost lines read from rent portals (or any other
          source) as JSON, up to 500 per request. Each line is one charge for
          one month. Re-sending a line with the same <Code>ref</Code> replaces
          it, so a weekly run can safely send a whole month again.
        </p>
        <CodeBlock>{`curl -X POST https://your-portal-domain/api/profitability/costs \\
  -H "Authorization: Bearer $PROFIT_COSTS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "costs": [
      {
        "ref": "exampleportal:100-sample-st-3b:2026-10:amenity",
        "type": "amenity",
        "month": "2026-10",
        "amount": 45.00,
        "unit": "100 Sample St Apt 3B, Exampleville NY 10000",
        "label": "Amenity fee"
      },
      {
        "ref": "exampleportal:100-sample-st-3b:2026-10:rent",
        "type": "rent_paid",
        "month": "2026-10",
        "amount": 3150.00,
        "unit": "100 Sample St Apt 3B"
      }
    ]
  }'`}</CodeBlock>
        <ParamTable
          header={["Field", "Content", ""]}
          rows={[
            ["ref", "required — your stable id for this line (portal + unit + month + charge works well); max 200 chars", ""],
            ["type", "required — rent_paid, internet, cleaning, insurance, amenity, misc, or company", ""],
            ["month", "required — the month the charge is for, YYYY-MM", ""],
            ["amount", "required — dollars; negative for a credit", ""],
            ["unit", "the unit's address including the apartment number (matched like utility statements)", ""],
            ["property_id", "the unit's id from GET below — use instead of unit when you have it", ""],
            ["label", "optional — what the charge is, e.g. Amenity fee", ""],
            ["notes", "optional — anything worth keeping, max 1000 chars", ""],
          ]}
        />
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
          <li>
            Every type except <Code>company</Code> needs a unit (by{" "}
            <Code>unit</Code> or <Code>property_id</Code>);{" "}
            <Code>company</Code> costs (e.g. Upwork) must have neither.
          </li>
          <li>
            Rent paid, internet, cleaning and insurance: a month with lines
            replaces the unit&apos;s flat monthly figure for that month.
            Amenity and misc: once a unit has any lines that year, only the
            lines count.
          </li>
          <li>
            Several lines of the same type and month for one unit add up — use
            different <Code>ref</Code>s for them.
          </li>
        </ul>
        <p>Response — one result per line, in order:</p>
        <CodeBlock>{`{
  "saved": 1,
  "unmatched": 1,
  "invalid": 0,
  "results": [
    { "ref": "exampleportal:100-sample-st-3b:2026-10:amenity", "status": "saved",
      "property_id": "00000000-0000-4000-8000-000000000000", "unit_label": "Sample Tower Apt 3B" },
    { "ref": "exampleportal:100-sample-st-3b:2026-10:rent", "status": "unmatched",
      "error": "no single unit matches this address" }
  ]
}`}</CodeBlock>
        <p>
          <Code>unmatched</Code> lines named a unit the portal couldn&apos;t
          match — resend them with <Code>property_id</Code>.{" "}
          <Code>invalid</Code> lines failed validation (the{" "}
          <Code>error</Code> says why). Neither is saved; the rest of the
          request still is.
        </p>
      </Section>

      <Section title="GET /api/profitability/costs">
        <p>
          The units to match against (no tenant data) and the cost lines
          already stored for a month range — use it to find a{" "}
          <Code>property_id</Code> or to skip months already sent.
        </p>
        <ParamTable
          header={["Query", "Content", ""]}
          rows={[
            ["from", "YYYY-MM, default January of this year", ""],
            ["to", "YYYY-MM, default December of this year", ""],
          ]}
        />
        <CodeBlock>{`{
  "from": "2026-10",
  "to": "2026-10",
  "units": [
    { "property_id": "00000000-0000-4000-8000-000000000000", "label": "Sample Tower Apt 3B",
      "street_address": "100 Sample St", "unit_number": "3B" }
  ],
  "costs": [
    { "ref": "exampleportal:100-sample-st-3b:2026-10:amenity", "source": "agent",
      "property_id": "00000000-0000-4000-8000-000000000000", "month": "2026-10",
      "type": "amenity", "amount": 45, "label": "Amenity fee",
      "updated_at": "2026-11-17T14:00:00.000Z" }
  ]
}`}</CodeBlock>
      </Section>

      <Section title="DELETE /api/profitability/costs?ref=…">
        <p>
          Remove one line you sent earlier, by its <Code>ref</Code>. Only
          lines sent through this API can be deleted here; costs entered on
          the Profitability page are left alone. Returns{" "}
          <Code>{`{ "deleted": 1 }`}</Code> (or <Code>0</Code> when no line
          had that ref).
        </p>
      </Section>
    </>
  );
}

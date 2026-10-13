import { Section, Code, CodeBlock, ParamTable } from "@/components/api-docs";

/**
 * Utilities statement-intake API reference — served on the PUBLIC
 * /developers page, so the example payload must stay fictional. The API
 * lives in src/app/api/utilities/statements/ — keep this in sync.
 */
export function UtilitiesApiDocs() {
  return (
    <>
      <Section title="Authentication">
        <p>
          Bearer token in the <Code>Authorization</Code> header — the{" "}
          <Code>UTILITIES_API_KEY</Code> environment value, separate from the
          tenants and inventory keys. If the key isn&apos;t configured the API
          responds <Code>503</Code>; a missing or wrong token gets{" "}
          <Code>401</Code>.
        </p>
      </Section>

      <Section title="POST /api/utilities/statements">
        <p>
          Submit one utility statement plus the fields you read from it, as{" "}
          <Code>multipart/form-data</Code>. The portal checks your fields
          against the PDF&apos;s own text with plain code — no AI call — and
          logs the bill. If a check fails (scanned PDF, photo, a number that
          isn&apos;t printed on the statement, charges that don&apos;t add
          up), the portal reads the statement itself instead, which is slower
          and costs money, so accurate fields matter.
        </p>
        <ParamTable
          header={["Part", "Content", ""]}
          rows={[
            ["statement", "the original statement file — PDF preferred (PNG/JPEG/WebP accepted), max 20 MB", ""],
            ["data", "JSON string, schema below", ""],
          ]}
        />
        <CodeBlock>{`curl -X POST https://your-portal-domain/api/utilities/statements \\
  -H "Authorization: Bearer $UTILITIES_API_KEY" \\
  -F statement=@statement.pdf \\
  -F 'data={
    "provider": "Example Electric",
    "utility_type": "electric",
    "account_number": "1234 5678 90",
    "service_address": "100 Sample St Apt 3B, Exampleville NJ 07000",
    "statement_date": "2026-09-18",
    "period_start": "2026-08-14",
    "period_end": "2026-09-15",
    "charges": [
      { "kind": "current", "description": "Electric delivery", "amount": 61.20 },
      { "kind": "current", "description": "Electric supply", "amount": 48.75 },
      { "kind": "late_fee", "description": "Late payment charge", "amount": 5.00 }
    ],
    "printed_total": 114.95,
    "notes": null
  }'`}</CodeBlock>
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
          <li>
            <Code>utility_type</Code> — <Code>electric</Code> for any bill
            with electricity (including combined electric + gas),{" "}
            <Code>gas</Code> for gas-only; also <Code>water</Code>,{" "}
            <Code>internet</Code>, <Code>trash</Code>, <Code>other</Code>.
          </li>
          <li>
            <Code>charges</Code> — only what is billed <em>for this
            cycle</em>. Never include previous balance, payments, credits,
            re-billed earlier periods, or security-deposit lines. Amounts are
            positive and must appear on the statement exactly as printed.{" "}
            <Code>kind</Code> is <Code>current</Code> (usage, supply,
            delivery, taxes), <Code>late_fee</Code>, or <Code>other</Code>.
          </li>
          <li>
            <Code>printed_total</Code> — this cycle&apos;s new-charges total
            as printed (not the amount due). Your charges must add up to it.
          </li>
          <li>
            Dates are <Code>YYYY-MM-DD</Code>; <Code>account_number</Code>{" "}
            as printed (spaces/dashes are fine). Don&apos;t send a unit — the
            portal matches the service address to a unit itself.
          </li>
        </ul>
        <CodeBlock>{`201 Created
{
  "bill_id": "0b6f6a52-6a4e-4a8e-9d55-2f1f3e1c9a10",
  "total": 114.95,
  "unit": "Sample House Apt 3B",
  "source": "agent",
  "warnings": []
}`}</CodeBlock>
        <p>
          <Code>source</Code> is <Code>agent</Code> when your fields passed
          and were stored as sent, or <Code>claude_fallback</Code> when the
          portal had to read the statement — <Code>warnings</Code> then lists
          the checks your data failed. <Code>unit</Code> is{" "}
          <Code>null</Code> when no unit matched; an operator assigns it.
        </p>
      </Section>

      <Section title="GET /api/utilities/coverage">
        <p>
          What&apos;s already logged, so you only download statements that
          aren&apos;t. For every active unit, one entry per utility account
          with the last billing period on file. Download only statements
          whose billing period ends <em>after</em>{" "}
          <Code>last_period_end</Code>; a unit with an empty{" "}
          <Code>coverage</Code> list has nothing logged yet. Bills not yet
          assigned to a unit are listed under <Code>unassigned</Code>.
        </p>
        <CodeBlock>{`GET /api/utilities/coverage

{
  "as_of": "2026-10-13",
  "units": [
    {
      "unit": "Sample House Apt 3B",
      "service_address": "100 Sample St Apt 3B",
      "coverage": [
        {
          "provider": "Example Electric",
          "utility_type": "electric",
          "account_number": "1234 5678 90",
          "last_period_end": "2026-09-15",
          "last_statement_date": "2026-09-18",
          "bills_logged": 7
        }
      ]
    },
    { "unit": "Sample House Apt 4A", "service_address": "100 Sample St Apt 4A", "coverage": [] }
  ],
  "unassigned": []
}`}</CodeBlock>
      </Section>

      <Section title="Errors">
        <p>
          Always JSON: <Code>{`{ "error": "<message>" }`}</Code>, sometimes
          with <Code>issues</Code> or <Code>failed_checks</Code>.
        </p>
        <ParamTable
          header={["Status", "Meaning", ""]}
          rows={[
            ["400", "Malformed request (POST) or data that doesn't match the schema (see issues)", ""],
            ["401", "Missing or wrong bearer token", ""],
            ["409", "Duplicate — same file, or a bill for the same account and period is already logged. Don't retry.", ""],
            ["422", "Statement couldn't be read or logged (see error / failed_checks)", ""],
            ["503", "The API is not configured on the server", ""],
          ]}
        />
      </Section>
    </>
  );
}

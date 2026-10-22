import { Section, Code, CodeBlock, ParamTable } from "@/components/api-docs";

/**
 * Credentials API reference content — served on the PUBLIC /developers page,
 * so the example payload must stay fictional (never paste a real login
 * here). The API itself lives in src/app/api/credentials/ — keep this in
 * sync when it changes.
 */
export function CredentialsApiDocs() {
  return (
    <>
      <Section title="Authentication">
        <p>
          Every request needs a bearer token in the <Code>Authorization</Code>{" "}
          header. The token is the <Code>CREDENTIALS_API_KEY</Code> environment
          value — separate from every other API key, because this API returns
          plaintext passwords. If the key isn&apos;t configured on the server,
          the API responds <Code>503</Code> (disabled).
        </p>
        <CodeBlock>{`curl -H "Authorization: Bearer $CREDENTIALS_API_KEY" \\
  "https://your-portal-domain/api/credentials?category=utility"`}</CodeBlock>
        <p>
          A missing or wrong token gets <Code>401 {"{"}&quot;error&quot;:
          &quot;unauthorized&quot;{"}"}</Code>.
        </p>
      </Section>

      <Section title="GET /api/credentials">
        <p>
          Stored logins with their decrypted passwords. Optional query params
          filter the list; combine them freely:
        </p>
        <ParamTable
          rows={[
            ["property_id", "UUID — credentials attached to one property", "—"],
            [
              "category",
              "payment_portal · maintenance_portal · utility · internet · building_login · other",
              "—",
            ],
            [
              "q",
              "case-insensitive substring over service, username and owner",
              "—",
            ],
          ]}
        />
        <CodeBlock>{`GET /api/credentials?category=utility&q=electric

{
  "count": 1,
  "credentials": [
    {
      "id": "5b1e7c2a-3f40-4d8e-9a61-0c2b7e9d4f13",
      "category": "utility",
      "service_name": "Example Electric",
      "property_id": "9c3d1a7e-6b2f-4e58-8d10-2a4f6c8e0b95",
      "unit": "Hudson Park Apt 604",
      "username": "ops@example.com",
      "password": "example-password",
      "login_url": "https://login.example.com",
      "account_number": "0000-1234-5678",
      "owner": "Example LLC",
      "notes": null,
      "updated_at": "2026-08-08T14:02:11.000Z"
    }
  ]
}`}</CodeBlock>
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
          <li>
            Read-only — there is no way to create, change or delete a
            credential through the API.
          </li>
          <li>
            Every credential returned is recorded in the credentials access
            log (action <Code>api</Code>). Filter as tightly as you can so
            each call only pulls the logins it needs.
          </li>
          <li>
            <Code>unit</Code> / <Code>property_id</Code> — <Code>null</Code>{" "}
            for credentials not tied to a property.
          </li>
          <li>
            <Code>password</Code> — <Code>null</Code> when none is stored.
          </li>
        </ul>
      </Section>

      <Section title="Errors">
        <p>
          Errors are always JSON: <Code>{`{ "error": "<message>" }`}</Code>.
        </p>
        <ParamTable
          header={["Status", "Meaning", ""]}
          rows={[
            ["400", "property_id isn't a UUID, or unknown category", ""],
            ["401", "Missing or wrong bearer token", ""],
            ["500", "Database, decrypt or access-log error (message included)", ""],
            ["503", "The API is not configured on the server", ""],
          ]}
        />
      </Section>
    </>
  );
}

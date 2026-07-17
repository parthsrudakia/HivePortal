import Link from "next/link";

export const metadata = {
  title: "Inventory API — Hive Portal",
};

/**
 * Human-readable reference for the read-only inventory API
 * (`GET /api/inventory`, `GET /api/inventory/[roomId]`). The API itself lives
 * in src/app/api/inventory/ — keep this page in sync when it changes.
 */
export default function InventoryApiDocsPage() {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <header className="border-b border-stone/60 pb-4">
        <p className="text-xs uppercase tracking-wide text-muted">
          <Link
            href="/inventory"
            className="text-accent-text hover:text-accent-dark"
          >
            Inventory
          </Link>{" "}
          / API
        </p>
        <h1 className="mt-1 text-3xl tracking-tight text-ink">
          <span className="font-display text-accent-text">Inventory API</span>
        </h1>
        <p className="mt-1 text-sm text-muted">
          Read-only JSON API for internal tools and scripts. Returns the same
          rooms the inventory table lists — available now, or occupied with a
          scheduled move-out — with core listing data only. Tenant names, ads,
          and listing actions are never included.
        </p>
      </header>

      <Section title="Authentication">
        <p>
          Every request needs a bearer token in the{" "}
          <Code>Authorization</Code> header. The token is the{" "}
          <Code>INVENTORY_API_KEY</Code> environment variable; if it isn&apos;t
          configured, the API responds <Code>503</Code> (disabled).
        </p>
        <CodeBlock>{`curl -H "Authorization: Bearer $INVENTORY_API_KEY" \\
  https://your-portal-domain/api/inventory`}</CodeBlock>
        <p>
          A missing or wrong token gets <Code>401 {"{"}&quot;error&quot;:
          &quot;unauthorized&quot;{"}"}</Code>.
        </p>
      </Section>

      <Section title="GET /api/inventory">
        <p>
          Lists every room currently in inventory. Optional query params mirror
          the inventory table&apos;s sorting:
        </p>
        <ParamTable
          rows={[
            [
              "sort",
              "unit · neighborhood · available · rent · services · total",
              "available",
            ],
            ["dir", "asc · desc", "asc"],
          ]}
        />
        <CodeBlock>{`GET /api/inventory?sort=total&dir=desc

{
  "as_of": "2026-07-17",
  "count": 9,
  "rooms": [
    {
      "id": "27866d1f-eb16-4bc0-bdc1-804fa9354ba9",
      "unit": "Hudson Park Apt 604",
      "building_name": "Hudson Park",
      "street_address": "323 W 96th St",
      "unit_number": "604",
      "neighborhood": "UWS",
      "room_number": "2",
      "status": "available",
      "available_from": "2026-06-30",
      "rent": { "base": 1725, "services": 125, "total": 1850 },
      "amenities": {
        "has_private_bathroom": false,
        "has_ac": true,
        "unit": ["In-unit laundry"],
        "building": ["Elevator"]
      },
      "photos_url": "https://drive.google.com/...",
      "marketing_description": null
    }
  ]
}`}</CodeBlock>
        <FieldNotes />
      </Section>

      <Section title="GET /api/inventory/[roomId]">
        <p>
          One currently-listed room by its id, wrapped as{" "}
          <Code>{`{ "as_of": "...", "room": { ... } }`}</Code> with the same
          room shape as the list. Responds <Code>404</Code> both when the id
          doesn&apos;t exist and when the room exists but isn&apos;t in
          inventory right now (filled, reserved/maintenance, or pending a
          tenant) — this endpoint only serves what <Code>/api/inventory</Code>{" "}
          lists.
        </p>
        <CodeBlock>{`curl -H "Authorization: Bearer $INVENTORY_API_KEY" \\
  https://your-portal-domain/api/inventory/27866d1f-eb16-4bc0-bdc1-804fa9354ba9`}</CodeBlock>
      </Section>

      <Section title="Errors">
        <p>
          Errors are always JSON: <Code>{`{ "error": "<message>" }`}</Code>.
        </p>
        <ParamTable
          header={["Status", "Meaning", ""]}
          rows={[
            ["401", "Missing or wrong bearer token", ""],
            [
              "404",
              "Room id unknown, malformed, or not currently in inventory",
              "detail endpoint only",
            ],
            ["500", "Database error (message included)", ""],
            ["503", "INVENTORY_API_KEY is not configured", ""],
          ]}
        />
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8 rounded-xl bg-white p-6 shadow-sm ring-1 ring-stone/40">
      <h2 className="text-lg font-medium text-ink">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-ink">
        {children}
      </div>
    </section>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-warm/70 px-1.5 py-0.5 font-mono text-[0.8125rem] text-ink">
      {children}
    </code>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg bg-ink p-4 font-mono text-xs leading-relaxed text-cream">
      <code>{children}</code>
    </pre>
  );
}

function ParamTable({
  header = ["Param", "Values", "Default"],
  rows,
}: {
  header?: [string, string, string];
  rows: [string, string, string][];
}) {
  return (
    <div className="overflow-x-auto rounded-lg ring-1 ring-stone/40">
      <table className="w-full text-sm">
        <thead className="bg-warm/60 text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            {header.map((h, i) => (
              <th key={i} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([a, b, c]) => (
            <tr key={a + c} className="border-t border-stone/30">
              <td className="px-3 py-2 font-mono text-xs text-accent-text">
                {a}
              </td>
              <td className="px-3 py-2 text-ink">{b}</td>
              <td className="px-3 py-2 text-muted">{c}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FieldNotes() {
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
      <li>
        <Code>as_of</Code> — the Eastern-time date the &quot;in inventory&quot;
        rule was evaluated against.
      </li>
      <li>
        <Code>unit</Code> — display title (building name if set, else street
        address, plus apartment number). The raw parts are also included.
      </li>
      <li>
        <Code>available_from</Code> — <Code>null</Code> means available now.
      </li>
      <li>
        <Code>rent</Code> — <Code>base</Code> + <Code>services</Code> (bundle
        fee) = <Code>total</Code>; any part can be <Code>null</Code> if unset.
      </li>
      <li>
        <Code>amenities.unit</Code> / <Code>amenities.building</Code> — apply
        to every room in the unit or building.
      </li>
    </ul>
  );
}

import { Section, Code, CodeBlock, ParamTable } from "@/components/api-docs";

/**
 * Inventory API reference content, shared by the public page
 * (`/docs/inventory-api`) and the portal's Developers tab. The API itself
 * lives in src/app/api/inventory/ — keep this in sync when it changes.
 */
export function InventoryApiDocs() {
  return (
    <>
      <Section title="Authentication">
        <p>
          Every request needs a bearer token in the <Code>Authorization</Code>{" "}
          header. Tokens are issued by Hive; if the API isn&apos;t configured
          on the server, it responds <Code>503</Code> (disabled).
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
          Lists every room currently in inventory. Optional query params
          control sorting:
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
      "marketing_description": null,
      "facebook_ads": false
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
            ["503", "The API is not configured on the server", ""],
          ]}
        />
      </Section>
    </>
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
      <li>
        <Code>facebook_ads</Code> — whether Facebook ads are currently running
        for this listing. Starts <Code>false</Code> whenever a room enters
        inventory.
      </li>
    </ul>
  );
}

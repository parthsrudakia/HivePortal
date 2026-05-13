# Hive Portal MCP Server

Exposes Hive Portal data + write actions to AI agents via the Model Context Protocol.

Reads through Supabase using the **service-role key** (bypasses RLS) — only run this
locally for clients you trust.

## Tools

**Read**

| Tool | What it returns |
|---|---|
| `list_properties` | All properties with rooms-total / rooms-available / leaseholder |
| `get_property` | Full property detail by id, including each room's current tenant |
| `list_vacancies` | Listable rooms (available + scheduled), price, amenities, ad status |
| `list_active_tenants` | Active tenants with monthly rent + paid + balance for a given month |
| `list_overdue_cleanings` | Properties overdue or due-soon for cleaning (35-day cadence) |
| `get_credentials` | Credentials filtered by property and/or category |

**Write**

| Tool | What it does |
|---|---|
| `record_payment` | Insert a payment row against a tenancy |
| `log_cleaning` | Insert a cleaning record for a property |
| `set_listing_action` | Update a room's VA priority flag |
| `update_room_rent` | Change a room's base rent (and optionally bundle fee) |
| `end_tenancy` | End a tenancy now or schedule a future move-out (handles room status) |
| `set_room_status` | Manually flip a room to available / occupied / reserved / maintenance |

## Setup

```bash
cd mcp
npm install
npm run build         # compiles src/ → dist/
```

Set the two env vars (anywhere — `.env`, your shell, or in the MCP client config):

```
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
```

The service-role key is in your Supabase dashboard at **Settings → API → service_role**.

## Use it from Claude Code

Add the server to your Claude Code MCP config:

```bash
claude mcp add hive-portal \
  --env SUPABASE_URL=https://<ref>.supabase.co \
  --env SUPABASE_SERVICE_ROLE_KEY=<key> \
  -- node /Users/parthrudakia/Desktop/Hive/HivePortal/mcp/dist/index.js
```

Then `/mcp` in Claude Code to confirm it's connected, and `/mcp list-tools` to see the tools.

## Use it from Claude Desktop

Open `~/Library/Application Support/Claude/claude_desktop_config.json` and add:

```json
{
  "mcpServers": {
    "hive-portal": {
      "command": "node",
      "args": [
        "/Users/parthrudakia/Desktop/Hive/HivePortal/mcp/dist/index.js"
      ],
      "env": {
        "SUPABASE_URL": "https://<your-project-ref>.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "<your-service-role-key>"
      }
    }
  }
}
```

Restart Claude Desktop. The tools appear in the 🔌 menu of the input box.

## Local dev

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run dev
```

Uses `tsx` so you don't need to rebuild on every change.

## Example queries an agent can answer

- *"Which tenants haven't paid this month?"* → `list_active_tenants({ only_overdue: true })`
- *"What's vacant in JSQ right now?"* → `list_vacancies` then filter.
- *"Which units are overdue for cleaning?"* → `list_overdue_cleanings`
- *"Mark Tom's payment of $2000 today, Zelle."* → look up tenancy via `list_active_tenants`, then `record_payment`.
- *"What's the password for ClickPay on 90 Washington 24M?"* → `get_credentials({ property_id, category: 'payment_portal' })`.

## Security notes

- **Service-role key bypasses RLS.** Anyone who can spawn this binary has full database access.
- Don't commit `.env`. It's already in `.gitignore`.
- Don't deploy this to a public server — it's designed for local agent tooling only.

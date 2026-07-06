import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { one } from "@/lib/relations";
import { formatDate } from "@/lib/date";
import { SearchInput } from "@/components/search-input";
import { processExpiredTenancies } from "../actions";
import { isMaster } from "@/lib/access";
import { computeLedger } from "@/lib/rent";
import { fetchLedgerSidecars } from "@/lib/rent-data";
import { todayISO } from "@/lib/date";

export const dynamic = "force-dynamic";

type TenantRel = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
};
type PropertyRel = {
  building_name: string | null;
  street_address: string;
  unit_number: string;
};
type RoomRel = {
  room_number: string | null;
  properties: PropertyRel | PropertyRel[] | null;
};
type PaymentRel = {
  amount: number | string;
  paid_on: string;
  payment_type: string;
};

type Row = {
  id: string;
  tenant_id: string;
  monthly_rent: number;
  first_month_rent: number | null;
  security_deposit: number | null;
  start_date: string;
  move_out_date: string | null;
  tenants: TenantRel | TenantRel[] | null;
  rooms: RoomRel | RoomRel[] | null;
  payments: PaymentRel[];
};

function fmtMoney(n: number | null) {
  if (n === null || n === undefined) return "—";
  return `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function monthsBetween(startISO: string, endISO: string | null) {
  if (!endISO) return null;
  const a = new Date(startISO + "T00:00:00Z");
  const b = new Date(endISO + "T00:00:00Z");
  const years = b.getUTCFullYear() - a.getUTCFullYear();
  const months = b.getUTCMonth() - a.getUTCMonth();
  const days = b.getUTCDate() - a.getUTCDate();
  let total = years * 12 + months;
  if (days < 0) total -= 1;
  return Math.max(0, total);
}

function formatDuration(months: number | null) {
  if (months === null) return "—";
  if (months < 1) return "< 1 mo";
  if (months < 12) return `${months} mo`;
  const y = Math.floor(months / 12);
  const m = months % 12;
  return m === 0 ? `${y}y` : `${y}y ${m}m`;
}

type PageProps = { searchParams: Promise<{ q?: string }> };

export default async function TenantHistoryPage({ searchParams }: PageProps) {
  // Finalize anything whose scheduled end has now passed so it shows up here.
  await processExpiredTenancies();

  const { q } = await searchParams;
  const query = (q ?? "").trim().toLowerCase();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const admin = isMaster(user?.email); // "Total paid" is admin-only
  const { data, error } = await supabase
    .from("tenancies")
    .select(
      `id, tenant_id, monthly_rent, first_month_rent, security_deposit, start_date, move_out_date,
       tenants(id, full_name, email, phone),
       rooms(room_number,
             properties(building_name, street_address, unit_number)),
       payments(amount, paid_on, payment_type)`,
    )
    .eq("status", "ended")
    .order("move_out_date", { ascending: false, nullsFirst: false })
    .returns<Row[]>();

  // Moved-out tenants keep their running ledger balance here — money owed
  // at move-out must stay visible and gets resolved from the tenant's page.
  const { charges, allocations, rentChanges } =
    await fetchLedgerSidecars(supabase);
  const today = todayISO();

  const rows = (data ?? []).map((r) => {
    const tenant = one(r.tenants);
    const room = one(r.rooms);
    const property = one(room?.properties ?? null);
    const months = monthsBetween(r.start_date, r.move_out_date);
    const totalPaid = (r.payments ?? [])
      .filter((p) => p.payment_type === "rent")
      .reduce((sum, p) => sum + Number(p.amount), 0);
    const unit = property
      ? `${property.building_name?.trim() || property.street_address} Apt ${property.unit_number}`
      : "—";
    return {
      id: r.id,
      tenant_id: r.tenant_id,
      tenant_name: tenant?.full_name ?? "—",
      email: tenant?.email ?? null,
      unit,
      room: room?.room_number ?? "—",
      start_date: r.start_date,
      move_out_date: r.move_out_date,
      months,
      monthly_rent: Number(r.monthly_rent),
      total_paid: totalPaid,
      balance: computeLedger(
        r,
        r.payments ?? [],
        charges.get(r.id) ?? [],
        allocations.get(r.id) ?? [],
        today,
        rentChanges.get(r.id) ?? [],
      ).netBalance,
    };
  });

  const filtered = query
    ? rows.filter((r) =>
        [r.tenant_name, r.email, r.unit, r.room]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query),
      )
    : rows;

  return (
    <div className="mx-auto w-full max-w-6xl">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-stone/60 pb-6">
        <div>
          <Link
            href="/tenants"
            className="text-xs uppercase tracking-wide text-muted hover:text-ink"
          >
            ← Rent Tracker
          </Link>
          <h1 className="mt-2 text-3xl tracking-tight text-ink">
            Tenant <span className="font-display text-accent-text">history</span>
          </h1>
          <p className="mt-1 text-sm text-muted">
            Every tenant who has moved out. Sorted by most recent move-out.
          </p>
        </div>
      </header>

      <div className="mt-6">
        <SearchInput
          placeholder="Search by name, email, unit, or room…"
          ariaLabel="Search tenant history"
        />
      </div>

      {error && <p className="mt-6 text-sm text-red-700">{error.message}</p>}

      {rows.length === 0 && (
        <p className="mt-10 rounded-2xl bg-white px-6 py-12 text-center text-sm text-muted shadow-sm">
          No move-outs yet.
        </p>
      )}

      {rows.length > 0 && filtered.length === 0 && (
        <p className="mt-10 rounded-2xl bg-white px-6 py-12 text-center text-sm text-muted shadow-sm">
          No history entries match &ldquo;{query}&rdquo;.
        </p>
      )}

      {filtered.length > 0 && (
        <section className="mt-6 overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-stone/40">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-warm/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Tenant</th>
                <th className="px-3 py-2 font-medium">Unit / Room</th>
                <th className="px-3 py-2 font-medium">Move-in</th>
                <th className="px-3 py-2 font-medium">Move-out</th>
                <th className="px-3 py-2 font-medium">Stay</th>
                <th className="px-3 py-2 text-right font-medium">Monthly</th>
                {admin && (
                  <th className="px-3 py-2 text-right font-medium">Total paid</th>
                )}
                <th className="px-3 py-2 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr
                  key={r.id}
                  className={`border-t border-stone/30 ${i % 2 === 1 ? "bg-cream/40" : "bg-white"} hover:bg-warm/30`}
                >
                  <td className="px-3 py-2.5">
                    <Link
                      href={`/tenants/${r.tenant_id}`}
                      className="text-ink hover:text-accent-text"
                    >
                      {r.tenant_name}
                    </Link>
                    {r.email && (
                      <div className="text-xs text-muted">{r.email}</div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-ink">
                    {r.unit}
                    <div className="text-xs text-muted">{r.room}</div>
                  </td>
                  <td className="px-3 py-2.5 tabular-nums text-ink">
                    {formatDate(r.start_date)}
                  </td>
                  <td className="px-3 py-2.5 tabular-nums text-ink">
                    {formatDate(r.move_out_date)}
                  </td>
                  <td className="px-3 py-2.5 text-muted">
                    {formatDuration(r.months)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-ink">
                    {fmtMoney(r.monthly_rent)}
                  </td>
                  {admin && (
                    <td className="px-3 py-2.5 text-right tabular-nums text-ink">
                      {fmtMoney(r.total_paid)}
                    </td>
                  )}
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {r.balance > 0.005 ? (
                      <Link
                        href={`/tenants/${r.tenant_id}`}
                        title="Open the ledger to resolve"
                        className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700 hover:bg-red-100"
                      >
                        owes {fmtMoney(r.balance)}
                      </Link>
                    ) : r.balance < -0.005 ? (
                      <span className="text-xs text-accent-text">
                        {fmtMoney(-r.balance)} credit
                      </span>
                    ) : (
                      <span className="text-xs text-muted">Settled</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

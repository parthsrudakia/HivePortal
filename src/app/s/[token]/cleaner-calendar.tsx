"use client";

import { useMemo, useState } from "react";

export type CalOccupant = {
  room_number: string | null;
  full_name: string;
  email: string | null;
  phone: string | null;
  vacated: boolean;
};

export type CalCleaning = {
  id: string;
  date: string; // ISO YYYY-MM-DD
  unitLabel: string;
  isMoveOut: boolean;
  roomLabel: string | null;
  notes: string | null;
  leaseholderName: string | null;
  occupants: CalOccupant[];
};

type View = "day" | "week" | "month" | "custom";

// ---- date helpers (date-only, UTC math so there's no timezone drift) ----
const parse = (iso: string) => new Date(iso + "T00:00:00Z");
const toISO = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => {
  const d = parse(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
};
const dow = (iso: string) => parse(iso).getUTCDay();
const weekStart = (iso: string) => addDays(iso, -dow(iso));
const startOfMonth = (iso: string) => iso.slice(0, 7) + "-01";
const addMonths = (iso: string, n: number) => {
  const d = parse(iso);
  d.setUTCMonth(d.getUTCMonth() + n);
  return toISO(d);
};
const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y.slice(2)}`;
};
const dowName = (iso: string, f: "long" | "short" | "narrow") =>
  parse(iso).toLocaleDateString("en-US", { weekday: f, timeZone: "UTC" });
const monthLabel = (iso: string) =>
  parse(iso).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

export function CleanerCalendar({
  cleanerName,
  today,
  cleanings,
}: {
  cleanerName: string | null;
  today: string;
  cleanings: CalCleaning[];
}) {
  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState(today); // focal date for day/week/month
  const [selected, setSelected] = useState(today); // tapped day (week/month)
  const [customStart, setCustomStart] = useState(today);
  const [customEnd, setCustomEnd] = useState(addDays(today, 13));
  const [open, setOpen] = useState<Set<string>>(new Set());

  const byDate = useMemo(() => {
    const m = new Map<string, CalCleaning[]>();
    for (const c of cleanings) {
      const arr = m.get(c.date) ?? [];
      arr.push(c);
      m.set(c.date, arr);
    }
    for (const arr of m.values())
      arr.sort((a, b) => a.unitLabel.localeCompare(b.unitLabel));
    return m;
  }, [cleanings]);

  const count = (iso: string) => byDate.get(iso)?.length ?? 0;
  const list = (iso: string) => byDate.get(iso) ?? [];
  const rangeList = (from: string, to: string) =>
    cleanings
      .filter((c) => c.date >= from && c.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date) || a.unitLabel.localeCompare(b.unitLabel));

  const firstName = cleanerName?.split(/\s+/)[0] ?? "there";

  return (
    <main className="min-h-screen bg-cream px-4 py-8">
      <div className="mx-auto w-full max-w-xl">
        <div className="h-1.5 w-12 rounded-full bg-accent" />
        <h1 className="mt-4 text-2xl tracking-tight text-ink">Hi {firstName},</h1>
        <p className="mt-1 text-sm text-muted">Your cleaning schedule.</p>

        {/* View toggle */}
        <div className="mt-5 grid grid-cols-4 gap-1 rounded-full bg-warm/70 p-1 text-sm">
          {(["day", "week", "month", "custom"] as View[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`rounded-full py-1.5 capitalize transition ${
                view === v
                  ? "bg-ink text-white shadow-sm"
                  : "text-ink hover:bg-white/60"
              }`}
            >
              {v === "custom" ? "Range" : v}
            </button>
          ))}
        </div>

        <div className="mt-5">
          {view === "day" && (
            <DayView
              anchor={anchor}
              setAnchor={setAnchor}
              count={count}
              list={list}
              open={open}
              setOpen={setOpen}
            />
          )}
          {view === "week" && (
            <WeekView
              anchor={anchor}
              setAnchor={setAnchor}
              selected={selected}
              setSelected={setSelected}
              count={count}
              list={list}
              today={today}
              open={open}
              setOpen={setOpen}
            />
          )}
          {view === "month" && (
            <MonthView
              anchor={anchor}
              setAnchor={setAnchor}
              selected={selected}
              setSelected={setSelected}
              count={count}
              list={list}
              today={today}
              open={open}
              setOpen={setOpen}
            />
          )}
          {view === "custom" && (
            <CustomView
              start={customStart}
              end={customEnd}
              setStart={setCustomStart}
              setEnd={setCustomEnd}
              rangeList={rangeList}
              count={count}
              open={open}
              setOpen={setOpen}
            />
          )}
        </div>

        <p className="mt-10 text-center text-xs text-muted">
          Tap a cleaning to see the unit&apos;s tenants &amp; contacts. This page
          always shows your latest schedule.
        </p>
      </div>
    </main>
  );
}

// ---- shared bits ----

function NavBar({
  label,
  onPrev,
  onNext,
}: {
  label: string;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <button
        type="button"
        onClick={onPrev}
        aria-label="Previous"
        className="flex h-9 w-9 items-center justify-center rounded-full border border-stone bg-white text-ink hover:bg-warm"
      >
        ‹
      </button>
      <p className="text-base font-semibold text-ink">{label}</p>
      <button
        type="button"
        onClick={onNext}
        aria-label="Next"
        className="flex h-9 w-9 items-center justify-center rounded-full border border-stone bg-white text-ink hover:bg-warm"
      >
        ›
      </button>
    </div>
  );
}

function CountPill({ n }: { n: number }) {
  if (n === 0) return null;
  return (
    <span className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-accent px-1.5 text-xs font-semibold text-white">
      {n}
    </span>
  );
}

// Accent card (#2): left honey strip (red for move-out), date chip, big unit,
// tap to expand tenants/contacts.
function CleaningCard({
  c,
  open,
  setOpen,
}: {
  c: CalCleaning;
  open: Set<string>;
  setOpen: (s: Set<string>) => void;
}) {
  const isOpen = open.has(c.id);
  const toggle = () => {
    const next = new Set(open);
    if (next.has(c.id)) next.delete(c.id);
    else next.add(c.id);
    setOpen(next);
  };
  return (
    <div
      className={`relative overflow-hidden rounded-2xl bg-white pl-2 shadow-sm before:absolute before:inset-y-0 before:left-0 before:w-2 ${
        c.isMoveOut ? "before:bg-red-700" : "before:bg-accent"
      }`}
    >
      <button
        type="button"
        onClick={toggle}
        className="block w-full px-4 py-4 text-left"
      >
        <span
          className={`inline-block rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
            c.isMoveOut ? "bg-red-100 text-red-700" : "bg-warm text-ink"
          }`}
        >
          {dowName(c.date, "short")} · {fmtDate(c.date)}
          {c.isMoveOut ? ` · Move-out${c.roomLabel ? ` · ${c.roomLabel}` : ""}` : ""}
        </span>
        <p className="mt-2.5 text-xl font-semibold tracking-tight text-ink">
          {c.unitLabel}
        </p>
        <p className="mt-1 text-xs uppercase tracking-wide text-accent-text">
          {isOpen ? "Hide tenants ▴" : "Tap to view tenants ▾"}
        </p>
      </button>
      {isOpen && (
        <div className="border-t border-warm px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-muted">Leaseholder</p>
          <p className="mb-3 text-ink">{c.leaseholderName ?? "—"}</p>
          <p className="text-xs uppercase tracking-wide text-muted">Tenants</p>
          {c.occupants.length === 0 ? (
            <p className="mt-1 text-muted">No tenants on record.</p>
          ) : (
            <div className="mt-1">
              {c.occupants.map((o, i) => (
                <Contact key={i} o={o} />
              ))}
            </div>
          )}
          {c.notes ? (
            <>
              <p className="mt-3 text-xs uppercase tracking-wide text-muted">Notes</p>
              <p className="text-ink">{c.notes}</p>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Contact({ o }: { o: CalOccupant }) {
  const phone = o.phone?.replace(/[^\d+]/g, "");
  return (
    <div className="border-b border-warm py-2 last:border-b-0">
      <p className="text-ink">
        {o.full_name}
        {o.room_number ? <span className="text-muted"> · {o.room_number}</span> : null}
        {o.vacated ? (
          <span className="ml-2 rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-accent-text">
            Vacated
          </span>
        ) : null}
      </p>
      <p className="mt-0.5 flex flex-wrap gap-x-4 text-sm">
        {phone ? (
          <a href={`tel:${phone}`} className="text-accent-text underline">
            {o.phone}
          </a>
        ) : null}
        {o.email ? (
          <a href={`mailto:${o.email}`} className="break-all text-accent-text underline">
            {o.email}
          </a>
        ) : null}
        {!o.phone && !o.email ? <span className="text-muted">No contact on file</span> : null}
      </p>
    </div>
  );
}

function CardList({
  items,
  open,
  setOpen,
  empty,
}: {
  items: CalCleaning[];
  open: Set<string>;
  setOpen: (s: Set<string>) => void;
  empty: string;
}) {
  if (items.length === 0)
    return (
      <p className="rounded-xl bg-white px-6 py-10 text-center text-muted shadow-sm">
        {empty}
      </p>
    );
  return (
    <div className="flex flex-col gap-3">
      {items.map((c) => (
        <CleaningCard key={c.id} c={c} open={open} setOpen={setOpen} />
      ))}
    </div>
  );
}

// ---- Day ----
function DayView({
  anchor,
  setAnchor,
  count,
  list,
  open,
  setOpen,
}: {
  anchor: string;
  setAnchor: (s: string) => void;
  count: (s: string) => number;
  list: (s: string) => CalCleaning[];
  open: Set<string>;
  setOpen: (s: Set<string>) => void;
}) {
  const n = count(anchor);
  return (
    <div className="flex flex-col gap-4">
      <NavBar
        label={`${dowName(anchor, "long")} ${fmtDate(anchor)}`}
        onPrev={() => setAnchor(addDays(anchor, -1))}
        onNext={() => setAnchor(addDays(anchor, 1))}
      />
      <p className="text-center text-sm text-muted">
        {n} cleaning{n === 1 ? "" : "s"}
      </p>
      <CardList items={list(anchor)} open={open} setOpen={setOpen} empty="No cleanings this day." />
    </div>
  );
}

// ---- Week ----
function WeekView({
  anchor,
  setAnchor,
  selected,
  setSelected,
  count,
  list,
  today,
  open,
  setOpen,
}: {
  anchor: string;
  setAnchor: (s: string) => void;
  selected: string;
  setSelected: (s: string) => void;
  count: (s: string) => number;
  list: (s: string) => CalCleaning[];
  today: string;
  open: Set<string>;
  setOpen: (s: Set<string>) => void;
}) {
  const ws = weekStart(anchor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  const we = days[6];
  // keep selected within the visible week
  const sel = days.includes(selected) ? selected : days.includes(today) ? today : ws;

  return (
    <div className="flex flex-col gap-4">
      <NavBar
        label={`${fmtDate(ws)} – ${fmtDate(we)}`}
        onPrev={() => setAnchor(addDays(ws, -7))}
        onNext={() => setAnchor(addDays(ws, 7))}
      />
      <div className="grid grid-cols-7 gap-1">
        {days.map((d) => {
          const active = d === sel;
          const n = count(d);
          return (
            <button
              key={d}
              type="button"
              onClick={() => setSelected(d)}
              className={`flex flex-col items-center gap-1 rounded-xl py-2 transition ${
                active ? "bg-ink text-white" : "bg-white text-ink hover:bg-warm"
              } ${d === today && !active ? "ring-1 ring-accent" : ""}`}
            >
              <span className="text-[11px] uppercase tracking-wide opacity-80">
                {dowName(d, "narrow")}
              </span>
              <span className="text-base font-semibold leading-none">
                {Number(d.slice(8, 10))}
              </span>
              <span
                className={`inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1 text-xs font-semibold ${
                  n === 0
                    ? "text-transparent"
                    : active
                      ? "bg-white/20 text-white"
                      : "bg-accent text-white"
                }`}
              >
                {n === 0 ? "0" : n}
              </span>
            </button>
          );
        })}
      </div>
      <div>
        <p className="mb-2 text-sm text-muted">
          {dowName(sel, "long")} {fmtDate(sel)} · {count(sel)} cleaning
          {count(sel) === 1 ? "" : "s"}
        </p>
        <CardList items={list(sel)} open={open} setOpen={setOpen} empty="No cleanings this day." />
      </div>
    </div>
  );
}

// ---- Month ----
function MonthView({
  anchor,
  setAnchor,
  selected,
  setSelected,
  count,
  list,
  today,
  open,
  setOpen,
}: {
  anchor: string;
  setAnchor: (s: string) => void;
  selected: string;
  setSelected: (s: string) => void;
  count: (s: string) => number;
  list: (s: string) => CalCleaning[];
  today: string;
  open: Set<string>;
  setOpen: (s: Set<string>) => void;
}) {
  const first = startOfMonth(anchor);
  const gridStart = weekStart(first);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const month = anchor.slice(0, 7);

  return (
    <div className="flex flex-col gap-4">
      <NavBar
        label={monthLabel(anchor)}
        onPrev={() => setAnchor(addMonths(first, -1))}
        onNext={() => setAnchor(addMonths(first, 1))}
      />
      <div>
        <div className="grid grid-cols-7 gap-1 text-center text-[11px] uppercase tracking-wide text-muted">
          {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
            <div key={i}>{d}</div>
          ))}
        </div>
        <div className="mt-1 grid grid-cols-7 gap-1">
          {cells.map((d) => {
            const inMonth = d.slice(0, 7) === month;
            const n = count(d);
            const active = d === selected;
            return (
              <button
                key={d}
                type="button"
                onClick={() => setSelected(d)}
                className={`flex aspect-square flex-col items-center justify-center gap-0.5 rounded-lg text-sm transition ${
                  active
                    ? "bg-ink text-white"
                    : inMonth
                      ? "bg-white text-ink hover:bg-warm"
                      : "bg-transparent text-stone"
                } ${d === today && !active ? "ring-1 ring-accent" : ""}`}
              >
                <span className="leading-none">{Number(d.slice(8, 10))}</span>
                {n > 0 ? (
                  <span
                    className={`inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold ${
                      active ? "bg-white/25 text-white" : "bg-accent text-white"
                    }`}
                  >
                    {n}
                  </span>
                ) : (
                  <span className="h-4" />
                )}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <p className="mb-2 text-sm text-muted">
          {dowName(selected, "long")} {fmtDate(selected)} · {count(selected)} cleaning
          {count(selected) === 1 ? "" : "s"}
        </p>
        <CardList items={list(selected)} open={open} setOpen={setOpen} empty="No cleanings this day." />
      </div>
    </div>
  );
}

// ---- Custom range ----
function CustomView({
  start,
  end,
  setStart,
  setEnd,
  rangeList,
  count,
  open,
  setOpen,
}: {
  start: string;
  end: string;
  setStart: (s: string) => void;
  setEnd: (s: string) => void;
  rangeList: (from: string, to: string) => CalCleaning[];
  count: (s: string) => number;
  open: Set<string>;
  setOpen: (s: Set<string>) => void;
}) {
  const lo = start <= end ? start : end;
  const hi = start <= end ? end : start;
  const items = rangeList(lo, hi);
  // group by day for per-day count headers
  const days: string[] = [];
  for (const c of items) if (!days.includes(c.date)) days.push(c.date);

  const inputCls =
    "rounded-lg border border-stone bg-white px-2 py-1.5 text-sm text-ink focus:border-accent focus:outline-none";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-muted">
          From
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-muted">
          To
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} />
        </label>
        <p className="ml-auto text-sm text-muted">{items.length} total</p>
      </div>
      {items.length === 0 ? (
        <p className="rounded-xl bg-white px-6 py-10 text-center text-muted shadow-sm">
          No cleanings in this range.
        </p>
      ) : (
        days.map((d) => (
          <div key={d}>
            <p className="mb-2 flex items-center gap-2 text-sm text-muted">
              {dowName(d, "long")} {fmtDate(d)} <CountPill n={count(d)} />
            </p>
            <CardList
              items={items.filter((c) => c.date === d)}
              open={open}
              setOpen={setOpen}
              empty=""
            />
          </div>
        ))
      )}
    </div>
  );
}

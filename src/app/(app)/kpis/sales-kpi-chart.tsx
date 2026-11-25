"use client";

import { useMemo, useState } from "react";
import { weekdayIndex, type DailyPoint } from "@/lib/sales-kpis";

const METRICS = [
  { key: "leads", label: "Leads", unit: "" },
  { key: "replies", label: "Replies sent", unit: "" },
  { key: "rejected", label: "Rejected", unit: "" },
  { key: "handoffs", label: "Handoffs", unit: "" },
  { key: "followedUp", label: "Follow-ups", unit: "" },
  { key: "neverAnswered", label: "Never answered", unit: "" },
  { key: "firstReplyHours", label: "First reply (h)", unit: " h" },
] as const;
type MetricKey = (typeof METRICS)[number]["key"];

type Bucket = {
  key: string;
  /** Tooltip heading, e.g. "Mon, Nov 17" or "Week of Nov 17". */
  title: string;
  /** Axis label. */
  bottom: string;
  point: DailyPoint | null;
};

const DAY_MS = 86_400_000;
const utc = (day: string) => new Date(`${day}T12:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const fmt = (day: string, opts: Intl.DateTimeFormatOptions) =>
  utc(day).toLocaleDateString("en-US", { timeZone: "UTC", ...opts });
const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });

function sumNullable(a: number | null, b: number | null) {
  return b === null ? a : (a ?? 0) + b;
}

/** Every day from `from` to `to`; days nobody reported stay as gaps. */
function dayBuckets(daily: DailyPoint[], from: string, to: string): Bucket[] {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const out: Bucket[] = [];
  for (let t = utc(from).getTime(); t <= utc(to).getTime(); t += DAY_MS) {
    const day = iso(new Date(t));
    out.push({
      key: day,
      title: fmt(day, { weekday: "short", month: "short", day: "numeric" }),
      bottom: fmt(day, { month: "short", day: "numeric" }),
      point: byDay.get(day) ?? null,
    });
  }
  return out;
}

/** Monday-start weeks, for long ranges. */
function weekBuckets(daily: DailyPoint[]): Bucket[] {
  const weeks = new Map<string, DailyPoint & { rw: number; rwt: number }>();
  for (const d of daily) {
    const start = iso(new Date(utc(d.day).getTime() - weekdayIndex(d.day) * DAY_MS));
    let w = weeks.get(start);
    if (!w)
      weeks.set(
        start,
        (w = { day: start, leads: 0, replies: null, handoffs: null, followedUp: null, neverAnswered: null, rejected: null, firstReplyHours: null, rw: 0, rwt: 0 }),
      );
    w.leads += d.leads;
    w.replies = sumNullable(w.replies, d.replies);
    w.handoffs = sumNullable(w.handoffs, d.handoffs);
    w.followedUp = sumNullable(w.followedUp, d.followedUp);
    w.neverAnswered = sumNullable(w.neverAnswered, d.neverAnswered);
    w.rejected = sumNullable(w.rejected, d.rejected);
    if (d.firstReplyHours !== null) {
      const wt = Math.max(d.leads, 1);
      w.rw += d.firstReplyHours * wt;
      w.rwt += wt;
      w.firstReplyHours = Math.round((w.rw / w.rwt) * 10) / 10;
    }
  }
  return [...weeks.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((w) => ({
      key: w.day,
      title: `Week of ${fmt(w.day, { month: "short", day: "numeric" })}`,
      bottom: fmt(w.day, { month: "short", day: "numeric" }),
      point: w,
    }));
}

/** A round axis top at or above `max`, with a clean midpoint. */
function niceMax(max: number) {
  if (max <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 3, 4, 5, 10]) if (m * pow >= max) return m * pow;
  return 10 * pow;
}

/**
 * Per-day performance chart for one account (or the summary): one bar per
 * day, the tallest one numbered, a metric switcher, and a hover/focus card
 * with that day's full numbers. Long ranges roll up to
 * weeks. Days with nothing reported show as gaps rather than zeros.
 */
export function SalesKpiChart({
  daily,
  from,
  to,
}: {
  daily: DailyPoint[];
  /** Range to draw; falls back to the span of the data (All time). */
  from: string | null;
  to: string | null;
}) {
  const [metric, setMetric] = useState<MetricKey>("leads");
  const [active, setActive] = useState<number | null>(null);

  const { buckets, weekly } = useMemo(() => {
    if (daily.length === 0) return { buckets: [] as Bucket[], weekly: false };
    const start = from ?? daily[0].day;
    const end = to ?? daily.at(-1)!.day;
    const span = Math.round((utc(end).getTime() - utc(start).getTime()) / DAY_MS) + 1;
    return span > 62
      ? { buckets: weekBuckets(daily), weekly: true }
      : { buckets: dayBuckets(daily, start, end), weekly: false };
  }, [daily, from, to]);

  // Only offer metrics the agent actually reported in this range.
  const available = METRICS.filter(
    (m) => m.key === "leads" || daily.some((d) => d[m.key] !== null),
  );
  const current = available.find((m) => m.key === metric) ?? available[0];

  if (buckets.length === 0) return null;

  const values = buckets.map((b) => (b.point ? b.point[current.key] : null));
  const present = values.filter((v): v is number => v !== null);
  const max = niceMax(Math.max(0, ...present));
  const avg = present.length > 0 ? present.reduce((a, b) => a + b, 0) / present.length : null;
  const peak = present.length > 0 ? Math.max(...present) : null;

  // About six date labels along the bottom, however many bars there are.
  const tickEvery = Math.max(1, Math.ceil(buckets.length / 6));
  const hovered = active !== null ? buckets[active] : null;
  // Only the tallest bar carries its number (the first, on a tie); the rest are on hover.
  const peakIndex = peak !== null && peak > 0 ? values.indexOf(peak) : -1;
  const PLOT = 132; // px
  const HEAD = 18; // room above the tallest bar for its number

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          {current.label} per {weekly ? "week" : "day"}
          {avg !== null && (
            <span className="tabular-nums">
              {" "}
              · avg {num(avg)}
              {current.unit} · peak {num(peak!)}
              {current.unit}
            </span>
          )}
        </p>
        {available.length > 1 && (
          <div className="-mr-2 flex flex-wrap" role="group" aria-label="Chart metric">
            {available.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setMetric(m.key)}
                aria-pressed={current.key === m.key}
                className={`rounded-full px-2 py-1 text-xs transition ${
                  current.key === m.key ? "font-semibold text-ink" : "text-muted hover:text-ink"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-5 flex gap-3">
        {/* y axis */}
        <div
          className="relative w-6 shrink-0 text-right text-[11px] tabular-nums text-muted"
          style={{ height: PLOT }}
          aria-hidden
        >
          {[max, max / 2, 0].map((t, i) => (
            <span key={i} className="absolute right-0 -translate-y-1/2" style={{ top: `${(i / 2) * 100}%` }}>
              {num(t)}
            </span>
          ))}
        </div>

        <div className="relative min-w-0 flex-1" onMouseLeave={() => setActive(null)}>
          <div className="relative" style={{ height: PLOT }}>
            {[0, 50, 100].map((p) => (
              <div
                key={p}
                className="absolute inset-x-0 h-px"
                style={{ top: `${p}%`, background: "var(--chart-grid)" }}
                aria-hidden
              />
            ))}

            <div className="absolute inset-0 flex items-end">
              {buckets.map((b, i) => {
                const v = values[i];
                const isActive = active === i;
                return (
                  <button
                    key={b.key}
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                    aria-label={`${b.title}: ${v === null ? "no data" : `${num(v)}${current.unit} ${current.label.toLowerCase()}`}`}
                    className="group relative flex h-full min-w-0 flex-1 cursor-default flex-col items-center justify-end outline-none"
                  >
                    {v === null ? (
                      <span className="mb-1 h-1 w-1 rounded-full bg-stone/60" aria-hidden />
                    ) : (
                      <>
                        {(i === peakIndex || isActive) && (
                          <span className="mb-1 text-xs font-semibold leading-none tabular-nums text-ink">
                            {num(v)}
                          </span>
                        )}
                        <span
                          className={`w-[60%] max-w-[30px] rounded-t-[3px] transition-colors ${
                            isActive ? "bg-accent-dark" : "bg-accent"
                          }`}
                          style={{ height: v === 0 ? 2 : `${Math.max(2, (v / max) * (PLOT - HEAD))}px` }}
                          aria-hidden
                        />
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* x axis: a date under every few bars, centred on its bar */}
          <div className="mt-2 flex h-4 text-[11px] leading-none text-muted" aria-hidden>
            {buckets.map((b, i) => (
              <div key={b.key} className="relative min-w-0 flex-1">
                {i % tickEvery === 0 && (
                  <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap tabular-nums">{b.bottom}</span>
                )}
              </div>
            ))}
          </div>

          {hovered && (
            <div
              className="pointer-events-none absolute top-0 z-20 w-44 rounded-lg bg-white p-2.5 text-xs shadow-lg ring-1 ring-stone/40"
              // Sit beside the hovered bar, on whichever side has room, so it never covers it.
              style={
                active! < buckets.length / 2
                  ? { left: `min(calc(${((active! + 0.5) / buckets.length) * 100}% + 24px), calc(100% - 180px))` }
                  : { right: `min(calc(${((buckets.length - active! - 0.5) / buckets.length) * 100}% + 24px), calc(100% - 180px))` }
              }
              role="status"
            >
              <div className="font-semibold text-ink">{hovered.title}</div>
              {hovered.point ? (
                <dl className="mt-1 space-y-0.5">
                  {METRICS.map((m) => {
                    const v = hovered.point![m.key];
                    return (
                      <div key={m.key} className="flex justify-between gap-2">
                        <dt className={m.key === current.key ? "font-medium text-ink" : "text-muted"}>{m.label}</dt>
                        <dd className="tabular-nums text-ink">{v === null ? "—" : num(v)}</dd>
                      </div>
                    );
                  })}
                </dl>
              ) : (
                <div className="mt-1 text-muted">No data sent for this day.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

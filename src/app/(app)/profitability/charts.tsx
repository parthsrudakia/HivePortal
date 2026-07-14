// Server-rendered SVG charts for the Profitability summary. Palette
// validated for CVD separation and surface contrast (dataviz six-checks):
// revenue #b87d09 (brand accent-dark) vs expenses #3f5f9e; the net chart
// encodes polarity by sign + position with green/red reinforcing it.

const REVENUE = "#b87d09";
const EXPENSE = "#3f5f9e";
const POSITIVE = "#166534";
const NEGATIVE = "#b91c1c";
const GRID = "#e8e3db";
const AXIS_TEXT = "#8a8378";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const W = 760;
const H = 240;
const PAD = { top: 14, right: 12, bottom: 26, left: 52 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

function fmtTick(n: number): string {
  const abs = Math.abs(n);
  const s =
    abs >= 1000 ? `${(abs / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k` : `${Math.round(abs)}`;
  return n < 0 ? `-$${s}` : `$${s}`;
}

function fmtFull(n: number): string {
  const abs = Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

/** "Nice" round step so gridlines land on clean dollar values. */
function niceStep(range: number, targetTicks: number): number {
  const raw = range / targetTicks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) {
    if (raw <= m * mag) return m * mag;
  }
  return 10 * mag;
}

/** Bar path with the data end rounded (4px) and the baseline end square. */
function barPath(x: number, w: number, yBase: number, yEnd: number): string {
  const r = Math.min(4, w / 2, Math.abs(yBase - yEnd));
  if (yEnd <= yBase) {
    // grows upward
    return `M${x},${yBase} L${x},${yEnd + r} Q${x},${yEnd} ${x + r},${yEnd} L${x + w - r},${yEnd} Q${x + w},${yEnd} ${x + w},${yEnd + r} L${x + w},${yBase} Z`;
  }
  // grows downward (negative values)
  return `M${x},${yBase} L${x},${yEnd - r} Q${x},${yEnd} ${x + r},${yEnd} L${x + w - r},${yEnd} Q${x + w},${yEnd} ${x + w},${yEnd - r} L${x + w},${yBase} Z`;
}

function Frame({
  yTicks,
  yFor,
  children,
}: {
  yTicks: number[];
  yFor: (v: number) => number;
  children: React.ReactNode;
}) {
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      className="w-full"
      style={{ fontVariantNumeric: "tabular-nums" }}
    >
      {yTicks.map((t) => (
        <g key={t}>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={yFor(t)}
            y2={yFor(t)}
            stroke={GRID}
            strokeWidth={t === 0 ? 1.5 : 1}
          />
          <text
            x={PAD.left - 8}
            y={yFor(t) + 3.5}
            textAnchor="end"
            fontSize="11"
            fill={AXIS_TEXT}
          >
            {fmtTick(t)}
          </text>
        </g>
      ))}
      {MONTHS.map((mo, m) => (
        <text
          key={mo}
          x={PAD.left + (m + 0.5) * (PLOT_W / 12)}
          y={H - 8}
          textAnchor="middle"
          fontSize="11"
          fill={AXIS_TEXT}
        >
          {mo}
        </text>
      ))}
      {children}
    </svg>
  );
}

/** Grouped monthly bars: revenue vs expenses. */
export function RevenueExpenseChart({
  revenue,
  expenses,
}: {
  revenue: (number | null)[];
  expenses: (number | null)[];
}) {
  const max = Math.max(1, ...revenue.map((v) => v ?? 0), ...expenses.map((v) => v ?? 0));
  const step = niceStep(max, 4);
  const top = Math.ceil(max / step) * step;
  const yFor = (v: number) => PAD.top + PLOT_H * (1 - v / top);
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);

  const slot = PLOT_W / 12;
  const barW = Math.min(16, (slot - 10) / 2);

  return (
    <figure>
      <div className="flex items-center gap-4 text-xs text-ink">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: REVENUE }} />
          Revenue
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: EXPENSE }} />
          Expenses
        </span>
      </div>
      <Frame yTicks={ticks} yFor={yFor}>
        {MONTHS.map((mo, m) => {
          const cx = PAD.left + (m + 0.5) * slot;
          const rev = revenue[m];
          const exp = expenses[m];
          return (
            <g key={mo}>
              {rev !== null && (
                <path d={barPath(cx - barW - 1, barW, yFor(0), yFor(rev))} fill={REVENUE}>
                  <title>{`${mo}: revenue ${fmtFull(rev)}`}</title>
                </path>
              )}
              {exp !== null && (
                <path d={barPath(cx + 1, barW, yFor(0), yFor(exp))} fill={EXPENSE}>
                  <title>{`${mo}: expenses ${fmtFull(exp)}`}</title>
                </path>
              )}
            </g>
          );
        })}
      </Frame>
    </figure>
  );
}

/** Net profit by month — bars anchored at zero, green up / red down. */
export function NetProfitChart({ net }: { net: (number | null)[] }) {
  const values = net.filter((v): v is number => v !== null);
  const max = Math.max(1, ...values, 0);
  const min = Math.min(0, ...values);
  const step = niceStep(max - min, 4);
  const top = Math.ceil(max / step) * step;
  const bottom = Math.floor(min / step) * step;
  const yFor = (v: number) =>
    PAD.top + PLOT_H * (1 - (v - bottom) / (top - bottom));
  const ticks: number[] = [];
  for (let t = bottom; t <= top; t += step) ticks.push(t);

  const slot = PLOT_W / 12;
  const barW = Math.min(24, slot - 14);

  return (
    <figure>
      <Frame yTicks={ticks} yFor={yFor}>
        {MONTHS.map((mo, m) => {
          const v = net[m];
          if (v === null) return null;
          const x = PAD.left + (m + 0.5) * slot - barW / 2;
          return (
            <path
              key={mo}
              d={barPath(x, barW, yFor(0), yFor(v))}
              fill={v >= 0 ? POSITIVE : NEGATIVE}
            >
              <title>{`${mo}: net ${fmtFull(v)}`}</title>
            </path>
          );
        })}
      </Frame>
    </figure>
  );
}

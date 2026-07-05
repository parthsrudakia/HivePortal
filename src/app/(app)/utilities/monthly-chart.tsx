"use client";

import { useMemo, useRef, useState } from "react";
import { fmtMoney, monthLabelShort, monthLabel } from "./bill-utils";

// Brand accent-dark: passes the 3:1 contrast check on the cream surface
// (validated); text stays in ink/muted tokens, never the series color.
const LINE = "#b87d09";

type Point = { month: string; total: number };

const W = 720;
const H = 180;
const PAD = { top: 16, right: 20, bottom: 26, left: 52 };

export function MonthlyChart({ data }: { data: Point[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const { points, ticks, max } = useMemo(() => {
    const max = Math.max(...data.map((d) => d.total), 1);
    // Round the axis top to a friendly step.
    const rawStep = max / 3;
    const mag = 10 ** Math.floor(Math.log10(rawStep));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s * 3 >= max) ?? rawStep;
    const top = step * 3;
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const points = data.map((d, i) => ({
      ...d,
      x: PAD.left + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW),
      y: PAD.top + innerH - (d.total / top) * innerH,
    }));
    const ticks = [0, 1, 2, 3].map((i) => ({
      value: step * i,
      y: PAD.top + innerH - (i / 3) * innerH,
    }));
    return { points, ticks, max: top };
  }, [data]);

  if (data.length === 0) return null;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = ((e.clientX - rect.left) / rect.width) * W;
    let nearest = 0;
    let bestDist = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(p.x - x);
      if (d < bestDist) {
        bestDist = d;
        nearest = i;
      }
    });
    setHover(nearest);
  }

  const h = hover !== null ? points[hover] : null;

  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">
        Monthly utility spend
      </p>
      <div className="relative mt-2">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          role="img"
          aria-label={`Monthly utility totals: ${data
            .map((d) => `${monthLabel(d.month)} ${fmtMoney(d.total)}`)
            .join(", ")}`}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          {/* recessive grid + y ticks */}
          {ticks.map((t) => (
            <g key={t.value}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={t.y}
                y2={t.y}
                stroke="#e8e3db"
                strokeWidth="1"
              />
              <text
                x={PAD.left - 8}
                y={t.y + 3.5}
                textAnchor="end"
                fontSize="10"
                fill="#8a8378"
              >
                {t.value >= 1000 ? `$${(t.value / 1000).toFixed(1)}k` : `$${t.value}`}
              </text>
            </g>
          ))}

          {/* x labels */}
          {points.map((p) => (
            <text
              key={p.month}
              x={p.x}
              y={H - 8}
              textAnchor="middle"
              fontSize="10"
              fill="#8a8378"
            >
              {monthLabelShort(p.month)}
            </text>
          ))}

          {/* crosshair */}
          {h && (
            <line
              x1={h.x}
              x2={h.x}
              y1={PAD.top}
              y2={H - PAD.bottom}
              stroke="#c4bdb3"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
          )}

          {/* series */}
          {points.length > 1 && (
            <polyline
              points={points.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none"
              stroke={LINE}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}
          {points.map((p, i) => (
            <circle
              key={p.month}
              cx={p.x}
              cy={p.y}
              r={hover === i ? 5 : 3.5}
              fill={LINE}
              stroke="#fefdfb"
              strokeWidth="2"
            />
          ))}

          {/* selective direct label on the latest point */}
          {points.length > 0 && hover === null && (
            <text
              x={Math.min(points[points.length - 1].x, W - PAD.right - 4)}
              y={Math.max(points[points.length - 1].y - 10, 11)}
              textAnchor="end"
              fontSize="11"
              fontWeight="600"
              fill="#1a1a18"
            >
              {fmtMoney(points[points.length - 1].total)}
            </text>
          )}
        </svg>

        {h && (
          <div
            className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 rounded-lg border border-stone bg-white px-2.5 py-1.5 text-xs shadow-md"
            style={{ left: `${(h.x / W) * 100}%` }}
          >
            <span className="text-muted">{monthLabel(h.month)}</span>{" "}
            <span className="font-semibold tabular-nums text-ink">
              {fmtMoney(h.total)}
            </span>
          </div>
        )}
      </div>
      <span className="sr-only">Max {fmtMoney(max)}</span>
    </div>
  );
}

import type { ReactNode } from "react";

export function BarChart({ data, height = 120, color = "var(--accent)" }: { data: Array<{ label: string; value: number }>; height?: number; color?: string }): ReactNode {
  if (data.length === 0) return <div className="muted">No data yet.</div>;
  const max = Math.max(1, ...data.map((d) => d.value));
  const w = Math.min(100 / data.length, 7); // few data points must not become giant blocks
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="chart" role="img" aria-label="bar chart">
      {data.map((d, i) => {
        const h = (d.value / max) * (height - 18);
        return (
          <g key={d.label + i}>
            <rect x={i * w + w * 0.15} y={height - 14 - h} width={w * 0.7} height={Math.max(h, 0.5)} fill={color} rx="0.6">
              <title>{`${d.label}: ${Math.round(d.value).toLocaleString()}`}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}

export function Meter({ value, cap, label }: { value: number; cap: number; label: string }): ReactNode {
  const pct = cap <= 0 ? 100 : Math.min(100, (value / cap) * 100);
  const tone = pct >= 100 ? "bad" : pct >= 80 ? "warn" : "ok";
  return (
    <div className="meter" title={`${label}: $${value.toFixed(2)} of $${cap.toFixed(2)}`}>
      <div className={`meter-fill ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

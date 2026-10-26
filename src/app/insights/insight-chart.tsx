import { chartGeometry, formatYmd, type DayPoint } from "@/lib/meta/insights";

const W = 320;
const H = 112;
const number = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });

/**
 * One metric as a line over its days. Drawn with plain SVG (no chart library); days Facebook gave no value for are
 * gaps in the line, never zeros. The numbers behind it are in the table under each card, so the picture is not the
 * only way to read them.
 */
export default function InsightChart({ label, series, zeroBased }: { label: string; series: readonly DayPoint[]; zeroBased: boolean }) {
  const geometry = chartGeometry(series.map((p) => p.value), { width: W, height: H, padX: 6, padTop: 10, padBottom: 6, zeroBased });
  const first = series[0]?.date;
  const last = series[series.length - 1]?.date;
  const known = series.filter((p) => p.value !== null).length;
  return <figure className="insight-chart">
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
      aria-label={`Biểu đồ ${label} theo ngày: thấp nhất ${number.format(geometry.min)}, cao nhất ${number.format(geometry.max)}, ${known} ngày có số liệu.`}>
      <line className="insight-baseline" x1="0" x2={W} y1={H - 6} y2={H - 6} />
      {geometry.area && <path className="insight-area" d={geometry.area} />}
      {geometry.line && <path className="insight-line" d={geometry.line} vectorEffect="non-scaling-stroke" />}
      {geometry.dots.map((d) => <circle key={`${d.x}-${d.y}`} className="insight-dot" cx={d.x} cy={d.y} r="3" />)}
    </svg>
    <figcaption className="insight-axis">
      <span>{first ? formatYmd(first) : ""}</span>
      <span>Cao nhất: <strong>{number.format(geometry.max)}</strong></span>
      <span>{last ? formatYmd(last) : ""}</span>
    </figcaption>
  </figure>;
}

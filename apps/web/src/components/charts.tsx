import { useId } from 'react'
import type { ReactNode } from 'react'
import { formatCount } from '../lib/format'
import { EmptyState } from './ui'

/**
 * Hand-rolled SVG chart primitives for the analytics surfaces.
 *
 * Geometry is percentage-based (no viewBox scaling), so bars stretch with the
 * card while text renders at a fixed, readable pixel size in any column width.
 * Each row stacks a label line above its bar with the value at the data end.
 *
 * Design rules (shared with the styles.css chart tokens):
 * - categorical colors come from the fixed --chart-cat-* slots, never cycled;
 * - bars are thin (14px in a 44px band), rounded at the data end, square at
 *   the baseline, and stacked segments are separated by a 2px surface gap;
 * - text always uses ink tokens (--text / --text-muted), never a series color;
 * - every chart carries an SVG <title>/<desc> pair plus a visually-hidden
 *   table twin, so no value is gated behind the graphic;
 * - no animation anywhere, so there is nothing to gate behind
 *   prefers-reduced-motion.
 */

const ROW_HEIGHT = 44
const PAD_TOP = 2
const PAD_BOTTOM = 4
const BAR_HEIGHT = 14
const BAR_TOP_OFFSET = 22
const LABEL_BASELINE = 14
const END_RADIUS = 4
const SEGMENT_GAP = 2
/** Bars occupy this share of the width; the rest is reserved for end values. */
const BAR_AREA_PCT = 82
const VALUE_GAP_PCT = 1.2

export interface BarChartRow {
  key: string
  label: string
  value: number
  /** Small muted note rendered after the label, e.g. "4 prospects". */
  detail?: string
  /** Hover tooltip text; defaults to "label: formatted value". */
  hover?: string
}

export interface StackedSeries {
  key: string
  label: string
  color: string
}

export interface StackedBarRow {
  key: string
  label: string
  values: number[]
  detail?: string
}

function chartHeight(rowCount: number) {
  return PAD_TOP + rowCount * ROW_HEIGHT + PAD_BOTTOM
}

function RowLabel({ label, detail, y }: { label: string; detail?: string; y: number }) {
  return (
    <text x={0} y={y + LABEL_BASELINE} fontSize={13} fill="var(--text)">
      {label}
      {detail ? (
        <tspan fontSize={11.5} fill="var(--text-muted)">
          {` · ${detail}`}
        </tspan>
      ) : null}
    </text>
  )
}

/**
 * A bar with a rounded data end and a square baseline end: the rounded rect
 * carries the mark, and a short same-fill rect squares off the left corners.
 */
function Bar({ xPct, widthPct, y, color }: { xPct: number; widthPct: number; y: number; color: string }) {
  if (widthPct <= 0) return null
  return (
    <>
      <rect
        x={`${xPct}%`}
        y={y}
        width={`${widthPct}%`}
        height={BAR_HEIGHT}
        rx={END_RADIUS}
        ry={END_RADIUS}
        fill={color}
        data-chart-bar
      />
      <rect x={`${xPct}%`} y={y} width={END_RADIUS} height={BAR_HEIGHT} fill={color} aria-hidden="true" />
    </>
  )
}

export function HorizontalBarChart({
  title,
  description,
  rows,
  color = 'var(--chart-cat-1)',
  formatValue = formatCount,
  valueHeader = 'Value',
  emptyTitle = 'No data yet.',
  emptyDetail,
  testId
}: {
  title: string
  description: string
  rows: BarChartRow[]
  color?: string
  formatValue?: (value: number) => string
  valueHeader?: string
  emptyTitle?: string
  emptyDetail?: string
  testId?: string
}) {
  const titleId = useId()
  const descId = useId()
  if (!rows.length) {
    return <EmptyState title={emptyTitle} detail={emptyDetail} />
  }
  const height = chartHeight(rows.length)
  const max = Math.max(...rows.map((row) => row.value), 0)
  return (
    <figure className="chart-figure" data-testid={testId} data-chart="bar">
      <svg width="100%" height={height} role="img" aria-labelledby={`${titleId} ${descId}`}>
        <title id={titleId}>{title}</title>
        <desc id={descId}>{description}</desc>
        {rows.map((row, index) => {
          const y = PAD_TOP + index * ROW_HEIGHT
          const barY = y + BAR_TOP_OFFSET
          const widthPct = max > 0 ? (Math.max(0, row.value) / max) * BAR_AREA_PCT : 0
          return (
            <g key={row.key}>
              <title>{row.hover || `${row.label}: ${formatValue(row.value)}`}</title>
              <RowLabel label={row.label} detail={row.detail} y={y} />
              <Bar xPct={0} widthPct={widthPct} y={barY} color={color} />
              <text
                x={`${widthPct + VALUE_GAP_PCT}%`}
                y={barY + BAR_HEIGHT / 2 + 4}
                fontSize={12}
                fill="var(--text-muted)"
              >
                {formatValue(row.value)}
              </text>
            </g>
          )
        })}
      </svg>
      <table className="visually-hidden">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">{valueHeader}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.detail ? `${row.label} (${row.detail})` : row.label}</th>
              <td>{formatValue(row.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}

export function StackedBarChart({
  title,
  description,
  series,
  rows,
  formatValue = formatCount,
  formatTotal,
  emptyTitle = 'No data yet.',
  emptyDetail,
  testId
}: {
  title: string
  description: string
  series: StackedSeries[]
  rows: StackedBarRow[]
  formatValue?: (value: number) => string
  /** Value printed at the data end of each stack; defaults to the formatted sum. */
  formatTotal?: (row: StackedBarRow, total: number) => string
  emptyTitle?: string
  emptyDetail?: string
  testId?: string
}) {
  const titleId = useId()
  const descId = useId()
  if (!rows.length) {
    return <EmptyState title={emptyTitle} detail={emptyDetail} />
  }
  const height = chartHeight(rows.length)
  const totals = rows.map((row) => row.values.reduce((sum, value) => sum + Math.max(0, value), 0))
  const max = Math.max(...totals, 0)
  return (
    <figure className="chart-figure" data-testid={testId} data-chart="stacked-bar">
      <svg width="100%" height={height} role="img" aria-labelledby={`${titleId} ${descId}`}>
        <title id={titleId}>{title}</title>
        <desc id={descId}>{description}</desc>
        {rows.map((row, index) => {
          const y = PAD_TOP + index * ROW_HEIGHT
          const barY = y + BAR_TOP_OFFSET
          const total = totals[index]
          const totalPct = max > 0 ? (total / max) * BAR_AREA_PCT : 0
          const visible = series
            .map((entry, seriesIndex) => ({ entry, value: Math.max(0, row.values[seriesIndex] || 0) }))
            .filter((segment) => segment.value > 0)
          let cursorPct = 0
          return (
            <g key={row.key}>
              <RowLabel label={row.label} detail={row.detail} y={y} />
              {visible.map((segment, segmentIndex) => {
                const isLast = segmentIndex === visible.length - 1
                const widthPct = max > 0 ? (segment.value / max) * BAR_AREA_PCT : 0
                const xPct = cursorPct
                cursorPct += widthPct
                return (
                  <g key={segment.entry.key}>
                    <title>{`${row.label} — ${segment.entry.label}: ${formatValue(segment.value)}`}</title>
                    {isLast ? (
                      <Bar xPct={xPct} widthPct={widthPct} y={barY} color={segment.entry.color} />
                    ) : (
                      <rect
                        x={`${xPct}%`}
                        y={barY}
                        width={`${widthPct}%`}
                        height={BAR_HEIGHT}
                        fill={segment.entry.color}
                        data-chart-bar
                      />
                    )}
                    {segmentIndex > 0 ? (
                      // 2px surface gap between touching segments, drawn on the
                      // boundary so the stack's total width stays truthful.
                      <rect
                        x={`${xPct}%`}
                        y={barY}
                        width={SEGMENT_GAP}
                        height={BAR_HEIGHT}
                        fill="var(--surface-strong)"
                        aria-hidden="true"
                      />
                    ) : null}
                  </g>
                )
              })}
              <text
                x={`${totalPct + VALUE_GAP_PCT}%`}
                y={barY + BAR_HEIGHT / 2 + 4}
                fontSize={12}
                fill="var(--text-muted)"
              >
                {formatTotal ? formatTotal(row, total) : formatValue(total)}
              </text>
            </g>
          )
        })}
      </svg>
      <ChartLegend series={series} />
      <table className="visually-hidden">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            {series.map((entry) => (
              <th key={entry.key} scope="col">
                {entry.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.detail ? `${row.label} (${row.detail})` : row.label}</th>
              {series.map((entry, seriesIndex) => (
                <td key={entry.key}>{formatValue(row.values[seriesIndex] || 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}

export function ChartLegend({ series }: { series: StackedSeries[] }) {
  if (series.length < 2) return null
  return (
    <ul className="chart-legend">
      {series.map((entry) => (
        <li key={entry.key}>
          <span className="chart-swatch" style={{ background: entry.color }} aria-hidden="true" />
          {entry.label}
        </li>
      ))}
    </ul>
  )
}

export interface StatItem {
  key: string
  label: string
  value: ReactNode
  /** Optional status dot color shown beside the label. */
  toneColor?: string
}

/**
 * Stat row for "usage" style figures: a strip of labeled numbers with an
 * optional single-stack distribution bar underneath (e.g. exports by status).
 */
export function StatTrendRow({
  stats,
  distribution,
  testId
}: {
  stats: StatItem[]
  distribution?: {
    title: string
    description: string
    segments: Array<{ key: string; label: string; value: number; color: string }>
  }
  testId?: string
}) {
  const segments = (distribution?.segments || []).filter((segment) => segment.value > 0)
  return (
    <div className="chart-block" data-testid={testId} data-chart="stat-row">
      <div className="chart-stat-row">
        {stats.map((stat) => (
          <div className="chart-stat" key={stat.key}>
            <p className="chart-stat-label">
              {stat.toneColor ? (
                <span className="chart-swatch" style={{ background: stat.toneColor }} aria-hidden="true" />
              ) : null}
              {stat.label}
            </p>
            <strong className="chart-stat-value">{stat.value}</strong>
          </div>
        ))}
      </div>
      {distribution && segments.length ? (
        <StackedBarChart
          title={distribution.title}
          description={distribution.description}
          series={segments.map((segment) => ({ key: segment.key, label: segment.label, color: segment.color }))}
          rows={[
            {
              key: 'distribution',
              label: distribution.title,
              values: segments.map((segment) => segment.value)
            }
          ]}
        />
      ) : null}
    </div>
  )
}

import { Link, type LinkProps } from 'react-router-dom'
import type { ComponentPropsWithoutRef, PropsWithChildren, ReactNode } from 'react'

export function Card({ className = '', children }: PropsWithChildren<{ className?: string }>) {
  return <section className={`card ${className}`.trim()}>{children}</section>
}

export function Badge({
  tone = 'neutral',
  children
}: PropsWithChildren<{ tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }>) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

export function StatusBadge({ status }: { status?: string | number | null }) {
  const value = String(status || 'unknown')
  const normalized = value.toLowerCase()
  const tone =
    normalized.includes('complete') || normalized.includes('published') || normalized.includes('pass')
      ? 'success'
      : normalized.includes('fail') || normalized.includes('dead') || normalized.includes('error')
        ? 'danger'
        : normalized.includes('draft') ||
            normalized.includes('queue') ||
            normalized.includes('running') ||
            normalized.includes('retry')
          ? 'warning'
          : 'info'
  return <Badge tone={tone}>{value}</Badge>
}

export function ButtonLink({
  variant = 'secondary',
  className = '',
  ...props
}: LinkProps & { variant?: 'primary' | 'secondary' | 'ghost' }) {
  return <Link className={`${variant}-button button-link ${className}`.trim()} {...props} />
}

export function PageHero({
  eyebrow,
  title,
  subtitle,
  actions,
  meta
}: {
  eyebrow?: string
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  meta?: ReactNode
}) {
  return (
    <Card className="page-hero">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h3>{title}</h3>
        {subtitle ? <p>{subtitle}</p> : null}
        {meta ? <div className="hero-meta">{meta}</div> : null}
      </div>
      {actions ? <div className="hero-actions">{actions}</div> : null}
    </Card>
  )
}

export function PageSection({
  title,
  subtitle,
  action,
  children
}: PropsWithChildren<{ title: string; subtitle?: string; action?: ReactNode }>) {
  return (
    <Card className="section-card">
      <div className="section-heading">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p className="section-subtitle">{subtitle}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </Card>
  )
}

export function MetricCard({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <Card className="metric-card">
      <p className="metric-label">{label}</p>
      <strong className="metric-value">{value}</strong>
      {hint ? <p className="metric-hint">{hint}</p> : null}
    </Card>
  )
}

export function StatGroup({ children }: PropsWithChildren) {
  return <div className="metrics-grid stat-group">{children}</div>
}

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="state-shell" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <p>{label}...</p>
    </div>
  )
}

export function ErrorState({
  title = 'Something went wrong.',
  detail,
  action
}: {
  title?: string
  detail?: string
  action?: ReactNode
}) {
  return (
    <div className="state-shell state-error" role="alert">
      <h3>{title}</h3>
      {detail ? <p>{detail}</p> : null}
      {action}
    </div>
  )
}

export function EmptyState({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="state-shell state-empty">
      <h3>{title}</h3>
      {detail ? <p>{detail}</p> : null}
      {action}
    </div>
  )
}

export function Toolbar({
  children,
  align = 'spread',
  label
}: PropsWithChildren<{ align?: 'start' | 'spread'; label?: string }>) {
  return (
    <div className={`toolbar toolbar-${align}`} role={label ? 'search' : undefined} aria-label={label}>
      {children}
    </div>
  )
}

export function Field({ label, hint, children }: PropsWithChildren<{ label: string; hint?: ReactNode }>) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  )
}

export function SectionHeader({
  title,
  subtitle,
  action
}: {
  title: ReactNode
  subtitle?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {subtitle ? <p className="section-subtitle">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  )
}

export function ActionPanel({
  title,
  subtitle,
  children
}: PropsWithChildren<{ title: ReactNode; subtitle?: ReactNode }>) {
  return (
    <Card className="section-card action-panel">
      <h3>{title}</h3>
      {subtitle ? <p className="muted">{subtitle}</p> : null}
      {children}
    </Card>
  )
}

export function DataTable({ children, caption }: PropsWithChildren<{ caption?: string }>) {
  return (
    <div className="table-shell data-table-shell">
      <table>
        {caption ? <caption>{caption}</caption> : null}
        {children}
      </table>
    </div>
  )
}

export function KeyValueList({ rows }: { rows: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="key-value-list">
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function InlineNotice({
  tone = 'info',
  children
}: PropsWithChildren<{ tone?: 'info' | 'success' | 'warning' | 'danger' }>) {
  return <p className={`inline-notice inline-notice-${tone}`}>{children}</p>
}

export function Timeline({
  items,
  empty
}: {
  items: Array<{ id: string; title: ReactNode; meta?: ReactNode; body?: ReactNode }>
  empty?: ReactNode
}) {
  if (!items.length) {
    return <div className="timeline-empty">{empty || 'No activity yet.'}</div>
  }
  return (
    <ol className="timeline">
      {items.map((item) => (
        <li key={item.id}>
          <div>
            <strong>{item.title}</strong>
            {item.meta ? <span>{item.meta}</span> : null}
          </div>
          {item.body ? <p>{item.body}</p> : null}
        </li>
      ))}
    </ol>
  )
}

export function SegmentedControl({
  label,
  options,
  value,
  onChange
}: {
  label: string
  options: Array<{ label: string; value: string }>
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="segmented-control" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? 'is-selected' : ''}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function IconButton(props: ComponentPropsWithoutRef<'button'>) {
  return <button {...props} className={`icon-button ${props.className || ''}`.trim()} />
}

import type { PropsWithChildren, ReactNode } from 'react'

export function Card({ className = '', children }: PropsWithChildren<{ className?: string }>) {
  return <section className={`card ${className}`.trim()}>{children}</section>
}

export function Badge({
  tone = 'neutral',
  children
}: PropsWithChildren<{ tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }>) {
  return <span className={`badge badge-${tone}`}>{children}</span>
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

export function EmptyState({
  title,
  detail,
  action
}: {
  title: string
  detail?: string
  action?: ReactNode
}) {
  return (
    <div className="state-shell state-empty">
      <h3>{title}</h3>
      {detail ? <p>{detail}</p> : null}
      {action}
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

import { NavLink, Navigate, Outlet, useLocation, useMatches } from 'react-router-dom'
import { useEffect, useState, type ReactNode } from 'react'
import { api, routes } from '../lib/client'
import type { DashboardPayload } from '../lib/types'
import { homePathForUser } from '../lib/permissions'
import { NotificationBell } from '../components/NotificationBell'
import { useAuth } from './auth'

export interface RouteHandle {
  title?: string | ((params: Record<string, string | undefined>) => string)
  subtitle?: string
  breadcrumb?: string | ((params: Record<string, string | undefined>) => string)
}

type NavItem = {
  label: string
  to: string
  search?: string
  roles: Array<'admin' | 'advisor' | 'readonly' | 'client'>
  badge?: string
}

const backofficeNav: NavItem[] = [
  { label: 'Dashboard', to: '/dashboard', roles: ['admin', 'advisor', 'readonly'] },
  { label: 'Pipeline', to: '/pipeline', roles: ['admin', 'advisor', 'readonly'] },
  { label: 'Profiles', to: '/profiles', roles: ['admin', 'advisor', 'readonly'] },
  { label: 'Households', to: '/households', roles: ['admin', 'advisor', 'readonly'] },
  { label: 'Forms', to: '/forms', roles: ['admin', 'advisor', 'readonly'] },
  { label: 'Templates', to: '/templates', roles: ['admin', 'advisor', 'readonly'] },
  { label: 'Exports', to: '/exports', roles: ['admin', 'advisor'] },
  { label: 'Field Schema', to: '/profiles', search: '?panel=schema', roles: ['admin', 'advisor', 'readonly'] },
  { label: 'Analytics', to: '/analytics', roles: ['admin', 'advisor', 'readonly'] },
  { label: 'Audit', to: '/audit', roles: ['admin', 'advisor', 'readonly'] },
  { label: 'Stages', to: '/admin/stages', roles: ['admin', 'advisor'], badge: 'Admin' },
  { label: 'Ops', to: '/admin/ops', roles: ['admin'], badge: 'Admin' }
]

function resolveHandleValue(
  handleValue: string | ((params: Record<string, string | undefined>) => string) | undefined,
  params: Record<string, string | undefined>
) {
  if (!handleValue) return ''
  return typeof handleValue === 'function' ? handleValue(params) : handleValue
}

function FullPageLoading({ label }: { label: string }) {
  return (
    <div className="full-page-loading" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <p>{label}...</p>
    </div>
  )
}

export function RootRedirect() {
  const { status, user } = useAuth()
  if (status === 'loading') return <FullPageLoading label="Loading workspace" />
  return <Navigate replace to={homePathForUser(user)} />
}

export function AnonymousOnly({ children }: { children: ReactNode }) {
  const { status, user } = useAuth()
  if (status === 'loading') return <FullPageLoading label="Loading sign-in" />
  if (user) return <Navigate replace to={homePathForUser(user)} />
  return <>{children}</>
}

export function RequireBackofficeSession({ children }: { children: ReactNode }) {
  const { status, user } = useAuth()
  const location = useLocation()
  if (status === 'loading') return <FullPageLoading label="Restoring session" />
  if (!user) {
    return <Navigate replace to="/login" state={{ from: location.pathname + location.search }} />
  }
  if (user.role === 'client') {
    return <Navigate replace to="/portal" />
  }
  return <>{children}</>
}

export function AuthFrame() {
  return (
    <div className="auth-shell">
      <div className="auth-brand">
        <p className="eyebrow">Kinetic Klient</p>
        <h1>A real advisory workspace, not a one-page control panel.</h1>
        <p>
          The new shell keeps the current API, session, CSRF, export, and security behavior intact while moving the
          product into routed screens built for real navigation.
        </p>
      </div>
      <div className="auth-panel">
        <Outlet />
      </div>
    </div>
  )
}

export function AppShell() {
  const matches = useMatches()
  const { user, logout } = useAuth()
  const [firmName, setFirmName] = useState<string>('Firm workspace')

  useEffect(() => {
    if (!user || user.role === 'client') return
    void api
      .get<DashboardPayload>(routes.dashboard())
      .then((payload) => setFirmName(payload.firm?.name || 'Firm workspace'))
      .catch(() => setFirmName('Firm workspace'))
  }, [user])

  const crumbs = matches
    .map((match) => {
      const handle = match.handle as RouteHandle | undefined
      const label = resolveHandleValue(handle?.breadcrumb, match.params)
      if (!label) return null
      return { id: match.id, label, pathname: match.pathname }
    })
    .filter(Boolean) as Array<{ id: string; label: string; pathname: string }>

  const currentHandle = matches[matches.length - 1]?.handle as RouteHandle | undefined
  const title = resolveHandleValue(currentHandle?.title, matches[matches.length - 1]?.params || {}) || 'Workspace'
  const subtitle = currentHandle?.subtitle || ''

  return (
    <div className="product-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <p className="eyebrow">Kinetic Klient</p>
          <h1>{firmName}</h1>
          <p>Routed advisory operations across pipeline, forms, exports, and audit.</p>
        </div>
        <nav aria-label="Primary">
          {backofficeNav
            .filter((item) => Boolean(user && item.roles.includes(user.role as NavItem['roles'][number])))
            .map((item) => (
              <NavLink
                key={`${item.to}${item.search || ''}`}
                to={{ pathname: item.to, search: item.search || '' }}
                className={({ isActive }) => (isActive ? 'nav-link nav-link-active' : 'nav-link')}
              >
                <span>{item.label}</span>
                {item.badge ? <span className="nav-badge">{item.badge}</span> : null}
              </NavLink>
            ))}
        </nav>
      </aside>
      <div className="shell-main">
        <header className="topbar">
          <div>
            <p className="topbar-label">{firmName}</p>
            <strong>{user ? `${user.firstName} ${user.lastName}` : 'Session'}</strong>
          </div>
          <div className="topbar-actions">
            <NotificationBell />
            <span className="role-pill" aria-label="Current role">
              {user?.role || 'anonymous'}
            </span>
            <button type="button" className="secondary-button" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </header>
        <main className="page-shell">
          <div className="page-header">
            <div>
              <p className="eyebrow">Workspace</p>
              <h2>{title}</h2>
              {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
            </div>
            {crumbs.length > 1 ? (
              <ol className="breadcrumbs" aria-label="Breadcrumb">
                {crumbs.map((crumb, index) => (
                  <li key={crumb.id}>
                    {index === crumbs.length - 1 ? (
                      <span>{crumb.label}</span>
                    ) : (
                      <NavLink to={crumb.pathname}>{crumb.label}</NavLink>
                    )}
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
          <Outlet />
        </main>
      </div>
    </div>
  )
}

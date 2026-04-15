import { createBrowserRouter } from 'react-router-dom'
import { AnonymousOnly, AppShell, AuthFrame, RequireBackofficeSession, RootRedirect } from './shell'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <RootRedirect />
  },
  {
    element: (
      <AnonymousOnly>
        <AuthFrame />
      </AnonymousOnly>
    ),
    children: [
      {
        path: '/login',
        lazy: () => import('../pages/LoginPage')
      },
      {
        path: '/register',
        lazy: () => import('../pages/RegisterPage')
      }
    ]
  },
  {
    path: '/portal',
    lazy: () => import('../pages/PortalPage')
  },
  {
    element: (
      <RequireBackofficeSession>
        <AppShell />
      </RequireBackofficeSession>
    ),
    children: [
      { path: '/dashboard', lazy: () => import('../pages/DashboardPage') },
      { path: '/pipeline', lazy: () => import('../pages/PipelinePage') },
      { path: '/profiles', lazy: () => import('../pages/ProfilesPage') },
      { path: '/profiles/:profileId', lazy: () => import('../pages/ProfileDetailPage') },
      { path: '/households', lazy: () => import('../pages/HouseholdsPage') },
      { path: '/households/:householdId', lazy: () => import('../pages/HouseholdDetailPage') },
      { path: '/forms', lazy: () => import('../pages/FormsPage') },
      { path: '/forms/submissions/:submissionId', lazy: () => import('../pages/SubmissionDetailPage') },
      { path: '/templates', lazy: () => import('../pages/TemplatesPage') },
      { path: '/templates/:templateId', lazy: () => import('../pages/TemplateDetailPage') },
      { path: '/exports', lazy: () => import('../pages/ExportsPage') },
      { path: '/analytics', lazy: () => import('../pages/AnalyticsPage') },
      { path: '/audit', lazy: () => import('../pages/AuditPage') },
      { path: '/admin/ops', lazy: () => import('../pages/OpsPage') }
    ]
  },
  {
    path: '*',
    lazy: () => import('../pages/NotFoundPage')
  }
])

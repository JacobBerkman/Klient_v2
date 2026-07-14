import { createBrowserRouter } from 'react-router-dom'
import { AnonymousOnly, AppShell, AuthFrame, RequireBackofficeSession, RootRedirect } from './shell'
import { RouteError } from './RouteError'

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
    errorElement: <RouteError />,
    children: [
      {
        path: '/login',
        lazy: () => import('../pages/LoginPage')
      },
      {
        path: '/register',
        lazy: () => import('../pages/RegisterPage')
      },
      {
        path: '/forgot-password',
        lazy: () => import('../pages/ForgotPasswordPage')
      },
      // Destinations of the reset and invite emails. Both carry ?token=.
      {
        path: '/reset-password',
        lazy: () => import('../pages/ResetPasswordPage')
      },
      {
        path: '/accept-invite',
        lazy: () => import('../pages/AcceptInvitePage')
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
    // Keeps a render throw or a stale-chunk import failure inside the app shell
    // instead of dropping the user on React Router's default error screen.
    errorElement: <RouteError />,
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
      { path: '/templates/:templateId/mapper', lazy: () => import('../pages/TemplateMapperPage') },
      { path: '/templates/:templateId', lazy: () => import('../pages/TemplateDetailPage') },
      { path: '/exports', lazy: () => import('../pages/ExportsPage') },
      { path: '/analytics', lazy: () => import('../pages/AnalyticsPage') },
      { path: '/activity', lazy: () => import('../pages/ActivityPage') },
      { path: '/audit', lazy: () => import('../pages/AuditPage') },
      { path: '/admin/stages', lazy: () => import('../pages/AdminStagesPage') },
      { path: '/admin/ops', lazy: () => import('../pages/OpsPage') }
    ]
  },
  {
    path: '*',
    lazy: () => import('../pages/NotFoundPage')
  }
])

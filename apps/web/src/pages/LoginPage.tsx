import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ApiError } from '../lib/client'
import { homePathForUser } from '../lib/permissions'
import { useAuth } from '../app/auth'
import { Card, InlineNotice } from '../components/ui'

export const handle = {
  title: 'Login',
  breadcrumb: 'Login'
}

export function Component() {
  const { login, pendingMfa, clearPendingMfa, enableDemoMode } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState('admin@demo.test')
  const [password, setPassword] = useState('ChangeMe123!')
  const [totpCode, setTotpCode] = useState('')
  const [backupCode, setBackupCode] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const nextPath = (location.state as { from?: string } | null)?.from

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setStatusMessage('')
    try {
      const result = await login(
        pendingMfa
          ? {
              email: pendingMfa.email,
              password: pendingMfa.password,
              mfaChallengeToken: pendingMfa.challengeToken,
              ...(totpCode ? { totpCode } : {}),
              ...(backupCode ? { backupCode } : {})
            }
          : { email, password }
      )
      if (result.mfaRequired) {
        setStatusMessage('MFA challenge required. Continue below.')
      } else if (result.user) {
        setStatusMessage('Signed in successfully.')
        navigate(nextPath || homePathForUser(result.user), { replace: true })
      }
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Sign-in failed.'
      setStatusMessage(message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDemoLogin() {
    setEmail('admin@demo.test')
    setPassword('ChangeMe123!')
    setSubmitting(true)
    setStatusMessage('')
    try {
      const result = await login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
      if (result.mfaRequired) {
        setStatusMessage('MFA challenge required. Continue below.')
      } else if (result.user) {
        setStatusMessage('Signed in successfully.')
        navigate(homePathForUser(result.user), { replace: true })
      }
    } catch (error) {
      setStatusMessage(error instanceof ApiError ? error.message : 'Sign-in failed.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card className="auth-card">
      <p className="eyebrow">Secure session</p>
      <h2>{pendingMfa ? 'Verify sign-in' : 'Sign in'}</h2>
      <p className="muted">
        {pendingMfa
          ? 'Finish the multi-factor challenge to open the routed workspace.'
          : 'Use your existing account and session policy.'}
      </p>
      <form className="form-grid" onSubmit={handleSubmit} data-testid="login-form">
        {!pendingMfa ? (
          <>
            <label>
              <span>Email</span>
              <input
                aria-label="Email"
                autoComplete="username"
                name="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            <label>
              <span>Password</span>
              <input
                aria-label="Password"
                autoComplete="current-password"
                name="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
          </>
        ) : (
          <>
            <label>
              <span>Authenticator code</span>
              <input
                aria-label="Authenticator code"
                value={totpCode}
                onChange={(event) => setTotpCode(event.target.value)}
              />
            </label>
            <label>
              <span>Backup code</span>
              <input
                aria-label="Backup code"
                value={backupCode}
                onChange={(event) => setBackupCode(event.target.value)}
              />
            </label>
          </>
        )}
        <div className="actions-row">
          <button type="submit" data-testid="login-submit" disabled={submitting}>
            {submitting ? 'Signing in...' : pendingMfa ? 'Verify sign-in' : 'Sign in'}
          </button>
          {pendingMfa ? (
            <button type="button" className="ghost-button" onClick={clearPendingMfa}>
              Start over
            </button>
          ) : null}
          {!pendingMfa && enableDemoMode ? (
            <button type="button" className="secondary-button" onClick={() => void handleDemoLogin()}>
              Use demo login
            </button>
          ) : null}
        </div>
      </form>
      {statusMessage ? (
        <p className="inline-notice inline-notice-info" data-testid="auth-status">
          {statusMessage}
        </p>
      ) : (
        <p className="muted" data-testid="auth-status">
          {pendingMfa ? 'Awaiting MFA verification.' : 'Sign in to continue.'}
        </p>
      )}
      {enableDemoMode && !pendingMfa ? (
        <InlineNotice tone="info">Demo credentials: `admin@demo.test` / `ChangeMe123!`</InlineNotice>
      ) : null}
      <p className="muted">
        No account yet?{' '}
        <Link className="text-link" to="/register">
          Create a firm admin account
        </Link>
      </p>
    </Card>
  )
}

import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError, api, routes } from '../lib/client'
import { Card, InlineNotice } from '../components/ui'

export const handle = {
  title: 'Choose a new password',
  breadcrumb: 'Reset password'
}

export function Component() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const token = searchParams.get('token') || ''
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setStatusMessage('')
    if (password !== confirmPassword) {
      setStatusMessage('Both passwords must match.')
      return
    }
    setSubmitting(true)
    try {
      await api.post(routes.passwordResetsConfirm(), { token, password }, { skipCsrf: true })
      // Completing a reset revokes every existing session for the account, so
      // there is nothing to resume -- send them to sign in with the new password.
      navigate('/login?reset=done', { replace: true })
    } catch (error) {
      setStatusMessage(
        error instanceof ApiError || error instanceof Error
          ? error.message
          : 'Unable to reset the password. Request a new link and try again.'
      )
      setSubmitting(false)
    }
  }

  if (!token) {
    return (
      <Card className="auth-card">
        <h2>Reset link is incomplete</h2>
        <InlineNotice tone="danger">
          This link is missing its reset token. Request a new one and use the most recent email.
        </InlineNotice>
        <p className="muted">
          <Link to="/forgot-password">Request a new reset link</Link>
        </p>
      </Card>
    )
  }

  return (
    <Card className="auth-card">
      <h2>Choose a new password</h2>
      <p className="muted">
        Passwords must be at least 12 characters and mix uppercase, lowercase, and numbers. Signing in again everywhere
        else will be required.
      </p>
      <form className="form-grid" onSubmit={handleSubmit} data-testid="reset-password-form">
        <label>
          <span>New password</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label>
          <span>Confirm new password</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </label>
        {statusMessage ? <InlineNotice tone="danger">{statusMessage}</InlineNotice> : null}
        <div className="form-actions">
          <button className="primary" type="submit" disabled={submitting}>
            {submitting ? 'Saving...' : 'Set new password'}
          </button>
          <Link to="/login">Cancel</Link>
        </div>
      </form>
    </Card>
  )
}

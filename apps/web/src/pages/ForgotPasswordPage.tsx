import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, routes } from '../lib/client'
import { Card, InlineNotice } from '../components/ui'

export const handle = {
  title: 'Forgot password',
  breadcrumb: 'Forgot password'
}

export function Component() {
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    try {
      await api.post(routes.passwordResets(), { email }, { skipCsrf: true })
    } catch {
      // Deliberately ignored. The API answers identically for a real and an
      // unknown address; surfacing an error here would hand back the account
      // enumeration oracle the endpoint is careful not to give.
    } finally {
      setSubmitting(false)
      setSent(true)
    }
  }

  if (sent) {
    return (
      <Card className="auth-card">
        <h2>Check your email</h2>
        <InlineNotice tone="success">
          If an account exists for {email || 'that address'}, we have sent a link to reset its password. The link
          expires in 30 minutes.
        </InlineNotice>
        <p className="muted">
          <Link to="/login">Back to sign in</Link>
        </p>
      </Card>
    )
  }

  return (
    <Card className="auth-card">
      <h2>Reset your password</h2>
      <p className="muted">Enter your work email and we will send you a link to choose a new password.</p>
      <form className="form-grid" onSubmit={handleSubmit} data-testid="forgot-password-form">
        <label>
          <span>Email</span>
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <div className="form-actions">
          <button className="primary" type="submit" disabled={submitting}>
            {submitting ? 'Sending...' : 'Send reset link'}
          </button>
          <Link to="/login">Cancel</Link>
        </div>
      </form>
    </Card>
  )
}

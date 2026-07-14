import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError } from '../lib/client'
import { homePathForUser } from '../lib/permissions'
import { useAuth } from '../app/auth'
import { Card, InlineNotice } from '../components/ui'

export const handle = {
  title: 'Accept invite',
  breadcrumb: 'Accept invite'
}

export function Component() {
  const { acceptInvite } = useAuth()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const token = searchParams.get('token') || ''
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
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
      // Accepting the invite signs the new user in, so go straight to their home.
      const user = await acceptInvite({ token, firstName, lastName, password })
      navigate(homePathForUser(user), { replace: true })
    } catch (error) {
      setStatusMessage(
        error instanceof ApiError || error instanceof Error
          ? error.message
          : 'Unable to accept this invite. Ask your administrator to send a new one.'
      )
      setSubmitting(false)
    }
  }

  if (!token) {
    return (
      <Card className="auth-card">
        <h2>Invite link is incomplete</h2>
        <InlineNotice tone="danger">
          This link is missing its invite token. Use the most recent invite email, or ask your administrator to send a
          new one.
        </InlineNotice>
        <p className="muted">
          <Link to="/login">Back to sign in</Link>
        </p>
      </Card>
    )
  }

  return (
    <Card className="auth-card">
      <h2>Accept your invite</h2>
      <p className="muted">
        Your email and role come from the invite. Choose a password of at least 12 characters mixing uppercase,
        lowercase, and numbers.
      </p>
      <form className="form-grid" onSubmit={handleSubmit} data-testid="accept-invite-form">
        <label>
          <span>First name</span>
          <input
            autoComplete="given-name"
            required
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
          />
        </label>
        <label>
          <span>Last name</span>
          <input
            autoComplete="family-name"
            required
            value={lastName}
            onChange={(event) => setLastName(event.target.value)}
          />
        </label>
        <label>
          <span>Password</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label>
          <span>Confirm password</span>
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
            {submitting ? 'Creating account...' : 'Accept invite'}
          </button>
          <Link to="/login">Cancel</Link>
        </div>
      </form>
    </Card>
  )
}

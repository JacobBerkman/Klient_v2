import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError } from '../lib/client'
import { useAuth } from '../app/auth'
import { Card } from '../components/ui'

export const handle = {
  title: 'Register',
  breadcrumb: 'Register'
}

export function Component() {
  const { register } = useAuth()
  const navigate = useNavigate()
  const [submitting, setSubmitting] = useState(false)
  const [statusMessage, setStatusMessage] = useState('')
  const [form, setForm] = useState({
    firmName: '',
    firstName: '',
    lastName: '',
    email: '',
    password: ''
  })

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setStatusMessage('')
    try {
      await register(form)
      setStatusMessage('Firm admin account created.')
      navigate('/dashboard', { replace: true })
    } catch (error) {
      setStatusMessage(error instanceof ApiError ? error.message : 'Registration failed.')
    } finally {
      setSubmitting(false)
    }
  }

  function updateField(key: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  return (
    <Card className="auth-card">
      <p className="eyebrow">Firm setup</p>
      <h2>Create your workspace</h2>
      <p className="muted">
        This preserves the current backend registration and session contract while moving the product to real routes.
      </p>
      <form className="form-grid" onSubmit={handleSubmit} data-testid="register-form">
        <label>
          <span>Firm name</span>
          <input
            aria-label="Firm name"
            value={form.firmName}
            onChange={(event) => updateField('firmName', event.target.value)}
            required
          />
        </label>
        <label>
          <span>First name</span>
          <input
            aria-label="First name"
            value={form.firstName}
            onChange={(event) => updateField('firstName', event.target.value)}
            required
          />
        </label>
        <label>
          <span>Last name</span>
          <input
            aria-label="Last name"
            value={form.lastName}
            onChange={(event) => updateField('lastName', event.target.value)}
            required
          />
        </label>
        <label>
          <span>Email</span>
          <input
            aria-label="Email"
            type="email"
            value={form.email}
            onChange={(event) => updateField('email', event.target.value)}
            required
          />
        </label>
        <label>
          <span>Password</span>
          <input
            aria-label="Password"
            type="password"
            value={form.password}
            onChange={(event) => updateField('password', event.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={submitting}>
          {submitting ? 'Creating account...' : 'Register'}
        </button>
      </form>
      <p className={statusMessage ? 'inline-notice inline-notice-info' : 'muted'}>
        {statusMessage || 'Create the first admin user for your firm.'}
      </p>
      <p className="muted">
        Already have access?{' '}
        <Link className="text-link" to="/login">
          Sign in
        </Link>
      </p>
    </Card>
  )
}

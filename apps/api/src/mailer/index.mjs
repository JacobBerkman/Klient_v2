import { renderTemplate } from './templates.mjs'
import { sendSmtpMail } from './smtp-client.mjs'

// Transactional email delivery (Milestone 3). Providers:
//   - 'disabled' (default): send() is a no-op. API behavior is byte-identical
//     to a build without a mailer.
//   - 'smtp': hand-rolled SMTP client (smtp-client.mjs), zero dependencies.
//   - 'capture': test-only, stores rendered messages in memory and exposes
//     them via `mailer.messages`. Forced back to 'disabled' in production.
//
// send() ALWAYS resolves — every failure (render, transport, audit) is
// swallowed and logged/audited. Invites, password resets, and portal links
// keep returning their tokens in the API response exactly as before; email is
// strictly additive, fire-and-forget delivery on top.
const PROVIDERS = new Set(['disabled', 'smtp', 'capture'])

export function maskEmail(value) {
  const email = String(value || '').trim()
  if (!email) return ''
  const at = email.indexOf('@')
  if (at <= 0) return '***'
  return `${email[0]}***@${email.slice(at + 1)}`
}

export function createMailer({ runtime, log = () => {}, onAudit = () => {} } = {}) {
  const requested = String(runtime?.emailProvider || 'disabled').toLowerCase()
  let provider = PROVIDERS.has(requested) ? requested : 'disabled'
  if (requested && !PROVIDERS.has(requested)) {
    log('warn', 'email.provider.unknown', { requested, provider })
  }
  if (provider === 'capture' && runtime?.nodeEnv === 'production') {
    log('error', 'email.provider.capture_blocked_in_production', { provider: 'disabled' })
    provider = 'disabled'
  }

  const baseUrl = String(runtime?.appBaseUrl || '').trim() || `http://localhost:${runtime?.port || 3000}`
  const messages = []

  function audit(action, { template, to, firmId, actorUserId, errorMessage }) {
    // NEVER include the token or the tokenized URL in the audit payload; the
    // recipient is masked. Audit failures are swallowed like everything else.
    try {
      onAudit({
        firmId: firmId || null,
        actorUserId: actorUserId || null,
        action,
        metadata: {
          template: String(template || ''),
          recipient: maskEmail(to),
          provider,
          ...(errorMessage ? { error: String(errorMessage) } : {})
        }
      })
    } catch (auditError) {
      log('warn', 'email.audit_failed', { action, error: auditError?.message || String(auditError) })
    }
  }

  async function deliver({ to, subject, text, template, firmId }) {
    if (provider === 'capture') {
      messages.push({ to, subject, text, template, firmId, capturedAt: new Date().toISOString() })
      return
    }
    await sendSmtpMail({
      host: runtime?.smtpHost,
      port: runtime?.smtpPort || 587,
      secure: Boolean(runtime?.smtpSecure),
      username: runtime?.smtpUsername || '',
      password: runtime?.smtpPassword || '',
      from: runtime?.emailFrom,
      to,
      subject,
      text,
      // Honored by the client only when NODE_ENV !== 'production'; lets local
      // development talk to plaintext catch-all SMTP sinks.
      allowInsecure: runtime?.nodeEnv !== 'production'
    })
  }

  return {
    provider,
    // Captured messages ('capture' provider only; stays empty otherwise).
    messages,
    async send({ to, template, data = {}, firmId = null, actorUserId = null } = {}) {
      if (provider === 'disabled') {
        return { ok: true, skipped: true, provider }
      }
      const recipient = String(to || '').trim()
      try {
        if (!recipient) throw new Error('Email recipient is required.')
        const rendered = renderTemplate(template, { baseUrl, ...data })
        await deliver({ to: recipient, subject: rendered.subject, text: rendered.text, template, firmId })
        audit('email.sent', { template, to: recipient, firmId, actorUserId })
        log('info', 'email.sent', { template, recipient: maskEmail(recipient), provider })
        return { ok: true, provider }
      } catch (error) {
        const errorMessage = error?.message || String(error)
        audit('email.send_failed', { template, to: recipient, firmId, actorUserId, errorMessage })
        log('warn', 'email.send_failed', { template, recipient: maskEmail(recipient), provider, error: errorMessage })
        return { ok: false, provider }
      }
    }
  }
}

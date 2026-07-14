// Plain-text transactional email templates. Every template receives the data
// the server route supplies plus `baseUrl` (injected by the mailer from the
// runtime APP_BASE_URL value) and returns { subject, text }.
//
// Every link path is a real route in apps/web/src/app/router.tsx and reads the
// ?token= query parameter:
//   - /accept-invite   -> AcceptInvitePage.tsx
//   - /reset-password  -> ResetPasswordPage.tsx
//   - /portal          -> PortalPage.tsx
// The reset token is now delivered ONLY here (the API no longer returns it in
// the response body), so these links have to work.

function trimTrailingSlashes(value) {
  return String(value || '').replace(/\/+$/, '')
}

function appUrl(baseUrl, path) {
  return `${trimTrailingSlashes(baseUrl)}${path}`
}

function firmLabel(firmName) {
  const name = String(firmName || '').trim()
  return name || 'your advisory firm'
}

function expiryLine(expiresAt) {
  return expiresAt ? `This link expires at ${expiresAt}.` : ''
}

function composeBody(lines) {
  return `${lines.filter(Boolean).join('\n')}\n`
}

export const templates = {
  userInvite({ baseUrl, token, firmName, role, expiresAt } = {}) {
    const firm = firmLabel(firmName)
    const inviteUrl = appUrl(baseUrl, `/accept-invite?token=${encodeURIComponent(String(token || ''))}`)
    return {
      subject: `You have been invited to join ${firm} on Kinetic Klient`,
      text: composeBody([
        'Hello,',
        '',
        `You have been invited to join ${firm} on Kinetic Klient${role ? ` as a ${role}` : ''}.`,
        '',
        'Open this link to accept your invite and create your account:',
        inviteUrl,
        '',
        `Your invite token: ${token || ''}`,
        expiryLine(expiresAt),
        '',
        'If you were not expecting this invitation, you can ignore this email.'
      ])
    }
  },
  passwordReset({ baseUrl, token, firmName, expiresAt } = {}) {
    const firm = firmLabel(firmName)
    const resetUrl = appUrl(baseUrl, `/reset-password?token=${encodeURIComponent(String(token || ''))}`)
    return {
      subject: `Password reset for your ${firm} Kinetic Klient account`,
      text: composeBody([
        'Hello,',
        '',
        `A password reset was requested for your ${firm} account on Kinetic Klient.`,
        '',
        'Open this link to continue:',
        resetUrl,
        '',
        `Your password reset token: ${token || ''}`,
        expiryLine(expiresAt),
        '',
        'If you did not request a reset, no action is needed and your password is unchanged.'
      ])
    }
  },
  portalLink({ baseUrl, token, firmName, expiresAt } = {}) {
    const firm = firmLabel(firmName)
    const portalUrl = appUrl(baseUrl, `/portal?token=${encodeURIComponent(String(token || ''))}`)
    return {
      subject: `${firm} has shared a secure client portal link with you`,
      text: composeBody([
        'Hello,',
        '',
        `${firm} has shared a secure portal link with you on Kinetic Klient.`,
        '',
        'Open your client portal here:',
        portalUrl,
        expiryLine(expiresAt),
        '',
        'This link is personal to you - please do not forward it.'
      ])
    }
  }
}

export function renderTemplate(name, data = {}) {
  const template = templates[name]
  if (typeof template !== 'function') {
    throw new Error(`Unknown email template: ${String(name)}`)
  }
  const rendered = template(data)
  if (!rendered?.subject || !rendered?.text) {
    throw new Error(`Email template "${String(name)}" rendered an empty subject or body.`)
  }
  return rendered
}

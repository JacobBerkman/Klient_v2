const DEFAULT_UNMASK_POLICY = 'privileged_sensitive_read_v1'

export const APPROVED_UNMASK_REASON_CODES = new Set([
  'compliance_review',
  'regulatory_review',
  'customer_request',
  'fraud_investigation'
])

export const PII_FIELD_POLICY = {
  profile: {
    ssn: { sensitivity: 'high', mask: 'ssn', storagePath: ['pii', 'ssnEncrypted'] },
    taxId: { sensitivity: 'high', mask: 'taxId', storagePath: ['pii', 'taxIdEncrypted'] },
    dateOfBirth: { sensitivity: 'high', mask: 'dob', storagePath: ['pii', 'dobEncrypted'] }
  },
  financialAccount: {
    accountNumber: { sensitivity: 'high', mask: 'accountNumber' },
    routingNumber: { sensitivity: 'high', mask: 'routingNumber' }
  },
  note: {
    body: { sensitivity: 'medium', mask: 'text', storagePath: ['bodyEncrypted'] }
  },
  formSubmission: {
    notes: { sensitivity: 'medium', mask: 'text', storagePath: ['notesEncrypted'] }
  }
}

export function canUnmaskSensitiveData(user, request = {}) {
  if (!user?.role || !['admin', 'advisor'].includes(user.role)) return false
  if (request.unmask !== true) return false
  if (request.privilegedPolicy !== DEFAULT_UNMASK_POLICY) return false
  if (!APPROVED_UNMASK_REASON_CODES.has(request.reasonCode)) return false
  return String(request.justification || '').trim().length >= 12
}

export function validateUnmaskRequest(request = {}) {
  if (!APPROVED_UNMASK_REASON_CODES.has(request.reasonCode)) {
    throw new Error('Unmask requests must use an approved code.')
  }
  if (!String(request.justification || '').trim()) {
    throw new Error('Unmask requests require non-empty justification.')
  }
  if (request.privilegedPolicy !== DEFAULT_UNMASK_POLICY) {
    throw new Error('Unmask requests require explicit privileged policy acknowledgement.')
  }
}

export function maskSsn(value) {
  if (!value) return null
  return `***-**-${String(value).slice(-4)}`
}

export function maskTaxId(value) {
  if (!value) return null
  return `**-${String(value).slice(-4)}`
}

export function maskDob(value) {
  if (!value) return null
  return '****-**-' + String(value).slice(-2)
}

export function maskAccountNumber(value) {
  if (!value) return null
  return `****${String(value).slice(-4)}`
}

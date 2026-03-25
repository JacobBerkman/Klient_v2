import { readFileSync } from 'node:fs'

const POLICY_MATRIX = Object.freeze(
  JSON.parse(readFileSync(new URL('./policy-matrix.json', import.meta.url), 'utf8'))
)

const ROLE_PERMISSIONS = Object.freeze(
  Object.entries(POLICY_MATRIX).reduce((acc, [guardName, roles]) => {
    for (const role of roles) {
      if (!acc[role]) acc[role] = {}
      acc[role][guardName] = true
    }
    return acc
  }, {})
)

function createPolicyError(message, code, details = null) {
  const error = new Error(message)
  error.statusCode = 403
  error.code = code
  error.details = details
  return error
}

export function createPolicy() {
  function evaluateGuard(user, guardName) {
    const allowedRoles = POLICY_MATRIX[guardName]
    if (!allowedRoles) {
      return { allowed: false, reasonCode: 'POLICY_GUARD_UNKNOWN', details: { guardName } }
    }

    const role = user?.role || 'anonymous'
    if (role === 'anonymous' && !allowedRoles.includes('anonymous')) {
      return { allowed: false, reasonCode: 'POLICY_USER_ROLE_MISSING', details: { guardName } }
    }

    const allowed = allowedRoles.includes(role)
    if (!allowed) {
      return {
        allowed: false,
        reasonCode: 'POLICY_ACCESS_DENIED',
        details: { guardName, role, allowedRoles }
      }
    }

    return { allowed: true, reasonCode: 'POLICY_ALLOW', details: { guardName, role, allowedRoles } }
  }

  function requireGuard(user, guardName) {
    const decision = evaluateGuard(user, guardName)
    if (!decision.allowed) {
      throw createPolicyError(`Missing permission: ${guardName}`, decision.reasonCode, decision.details)
    }
    return decision
  }

  return {
    matrix: POLICY_MATRIX,
    roleMatrix: ROLE_PERMISSIONS,
    guards: POLICY_MATRIX,
    evaluateGuard,
    requireGuard,
    requirePermission(user, permission) {
      return requireGuard(user, permission)
    }
  }
}

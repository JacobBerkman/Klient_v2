const POLICY_MATRIX = {
  admin: {
    users: { manage: true, read: true },
    profiles: { read: true, write: true, sensitiveRead: true },
    pipeline: { move: true, read: true },
    households: { read: true, write: true },
    forms: { read: true, write: true },
    templates: { read: true, write: true, publish: true },
    exports: { read: true, write: true, process: true },
    analytics: { read: true },
    audit: { read: true },
    diagnostics: { read: true },
    portal: { read: true, create: true },
    clientWorkspace: { read: true, write: true }
  },
  advisor: {
    users: { manage: false, read: false },
    profiles: { read: true, write: true, sensitiveRead: true },
    pipeline: { move: true, read: true },
    households: { read: true, write: true },
    forms: { read: true, write: true },
    templates: { read: true, write: true, publish: true },
    exports: { read: true, write: true, process: true },
    analytics: { read: true },
    audit: { read: true },
    diagnostics: { read: true },
    portal: { read: true, create: true },
    clientWorkspace: { read: false, write: false }
  },
  readonly: {
    users: { manage: false, read: false },
    profiles: { read: true, write: false, sensitiveRead: false },
    pipeline: { move: false, read: true },
    households: { read: true, write: false },
    forms: { read: true, write: false },
    templates: { read: false, write: false, publish: false },
    exports: { read: false, write: false, process: false },
    analytics: { read: true },
    audit: { read: true },
    diagnostics: { read: false },
    portal: { read: true, create: true },
    clientWorkspace: { read: false, write: false }
  },
  client: {
    users: { manage: false, read: false },
    profiles: { read: false, write: false, sensitiveRead: false },
    pipeline: { move: false, read: false },
    households: { read: false, write: false },
    forms: { read: false, write: false },
    templates: { read: false, write: false, publish: false },
    exports: { read: false, write: false, process: false },
    analytics: { read: false },
    audit: { read: false },
    diagnostics: { read: false },
    portal: { read: true, create: false },
    clientWorkspace: { read: true, write: true }
  }
}

const GUARD_TO_POLICY = {
  canManageUsers: ['users', 'manage'],
  canReadUsers: ['users', 'read'],
  canViewDashboard: ['profiles', 'read'],
  canReadProfiles: ['profiles', 'read'],
  canWriteProfiles: ['profiles', 'write'],
  canReadSensitiveProfileData: ['profiles', 'sensitiveRead'],
  canReadPipeline: ['pipeline', 'read'],
  canMovePipeline: ['pipeline', 'move'],
  canReadHouseholds: ['households', 'read'],
  canWriteHouseholds: ['households', 'write'],
  canReadForms: ['forms', 'read'],
  canWriteForms: ['forms', 'write'],
  canReadTemplate: ['templates', 'read'],
  canEditTemplate: ['templates', 'write'],
  canPublishTemplate: ['templates', 'publish'],
  canReadExports: ['exports', 'read'],
  canWriteExports: ['exports', 'write'],
  canProcessExports: ['exports', 'process'],
  canReadAudit: ['audit', 'read'],
  canReadAnalytics: ['analytics', 'read'],
  canReadDiagnostics: ['diagnostics', 'read'],
  canReadClientWorkspace: ['clientWorkspace', 'read'],
  canWriteClientWorkspace: ['clientWorkspace', 'write'],
  canCreatePortalLink: ['portal', 'create'],
  canReadPortal: ['portal', 'read']
}

function createPolicyError(message, code, details = null) {
  const error = new Error(message)
  error.statusCode = 403
  error.code = code
  error.details = details
  return error
}

export function createPolicy() {
  function evaluateGuard(user, guardName) {
    const mapping = GUARD_TO_POLICY[guardName]
    if (!mapping) {
      return { allowed: false, reasonCode: 'POLICY_GUARD_UNKNOWN', details: { guardName } }
    }
    if (!user?.role) {
      return { allowed: false, reasonCode: 'POLICY_USER_ROLE_MISSING', details: { guardName } }
    }

    const [resource, action] = mapping
    const allowed = Boolean(POLICY_MATRIX[user.role]?.[resource]?.[action])
    if (!allowed) {
      return {
        allowed: false,
        reasonCode: 'POLICY_ACCESS_DENIED',
        details: { guardName, role: user.role, resource, action }
      }
    }

    return { allowed: true, reasonCode: 'POLICY_ALLOW', details: { guardName, role: user.role, resource, action } }
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
    guards: GUARD_TO_POLICY,
    evaluateGuard,
    requireGuard,
    requirePermission(user, permission) {
      return requireGuard(user, permission)
    }
  }
}

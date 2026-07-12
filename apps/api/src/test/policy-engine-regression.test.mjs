import test from 'node:test'
import assert from 'node:assert/strict'

import { createPolicy } from '../modules/shared/policy.mjs'
import { createFirmsUsersService } from '../modules/firms-users/service.mjs'
import { createProfilesService } from '../modules/profiles/service.mjs'
import { createPipelineService } from '../modules/pipeline/service.mjs'
import { createHouseholdsService } from '../modules/households/service.mjs'
import { createFormsService } from '../modules/forms/service.mjs'
import { createTemplatesService } from '../modules/templates/service.mjs'
import { createExportsService } from '../modules/exports/service.mjs'
import { CANONICAL_AUDIT_FIELDS, createAuditService } from '../modules/audit/service.mjs'
import { createAnalyticsService } from '../modules/analytics/service.mjs'

const usersByRole = Object.fromEntries(
  ['admin', 'advisor', 'readonly', 'client'].map((role) => [role, { id: `${role}-1`, role, firmId: 'firm-1' }])
)

function createDeps() {
  const store = {
    state: { auditEvents: [] },
    listAudit() {
      return this.state.auditEvents
    }
  }
  const mutatingStore = new Proxy(store, {
    get(target, key) {
      if (key in target) return target[key]
      return () => {
        target.state.auditEvents.push({ id: `e-${target.state.auditEvents.length + 1}` })
        return { ok: true }
      }
    }
  })
  const reads = { getAnalytics: () => ({ ok: true }) }
  const policy = createPolicy()
  const profileRepository = new Proxy({}, { get: () => () => ({ ok: true }) })
  const templateRepository = new Proxy(
    {},
    {
      get: () => () => {
        store.state.auditEvents.push({ id: `t-${store.state.auditEvents.length + 1}` })
        return { ok: true }
      }
    }
  )
  // Exports repository double: the service normalizes list results via
  // Array.prototype.map, so `list` must return an array. Other methods keep the
  // mutating behavior (record an audit event so runAuditedMutation is satisfied).
  const exportsRepository = new Proxy(store, {
    get(target, key) {
      if (key === 'list') return () => []
      if (key in target) return target[key]
      return () => {
        target.state.auditEvents.push({ id: `x-${target.state.auditEvents.length + 1}` })
        return { ok: true }
      }
    }
  })

  return {
    policy,
    firmsUsers: createFirmsUsersService({ store: mutatingStore, policy }),
    profiles: createProfilesService({ profileRepository, policy }),
    pipeline: createPipelineService({ store: mutatingStore, policy }),
    households: createHouseholdsService({ store: mutatingStore, policy }),
    forms: createFormsService({ store: mutatingStore, policy }),
    templates: createTemplatesService({ templateRepository, policy, store }),
    exports: createExportsService({ exportsRepository, policy, store: mutatingStore }),
    audit: createAuditService({ store: mutatingStore, policy }),
    analytics: createAnalyticsService({ store: mutatingStore, reads, policy })
  }
}

const operations = [
  { key: 'firmsUsers.listUsers', invoke: (s, u) => s.firmsUsers.listUsers(u), allowed: new Set(['admin']) },
  { key: 'firmsUsers.inviteUser', invoke: (s, u) => s.firmsUsers.inviteUser(u, {}), allowed: new Set(['admin']) },
  {
    key: 'profiles.listProfiles',
    invoke: (s, u) => s.profiles.listProfiles(u, {}),
    allowed: new Set(['admin', 'advisor', 'readonly'])
  },
  {
    key: 'profiles.createProfile',
    invoke: (s, u) => s.profiles.createProfile(u, {}),
    allowed: new Set(['admin', 'advisor'])
  },
  {
    key: 'profiles.getMaskedSensitiveData',
    invoke: (s, u) => s.profiles.getMaskedSensitiveData(u, 'p1'),
    allowed: new Set(['admin', 'advisor'])
  },
  {
    key: 'pipeline.getBoard',
    invoke: (s, u) => s.pipeline.getBoard(u),
    allowed: new Set(['admin', 'advisor', 'readonly'])
  },
  {
    key: 'pipeline.moveProfileStage',
    invoke: (s, u) => s.pipeline.moveProfileStage(u, 'p1', 'analysis'),
    allowed: new Set(['admin', 'advisor'])
  },
  {
    key: 'households.listHouseholds',
    invoke: (s, u) => s.households.listHouseholds(u),
    allowed: new Set(['admin', 'advisor', 'readonly'])
  },
  {
    key: 'households.createHousehold',
    invoke: (s, u) => s.households.createHousehold(u, {}),
    allowed: new Set(['admin', 'advisor'])
  },
  {
    key: 'forms.listFormSubmissions',
    invoke: (s, u) => s.forms.listFormSubmissions(u),
    allowed: new Set(['admin', 'advisor', 'readonly'])
  },
  {
    key: 'forms.createFormSubmission',
    invoke: (s, u) => s.forms.createFormSubmission(u, {}),
    allowed: new Set(['admin', 'advisor'])
  },
  {
    key: 'forms.acquireDraftLock',
    invoke: (s, u) => s.forms.acquireDraftLock(u, 'd1', {}),
    allowed: new Set(['admin', 'advisor'])
  },
  {
    key: 'forms.reviseDraftSubmission',
    invoke: (s, u) => s.forms.reviseDraftSubmission(u, 'd1', { leaseId: 'l1', expectedRevisionId: 1, data: {} }),
    allowed: new Set(['admin', 'advisor'])
  },
  {
    key: 'forms.listDraftCollaborators',
    invoke: (s, u) => s.forms.listDraftCollaborators(u, 'd1'),
    allowed: new Set(['admin', 'advisor'])
  },
  {
    key: 'forms.addDraftCollaborator',
    invoke: (s, u) => s.forms.addDraftCollaborator(u, 'd1', { userId: 'u2', permission: 'write' }),
    allowed: new Set(['admin', 'advisor'])
  },
  {
    key: 'forms.removeDraftCollaborator',
    invoke: (s, u) => s.forms.removeDraftCollaborator(u, 'd1', 'u2'),
    allowed: new Set(['admin', 'advisor'])
  },
  {
    key: 'forms.getClientWorkspace',
    invoke: (s, u) => s.forms.getClientWorkspace(u),
    allowed: new Set(['client'])
  },
  {
    key: 'forms.submitClientForm',
    invoke: (s, u) => s.forms.submitClientForm(u, {}),
    allowed: new Set(['client'])
  },
  { key: 'templates.list', invoke: (s, u) => s.templates.list(u), allowed: new Set(['admin', 'advisor', 'readonly']) },
  { key: 'templates.create', invoke: (s, u) => s.templates.create(u, {}), allowed: new Set(['admin', 'advisor']) },
  { key: 'templates.publish', invoke: (s, u) => s.templates.publish(u, 't1'), allowed: new Set(['admin', 'advisor']) },
  { key: 'exports.list', invoke: (s, u) => s.exports.list(u), allowed: new Set(['admin', 'advisor']) },
  { key: 'exports.create', invoke: (s, u) => s.exports.create(u, {}), allowed: new Set(['admin', 'advisor']) },
  {
    key: 'exports.processQueuedExports',
    invoke: (s, u) => s.exports.processQueuedExports(u),
    allowed: new Set(['admin']),
    async: true
  },
  { key: 'audit.list', invoke: (s, u) => s.audit.list(u), allowed: new Set(['admin', 'advisor', 'readonly']) },
  { key: 'analytics.get', invoke: (s, u) => s.analytics.get(u), allowed: new Set(['admin', 'advisor', 'readonly']) },
  {
    key: 'analytics.getDiagnosticsContext',
    invoke: (s, u) => s.analytics.getDiagnosticsContext(u),
    allowed: new Set(['admin'])
  }
]

test('policy engine deny-by-default returns reason codes', () => {
  const policy = createPolicy()
  assert.deepEqual(policy.evaluateGuard({ role: 'admin' }, 'unknownGuard').reasonCode, 'POLICY_GUARD_UNKNOWN')
  assert.deepEqual(policy.evaluateGuard({}, 'canReadProfiles').reasonCode, 'POLICY_USER_ROLE_MISSING')
  assert.deepEqual(policy.evaluateGuard({ role: 'readonly' }, 'canWriteProfiles').reasonCode, 'POLICY_ACCESS_DENIED')
})

test('role regression covers read/write service boundaries', async () => {
  const services = createDeps()

  for (const operation of operations) {
    for (const [role, user] of Object.entries(usersByRole)) {
      const allowed = operation.allowed.has(role)
      if (operation.async) {
        // Async service methods turn the synchronous guard throw into a rejected
        // promise, so the deny/allow boundary must be asserted via rejects/doesNotReject.
        if (allowed) {
          await assert.doesNotReject(
            async () => operation.invoke(services, user),
            `${operation.key} should allow ${role}`
          )
        } else {
          await assert.rejects(
            async () => operation.invoke(services, user),
            (error) => error?.code === 'POLICY_ACCESS_DENIED',
            `${operation.key} should deny ${role}`
          )
        }
      } else if (allowed) {
        assert.doesNotThrow(() => operation.invoke(services, user), `${operation.key} should allow ${role}`)
      } else {
        assert.throws(
          () => operation.invoke(services, user),
          (error) => error?.code === 'POLICY_ACCESS_DENIED',
          `${operation.key} should deny ${role}`
        )
      }
    }
  }
})

test('canonical audit schema remains stable', () => {
  assert.deepEqual(CANONICAL_AUDIT_FIELDS, [
    'actor',
    'firmId',
    'entityType',
    'entityId',
    'action',
    'before',
    'after',
    'requestId',
    'ip',
    'timestamp'
  ])
})

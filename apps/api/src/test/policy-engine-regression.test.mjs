import test from 'node:test';
import assert from 'node:assert/strict';

import { createPolicy } from '../modules/shared/policy.mjs';
import { createFirmsUsersService } from '../modules/firms-users/service.mjs';
import { createProfilesService } from '../modules/profiles/service.mjs';
import { createPipelineService } from '../modules/pipeline/service.mjs';
import { createHouseholdsService } from '../modules/households/service.mjs';
import { createFormsService } from '../modules/forms/service.mjs';
import { createTemplatesService } from '../modules/templates/service.mjs';
import { createExportsService } from '../modules/exports/service.mjs';
import { createAuditService } from '../modules/audit/service.mjs';
import { createAnalyticsService } from '../modules/analytics/service.mjs';

const usersByRole = Object.fromEntries(['admin', 'advisor', 'readonly', 'client'].map((role) => [role, { id: `${role}-1`, role, firmId: 'firm-1' }]));

function createDeps() {
  const store = new Proxy({}, { get: () => () => ({ ok: true }) });
  const reads = { getAnalytics: () => ({ ok: true }) };
  const policy = createPolicy();
  const profileRepository = new Proxy({}, { get: () => () => ({ ok: true }) });
  const templateRepository = new Proxy({}, { get: () => () => ({ ok: true }) });

  return {
    policy,
    firmsUsers: createFirmsUsersService({ store, policy }),
    profiles: createProfilesService({ profileRepository, policy }),
    pipeline: createPipelineService({ store, policy }),
    households: createHouseholdsService({ store, policy }),
    forms: createFormsService({ store, policy }),
    templates: createTemplatesService({ templateRepository, policy }),
    exports: createExportsService({ store, policy }),
    audit: createAuditService({ store, policy }),
    analytics: createAnalyticsService({ store, reads, policy })
  };
}

const operations = [
  { key: 'firmsUsers.listUsers', invoke: (s, u) => s.firmsUsers.listUsers(u), allowed: new Set(['admin']) },
  { key: 'firmsUsers.inviteUser', invoke: (s, u) => s.firmsUsers.inviteUser(u, {}), allowed: new Set(['admin']) },
  { key: 'profiles.listProfiles', invoke: (s, u) => s.profiles.listProfiles(u, {}), allowed: new Set(['admin', 'advisor', 'readonly']) },
  { key: 'profiles.createProfile', invoke: (s, u) => s.profiles.createProfile(u, {}), allowed: new Set(['admin', 'advisor']) },
  { key: 'profiles.getMaskedSensitiveData', invoke: (s, u) => s.profiles.getMaskedSensitiveData(u, 'p1'), allowed: new Set(['admin', 'advisor']) },
  { key: 'pipeline.getBoard', invoke: (s, u) => s.pipeline.getBoard(u), allowed: new Set(['admin', 'advisor', 'readonly']) },
  { key: 'pipeline.moveProfileStage', invoke: (s, u) => s.pipeline.moveProfileStage(u, 'p1', 'analysis'), allowed: new Set(['admin', 'advisor']) },
  { key: 'households.listHouseholds', invoke: (s, u) => s.households.listHouseholds(u), allowed: new Set(['admin', 'advisor', 'readonly']) },
  { key: 'households.createHousehold', invoke: (s, u) => s.households.createHousehold(u, {}), allowed: new Set(['admin', 'advisor']) },
  { key: 'forms.listFormSubmissions', invoke: (s, u) => s.forms.listFormSubmissions(u), allowed: new Set(['admin', 'advisor', 'readonly']) },
  { key: 'forms.createFormSubmission', invoke: (s, u) => s.forms.createFormSubmission(u, {}), allowed: new Set(['admin', 'advisor']) },
  { key: 'forms.getClientWorkspace', invoke: (s, u) => s.forms.getClientWorkspace(u), allowed: new Set(['admin', 'client']) },
  { key: 'forms.submitClientForm', invoke: (s, u) => s.forms.submitClientForm(u, {}), allowed: new Set(['admin', 'client']) },
  { key: 'templates.list', invoke: (s, u) => s.templates.list(u), allowed: new Set(['admin', 'advisor']) },
  { key: 'templates.create', invoke: (s, u) => s.templates.create(u, {}), allowed: new Set(['admin', 'advisor']) },
  { key: 'templates.publish', invoke: (s, u) => s.templates.publish(u, 't1'), allowed: new Set(['admin', 'advisor']) },
  { key: 'exports.list', invoke: (s, u) => s.exports.list(u), allowed: new Set(['admin', 'advisor']) },
  { key: 'exports.create', invoke: (s, u) => s.exports.create(u, {}), allowed: new Set(['admin', 'advisor']) },
  { key: 'exports.processQueuedExports', invoke: (s, u) => s.exports.processQueuedExports(u), allowed: new Set(['admin', 'advisor']) },
  { key: 'audit.list', invoke: (s, u) => s.audit.list(u), allowed: new Set(['admin', 'advisor', 'readonly']) },
  { key: 'analytics.get', invoke: (s, u) => s.analytics.get(u), allowed: new Set(['admin', 'advisor', 'readonly']) },
  { key: 'analytics.getDiagnosticsContext', invoke: (s, u) => s.analytics.getDiagnosticsContext(u), allowed: new Set(['admin', 'advisor']) }
];

test('policy engine deny-by-default returns reason codes', () => {
  const policy = createPolicy();
  assert.deepEqual(policy.evaluateGuard({ role: 'admin' }, 'unknownGuard').reasonCode, 'POLICY_GUARD_UNKNOWN');
  assert.deepEqual(policy.evaluateGuard({}, 'canReadProfiles').reasonCode, 'POLICY_USER_ROLE_MISSING');
  assert.deepEqual(policy.evaluateGuard({ role: 'readonly' }, 'canWriteProfiles').reasonCode, 'POLICY_ACCESS_DENIED');
});

test('role regression covers read/write service boundaries', () => {
  const services = createDeps();

  for (const operation of operations) {
    for (const [role, user] of Object.entries(usersByRole)) {
      if (operation.allowed.has(role)) {
        assert.doesNotThrow(() => operation.invoke(services, user), `${operation.key} should allow ${role}`);
      } else {
        assert.throws(() => operation.invoke(services, user), (error) => error?.code === 'POLICY_ACCESS_DENIED', `${operation.key} should deny ${role}`);
      }
    }
  }
});

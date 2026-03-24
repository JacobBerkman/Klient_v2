import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createAuthService } from './auth/service.mjs';
import { createLocalAuthProvider } from './auth/local-provider.mjs';
import { createOidcAuthProvider } from './auth/oidc-provider.mjs';
import { createSamlAuthProvider } from './auth/saml-provider.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { runtime } from './runtime.mjs';
import { createKeyProvider, PiiCryptoService } from './pii-crypto.mjs';
import { createLocalAuthProvider } from './auth/local-provider.mjs';
import { createAuthService } from './auth/service.mjs';
import { createAuthService } from './auth/service.mjs';
import { createLocalAuthProvider } from './auth/local-provider.mjs';
import { enqueueExportJob, listExportQueueJobs, loadState, processExportQueueTick, requeueExportJob, saveState } from './storage.mjs';
import { createLocalAuthProvider } from './auth/local-provider.mjs';
import { createAuthService } from './auth/service.mjs';
import { createAuthService } from './auth/service.mjs';
import { createLocalAuthProvider } from './auth/local-provider.mjs';
import { objectStorage as defaultObjectStorage } from './object-storage/index.mjs';

const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const ALLOWED_INVITE_ROLES = new Set(['advisor', 'readonly', 'client']);
const ROLE_POLICY_MATRIX = {
  admin: {
    profiles: { read: 'firm', write: 'firm', sensitiveRead: 'firm' },
    pipeline: { write: 'firm' },
    households: { read: 'firm', write: 'firm' },
    forms: { read: 'firm', write: 'firm' },
    templates: { read: 'firm', write: 'firm', publish: 'firm' },
    exports: { read: 'firm', write: 'firm', process: 'firm' },
    analytics: { read: 'firm' },
    users: { read: 'firm', write: 'firm' },
    firm: { settingsWrite: 'firm' },
    portal: { read: 'self', write: 'self' },
    client: { write: 'self' }
  },
  advisor: {
    profiles: { read: 'firm', write: 'firm', sensitiveRead: 'firm' },
    pipeline: { write: 'firm' },
    households: { read: 'firm', write: 'firm' },
    forms: { read: 'firm', write: 'firm' },
    templates: { read: 'firm', write: 'firm', publish: 'firm' },
    exports: { read: 'firm', write: 'firm', process: 'firm' },
    analytics: { read: 'firm' },
    users: { read: null, write: null },
    firm: { settingsWrite: null },
    portal: { read: 'self', write: 'self' },
    client: { write: null }
  },
  readonly: {
    profiles: { read: 'firm', write: null, sensitiveRead: null },
    pipeline: { write: null },
    households: { read: 'firm', write: null },
    forms: { read: 'firm', write: null },
    templates: { read: null, write: null, publish: null },
    exports: { read: null, write: null, process: null },
    analytics: { read: 'firm' },
    users: { read: null, write: null },
    firm: { settingsWrite: null },
    portal: { read: null, write: null },
    client: { write: null }
  },
  client: {
    profiles: { read: null, write: null, sensitiveRead: null },
    pipeline: { write: null },
    households: { read: null, write: null },
    forms: { read: null, write: null },
    templates: { read: null, write: null, publish: null },
    exports: { read: null, write: null, process: null },
    analytics: { read: null },
    users: { read: null, write: null },
    firm: { settingsWrite: null },
    portal: { read: 'self', write: 'self' },
    client: { write: 'self' }
  }
};

const OPERATION_TO_POLICY = {
  'profiles:read': ['profiles', 'read'],
  'profiles:write': ['profiles', 'write'],
  'profiles:sensitive:read': ['profiles', 'sensitiveRead'],
  'pipeline:write': ['pipeline', 'write'],
  'households:read': ['households', 'read'],
  'households:write': ['households', 'write'],
  'forms:read': ['forms', 'read'],
  'forms:write': ['forms', 'write'],
  'templates:read': ['templates', 'read'],
  'templates:write': ['templates', 'write'],
  'templates:publish': ['templates', 'publish'],
  'exports:read': ['exports', 'read'],
  'exports:write': ['exports', 'write'],
  'exports:process': ['exports', 'process'],
  'analytics:read': ['analytics', 'read'],
  'users:read': ['users', 'read'],
  'users:write': ['users', 'write'],
  'firm:settings:write': ['firm', 'settingsWrite'],
  'portal:read': ['portal', 'read'],
  'portal:write': ['portal', 'write'],
  'client:write': ['client', 'write']
const CSRF_TOKEN_TTL_MS = 1000 * 60 * 15;
const PERMISSIONS = {
  admin: ['*'],
  advisor: ['profiles:read', 'profiles:write', 'pipeline:write', 'households:write', 'forms:write', 'templates:write', 'exports:write', 'analytics:read'],
  readonly: ['profiles:read', 'analytics:read'],
  client: ['portal:read', 'client:write']
};
const ITEM_KEY_FIELD = '_itemKey';

function createStoreError(message, { statusCode = 400, code = 'BAD_REQUEST', details = null } = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details) error.details = details;
  return error;
}
const BOARD_COLUMNS = ['discovery', 'gather_oi', 'analysis', 'advisor_proposal_meeting', 'intake', 'on_boarding', 'investment_strategy', 'completed', 'drop_dead_lead', 'drop_nurture'];


const SENSITIVE_ACCESS_POLICY = {
  admin: {
    profile_view: { allowMasked: true, allowUnmasked: false },
    compliance_review: { allowMasked: true, allowUnmasked: true },
    audit_investigation: { allowMasked: true, allowUnmasked: true }
  },
  advisor: {
    profile_view: { allowMasked: true, allowUnmasked: false },
    client_support: { allowMasked: true, allowUnmasked: true }
  },
  readonly: {
    profile_view: { allowMasked: true, allowUnmasked: false }
  },
  client: {}
};

function can(role, operation) {
  const policy = OPERATION_TO_POLICY[operation];
  if (!policy) return false;
  const [resource, action] = policy;
  return Boolean(ROLE_POLICY_MATRIX[role]?.[resource]?.[action]);
}

function authorize(user, operation) {
  if (!can(user.role, operation)) {
    throw new Error(`Missing permission: ${operation}`);
  }
}

function now() {
  return new Date().toISOString();
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toKey(item) {
  return JSON.stringify(item ?? null);
}

function summarizeArrayDiff(previous = [], next = []) {
  const prevMap = new Map(previous.map((item) => [toKey(item), item]));
  const nextMap = new Map(next.map((item) => [toKey(item), item]));
  const added = [];
  const removed = [];
  for (const [key, value] of nextMap.entries()) {
    if (!prevMap.has(key)) added.push(value);
  }
  for (const [key, value] of prevMap.entries()) {
    if (!nextMap.has(key)) removed.push(value);
  }
  return { added, removed, changed: added.length > 0 || removed.length > 0 };
}

function summarizeBlueprintDiff(previousBlueprint = { sections: [] }, nextBlueprint = { sections: [] }) {
  const previousSections = Array.isArray(previousBlueprint?.sections) ? previousBlueprint.sections : [];
  const nextSections = Array.isArray(nextBlueprint?.sections) ? nextBlueprint.sections : [];
  const sectionDiff = summarizeArrayDiff(previousSections, nextSections);
  return {
    changed: sectionDiff.changed,
    previousSectionCount: previousSections.length,
    nextSectionCount: nextSections.length,
    addedSections: sectionDiff.added,
    removedSections: sectionDiff.removed
  };
}

function createTemplateVersion(template, event, { blueprint, mappings, publishState, diff, actorUserId }) {
  return {
    version: (template.versions?.length || 0) + 1,
    event,
    blueprint: deepClone(blueprint || template.blueprint || { sections: [] }),
    mappings: deepClone(mappings || template.mappings || []),
    formSchema: deepClone(template.formSchema || { sections: [] }),
    publishState: publishState || template.publishState || 'draft',
    diff: diff || null,
    actorUserId: actorUserId || null,
    createdAt: now()
  };
}

function normalizeTemplateAggregate(template, fallbackKind = 'document') {
  const baseBlueprint = template.blueprint || { sections: [] };
  const baseMappings = template.mappings || template.mappingRules || [];
  const basePublishState = template.publishState || template.status || 'draft';
  const baseFormSchema = template.formSchema || { sections: template.sections || [] };
  const normalized = {
    id: template.id,
    firmId: template.firmId,
    kind: template.kind || fallbackKind,
    name: template.name,
    description: template.description || '',
    documentMetadata: template.documentMetadata || { fileName: template.fileName || null },
    extractedFields: template.extractedFields || [],
    formSchema: baseFormSchema,
    blueprint: baseBlueprint,
    mappings: baseMappings,
    mappingRules: baseMappings,
    publishState: basePublishState,
    status: basePublishState,
    versions: (template.versions || []).map((entry, index) => ({
      version: entry.version || index + 1,
      event: entry.event || 'snapshot',
      blueprint: deepClone(entry.blueprint || baseBlueprint),
      mappings: deepClone(entry.mappings || baseMappings),
      formSchema: deepClone(entry.formSchema || baseFormSchema),
      publishState: entry.publishState || basePublishState,
      diff: entry.diff || null,
      actorUserId: entry.actorUserId || null,
      createdAt: entry.createdAt || template.updatedAt || template.createdAt || now()
    })),
    publishTransitions: template.publishTransitions || [],
    createdAt: template.createdAt || now(),
    updatedAt: template.updatedAt || template.createdAt || now(),
    legacy: template.legacy || null
  };
  if (!normalized.versions.length) {
    normalized.versions.push(createTemplateVersion(normalized, 'created', {
      blueprint: normalized.blueprint,
      mappings: normalized.mappings,
      publishState: normalized.publishState
    }));
  }
  return normalized;
}

function migrateTemplateSystems(state) {
  state.templateAggregates ||= [];
  if (state.templateAggregates.length === 0) {
    const migratedForms = (state.formTemplates || []).map((template) => normalizeTemplateAggregate({
      ...template,
      kind: 'form',
      formSchema: { sections: template.sections || [] },
      blueprint: { sections: [] },
      mappings: [],
      publishState: 'draft',
      legacy: { source: 'formTemplates', id: template.id }
    }, 'form'));
    const migratedDocuments = (state.documentTemplates || []).map((template) => normalizeTemplateAggregate({
      ...template,
      kind: 'document',
      formSchema: { sections: [] },
      blueprint: template.blueprint || { sections: [] },
      mappings: template.mappings || [],
      publishState: template.status || 'draft',
      legacy: { source: 'documentTemplates', id: template.id }
    }, 'document'));
    state.templateAggregates = [...migratedForms, ...migratedDocuments];
  } else {
    state.templateAggregates = state.templateAggregates.map((entry) => normalizeTemplateAggregate(entry, entry.kind || 'document'));
  }
  state.formTemplates = state.templateAggregates
    .filter((entry) => entry.kind === 'form')
    .map((entry) => ({
      id: entry.id,
      firmId: entry.firmId,
      name: entry.name,
      description: entry.description || '',
      sections: deepClone(entry.formSchema?.sections || []),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt
    }));
  state.documentTemplates = state.templateAggregates
    .filter((entry) => entry.kind !== 'form')
    .map((entry) => ({
      id: entry.id,
      firmId: entry.firmId,
      name: entry.name,
      fileName: entry.documentMetadata?.fileName || 'template.pdf',
      blueprint: deepClone(entry.blueprint || { sections: [] }),
      mappings: deepClone(entry.mappings || []),
      versions: deepClone(entry.versions || []),
      status: entry.publishState || 'draft',
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt
    }));
function parseIso(value) {
  const time = new Date(value || '').getTime();
  return Number.isFinite(time) ? time : 0;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function hash(password) {
  return createHash('sha256').update(password).digest('hex');
}

function assertStrongPassword(password) {
  const value = String(password || '');
  if (value.length < 12) throw new Error('Password must be at least 12 characters long.');
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) {
    throw new Error('Password must include uppercase, lowercase, and numeric characters.');
  }
}


function sanitizeFileName(value = 'file.bin') {
  return String(value || 'file.bin').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-{2,}/g, '-').slice(0, 120) || 'file.bin';
}

function daysBetween(thenIso, nowMs) {
  const thenMs = new Date(thenIso || 0).getTime();
  if (!Number.isFinite(thenMs) || thenMs <= 0) return 0;
  return Math.floor((nowMs - thenMs) / (1000 * 60 * 60 * 24));
}

function sourceDisplay(source) {
  return `${source.cityOrLocation} X ${source.venue} X ${source.occurredOn}`;
}

function normalizeSectionKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
function pipelineConflict(message, details = {}) {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = 'PIPELINE_ORDER_CONFLICT';
  error.details = details;
  return error;
}

function seedState() {
  const createdAt = now();
  const firmId = randomUUID();
  const adminId = randomUUID();
  const householdId = randomUUID();
  const clientId = randomUUID();
  const spouseId = randomUUID();
  const prospectOneId = randomUUID();
  const prospectTwoId = randomUUID();
  const templateId = randomUUID();
  const formTemplateId = randomUUID();
  const submissionId = randomUUID();
  const exportId = randomUUID();
  const documentUploadId = randomUUID();

  return {
    firms: [{ id: firmId, name: 'Demo Advisory Group', slug: 'demo-advisory-group', createdAt }],
    users: [{
      id: adminId,
      firmId,
      email: 'admin@demo.test',
      passwordHash: hash('ChangeMe123!'),
      firstName: 'Demo',
      lastName: 'Admin',
      role: 'admin',
      mfa: { enabled: false, totpSecret: null, backupCodes: [] },
      createdAt
    }],
    sessions: [],
    csrfTokens: [],
    profiles: [
      {
        id: clientId,
        firmId,
        advisorUserId: adminId,
        kind: 'client',
        firstName: 'Morgan',
        lastName: 'Taylor',
        email: 'morgan@example.com',
        phone: '555-000-1111',
        dateOfBirth: '1981-04-12',
        source: { cityOrLocation: 'Dallas', venue: 'Referral', occurredOn: '2026-03-01', displayValue: sourceDisplay({ cityOrLocation: 'Dallas', venue: 'Referral', occurredOn: '2026-03-01' }) },
        address: { city: 'Dallas', state: 'TX' },
        customProfile: { investableAssets: 850000 },
        householdId,
        spouseClientId: spouseId,
        createdAt,
        updatedAt: createdAt
      },
      {
        id: spouseId,
        firmId,
        advisorUserId: adminId,
        kind: 'client',
        firstName: 'Jamie',
        lastName: 'Taylor',
        email: 'jamie@example.com',
        phone: '555-000-2222',
        dateOfBirth: '1982-10-21',
        address: { city: 'Dallas', state: 'TX' },
        customProfile: {},
        householdId,
        spouseClientId: clientId,
        createdAt,
        updatedAt: createdAt
      },
      {
        id: prospectOneId,
        firmId,
        advisorUserId: adminId,
        kind: 'prospect',
        firstName: 'Casey',
        lastName: 'Jordan',
        email: 'casey@example.com',
        phone: '555-111-3333',
        stage: 'discovery',
        stageOrderIndex: 1,
        pipelineVersion: 1,
        source: { cityOrLocation: 'Austin', venue: 'Seminar', occurredOn: '2026-03-10', displayValue: sourceDisplay({ cityOrLocation: 'Austin', venue: 'Seminar', occurredOn: '2026-03-10' }) },
        address: { city: 'Austin', state: 'TX' },
        customProfile: {},
        createdAt,
        updatedAt: createdAt
      },
      {
        id: prospectTwoId,
        firmId,
        advisorUserId: adminId,
        kind: 'prospect',
        firstName: 'Riley',
        lastName: 'Carter',
        email: 'riley@example.com',
        phone: '555-111-4444',
        stage: 'analysis',
        stageOrderIndex: 1,
        pipelineVersion: 1,
        source: { cityOrLocation: 'Houston', venue: 'CPA Referral', occurredOn: '2026-03-15', displayValue: sourceDisplay({ cityOrLocation: 'Houston', venue: 'CPA Referral', occurredOn: '2026-03-15' }) },
        address: { city: 'Houston', state: 'TX' },
        customProfile: {},
        createdAt,
        updatedAt: createdAt
      }
    ],
    households: [{ id: householdId, firmId, name: 'Taylor Household', primaryClientId: clientId, createdAt }],
    householdMembers: [
      { householdId, clientId, role: 'primary', firmId, createdAt },
      { householdId, clientId: spouseId, role: 'spouse', firmId, createdAt }
    ],
    stageChanges: [
      { id: randomUUID(), firmId, clientId: prospectOneId, toStage: 'discovery', changedByUserId: adminId, changedAt: createdAt },
      { id: randomUUID(), firmId, clientId: prospectTwoId, toStage: 'analysis', changedByUserId: adminId, changedAt: createdAt }
    ],
    auditEvents: [
      { id: randomUUID(), firmId, actorUserId: adminId, entityType: 'seed', entityId: 'initial', action: 'seed.created', occurredAt: createdAt, metadata: {} }
    ],
    formTemplates: [{
      id: formTemplateId,
      firmId,
      name: 'Financial Discovery',
      description: 'Core onboarding discovery form',
      sections: [
        { id: randomUUID(), title: 'Household', fields: [{ key: 'goals', label: 'Goals', type: 'textarea' }, { key: 'riskTolerance', label: 'Risk Tolerance', type: 'select', options: ['Conservative','Moderate','Aggressive'] }] },
        { id: randomUUID(), title: 'Assets', repeatable: true, fields: [{ key: 'accountName', label: 'Account Name', type: 'text' }, { key: 'value', label: 'Value', type: 'number' }] }
      ],
      createdAt,
      updatedAt: createdAt
    }],
    formSubmissions: [{
      id: submissionId,
      firmId,
      clientId,
      templateId: formTemplateId,
      status: 'submitted',
      data: { goals: 'Retire at 60', riskTolerance: 'Moderate', assets: [{ accountName: '401k', value: 450000 }] },
      createdAt,
      updatedAt: createdAt
    }],
    documentTemplates: [{
      id: templateId,
      firmId,
      name: 'Client Intake PDF Template',
      fileName: 'client-intake.pdf',
      blueprint: { sections: ['client', 'household', 'assets'] },
      mappings: [{ pdfField: 'client_name', sourcePath: 'profile.firstName' }],
      createdAt,
      updatedAt: createdAt
    }],
    exportJobs: [{ id: exportId, firmId, clientId, templateId, type: 'pdf', status: 'completed', output: { fileName: 'client-intake-demo.json', object: { bucket: defaultObjectStorage.bucketExports, key: `${firmId}/exports/client-intake-demo.json`, checksum: null, contentType: 'application/json', retentionClass: 'export_artifact' } }, createdAt, updatedAt: createdAt }],
    documentUploads: [{
      id: documentUploadId,
      firmId,
      clientId,
      name: 'Driver License - Morgan',
      category: 'identification',
      visibility: 'shared',
      status: 'uploaded',
      uploadedBy: 'advisor',
      object: { bucket: defaultObjectStorage.bucketDocuments, key: `${firmId}/documents/${clientId}/driver-license-demo.pdf`, checksum: null, contentType: 'application/pdf', retentionClass: 'uploaded_document' },
      createdAt,
      updatedAt: createdAt
    }],
    pendingUploadIntents: [],
    notes: [{ id: randomUUID(), firmId, profileId: prospectOneId, body: 'Follow up after workshop and confirm beneficiary details.', createdByUserId: adminId, createdAt }],
    invites: [],
    passwordResets: [],
    passwordResetAttempts: [],
    portalLinks: [],
    authAttempts: [],
    mfaChallenges: [],
    mfaEnrollments: []
    boardVersions: { [firmId]: 1 }
  };
}

export function createStore(options = {}) {
  const state = loadState(seedState);
  const piiCrypto = new PiiCryptoService({
    keyProvider: createKeyProvider(runtime, { kmsAdapter: options.kmsAdapter }),
    legacyKeyId: process.env.PII_LEGACY_KEY_ID || 'legacy-app-secret-v1'
  });
export function createStore({ objectStorage = defaultObjectStorage } = {}) {
  const state = loadState(seedState);
  if (!Array.isArray(state.csrfTokens)) state.csrfTokens = [];
  migrateTemplateSystems(state);
  saveState(state);

  function persist() {
    migrateTemplateSystems(state);
  state.pendingUploadIntents ||= [];

  function normalizeObjectMetadata(metadata = {}, defaultRetentionClass = 'uploaded_document') {
    return {
      bucket: metadata.bucket,
      key: metadata.key,
      checksum: metadata.checksum || null,
      contentType: metadata.contentType || 'application/octet-stream',
      retentionClass: metadata.retentionClass || defaultRetentionClass
    };
  }

  function createUploadIntent({ firmId, clientId, fileName, contentType, checksum, category, source }) {
    const id = randomUUID();
    const key = `${firmId}/documents/${clientId}/${Date.now()}-${id}-${sanitizeFileName(fileName || 'upload.bin')}`;
    const object = normalizeObjectMetadata({
      bucket: objectStorage.bucketDocuments,
      key,
      checksum: checksum || null,
      contentType: contentType || 'application/octet-stream',
      retentionClass: 'uploaded_document'
    });
    const intent = {
      id,
      firmId,
      clientId,
      category: category || 'general',
      source: source || 'client',
      fileName: fileName || 'upload.bin',
      object,
      createdAt: now(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    };
    state.pendingUploadIntents.push(intent);
    return intent;
  }

  async function applyLifecyclePolicies() {
    const policy = objectStorage.retentionPolicies;
    const nowMs = Date.now();

    for (const upload of state.documentUploads) {
      const object = upload.object;
      if (!object?.bucket || !object?.key) continue;
      const ageDays = daysBetween(upload.createdAt, nowMs);
      if (ageDays >= policy.uploaded_document.purgeAfterDays) {
        await objectStorage.deleteObject(object).catch(() => null);
        upload.status = 'purged';
        upload.purgedAt = now();
      } else if (ageDays >= policy.uploaded_document.archiveAfterDays && upload.status !== 'archived') {
        upload.status = 'archived';
        upload.archivedAt = now();
      }
    }

    for (const job of state.exportJobs) {
      const object = job.output?.object;
      if (!object?.bucket || !object?.key) continue;
      const ageDays = daysBetween(job.updatedAt || job.createdAt, nowMs);
      if (ageDays >= policy.export_artifact.purgeAfterDays) {
        await objectStorage.deleteObject(object).catch(() => null);
        job.status = job.status === 'completed' ? 'purged' : job.status;
        job.output = { ...job.output, purgedAt: now() };
      } else if (ageDays >= policy.export_artifact.archiveAfterDays && !job.output.archivedAt) {
        job.output = { ...job.output, archivedAt: now() };
      }
    }

    persist();
  }
  let testHooks = {};

  function persist() {
    if (typeof testHooks.beforePersist === 'function') {
      testHooks.beforePersist(state);
    }
    saveState(state);
  }

  function getBoardVersion(firmId) {
    if (!state.boardVersions || typeof state.boardVersions !== 'object') {
      state.boardVersions = {};
    }
    if (!state.boardVersions[firmId]) {
      state.boardVersions[firmId] = 1;
    }
    return state.boardVersions[firmId];
  }

  function bumpBoardVersion(firmId) {
    const current = getBoardVersion(firmId);
    state.boardVersions[firmId] = current + 1;
    return state.boardVersions[firmId];
  }

  function listProspectsByStage(firmId, stage, excludedProfileId = null) {
    return state.profiles
      .filter((profile) => profile.firmId === firmId && profile.kind === 'prospect' && profile.stage === stage && profile.id !== excludedProfileId)
      .sort((a, b) => {
        const indexDiff = (a.stageOrderIndex || Number.MAX_SAFE_INTEGER) - (b.stageOrderIndex || Number.MAX_SAFE_INTEGER);
        if (indexDiff !== 0) return indexDiff;
        const updatedDiff = new Date(a.updatedAt || a.createdAt || 0).getTime() - new Date(b.updatedAt || b.createdAt || 0).getTime();
        if (updatedDiff !== 0) return updatedDiff;
        return a.id.localeCompare(b.id);
      });
  }

  function compactStageIndices(firmId, stage) {
    const cards = listProspectsByStage(firmId, stage);
    let changed = false;
    cards.forEach((card, index) => {
      const nextIndex = index + 1;
      if (card.stageOrderIndex !== nextIndex) {
        card.stageOrderIndex = nextIndex;
        changed = true;
      }
    });
    return changed;
  }

  function normalizePipelineIndices(firmId, stage = null) {
    const stages = stage ? [stage] : BOARD_COLUMNS;
    const normalizedStages = [];
    for (const currentStage of stages) {
      if (compactStageIndices(firmId, currentStage)) {
        normalizedStages.push(currentStage);
      }
    }
    return normalizedStages;
  }

  function buildBoardPayload(user, conflict = null) {
    const columns = BOARD_COLUMNS.map((stage) => ({
      stage,
      orderingVersion: getBoardVersion(user.firmId),
      cards: listProspectsByStage(user.firmId, stage)
    }));
    return {
      boardVersion: getBoardVersion(user.firmId),
      generatedAt: now(),
      ordering: {
        mode: 'sequential_stage_index',
        normalized: true
      },
      conflict,
      columns
    };
  }

  function executePipelineTransaction(mutator) {
    const snapshot = {
      profiles: state.profiles.map((profile) => ({ ...profile })),
      stageChangesLength: state.stageChanges.length,
      auditEventsLength: state.auditEvents.length,
      boardVersions: { ...(state.boardVersions || {}) }
    };
    try {
      const result = mutator();
      persist();
      return result;
    } catch (error) {
      state.profiles = snapshot.profiles;
      state.stageChanges = state.stageChanges.slice(0, snapshot.stageChangesLength);
      state.auditEvents = state.auditEvents.slice(0, snapshot.auditEventsLength);
      state.boardVersions = snapshot.boardVersions;
      throw error;
    }
  }

  function createSession(user) {
    const token = randomUUID();
    state.sessions.push({ token, userId: user.id, firmId: user.firmId, createdAt: now(), expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
    persist();
    return { token, user: publicUser(user) };
  }

  function pruneExpiredCsrfTokens(persistChanges = true) {
    const cutoff = Date.now();
    const activeSessionTokens = new Set(state.sessions.map((entry) => entry.token));
    const nextTokens = state.csrfTokens.filter((entry) => {
      const expiresAt = new Date(entry.expiresAt).getTime();
      return activeSessionTokens.has(entry.sessionToken) && Number.isFinite(expiresAt) && expiresAt > cutoff;
    });
    if (nextTokens.length !== state.csrfTokens.length) {
      state.csrfTokens = nextTokens;
      if (persistChanges) persist();
    }
  }

  function pruneExpiredSessions() {
    const cutoff = Date.now();
    const nextSessions = state.sessions.filter((entry) => new Date(entry.expiresAt).getTime() > cutoff);
    if (nextSessions.length !== state.sessions.length) {
      state.sessions = nextSessions;
      pruneExpiredCsrfTokens(false);
      persist();
    }
  }

  function publicUser(user) {
    return { id: user.id, firmId: user.firmId, email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.role };
  }

  function requireUser(token) {
    pruneExpiredSessions();
    const session = state.sessions.find((entry) => entry.token === token);
    if (!session) throw new Error('Authentication required.');
    const user = state.users.find((entry) => entry.id === session.userId && entry.firmId === session.firmId);
    if (!user) throw new Error('Authentication required.');
    return publicUser(user);
  }

  function assertFirmScopedRecord(record, user, entityName = 'Record') {
    if (!record) throw new Error(`${entityName} not found.`);
    if (record.firmId && record.firmId !== user.firmId) {
      throw new Error(`${entityName} not found.`);
    }
    return record;
  }

  function requireFirmProfile(user, profileId, entityName = 'Profile') {
    const profile = state.profiles.find((entry) => entry.id === profileId);
    return assertFirmScopedRecord(profile, user, entityName);
  }

  function requireFirmHousehold(user, householdId, entityName = 'Household') {
    const household = state.households.find((entry) => entry.id === householdId);
    return assertFirmScopedRecord(household, user, entityName);
  }

  function requireFirmTemplate(user, templateId, entityName = 'Template') {
    const template = state.formTemplates.find((entry) => entry.id === templateId);
    return assertFirmScopedRecord(template, user, entityName);
  }

  function addAudit(firmId, actorUserId, entityType, entityId, action, metadata = {}) {
  function addAudit(firmId, actorUserId, entityType, entityId, action, metadata = {}, options = {}) {
    state.auditEvents.push({ id: randomUUID(), firmId, actorUserId, entityType, entityId, action, occurredAt: now(), metadata });
    if (options.persist !== false) {
      persist();
    }
  }

  function ensureSubmissionWithTemplate(user, submissionId) {
    const submission = state.formSubmissions.find((entry) => entry.id === submissionId && entry.firmId === user.firmId);
    if (!submission) {
      throw createStoreError('Submission not found.', { statusCode: 404, code: 'SUBMISSION_NOT_FOUND' });
    }
    const template = state.formTemplates.find((entry) => entry.id === submission.templateId && entry.firmId === user.firmId);
    if (!template) {
      throw createStoreError('Form template not found.', { statusCode: 404, code: 'FORM_TEMPLATE_NOT_FOUND' });
    }
    return { submission, template };
  }

  function resolveRepeatableSection(template, sectionKey) {
    const key = normalizeSectionKey(sectionKey);
    const section = (template.sections || []).find((entry) => {
      return entry.repeatable && (
        normalizeSectionKey(entry.key) === key
        || normalizeSectionKey(entry.title) === key
        || normalizeSectionKey(entry.id) === key
      );
    });
    if (!section) {
      throw createStoreError('Repeatable section not found.', { statusCode: 404, code: 'REPEATABLE_SECTION_NOT_FOUND', details: { sectionKey } });
    }
    const dataPath = normalizeSectionKey(section.key || section.title || section.id || sectionKey);
    return { section, dataPath };
  }

  function ensureRepeatableArray(submission, dataPath) {
    if (!Array.isArray(submission.data[dataPath])) {
      submission.data[dataPath] = [];
    }
    submission.data[dataPath] = submission.data[dataPath].map((entry) => {
      if (entry && typeof entry === 'object' && entry[ITEM_KEY_FIELD]) return entry;
      return { ...(entry || {}), [ITEM_KEY_FIELD]: randomUUID() };
    });
    return submission.data[dataPath];
  }

  function validateItem(section, item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw createStoreError('Item payload must be an object.', { code: 'VALIDATION_ERROR', details: { path: 'item' } });
    }
    const allowedFields = new Set((section.fields || []).map((field) => field.key));
    const submittedFields = Object.keys(item).filter((key) => key !== ITEM_KEY_FIELD);
    const invalidFields = submittedFields.filter((key) => !allowedFields.has(key));
    if (invalidFields.length) {
      throw createStoreError('Item payload contains unknown fields.', {
        code: 'VALIDATION_ERROR',
        details: { invalidFields, allowedFields: Array.from(allowedFields) }
      });
    }
  }

  function ensureSubmissionRepeatableItemKeys(submission) {
    const template = state.formTemplates.find((entry) => entry.id === submission.templateId && entry.firmId === submission.firmId);
    if (!template) return;
    let changed = false;
    (template.sections || []).forEach((section) => {
      if (!section.repeatable) return;
      const dataPath = normalizeSectionKey(section.key || section.title || section.id);
      const items = submission.data?.[dataPath];
      if (!Array.isArray(items)) return;
      submission.data[dataPath] = items.map((entry) => {
        if (entry && typeof entry === 'object' && entry[ITEM_KEY_FIELD]) return entry;
        changed = true;
        return { ...(entry || {}), [ITEM_KEY_FIELD]: randomUUID() };
      });
    });
    if (changed) {
      submission.updatedAt = now();
      persist();
    }
  }

  function requireClientProfile(user) {
    authorize(user, 'portal:read');
    const profile = state.profiles.find((entry) =>
      entry.firmId === user.firmId
      && entry.kind === 'client'
      && entry.email
      && entry.email.toLowerCase() === user.email.toLowerCase()
    );
    if (!profile) throw new Error('Client profile not found.');
    return profile;
  }

  function createAuthProvider() {
    const localProvider = createLocalAuthProvider({ state, persist, createSession, addAudit });
    if (runtime.authProvider === 'local') {
      return localProvider;
    }
    if (runtime.authProvider === 'oidc') {
      return createOidcAuthProvider({ state, persist, createSession, addAudit, fallbackProvider: localProvider });
    }
    if (runtime.authProvider === 'saml') {
      return createSamlAuthProvider({ state, persist, createSession, addAudit, fallbackProvider: localProvider });
    }
    return localProvider;
  }

  const auth = createAuthService({ provider: createAuthProvider() });

  function getSensitivePolicy(role, purpose = 'profile_view') {
    return SENSITIVE_ACCESS_POLICY[role]?.[purpose] || null;
  }

  function maskSsn(value) {
    return value ? `***-**-${value.slice(-4)}` : null;
  }

  function maskTaxId(value) {
    return value ? `**-${value.slice(-4)}` : null;
  }

  function readSensitiveRecord(profile, field) {
    if (!profile?.pii) return null;
    const envelopeField = `${field}Encrypted`;
    if (profile.pii[envelopeField]) return profile.pii[envelopeField];
    const legacyField = `${field}Ciphertext`;
    return profile.pii[legacyField] || null;
  }

  function writeSensitiveRecord(profile, field, value) {
    profile.pii ||= { maskingPolicy: 'role_based' };
    profile.pii[`${field}Encrypted`] = piiCrypto.encrypt(value);
    delete profile.pii[`${field}Ciphertext`];
  }

  function reencryptProfilePii(profile) {
    if (!profile?.pii) return { changed: false, fields: [] };
    const fields = ['ssn', 'taxId'];
    const changedFields = [];
    fields.forEach((field) => {
      const current = readSensitiveRecord(profile, field);
      if (!current) return;
      if (!piiCrypto.needsReencryption(current)) {
        if (typeof current === 'string') {
          profile.pii[`${field}Encrypted`] = piiCrypto.encrypt(piiCrypto.decrypt(current));
          delete profile.pii[`${field}Ciphertext`];
          changedFields.push(field);
        }
        return;
      }
      profile.pii[`${field}Encrypted`] = piiCrypto.reencrypt(current);
      delete profile.pii[`${field}Ciphertext`];
      changedFields.push(field);
    });
    return { changed: changedFields.length > 0, fields: changedFields };
  }

  return {
    state,
    policyMatrix: ROLE_POLICY_MATRIX,
    assertPermission(user, permission) {
      authorize(user, permission);
      return true;
    },
    auth,
    register(input) {
      return auth.register(input);
    },
    login(input) {
      return auth.login(input);
    },
    startTotpEnrollment(user) {
      return auth.startTotpEnrollment(user);
    },
    confirmTotpEnrollment(user, input) {
      return auth.confirmTotpEnrollment(user, input);
    },
    createMfaChallenge(user) {
      return auth.createMfaChallenge(user);
    },
    verifyMfaChallenge(user, input) {
      return auth.verifyMfaChallenge(user, input);
    },
    rotateBackupCodes(user) {
      return auth.rotateBackupCodes(user);
    },
    requireUser,
    getSession(token) {
      pruneExpiredSessions();
      const session = state.sessions.find((entry) => entry.token === token);
      if (!session) return null;
      return { ...session };
    },
    issueCsrfToken(sessionToken) {
      pruneExpiredSessions();
      const session = state.sessions.find((entry) => entry.token === sessionToken);
      if (!session) throw new Error('Authentication required.');
      const issuedAt = now();
      const record = {
        id: randomUUID(),
        sessionToken,
        token: randomUUID(),
        issuedAt,
        expiresAt: new Date(Date.now() + CSRF_TOKEN_TTL_MS).toISOString()
      };
      state.csrfTokens = state.csrfTokens.filter((entry) => entry.sessionToken !== sessionToken);
      state.csrfTokens.push(record);
      persist();
      return { ...record };
    },
    validateCsrfToken(sessionToken, csrfTokenId, csrfToken) {
      pruneExpiredSessions();
      const session = state.sessions.find((entry) => entry.token === sessionToken);
      if (!session) {
        return { ok: false, reason: 'Missing or expired authenticated session.' };
      }
      const record = state.csrfTokens.find((entry) => entry.sessionToken === sessionToken && entry.id === csrfTokenId);
      if (!record) {
        return { ok: false, reason: 'Missing CSRF session.' };
      }
      if (new Date(record.expiresAt).getTime() <= Date.now()) {
        state.csrfTokens = state.csrfTokens.filter((entry) => entry.id !== record.id);
        persist();
        return { ok: false, reason: 'Stale CSRF token.' };
      }
      if (!csrfToken || record.token !== csrfToken) {
        return { ok: false, reason: 'Invalid or missing CSRF token.' };
      }
      const nextToken = {
        id: randomUUID(),
        sessionToken,
        token: randomUUID(),
        issuedAt: now(),
        expiresAt: new Date(Date.now() + CSRF_TOKEN_TTL_MS).toISOString()
      };
      state.csrfTokens = state.csrfTokens.filter((entry) => entry.sessionToken !== sessionToken);
      state.csrfTokens.push(nextToken);
      persist();
      return { ok: true, nextToken };
    },
    _internal: { piiCrypto },
    getDashboard(user) {
      authorize(user, 'profiles:read');
      const profiles = state.profiles.filter((profile) => profile.firmId === user.firmId);
      const prospects = profiles.filter((profile) => profile.kind === 'prospect');
      const clients = profiles.filter((profile) => profile.kind === 'client');
      return {
        firm: state.firms.find((firm) => firm.id === user.firmId),
        stats: {
          totalProfiles: profiles.length,
          prospects: prospects.length,
          clients: clients.length,
          households: state.households.filter((household) => household.firmId === user.firmId).length,
          forms: state.formSubmissions.filter((submission) => submission.firmId === user.firmId).length,
          exports: state.exportJobs.filter((job) => job.firmId === user.firmId).length
        },
        recentProfiles: profiles.slice(-5).reverse(),
        recentAuditEvents: state.auditEvents.filter((event) => event.firmId === user.firmId).slice(-10).reverse()
      };
    },
    listProfiles(user, kind, search = '') {
      authorize(user, 'profiles:read');
      const q = String(search || '').toLowerCase();
      return state.profiles
        .filter((profile) => profile.firmId === user.firmId)
        .filter((profile) => !kind || profile.kind === kind)
        .filter((profile) => !q || `${profile.firstName} ${profile.lastName} ${profile.email || ''}`.toLowerCase().includes(q))
        .sort((a, b) => (a.stage === b.stage ? (a.stageOrderIndex || 0) - (b.stageOrderIndex || 0) : a.lastName.localeCompare(b.lastName)));
    },
    getProfileDetail(user, profileId) {
      authorize(user, 'profiles:read');
      const profile = state.profiles.find((entry) => entry.id === profileId && entry.firmId === user.firmId);
      if (!profile) throw new Error('Profile not found.');
      const household = profile.householdId ? state.households.find((entry) => entry.id === profile.householdId && entry.firmId === user.firmId) : null;
      const householdMembers = household ? state.householdMembers.filter((entry) => entry.householdId === household.id && entry.firmId === user.firmId) : [];
      const submissions = state.formSubmissions.filter((entry) => entry.clientId === profile.id && entry.firmId === user.firmId);
      submissions.forEach(ensureSubmissionRepeatableItemKeys);
      const stageHistory = state.stageChanges.filter((entry) => entry.clientId === profile.id && entry.firmId === user.firmId);
      const notes = state.notes.filter((entry) => entry.profileId === profile.id && entry.firmId === user.firmId).slice().reverse();
      return { profile, household, householdMembers, submissions, stageHistory, notes };
    },
    createProfile(user, input) {
      authorize(user, 'profiles:write');
      if (input.householdId) requireFirmHousehold(user, input.householdId);
      if (input.spouseClientId) requireFirmProfile(user, input.spouseClientId);
      const createdAt = now();
      const inStage = state.profiles.filter((profile) => profile.firmId === user.firmId && profile.kind === 'prospect' && profile.stage === (input.stage || 'discovery')).length;
      const profile = {
        pii: { maskingPolicy: 'role_based', ssnEncrypted: piiCrypto.encrypt(input.ssn), taxIdEncrypted: piiCrypto.encrypt(input.taxId) },
        id: randomUUID(),
        firmId: user.firmId,
        advisorUserId: user.id,
        kind: input.kind,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email || '',
        phone: input.phone || '',
        dateOfBirth: input.dateOfBirth || '',
        source: input.source ? { ...input.source, displayValue: sourceDisplay(input.source) } : null,
        stage: input.kind === 'prospect' ? input.stage || 'discovery' : null,
        stageOrderIndex: input.kind === 'prospect' ? inStage + 1 : null,
        pipelineVersion: input.kind === 'prospect' ? 1 : null,
        address: input.address || {},
        customProfile: input.customProfile || {},
        householdId: input.householdId || null,
        spouseClientId: input.spouseClientId || null,
        createdAt,
        updatedAt: createdAt
      };
      state.profiles.push(profile);
      if (profile.stage) {
        state.stageChanges.push({ id: randomUUID(), firmId: user.firmId, clientId: profile.id, toStage: profile.stage, changedByUserId: user.id, changedAt: createdAt });
      }
      addAudit(user.firmId, user.id, 'profile', profile.id, 'profile.created', { kind: profile.kind });
      persist();
      return profile;
    },
    updateProfile(user, profileId, patch) {
      authorize(user, 'profiles:write');
      if (patch.kind === 'client') { patch.stage = null; patch.stageOrderIndex = null; }
      if (patch.kind === 'prospect' && !patch.stage) { patch.stage = 'discovery'; }
      const profile = state.profiles.find((entry) => entry.id === profileId && entry.firmId === user.firmId);
      if (!profile) throw new Error('Profile not found.');
      const nextPatch = { ...patch };
      if ('ssn' in nextPatch) {
        writeSensitiveRecord(profile, 'ssn', nextPatch.ssn);
        delete nextPatch.ssn;
      }
      if ('taxId' in nextPatch) {
        writeSensitiveRecord(profile, 'taxId', nextPatch.taxId);
        delete nextPatch.taxId;
      }
      Object.assign(profile, nextPatch, { updatedAt: now() });
      addAudit(user.firmId, user.id, 'profile', profileId, 'profile.updated', { fields: Object.keys(patch) });
      persist();
      return profile;
    },
    moveProfileStage(user, profileId, stage, beforeProfileId = null) {
      authorize(user, 'pipeline:write');
      const profile = state.profiles.find((entry) => entry.id === profileId && entry.firmId === user.firmId);
      if (!profile) throw new Error('Profile not found.');
      const sameStage = state.profiles.filter((entry) => entry.firmId === user.firmId && entry.kind === 'prospect' && entry.stage === stage && entry.id !== profileId).sort((a,b)=>(a.stageOrderIndex||0)-(b.stageOrderIndex||0));
      const previousStage = profile.stage || null;
      let nextIndex = sameStage.length + 1;
      if (beforeProfileId) {
        const before = sameStage.find((entry) => entry.id === beforeProfileId);
        if (before) {
          nextIndex = before.stageOrderIndex || 1;
          sameStage.filter((entry) => (entry.stageOrderIndex || 0) >= nextIndex).forEach((entry) => { entry.stageOrderIndex = (entry.stageOrderIndex || 0) + 1; });
      return this.reorderBoard(user, { profileId, toStage: stage, beforeProfileId });
    },
    reorderBoard(user, input) {
      requirePermission(user, 'pipeline:write');
      const { profileId, toStage, beforeProfileId = null, expectedVersion = null, expectedUpdatedAt = null, expectedBoardVersion = null } = input || {};
      if (!profileId || !toStage) {
        throw new Error('Reorder payload must include profileId and toStage.');
      }
      if (!BOARD_COLUMNS.includes(toStage)) {
        throw new Error(`Unknown stage: ${toStage}.`);
      }

      try {
        return executePipelineTransaction(() => {
          const profile = state.profiles.find((entry) => entry.id === profileId && entry.firmId === user.firmId);
          if (!profile) throw new Error('Profile not found.');

          const currentVersion = Number(profile.pipelineVersion || 1);
          if (expectedVersion !== null && Number(expectedVersion) !== currentVersion) {
            throw pipelineConflict('Profile ordering version mismatch.', {
              profileId,
              expectedVersion: Number(expectedVersion),
              actualVersion: currentVersion,
              profileUpdatedAt: profile.updatedAt
            });
          }
          if (expectedUpdatedAt && String(expectedUpdatedAt) !== String(profile.updatedAt)) {
            throw pipelineConflict('Profile updatedAt mismatch.', {
              profileId,
              expectedUpdatedAt,
              actualUpdatedAt: profile.updatedAt
            });
          }
          const boardVersion = getBoardVersion(user.firmId);
          if (expectedBoardVersion !== null && Number(expectedBoardVersion) !== Number(boardVersion)) {
            throw pipelineConflict('Board version mismatch.', {
              expectedBoardVersion: Number(expectedBoardVersion),
              actualBoardVersion: Number(boardVersion)
            });
          }

          const destinationCards = listProspectsByStage(user.firmId, toStage, profile.id);
          let insertIndex = destinationCards.length;
          if (beforeProfileId) {
            insertIndex = destinationCards.findIndex((entry) => entry.id === beforeProfileId);
            if (insertIndex < 0) {
              throw new Error('beforeProfileId was not found in the destination stage.');
            }
          }

          const previousStage = profile.stage || null;
          const movedAt = now();
          profile.kind = 'prospect';
          profile.stage = toStage;
          profile.updatedAt = movedAt;
          profile.pipelineVersion = currentVersion + 1;

          destinationCards.splice(insertIndex, 0, profile);
          destinationCards.forEach((card, index) => {
            card.stageOrderIndex = index + 1;
          });

          if (previousStage && previousStage !== toStage) {
            compactStageIndices(user.firmId, previousStage);
          }

          normalizePipelineIndices(user.firmId, toStage);
          const normalized = normalizePipelineIndices(user.firmId, previousStage);
          if (normalized.length > 0) {
            addAudit(user.firmId, user.id, 'pipeline', profile.id, 'pipeline.indices_normalized', { stages: normalized }, { persist: false });
          }
          bumpBoardVersion(user.firmId);
          state.stageChanges.push({ id: randomUUID(), firmId: user.firmId, clientId: profile.id, fromStage: previousStage, toStage, changedByUserId: user.id, changedAt: movedAt });
          addAudit(user.firmId, user.id, 'profile', profile.id, 'pipeline.stage_changed', { fromStage: previousStage, toStage, beforeProfileId }, { persist: false });
          return {
            moved: profile,
            board: buildBoardPayload(user),
            conflict: null
          };
        });
      } catch (error) {
        if (error?.code === 'PIPELINE_ORDER_CONFLICT') {
          error.details = {
            ...(error.details || {}),
            serverBoard: buildBoardPayload(user, {
              code: error.code,
              message: error.message
            })
          };
        }
        throw error;
      }
    },
    normalizeBoardOrdering(user) {
      requirePermission(user, 'pipeline:write');
      return executePipelineTransaction(() => {
        const normalizedStages = normalizePipelineIndices(user.firmId);
        if (normalizedStages.length > 0) {
          bumpBoardVersion(user.firmId);
          addAudit(user.firmId, user.id, 'pipeline', user.firmId, 'pipeline.indices_normalized', { stages: normalizedStages }, { persist: false });
        }
        return {
          normalizedStages,
          board: buildBoardPayload(user),
          changed: normalizedStages.length > 0
        };
      });
    },
    getBoard(user) {
      authorize(user, 'profiles:read');
      const columns = ['discovery','gather_oi','analysis','advisor_proposal_meeting','intake','on_boarding','investment_strategy','completed','drop_dead_lead','drop_nurture'];
      return columns.map((stage) => ({
        stage,
        cards: state.profiles
          .filter((profile) => profile.firmId === user.firmId && profile.kind === 'prospect' && profile.stage === stage)
          .sort((a, b) => (a.stageOrderIndex || 0) - (b.stageOrderIndex || 0))
      }));
      requirePermission(user, 'profiles:read');
      normalizePipelineIndices(user.firmId);
      return buildBoardPayload(user);
    },
    listStageHistory(user, profileId) {
      authorize(user, 'profiles:read');
      return state.stageChanges.filter((entry) => entry.firmId === user.firmId && entry.clientId === profileId);
    },
    createHousehold(user, input) {
      authorize(user, 'households:write');
      requireFirmProfile(user, input.primaryClientId);
      const household = { id: randomUUID(), firmId: user.firmId, name: input.name, primaryClientId: input.primaryClientId, createdAt: now() };
      state.households.push(household);
      state.householdMembers.push({ householdId: household.id, clientId: input.primaryClientId, role: 'primary', firmId: user.firmId, createdAt: household.createdAt });
      const profile = state.profiles.find((entry) => entry.id === input.primaryClientId && entry.firmId === user.firmId);
      if (profile) profile.householdId = household.id;
      addAudit(user.firmId, user.id, 'household', household.id, 'household.created', { name: household.name });
      persist();
      return household;
    },
    addHouseholdMember(user, householdId, input) {
      authorize(user, 'households:write');
      const household = requireFirmHousehold(user, householdId);
      requireFirmProfile(user, input.clientId);
      const member = { householdId, clientId: input.clientId, role: input.role, firmId: user.firmId, createdAt: now() };
      state.householdMembers.push(member);
      const profile = state.profiles.find((entry) => entry.id === input.clientId && entry.firmId === user.firmId);
      if (profile) profile.householdId = householdId;
      addAudit(user.firmId, user.id, 'household', householdId, 'household.member_added', input);
      persist();
      return member;
    },
    listHouseholds(user) {
      authorize(user, 'profiles:read');
      return state.households.filter((entry) => entry.firmId === user.firmId).map((household) => ({
        ...household,
        members: state.householdMembers.filter((member) => member.firmId === user.firmId && member.householdId === household.id)
      }));
    },
    listNotes(user, profileId) {
      authorize(user, 'profiles:read');
      return state.notes.filter((entry) => entry.firmId === user.firmId && entry.profileId === profileId).slice().reverse();
    },
    addNote(user, profileId, body) {
      authorize(user, 'profiles:write');
      const profile = requireFirmProfile(user, profileId);
      const note = { id: randomUUID(), firmId: user.firmId, profileId, body, createdByUserId: user.id, createdAt: now() };
      state.notes.push(note);
      addAudit(user.firmId, user.id, 'profile_note', note.id, 'profile.note_added', { profileId });
      persist();
      return note;
    },
    listFormTemplates(user) {
      authorize(user, 'profiles:read');
      return state.formTemplates.filter((entry) => entry.firmId === user.firmId);
    },
    createFormTemplate(user, input) {
      authorize(user, 'forms:write');
      const template = { id: randomUUID(), firmId: user.firmId, name: input.name, description: input.description || '', sections: input.sections || [], createdAt: now(), updatedAt: now() };
      state.formTemplates.push(template);
      addAudit(user.firmId, user.id, 'form_template', template.id, 'form_template.created', { name: template.name });
      requirePermission(user, 'profiles:read');
      return state.templateAggregates
        .filter((entry) => entry.firmId === user.firmId && entry.kind === 'form')
        .map((entry) => ({
          id: entry.id,
          firmId: entry.firmId,
          name: entry.name,
          description: entry.description || '',
          sections: entry.formSchema?.sections || [],
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt
        }));
    },
    createFormTemplate(user, input) {
      requirePermission(user, 'forms:write');
      const createdAt = now();
      const template = normalizeTemplateAggregate({
        id: randomUUID(),
        firmId: user.firmId,
        kind: 'form',
        name: input.name,
        description: input.description || '',
        documentMetadata: { fileName: null },
        extractedFields: [],
        formSchema: { sections: input.sections || [] },
        blueprint: { sections: [] },
        mappings: [],
        publishState: 'draft',
        versions: [{
          version: 1,
          event: 'created',
          blueprint: { sections: [] },
          mappings: [],
          formSchema: { sections: input.sections || [] },
          publishState: 'draft',
          createdAt
        }],
        publishTransitions: [],
        createdAt,
        updatedAt: createdAt
      }, 'form');
      state.templateAggregates.push(template);
      addAudit(user.firmId, user.id, 'template_aggregate', template.id, 'form_template.created', { name: template.name });
      persist();
      return { id: template.id, firmId: template.firmId, name: template.name, description: template.description, sections: template.formSchema.sections, createdAt, updatedAt: createdAt };
    },
    listFormSubmissions(user, status = null) {
      authorize(user, 'profiles:read');
      requirePermission(user, 'profiles:read');
      const submissions = state.formSubmissions
      const currentTime = Date.now();
      return state.formSubmissions
        .filter((entry) => entry.firmId === user.firmId)
        .filter((entry) => !status || entry.status === status)
        .map((entry) => {
          if (entry.lock && parseIso(entry.lock.expiresAt) <= currentTime) {
            return { ...entry, lock: null };
          }
          return entry;
        })
        .slice()
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
      submissions.forEach(ensureSubmissionRepeatableItemKeys);
      return submissions;
    },
    getClientWorkspace(user) {
      const profile = requireClientProfile(user);
      const submissions = state.formSubmissions
        .filter((entry) => entry.firmId === user.firmId && entry.clientId === profile.id)
        .slice()
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
      const templates = state.templateAggregates
        .filter((entry) => entry.firmId === user.firmId && entry.kind === 'form')
        .map((entry) => ({ id: entry.id, name: entry.name, description: entry.description || '', sections: entry.formSchema?.sections || [] }));
      submissions.forEach(ensureSubmissionRepeatableItemKeys);
      const templates = state.formTemplates
        .filter((entry) => entry.firmId === user.firmId)
        .map((entry) => ({ id: entry.id, name: entry.name, description: entry.description || '', sections: entry.sections || [] }));
      const uploads = state.documentUploads
        .filter((entry) => entry.firmId === user.firmId && entry.clientId === profile.id)
        .slice()
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
      const submissionByTemplate = new Map();
      submissions.forEach((submission) => {
        if (!submissionByTemplate.has(submission.templateId)) submissionByTemplate.set(submission.templateId, submission.status);
      });
      const templateProgress = templates.map((template) => ({
        templateId: template.id,
        templateName: template.name,
        status: submissionByTemplate.get(template.id) || 'not_started'
      }));
      return { profile, submissions, templates, templateProgress, uploads };
    },
    submitClientForm(user, input) {
      authorize(user, 'client:write');
      const profile = requireClientProfile(user);
      requireFirmTemplate(user, input.templateId, 'Form template');
      const template = state.templateAggregates.find((entry) => entry.id === input.templateId && entry.firmId === user.firmId && entry.kind === 'form');
      if (!template) throw new Error('Form template not found.');
      const status = input.status === 'draft' ? 'draft' : 'submitted';
      const submission = {
        id: randomUUID(),
        firmId: user.firmId,
        clientId: profile.id,
        templateId: input.templateId,
        status,
        data: input.data && typeof input.data === 'object' ? input.data : {},
        source: 'client_portal',
        createdByUserId: user.id,
        createdAt: now(),
        updatedAt: now()
      };
      state.formSubmissions.push(submission);
      addAudit(user.firmId, user.id, 'form_submission', submission.id, 'client.form_submission.created', { templateId: input.templateId, status });
      persist();
      return submission;
    },
    async createClientUploadPresign(user, input) {
      requirePermission(user, 'client:write');
      const profile = requireClientProfile(user);
      const intent = createUploadIntent({
        firmId: user.firmId,
        clientId: profile.id,
        fileName: input.fileName,
        contentType: input.contentType,
        checksum: input.checksum,
        category: input.category,
        source: 'client'
      });
      const presigned = await objectStorage.createPresignedUploadUrl({ ...intent.object, expiresInSeconds: Number(input.expiresInSeconds || 900) });
      persist();
      return { uploadId: intent.id, object: intent.object, presigned };
    },
    submitClientUpload(user, input) {
      authorize(user, 'client:write');
      const profile = requireClientProfile(user);
      const intent = input.uploadId ? state.pendingUploadIntents.find((entry) => entry.id === input.uploadId && entry.firmId === user.firmId) : null;
      const object = normalizeObjectMetadata(input.object || intent?.object || {}, 'uploaded_document');
      const upload = {
        id: randomUUID(),
        firmId: user.firmId,
        clientId: profile.id,
        name: input.name || input.fileName || intent?.fileName || 'Client upload',
        category: input.category || intent?.category || 'general',
        visibility: 'shared',
        status: 'uploaded',
        uploadedBy: 'client',
        notes: input.notes || '',
        object,
        createdAt: now(),
        updatedAt: now()
      };
      state.pendingUploadIntents = state.pendingUploadIntents.filter((entry) => entry.id !== input.uploadId);
      state.documentUploads.push(upload);
      addAudit(user.firmId, user.id, 'document_upload', upload.id, 'client.document_upload.created', { category: upload.category, key: upload.object.key });
      persist();
      return upload;
    },
    async createClientUploadDownloadUrl(user, uploadId) {
      requirePermission(user, 'client:write');
      const profile = requireClientProfile(user);
      const upload = state.documentUploads.find((entry) => entry.id === uploadId && entry.firmId === user.firmId && entry.clientId === profile.id);
      if (!upload) throw new Error('Upload not found.');
      return objectStorage.createPresignedDownloadUrl({ ...upload.object, expiresInSeconds: 900 });
    },
    listFormDrafts(user) {
      return this.listFormSubmissions(user, 'draft');
    },
    createFormSubmission(user, input) {
      authorize(user, 'forms:write');
      requireFirmProfile(user, input.clientId);
      requireFirmTemplate(user, input.templateId, 'Form template');
      const submission = { id: randomUUID(), firmId: user.firmId, clientId: input.clientId, templateId: input.templateId, status: input.status || 'draft', data: input.data || {}, createdAt: now(), updatedAt: now() };
      requirePermission(user, 'forms:write');
      const status = input.status || 'draft';
      const createdAt = now();
      const submission = {
        id: randomUUID(),
        firmId: user.firmId,
        clientId: input.clientId,
        templateId: input.templateId,
        status,
        data: input.data || {},
        createdByUserId: user.id,
        createdAt,
        updatedAt: createdAt,
        revisionId: status === 'draft' ? 1 : null,
        lock: null
      };
      state.formSubmissions.push(submission);
      addAudit(user.firmId, user.id, 'form_submission', submission.id, 'form_submission.created', { templateId: input.templateId, clientId: input.clientId });
      persist();
      return submission;
    },
    acquireDraftLock(user, submissionId, input = {}) {
      requirePermission(user, 'forms:write');
      const submission = state.formSubmissions.find((entry) => entry.id === submissionId && entry.firmId === user.firmId && entry.status === 'draft');
      if (!submission) throw new Error('Draft submission not found.');

      const nowTime = Date.now();
      const leaseMs = Math.max(5_000, Math.min(120_000, Number(input.leaseMs || 30_000)));
      const existing = submission.lock;
      const active = existing && parseIso(existing.expiresAt) > nowTime;
      const force = input.force === true;
      if (active && existing.holderUserId !== user.id && !force) {
        return {
          ok: false,
          conflict: true,
          reason: 'Draft is currently locked by another advisor.',
          lock: existing,
          revisionId: submission.revisionId || 1
        };
      }

      const lock = {
        leaseId: randomUUID(),
        holderUserId: user.id,
        acquiredAt: now(),
        expiresAt: new Date(nowTime + leaseMs).toISOString(),
        leaseMs
      };
      submission.lock = lock;
      submission.updatedAt = now();
      addAudit(user.firmId, user.id, 'form_submission', submission.id, 'form_submission.lock_acquired', { leaseMs, force });
      persist();
      return { ok: true, lock, revisionId: submission.revisionId || 1 };
    },
    releaseDraftLock(user, submissionId, leaseId = '') {
      requirePermission(user, 'forms:write');
      const submission = state.formSubmissions.find((entry) => entry.id === submissionId && entry.firmId === user.firmId && entry.status === 'draft');
      if (!submission) throw new Error('Draft submission not found.');
      const existing = submission.lock;
      if (!existing) return { ok: true, released: false };
      if (existing.holderUserId !== user.id && leaseId && existing.leaseId !== leaseId) {
        throw new Error('Cannot release lock held by another advisor.');
      }
      submission.lock = null;
      submission.updatedAt = now();
      addAudit(user.firmId, user.id, 'form_submission', submission.id, 'form_submission.lock_released', {});
      persist();
      return { ok: true, released: true };
    },
    reviseDraftSubmission(user, submissionId, input = {}) {
      requirePermission(user, 'forms:write');
      const submission = state.formSubmissions.find((entry) => entry.id === submissionId && entry.firmId === user.firmId && entry.status === 'draft');
      if (!submission) throw new Error('Draft submission not found.');

      const currentRevision = Number(submission.revisionId || 1);
      const expectedRevision = Number(input.expectedRevisionId || 0);
      if (!Number.isFinite(expectedRevision) || expectedRevision < 1) {
        throw new Error('expectedRevisionId is required.');
      }

      const lock = submission.lock;
      const lockActive = lock && parseIso(lock.expiresAt) > Date.now();
      if (!lockActive || lock.holderUserId !== user.id || lock.leaseId !== input.leaseId) {
        return {
          ok: false,
          conflict: true,
          reason: 'Draft lease is missing, expired, or held by another advisor.',
          mergePrompt: {
            type: 'lease_conflict',
            localRevisionId: expectedRevision,
            serverRevisionId: currentRevision,
            suggestion: 'Refresh draft, compare changes, and reacquire lock before saving.'
          },
          serverDraft: submission
        };
      }

      if (expectedRevision !== currentRevision) {
        return {
          ok: false,
          conflict: true,
          reason: 'Draft has changed since your last load.',
          mergePrompt: {
            type: 'revision_conflict',
            localRevisionId: expectedRevision,
            serverRevisionId: currentRevision,
            suggestion: 'Show merge preview and choose keep-local, keep-server, or manual merge.'
          },
          serverDraft: submission
        };
      }

      submission.data = input.data && typeof input.data === 'object' ? input.data : {};
      submission.revisionId = currentRevision + 1;
      submission.updatedAt = now();
      if (input.status === 'submitted') {
        submission.status = 'submitted';
        submission.lock = null;
      } else {
        submission.lock = {
          ...lock,
          expiresAt: new Date(Date.now() + Number(lock.leaseMs || 30_000)).toISOString()
        };
      }
      addAudit(user.firmId, user.id, 'form_submission', submission.id, 'form_submission.draft_revised', {
        revisionId: submission.revisionId,
        submitted: submission.status === 'submitted'
      });
      persist();
      return { ok: true, submission };
    },
    listDocumentTemplates(user) {
      authorize(user, 'templates:read');
      return state.documentTemplates.filter((entry) => entry.firmId === user.firmId);
    },
    createDocumentTemplate(user, input) {
      authorize(user, 'templates:write');
      const template = { id: randomUUID(), firmId: user.firmId, name: input.name, fileName: input.fileName || 'template.pdf', blueprint: input.blueprint || { sections: [] }, mappings: input.mappings || [], versions: [{ version: 1, blueprint: input.blueprint || { sections: [] }, mappings: input.mappings || [], createdAt: now() }], status: 'draft', createdAt: now(), updatedAt: now() };
      state.documentTemplates.push(template);
      addAudit(user.firmId, user.id, 'document_template', template.id, 'document_template.created', { name: template.name });
      requirePermission(user, 'templates:write');
      return state.templateAggregates
        .filter((entry) => entry.firmId === user.firmId && entry.kind !== 'form')
        .map((entry) => ({
          id: entry.id,
          firmId: entry.firmId,
          name: entry.name,
          fileName: entry.documentMetadata?.fileName || 'template.pdf',
          blueprint: entry.blueprint || { sections: [] },
          mappings: entry.mappings || [],
          versions: entry.versions || [],
          status: entry.publishState || 'draft',
          publishState: entry.publishState || 'draft',
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt
        }));
    },
    createDocumentTemplate(user, input) {
      requirePermission(user, 'templates:write');
      const createdAt = now();
      const template = normalizeTemplateAggregate({
        id: randomUUID(),
        firmId: user.firmId,
        kind: 'document',
        name: input.name,
        description: input.description || '',
        documentMetadata: { fileName: input.fileName || 'template.pdf' },
        extractedFields: input.fields || [],
        formSchema: { sections: input.formSections || [] },
        blueprint: input.blueprint || { sections: [] },
        mappings: input.mappings || [],
        publishState: 'draft',
        versions: [{
          version: 1,
          event: 'created',
          blueprint: input.blueprint || { sections: [] },
          mappings: input.mappings || [],
          formSchema: { sections: input.formSections || [] },
          publishState: 'draft',
          createdAt,
          actorUserId: user.id
        }],
        publishTransitions: [],
        createdAt,
        updatedAt: createdAt
      }, 'document');
      state.templateAggregates.push(template);
      addAudit(user.firmId, user.id, 'template_aggregate', template.id, 'document_template.created', { name: template.name });
      persist();
      return { ...template, fileName: template.documentMetadata.fileName, status: template.publishState };
    },
    updateTemplateMappings(user, templateId, mappings) {
      authorize(user, 'templates:write');
      const template = assertFirmScopedRecord(state.documentTemplates.find((entry) => entry.id === templateId), user, 'Template');
      template.mappings = mappings;
      template.versions.push({ version: template.versions.length + 1, blueprint: template.blueprint, mappings, createdAt: now() });
      requirePermission(user, 'templates:write');
      const template = state.templateAggregates.find((entry) => entry.id === templateId && entry.firmId === user.firmId && entry.kind !== 'form');
      if (!template) throw new Error('Template not found.');
      const nextMappings = mappings || [];
      const prevMappings = template.mappings || [];
      const mappingDiff = summarizeArrayDiff(prevMappings, nextMappings);
      template.mappings = nextMappings;
      template.mappingRules = nextMappings;
      template.updatedAt = now();
      template.versions.push(createTemplateVersion(template, 'mappings_updated', {
        mappings: nextMappings,
        blueprint: template.blueprint,
        actorUserId: user.id,
        diff: { mappings: mappingDiff, blueprint: summarizeBlueprintDiff(template.blueprint, template.blueprint) }
      }));
      addAudit(user.firmId, user.id, 'template_aggregate', template.id, 'document_template.mappings_updated', { count: nextMappings.length });
      persist();
      return { ...template, fileName: template.documentMetadata.fileName, status: template.publishState };
    },
    publishTemplate(user, templateId) {
      authorize(user, 'templates:publish');
      const template = assertFirmScopedRecord(state.documentTemplates.find((entry) => entry.id === templateId), user, 'Template');
      requirePermission(user, 'templates:write');
      const template = state.templateAggregates.find((entry) => entry.id === templateId && entry.firmId === user.firmId && entry.kind !== 'form');
      if (!template) throw new Error('Template not found.');
      const previousState = template.publishState || 'draft';
      template.publishState = 'published';
      template.status = 'published';
      template.updatedAt = now();
      template.publishTransitions ||= [];
      template.publishTransitions.push({ from: previousState, to: 'published', at: template.updatedAt, actorUserId: user.id });
      template.versions.push(createTemplateVersion(template, 'published', {
        mappings: template.mappings,
        blueprint: template.blueprint,
        publishState: 'published',
        actorUserId: user.id,
        diff: { publishTransition: { from: previousState, to: 'published' } }
      }));
      persist();
      return { ...template, fileName: template.documentMetadata.fileName, status: template.publishState };
    },
    listTemplateVersions(user, templateId) {
      requirePermission(user, 'templates:write');
      const template = state.templateAggregates.find((entry) => entry.id === templateId && entry.firmId === user.firmId && entry.kind !== 'form');
      if (!template) throw new Error('Template not found.');
      return template.versions || [];
    },
    listPublishTransitions(user, templateId) {
      requirePermission(user, 'templates:write');
      const template = state.templateAggregates.find((entry) => entry.id === templateId && entry.firmId === user.firmId && entry.kind !== 'form');
      if (!template) throw new Error('Template not found.');
      return template.publishTransitions || [];
    },
    listExports(user) {
      authorize(user, 'exports:write');
      state.exportJobs = listExportQueueJobs();
      return state.exportJobs.filter((entry) => entry.firmId === user.firmId);
    },
    createExport(user, input) {
      authorize(user, 'exports:write');
      requireFirmProfile(user, input.clientId);
      assertFirmScopedRecord(state.documentTemplates.find((entry) => entry.id === input.templateId), user, 'Template');
      const queued = enqueueExportJob({
        id: randomUUID(),
        firmId: user.firmId,
        clientId: input.clientId,
        templateId: input.templateId,
        type: input.type || 'pdf',
        maxAttempts: Number(input.maxAttempts || 3),
        metadata: input.metadata || {}
      });
      addAudit(user.firmId, user.id, 'export_job', queued.id, 'export_job.created', { clientId: input.clientId, templateId: input.templateId, type: queued.type });
      state.exportJobs = state.exportJobs.filter((entry) => entry.id !== queued.id);
      state.exportJobs.push(queued);
      persist();
      return queued;
    },
    retryExport(user, exportId) {
      authorize(user, 'exports:write');
      const job = assertFirmScopedRecord(state.exportJobs.find((entry) => entry.id === exportId), user, 'Export');
      const updated = requeueExportJob(exportId);
      if (!updated) throw new Error('Export not found.');
      state.exportJobs = state.exportJobs.map((entry) => (entry.id === exportId ? updated : entry));
      persist();
      return updated;
    },
    async processQueuedExports() {
      const result = processExportQueueTick({
        workerId: 'api-process-endpoint',
        limit: 10,
        leaseMs: 15_000,
        processor(job) {
          const failCount = Number(job?.metadata?.simulateFailuresRemaining || 0);
          if (failCount > 0) {
            job.metadata.simulateFailuresRemaining = failCount - 1;
            throw new Error(`Simulated export failure for ${job.id}`);
          }
          const fileName = `${job.type}-${Date.now()}.json`;
          const key = `${job.firmId}/exports/${fileName}`;
          return { fileName, preview: { clientId: job.clientId, templateId: job.templateId }, object: { bucket: objectStorage.bucketExports, key, checksum: null, contentType: 'application/json', retentionClass: 'export_artifact' } };
        }
      });
      return { processed: result.processed, leased: result.leased, failed: result.failed };
    },
    listAudit(user) {
      authorize(user, 'profiles:read');
      return state.auditEvents.filter((entry) => entry.firmId === user.firmId).slice().reverse();
    },
    logout(token) {
      state.sessions = state.sessions.filter((entry) => entry.token !== token);
      state.csrfTokens = state.csrfTokens.filter((entry) => entry.sessionToken !== token);
      persist();
      return { ok: true };
    },
    listUsers(user) {
      authorize(user, 'users:read');
      return state.users.filter((entry) => entry.firmId === user.firmId).map(publicUser);
    },
    inviteUser(user, input) {
      requirePermission(user, 'profiles:write');
      const role = input.role || 'advisor';
      if (!ALLOWED_INVITE_ROLES.has(role)) throw new Error('Invalid invite role.');
      if (role === 'client' && user.role !== 'admin') throw new Error('Only admins can invite client users.');
      const invite = {
        id: randomUUID(),
        firmId: user.firmId,
        email: input.email.toLowerCase(),
        role,
        invitedByUserId: user.id,
        token: randomUUID(),
        createdAt: now(),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
        consumedAt: null
      };
      authorize(user, 'users:write');
      const invite = { id: randomUUID(), firmId: user.firmId, email: input.email.toLowerCase(), role: input.role || 'advisor', invitedByUserId: user.id, token: randomUUID(), createdAt: now() };
      state.invites.push(invite);
      addAudit(user.firmId, user.id, 'invite', invite.id, 'invite.created', { email: invite.email, role: invite.role });
      persist();
      return invite;
    },
    acceptInvite(input) {
      assertStrongPassword(input.password);
      const invite = state.invites.find((entry) => entry.token === input.token);
      if (!invite) throw new Error('Invite not found.');
      if (invite.consumedAt) throw new Error('Invite already consumed.');
      if (new Date(invite.expiresAt).getTime() <= Date.now()) {
        addAudit(invite.firmId, null, 'invite', invite.id, 'invite.expired', { email: invite.email });
        state.invites = state.invites.filter((entry) => entry.id !== invite.id);
        persist();
        throw new Error('Invite expired.');
      }
      if (state.users.some((entry) => entry.email === invite.email && entry.firmId === invite.firmId)) {
        throw new Error('An account with this email already exists.');
      }
      const user = {
        id: randomUUID(),
        firmId: invite.firmId,
        email: invite.email,
        passwordHash: hash(input.password),
        firstName: input.firstName,
        lastName: input.lastName,
        role: invite.role,
        mfa: { enabled: false, totpSecret: null, backupCodes: [] },
        createdAt: now()
      };
      state.users.push(user);
      invite.consumedAt = now();
      state.invites = state.invites.filter((entry) => entry.id !== invite.id);
      addAudit(invite.firmId, user.id, 'invite', invite.id, 'invite.accepted', { email: invite.email, role: invite.role });
      persist();
      return createSession(user);
    },
    requestPasswordReset(email) {
      return auth.requestReset({ email, ipAddress: 'internal-call' });
    },
    resetPassword(input) {
      return auth.resetPassword(input);
    },
    objectStorage,
    removeHouseholdMember(user, householdId, clientId) {
      authorize(user, 'households:write');
      requireFirmHousehold(user, householdId);
      requireFirmProfile(user, clientId);
      state.householdMembers = state.householdMembers.filter((entry) => !(entry.householdId === householdId && entry.clientId === clientId && entry.firmId === user.firmId));
      const profile = state.profiles.find((entry) => entry.id === clientId && entry.firmId === user.firmId);
      if (profile) profile.householdId = null;
      persist();
      return { ok: true };
    },
    linkSpouse(user, primaryClientId, spouseClientId) {
      authorize(user, 'households:write');
      const primary = requireFirmProfile(user, primaryClientId);
      const spouse = requireFirmProfile(user, spouseClientId);
      primary.spouseClientId = spouse.id;
      spouse.spouseClientId = primary.id;
      let householdId = primary.householdId;
      if (!householdId) {
        householdId = this.createHousehold(user, { name: `${primary.lastName} Household`, primaryClientId: primary.id }).id;
      }
      spouse.householdId = householdId;
      state.householdMembers.push({ householdId, clientId: spouse.id, role: 'spouse', firmId: user.firmId, createdAt: now() });
      persist();
      return { primary, spouse };
    },
    createSpouse(user, primaryClientId, input) {
      const spouse = this.createProfile(user, { ...input, kind: 'client' });
      this.linkSpouse(user, primaryClientId, spouse.id);
      return spouse;
    },
    updateSubmission(user, submissionId, patch) {
      authorize(user, 'forms:write');
      const submission = assertFirmScopedRecord(state.formSubmissions.find((entry) => entry.id === submissionId), user, 'Submission');
      Object.assign(submission, patch, { updatedAt: now() });
      persist();
      return submission;
    },
    createSubmissionSectionItem(user, submissionId, sectionKey, payload) {
      requirePermission(user, 'forms:write');
      const { submission, template } = ensureSubmissionWithTemplate(user, submissionId);
      const { section, dataPath } = resolveRepeatableSection(template, sectionKey);
      validateItem(section, payload?.item);
      const items = ensureRepeatableArray(submission, dataPath);
      const createdItem = { ...payload.item, [ITEM_KEY_FIELD]: randomUUID() };
      items.push(createdItem);
      submission.updatedAt = now();
      addAudit(user.firmId, user.id, 'form_submission', submission.id, 'form_submission.item_created', {
        path: `data.${dataPath}[${items.length - 1}]`,
        sectionKey,
        itemKey: createdItem[ITEM_KEY_FIELD],
        changedFields: Object.keys(payload.item || {})
      });
      persist();
      return { submission, item: createdItem };
    },
    updateSubmissionSectionItem(user, submissionId, sectionKey, itemKey, payload) {
      requirePermission(user, 'forms:write');
      const { submission, template } = ensureSubmissionWithTemplate(user, submissionId);
      const { section, dataPath } = resolveRepeatableSection(template, sectionKey);
      validateItem(section, payload?.item || {});
      const items = ensureRepeatableArray(submission, dataPath);
      const itemIndex = items.findIndex((entry) => entry?.[ITEM_KEY_FIELD] === itemKey);
      if (itemIndex < 0) {
        throw createStoreError('Repeatable item not found.', { statusCode: 404, code: 'REPEATABLE_ITEM_NOT_FOUND', details: { sectionKey, itemKey } });
      }
      const nextItem = { ...items[itemIndex], ...payload.item, [ITEM_KEY_FIELD]: itemKey };
      items[itemIndex] = nextItem;
      submission.updatedAt = now();
      addAudit(user.firmId, user.id, 'form_submission', submission.id, 'form_submission.item_updated', {
        path: `data.${dataPath}[${itemIndex}]`,
        sectionKey,
        itemKey,
        changedFields: Object.keys(payload.item || {})
      });
      persist();
      return { submission, item: nextItem };
    },
    deleteSubmissionSectionItem(user, submissionId, sectionKey, itemKey) {
      requirePermission(user, 'forms:write');
      const { submission, template } = ensureSubmissionWithTemplate(user, submissionId);
      const { dataPath } = resolveRepeatableSection(template, sectionKey);
      const items = ensureRepeatableArray(submission, dataPath);
      const itemIndex = items.findIndex((entry) => entry?.[ITEM_KEY_FIELD] === itemKey);
      if (itemIndex < 0) {
        throw createStoreError('Repeatable item not found.', { statusCode: 404, code: 'REPEATABLE_ITEM_NOT_FOUND', details: { sectionKey, itemKey } });
      }
      items.splice(itemIndex, 1);
      submission.updatedAt = now();
      addAudit(user.firmId, user.id, 'form_submission', submission.id, 'form_submission.item_deleted', {
        path: `data.${dataPath}[${itemIndex}]`,
        sectionKey,
        itemKey
      });
      persist();
      return { submission, ok: true };
    },
    deleteSubmission(user, submissionId) {
      authorize(user, 'forms:write');
      assertFirmScopedRecord(state.formSubmissions.find((entry) => entry.id === submissionId), user, 'Submission');
      state.formSubmissions = state.formSubmissions.filter((entry) => !(entry.id === submissionId && entry.firmId === user.firmId));
      persist();
      return { ok: true };
    },
    autoBuildTemplate(user, input) {
      authorize(user, 'templates:write');
      const sections = (input.fields || []).reduce((acc, field) => {
        const sectionKey = field.split('.')[0] || 'general';
        acc[sectionKey] ||= [];
        acc[sectionKey].push(field);
        return acc;
      }, {});
      return this.createDocumentTemplate(user, { name: input.name, fileName: input.fileName || 'uploaded.pdf', blueprint: { sections }, mappings: (input.fields || []).map((field) => ({ pdfField: field, sourcePath: field.replace(/\s+/g, '_').toLowerCase() })) });
    },
    createPortalLink(user, profileId) {
      authorize(user, 'profiles:read');
      requireFirmProfile(user, profileId);
      const link = { id: randomUUID(), firmId: user.firmId, profileId, token: randomUUID(), createdAt: now() };
      state.portalLinks.push(link);
      persist();
      return link;
    },
    getPortalData(token) {
      const link = state.portalLinks.find((entry) => entry.token === token);
      if (!link) throw new Error('Portal link not found.');
      const firm = state.firms.find((entry) => entry.id === link.firmId) || null;
      const profile = state.profiles.find((entry) => entry.id === link.profileId && entry.firmId === link.firmId);
      const submissions = state.formSubmissions
        .filter((entry) => entry.clientId === link.profileId && entry.firmId === link.firmId)
        .slice()
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
      const availableTemplates = state.templateAggregates
        .filter((entry) => entry.firmId === link.firmId && entry.kind === 'form')
        .map((entry) => ({ id: entry.id, name: entry.name, description: entry.description || '', sections: entry.formSchema?.sections || [] }));
      submissions.forEach(ensureSubmissionRepeatableItemKeys);
      const availableTemplates = state.formTemplates
        .filter((entry) => entry.firmId === link.firmId)
        .map((entry) => ({ id: entry.id, name: entry.name, description: entry.description || '', sections: entry.sections || [] }));
      const uploads = state.documentUploads
        .filter((entry) => entry.firmId === link.firmId && entry.clientId === link.profileId)
        .slice()
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
      return { firm, profile, submissions, availableTemplates, uploads };
    },
    portalSubmit(token, input) {
      const link = state.portalLinks.find((entry) => entry.token === token);
      if (!link) throw new Error('Portal link not found.');
      const templateId = input.templateId || 'portal';
      const template = templateId === 'portal' ? null : state.templateAggregates.find((entry) => entry.id === templateId && entry.firmId === link.firmId && entry.kind === 'form');
      if (templateId !== 'portal' && !template) throw new Error('Form template not found.');
      const status = input.status === 'draft' ? 'draft' : 'submitted';
      const submission = {
        id: randomUUID(),
        firmId: link.firmId,
        clientId: link.profileId,
        templateId,
        status,
        data: input.data && typeof input.data === 'object' ? input.data : {},
        createdByUserId: null,
        createdAt: now(),
        updatedAt: now(),
        source: 'portal'
      };
      state.formSubmissions.push(submission);
      persist();
      return submission;
    },
    async createPortalUploadPresign(token, input) {
      const link = state.portalLinks.find((entry) => entry.token === token);
      if (!link) throw new Error('Portal link not found.');
      const intent = createUploadIntent({
        firmId: link.firmId,
        clientId: link.profileId,
        fileName: input.fileName,
        contentType: input.contentType,
        checksum: input.checksum,
        category: input.category,
        source: 'portal'
      });
      const presigned = await objectStorage.createPresignedUploadUrl({ ...intent.object, expiresInSeconds: Number(input.expiresInSeconds || 900) });
      persist();
      return { uploadId: intent.id, object: intent.object, presigned };
    },
    portalUpload(token, input) {
      const link = state.portalLinks.find((entry) => entry.token === token);
      if (!link) throw new Error('Portal link not found.');
      const intent = input.uploadId ? state.pendingUploadIntents.find((entry) => entry.id === input.uploadId && entry.firmId === link.firmId) : null;
      const object = normalizeObjectMetadata(input.object || intent?.object || {}, 'uploaded_document');
      const upload = {
        id: randomUUID(),
        firmId: link.firmId,
        clientId: link.profileId,
        name: input.name || input.fileName || intent?.fileName || 'Portal upload',
        category: input.category || intent?.category || 'general',
        visibility: 'shared',
        status: 'uploaded',
        uploadedBy: 'portal',
        notes: input.notes || '',
        object,
        createdAt: now(),
        updatedAt: now()
      };
      state.pendingUploadIntents = state.pendingUploadIntents.filter((entry) => entry.id !== input.uploadId);
      state.documentUploads.push(upload);
      persist();
      return upload;
    },
    async createPortalUploadDownloadUrl(token, uploadId) {
      const link = state.portalLinks.find((entry) => entry.token === token);
      if (!link) throw new Error('Portal link not found.');
      const upload = state.documentUploads.find((entry) => entry.id === uploadId && entry.firmId === link.firmId && entry.clientId === link.profileId);
      if (!upload) throw new Error('Upload not found.');
      return objectStorage.createPresignedDownloadUrl({ ...upload.object, expiresInSeconds: 900 });
    },
    getAnalytics(user) {
      authorize(user, 'analytics:read');
      const prospects = state.profiles.filter((entry) => entry.firmId === user.firmId && entry.kind === 'prospect');
      requirePermission(user, 'analytics:read');
      const firmProfiles = state.profiles.filter((entry) => entry.firmId === user.firmId);
      const prospects = firmProfiles.filter((entry) => entry.kind === 'prospect');
      const stageCounts = prospects.reduce((acc, profile) => {
        const stage = profile.stage || 'unassigned';
        acc[stage] = (acc[stage] || 0) + 1;
        return acc;
      }, {});
      const totalProspects = prospects.length || 1;
      const stageOrder = ['discovery', 'gather_oi', 'analysis', 'advisor_proposal_meeting', 'intake', 'on_boarding', 'investment_strategy', 'completed'];
      const funnel = stageOrder.map((stage) => {
        const count = stageCounts[stage] || 0;
        return { stage, count, conversionRate: Number((count / totalProspects).toFixed(4)) };
      });
      const firstStage = stageCounts[stageOrder[0]] || 0;
      const lastStage = stageCounts.completed || 0;

      const stageEvents = state.stageChanges
        .filter((entry) => entry.firmId === user.firmId)
        .slice()
        .sort((a, b) => parseIso(a.changedAt) - parseIso(b.changedAt));
      const stageEntryTimes = new Map();
      stageEvents.forEach((event) => {
        const key = `${event.clientId}:${event.toStage || 'unassigned'}`;
        if (!stageEntryTimes.has(key)) stageEntryTimes.set(key, parseIso(event.changedAt));
      });
      const stageAging = Object.fromEntries(stageOrder.map((stage) => [stage, { count: 0, avgDays: 0 }]));
      const nowTime = Date.now();
      prospects.forEach((profile) => {
        const stage = profile.stage || 'unassigned';
        if (!stageAging[stage]) stageAging[stage] = { count: 0, avgDays: 0 };
        const enteredAt = stageEntryTimes.get(`${profile.id}:${stage}`) || parseIso(profile.createdAt);
        const ageDays = Math.max(0, (nowTime - enteredAt) / 86_400_000);
        stageAging[stage].count += 1;
        stageAging[stage].avgDays += ageDays;
      });
      Object.values(stageAging).forEach((entry) => {
        if (entry.count) entry.avgDays = Number((entry.avgDays / entry.count).toFixed(2));
      });

      const templateIds = new Set(state.formTemplates.filter((entry) => entry.firmId === user.firmId).map((entry) => entry.id));
      const formsByTemplate = {};
      templateIds.forEach((templateId) => {
        formsByTemplate[templateId] = { templateId, drafts: 0, submitted: 0, completionRate: 0 };
      });
      state.formSubmissions
        .filter((entry) => entry.firmId === user.firmId)
        .forEach((submission) => {
          formsByTemplate[submission.templateId] ||= { templateId: submission.templateId, drafts: 0, submitted: 0, completionRate: 0 };
          if (submission.status === 'submitted') formsByTemplate[submission.templateId].submitted += 1;
          else formsByTemplate[submission.templateId].drafts += 1;
        });
      Object.values(formsByTemplate).forEach((entry) => {
        const total = entry.drafts + entry.submitted;
        entry.completionRate = total ? Number((entry.submitted / total).toFixed(4)) : 0;
      });

      const advisors = state.users.filter((entry) => entry.firmId === user.firmId && ['advisor', 'admin'].includes(entry.role));
      const advisorProductivity = advisors.map((advisor) => {
        const assignedProfiles = firmProfiles.filter((entry) => entry.advisorUserId === advisor.id);
        const notesCount = state.notes.filter((entry) => entry.firmId === user.firmId && entry.createdByUserId === advisor.id).length;
        const stageMoves = state.stageChanges.filter((entry) => entry.firmId === user.firmId && entry.changedByUserId === advisor.id).length;
        const submissions = state.formSubmissions.filter((entry) => entry.firmId === user.firmId && entry.createdByUserId === advisor.id).length;
        return {
          advisorUserId: advisor.id,
          advisorName: `${advisor.firstName} ${advisor.lastName}`,
          profilesManaged: assignedProfiles.length,
          notesAuthored: notesCount,
          stageMoves,
          formSubmissionsAuthored: submissions,
          productivityScore: assignedProfiles.length + notesCount + stageMoves + submissions
        };
      });

      return {
        stageCounts,
        funnel,
        overallConversionRate: firstStage ? Number((lastStage / firstStage).toFixed(4)) : 0,
        stageAging,
        formCompletionRates: Object.values(formsByTemplate),
        advisorProductivity,
        profileCount: firmProfiles.length,
        householdCount: state.households.filter((entry) => entry.firmId === user.firmId).length,
        exportCount: state.exportJobs.filter((entry) => entry.firmId === user.firmId).length,
        templateCount: state.templateAggregates.filter((entry) => entry.firmId === user.firmId && entry.kind !== 'form').length
        templateCount: state.documentTemplates.filter((entry) => entry.firmId === user.firmId).length,
        avgProspectStageAgeDays: Number(average(Object.values(stageAging).map((entry) => entry.avgDays || 0)).toFixed(2))
      };
    },
    getMaskedSensitiveData(user, profileId) {
      authorize(user, 'profiles:sensitive:read');
      const profile = requireFirmProfile(user, profileId);
      const ssn = decryptValue(profile.pii?.ssnCiphertext);
      const taxId = decryptValue(profile.pii?.taxIdCiphertext);
      return {
        ssnMasked: ssn ? `***-**-${ssn.slice(-4)}` : null,
        taxIdMasked: taxId ? `**-${taxId.slice(-4)}` : null

    async createExportDownloadUrl(user, exportId) {
      requirePermission(user, 'exports:write');
      const job = state.exportJobs.find((entry) => entry.id === exportId && entry.firmId === user.firmId);
      if (!job) throw new Error('Export not found.');
      const object = job.output?.object;
      if (!object) throw new Error('Export output object not available.');
      return objectStorage.createPresignedDownloadUrl({ ...object, expiresInSeconds: 900 });
    },
    async runLifecyclePolicies(user) {
      requirePermission(user, 'exports:write');
      await applyLifecyclePolicies();
      return {
        uploads: state.documentUploads.filter((entry) => entry.firmId === user.firmId),
        exports: state.exportJobs.filter((entry) => entry.firmId === user.firmId),
        retention: objectStorage.retentionPolicies
      };
    },
    getMaskedSensitiveData(user, profileId, options = {}) {
      requirePermission(user, 'profiles:read');
      const profile = state.profiles.find((entry) => entry.id === profileId && entry.firmId === user.firmId);
      if (!profile) throw new Error('Profile not found.');
      const purpose = options.purpose || 'profile_view';
      const requestedUnmask = Boolean(options.unmask);
      const policy = getSensitivePolicy(user.role, purpose);
      if (!policy?.allowMasked || (requestedUnmask && !policy.allowUnmasked)) {
        addAudit(user.firmId, user.id, 'profile', profileId, 'sensitive.read_denied', { purpose, requestedUnmask, role: user.role });
        throw new Error('Sensitive data access denied for role/purpose combination.');
      }
      const ssn = piiCrypto.decrypt(readSensitiveRecord(profile, 'ssn'));
      const taxId = piiCrypto.decrypt(readSensitiveRecord(profile, 'taxId'));
      const response = {
        ssnMasked: maskSsn(ssn),
        taxIdMasked: maskTaxId(taxId)
      };
      if (requestedUnmask) {
        response.ssn = ssn;
        response.taxId = taxId;
      }
      addAudit(user.firmId, user.id, 'profile', profileId, 'sensitive.read', {
        purpose,
        requestedUnmask,
        grantedUnmask: requestedUnmask,
        role: user.role,
        fields: requestedUnmask ? ['ssn', 'taxId'] : ['ssnMasked', 'taxIdMasked']
      });
      return response;
    },
    reencryptSensitiveData(options = {}) {
      const profiles = state.profiles.filter((entry) => entry.firmId === options.firmId || !options.firmId);
      let rotatedProfiles = 0;
      let rotatedFields = 0;
      profiles.forEach((profile) => {
        const result = reencryptProfilePii(profile);
        if (result.changed) {
          rotatedProfiles += 1;
          rotatedFields += result.fields.length;
          profile.updatedAt = now();
        }
      });
      const actorUserId = options.actorUserId || 'system';
      const actorFirmId = options.firmId || profiles[0]?.firmId || 'system';
      addAudit(actorFirmId, actorUserId, 'pii', 'rotation', 'pii.rotation.completed', {
        rotatedProfiles,
        rotatedFields,
        activeKeyId: piiCrypto.keyProvider.getActiveKey().keyId
      });
      persist();
      return { rotatedProfiles, rotatedFields };
    },
    __setTestHooks(hooks = {}) {
      testHooks = { ...hooks };
    },
    __clearTestHooks() {
      testHooks = {};
    }
  };
}

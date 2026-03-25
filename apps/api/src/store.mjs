import { createHash, randomUUID } from 'node:crypto'
import { runtime } from './runtime.mjs'
import {
  enqueueExportJob,
  listExportQueueJobs,
  loadState,
  processExportQueueTick,
  readExportWorkerStatus,
  requeueExportJob,
  saveState
} from './storage.mjs'
import { createAuthService } from './auth/service.mjs'
import { createLocalAuthProvider } from './auth/local-provider.mjs'
import { createOidcAuthProvider } from './auth/oidc-provider.mjs'
import { createSamlAuthProvider } from './auth/saml-provider.mjs'
import { objectStorage as defaultObjectStorage } from './object-storage/index.mjs'
import { formatProfileSourceDisplay, migrateProfileSource, normalizeProfileSource } from './modules/profiles/source.mjs'
import { createCanonicalAuditEvent } from './modules/audit/schema.mjs'
import { createKeyProvider, PiiCryptoService } from './pii-crypto.mjs'
import { createRuntimeKmsAdapter } from './kms-adapter.mjs'
import { canUnmaskSensitiveData, maskSsn, maskTaxId, validateUnmaskRequest } from './security/pii-policy.mjs'

const SESSION_TTL_MS = 1000 * 60 * 60 * 8
const PERMISSIONS = {
  admin: ['*'],
  advisor: [
    'profiles:read',
    'profiles:write',
    'pipeline:write',
    'households:write',
    'forms:write',
    'templates:write',
    'exports:write',
    'analytics:read'
  ],
  readonly: ['profiles:read', 'analytics:read'],
  client: ['portal:read', 'client:write']
}
const BOARD_COLUMNS = [
  'discovery',
  'gather_oi',
  'analysis',
  'advisor_proposal_meeting',
  'intake',
  'on_boarding',
  'investment_strategy',
  'completed',
  'drop_dead_lead',
  'drop_nurture'
]

function can(role, permission) {
  return PERMISSIONS[role]?.includes('*') || PERMISSIONS[role]?.includes(permission)
}

function requirePermission(user, permission) {
  if (!can(user.role, permission)) {
    throw new Error(`Missing permission: ${permission}`)
  }
}


function now() {
  return new Date().toISOString()
}

function parseIso(value) {
  const time = new Date(value || '').getTime()
  return Number.isFinite(time) ? time : 0
}

function profileOrderIndex(profile) {
  const raw = profile?.orderIndex ?? profile?.stageOrderIndex ?? null
  const numeric = Number(raw)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : Number.MAX_SAFE_INTEGER
}

function assignProspectOrderIndex(profile, index) {
  const normalized = Number(index)
  const next = Number.isFinite(normalized) && normalized > 0 ? normalized : null
  profile.orderIndex = next
  profile.stageOrderIndex = next
}

function average(values) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function toIsoDate(value) {
  if (!value) return null
  const stamp = new Date(value).getTime()
  if (!Number.isFinite(stamp)) return null
  return new Date(stamp).toISOString().slice(0, 10)
}

function csvCell(value) {
  const text = String(value ?? '')
  if (/[,"\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

function hash(password) {
  return createHash('sha256').update(password).digest('hex')
}

function assertStrongPassword(password) {
  const value = String(password || '')
  if (value.length < 12) throw new Error('Password must be at least 12 characters long.')
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) {
    throw new Error('Password must include uppercase, lowercase, and numeric characters.')
  }
}

function sanitizeFileName(value = 'file.bin') {
  return (
    String(value || 'file.bin')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .slice(0, 120) || 'file.bin'
  )
}

function daysBetween(thenIso, nowMs) {
  const thenMs = new Date(thenIso || 0).getTime()
  if (!Number.isFinite(thenMs) || thenMs <= 0) return 0
  return Math.floor((nowMs - thenMs) / (1000 * 60 * 60 * 24))
}

function sourceDisplay(source) {
  return `${source.cityOrLocation} X ${source.venue} X ${source.occurredOn}`
}

function toFiniteNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeExtensions(extensions = {}) {
  if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) return {}
  const schema = extensions.schema && typeof extensions.schema === 'object' ? { ...extensions.schema } : null
  const values = extensions.values && typeof extensions.values === 'object' ? { ...extensions.values } : {}
  const schemaVersion = schema?.version || extensions.schemaVersion || '1.0.0'
  if (schema?.properties && typeof schema.properties === 'object') {
    const invalid = Object.entries(schema.properties).find(([key, descriptor]) => {
      const expected = descriptor?.type
      if (!expected || !(key in values)) return false
      const actual = values[key]
      if (actual == null) return false
      if (expected === 'number') return typeof actual !== 'number' || Number.isNaN(actual)
      if (expected === 'string') return typeof actual !== 'string'
      if (expected === 'boolean') return typeof actual !== 'boolean'
      if (expected === 'array') return !Array.isArray(actual)
      return false
    })
    if (invalid) {
      const [invalidKey, descriptor] = invalid
      throw new Error(`Invalid extension field type for "${invalidKey}". Expected ${descriptor.type}.`)
    }
  }
  return { schemaVersion, schema, values }
}

function normalizeFinancialSummary(input = {}, extensions = {}) {
  const extensionValues = extensions.values || {}
  const investableAssets = toFiniteNumber(input.investableAssets ?? extensionValues.investableAssets) || 0
  const annualIncome = toFiniteNumber(input.annualIncome ?? extensionValues.annualIncome) || 0
  const totalAssets = toFiniteNumber(input.totalAssets ?? extensionValues.totalAssets ?? investableAssets) || 0
  const totalLiabilities = toFiniteNumber(input.totalLiabilities ?? extensionValues.totalLiabilities) || 0
  const netWorth = toFiniteNumber(input.netWorth ?? extensionValues.netWorth ?? totalAssets - totalLiabilities) || 0
  return {
    investableAssets,
    annualIncome,
    totalAssets,
    totalLiabilities,
    netWorth
  }
}

function normalizeProfileRecord(profile) {
  const extensionSeed =
    profile.extensions ||
    (profile.customProfile ? { schemaVersion: '1.0.0', values: { ...profile.customProfile } } : {})
  const extensions = normalizeExtensions(extensionSeed)
  return {
    ...profile,
    status: profile.status || (profile.kind === 'client' ? 'active' : 'new'),
    extensions,
    financialSummary: normalizeFinancialSummary(profile.financialSummary || profile.customProfile || {}, extensions)
  }
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value))
}

const TEMPLATE_STATES = new Set(['draft', 'review', 'published', 'deprecated'])

function normalizeTemplateState(value, fallback = 'draft') {
  return TEMPLATE_STATES.has(value) ? value : fallback
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function templateVersionHash(template) {
  return createHash('sha256')
    .update(
      stableSerialize({
        blueprint: template.blueprint || { sections: [] },
        mappings: template.mappings || [],
        publishState: normalizeTemplateState(template.publishState || template.status || 'draft')
      })
    )
    .digest('hex')
}

function createTemplateVersion(template, event, overrides = {}) {
  const publishState = normalizeTemplateState(overrides.publishState || template.publishState || 'draft')
  const blueprint = deepClone(overrides.blueprint || template.blueprint || { sections: [] })
  const mappings = deepClone(overrides.mappings || template.mappings || [])
  const formSchema = deepClone(overrides.formSchema || template.formSchema || { sections: [] })
  return {
    version: (template.versions?.length || 0) + 1,
    event,
    blueprint,
    mappings,
    formSchema,
    publishState,
    immutable: overrides.immutable === true,
    changelog: overrides.changelog || null,
    versionHash: overrides.versionHash || templateVersionHash({ blueprint, mappings, publishState }),
    diff: overrides.diff || null,
    actorUserId: overrides.actorUserId || null,
    createdAt: now()
  }
}

function normalizeTemplateAggregate(template, fallbackKind = 'document') {
  const kind = template.kind || fallbackKind
  const formSchema = convertLegacyFormDefinition(template.formSchema || { sections: template.sections || [] })
  const blueprint = template.blueprint || { sections: [] }
  const mappings = template.mappings || template.mappingRules || []
  const publishState = normalizeTemplateState(template.publishState || template.status || 'draft')
  const normalized = {
    id: template.id,
    firmId: template.firmId,
    kind,
    name: template.name,
    description: template.description || '',
    documentMetadata: template.documentMetadata || { fileName: template.fileName || null },
    formSchema,
    blueprint,
    mappings,
    mappingRules: mappings,
    extractedFields: template.extractedFields || [],
    publishState,
    status: publishState, // deprecated internal alias for compatibility payloads
    versions: (template.versions || []).map((entry, index) => ({
      version: entry.version || index + 1,
      event: entry.event || 'snapshot',
      blueprint: deepClone(entry.blueprint || blueprint),
      mappings: deepClone(entry.mappings || mappings),
      formSchema: deepClone(entry.formSchema || formSchema),
      publishState: entry.publishState || publishState,
      immutable: entry.immutable === true,
      changelog: entry.changelog || null,
      versionHash:
        entry.versionHash ||
        templateVersionHash({
          blueprint: entry.blueprint || blueprint,
          mappings: entry.mappings || mappings,
          publishState: entry.publishState || publishState
        }),
      diff: entry.diff || null,
      actorUserId: entry.actorUserId || null,
      createdAt: entry.createdAt || template.updatedAt || template.createdAt || now()
    })),
    publishTransitions: template.publishTransitions || [],
    createdAt: template.createdAt || now(),
    updatedAt: template.updatedAt || template.createdAt || now(),
    legacy: template.legacy || null
  }
  if (!normalized.versions.length) {
    normalized.versions.push(createTemplateVersion(normalized, 'created'))
  }
  return normalized
}

function formTemplateAdapter(entry) {
  return {
    id: entry.id,
    firmId: entry.firmId,
    name: entry.name,
    description: entry.description || '',
    sections: deepClone(entry.formSchema?.sections || []),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  }
}

function documentTemplateAdapter(entry) {
  return {
    id: entry.id,
    firmId: entry.firmId,
    name: entry.name,
    fileName: entry.documentMetadata?.fileName || 'template.pdf',
    blueprint: deepClone(entry.blueprint || { sections: [] }),
    mappings: deepClone(entry.mappings || []),
    versions: deepClone(entry.versions || []),
    status: entry.publishState || 'draft',
    publishState: entry.publishState || 'draft',
    versionHash: templateVersionHash(entry),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  }
}

function migrateTemplateSystems(state) {
  state.templateAggregates ||= []
  if (state.templateAggregates.length === 0) {
    const forms = (state.formTemplates || []).map((entry) =>
      normalizeTemplateAggregate(
        {
          ...entry,
          kind: 'form',
          publishState: 'draft',
          blueprint: { sections: [] },
          mappings: [],
          legacy: { source: 'formTemplates', id: entry.id }
        },
        'form'
      )
    )
    const documents = (state.documentTemplates || []).map((entry) =>
      normalizeTemplateAggregate(
        {
          ...entry,
          kind: 'document',
          legacy: { source: 'documentTemplates', id: entry.id }
        },
        'document'
      )
    )
    state.templateAggregates = [...forms, ...documents]
  } else {
    state.templateAggregates = state.templateAggregates.map((entry) =>
      normalizeTemplateAggregate(entry, entry.kind || 'document')
    )
  }

  // Deprecated compatibility projections for persistence only; do not read internally.
  state.formTemplates = state.templateAggregates.filter((entry) => entry.kind === 'form').map(formTemplateAdapter)
  state.documentTemplates = state.templateAggregates
    .filter((entry) => entry.kind !== 'form')
    .map(documentTemplateAdapter)
}

function migrateProspectOrdering(state) {
  const profiles = Array.isArray(state?.profiles) ? state.profiles : []
  const byFirmStage = new Map()
  for (const profile of profiles) {
    if (profile?.kind !== 'prospect') continue
    const stage = profile.stage || 'discovery'
    const key = `${profile.firmId}:${stage}`
    if (!byFirmStage.has(key)) byFirmStage.set(key, [])
    byFirmStage.get(key).push(profile)
  }
  for (const cards of byFirmStage.values()) {
    cards.sort((a, b) => {
      const indexDiff = profileOrderIndex(a) - profileOrderIndex(b)
      if (indexDiff !== 0) return indexDiff
      const updatedDiff = parseIso(a.updatedAt || a.createdAt) - parseIso(b.updatedAt || b.createdAt)
      if (updatedDiff !== 0) return updatedDiff
      return String(a.id || '').localeCompare(String(b.id || ''))
    })
    cards.forEach((card, index) => assignProspectOrderIndex(card, index + 1))
  }
}

function pipelineConflict(message, details = {}) {
  const error = new Error(message)
  error.statusCode = 409
  error.code = 'PIPELINE_ORDER_CONFLICT'
  error.details = details
  return error
}

function seedState({ objectStorage = defaultObjectStorage } = {}) {
  const createdAt = now()
  const firmId = randomUUID()
  const adminId = randomUUID()
  const householdId = randomUUID()
  const clientId = randomUUID()
  const spouseId = randomUUID()
  const prospectOneId = randomUUID()
  const prospectTwoId = randomUUID()
  const templateId = randomUUID()
  const formTemplateId = randomUUID()
  const submissionId = randomUUID()
  const exportId = randomUUID()
  const documentUploadId = randomUUID()

  return {
    firms: [{ id: firmId, name: 'Demo Advisory Group', slug: 'demo-advisory-group', createdAt }],
    users: [
      {
        id: adminId,
        firmId,
        email: 'admin@demo.test',
        passwordHash: hash('ChangeMe123!'),
        firstName: 'Demo',
        lastName: 'Admin',
        role: 'admin',
        createdAt
      }
    ],
    sessions: [],
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
        source: {
          sourceCity: 'Dallas',
          sourceVenue: 'Referral',
          sourceDate: '2026-03-01',
          campaignId: null,
          displayValue: formatProfileSourceDisplay({ sourceCity: 'Dallas', sourceVenue: 'Referral', sourceDate: '2026-03-01' })
        },
        status: 'active',
        address: { city: 'Dallas', state: 'TX' },
        financialSummary: normalizeFinancialSummary({ investableAssets: 850000 }),
        extensions: normalizeExtensions({
          schemaVersion: '1.0.0',
          schema: { properties: { legacyInvestableAssets: { type: 'number' } } },
          values: { legacyInvestableAssets: 850000 }
        }),
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
        status: 'active',
        address: { city: 'Dallas', state: 'TX' },
        financialSummary: normalizeFinancialSummary({}),
        extensions: normalizeExtensions({}),
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
        orderIndex: 1,
        pipelineVersion: 1,
        source: {
          sourceCity: 'Austin',
          sourceVenue: 'Seminar',
          sourceDate: '2026-03-10',
          campaignId: null,
          displayValue: formatProfileSourceDisplay({ sourceCity: 'Austin', sourceVenue: 'Seminar', sourceDate: '2026-03-10' })
        },
        status: 'new',
        address: { city: 'Austin', state: 'TX' },
        financialSummary: normalizeFinancialSummary({}),
        extensions: normalizeExtensions({}),
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
        orderIndex: 1,
        pipelineVersion: 1,
        source: {
          sourceCity: 'Houston',
          sourceVenue: 'CPA Referral',
          sourceDate: '2026-03-15',
          campaignId: null,
          displayValue: formatProfileSourceDisplay({ sourceCity: 'Houston', sourceVenue: 'CPA Referral', sourceDate: '2026-03-15' })
        },
        status: 'qualified',
        address: { city: 'Houston', state: 'TX' },
        financialSummary: normalizeFinancialSummary({}),
        extensions: normalizeExtensions({}),
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
      {
        id: randomUUID(),
        firmId,
        clientId: prospectOneId,
        toStage: 'discovery',
        changedByUserId: adminId,
        changedAt: createdAt
      },
      {
        id: randomUUID(),
        firmId,
        clientId: prospectTwoId,
        toStage: 'analysis',
        changedByUserId: adminId,
        changedAt: createdAt
      }
    ],
    auditEvents: [
      createCanonicalAuditEvent({
        id: randomUUID(),
        actor: { userId: adminId },
        firmId,
        entityType: 'seed',
        entityId: 'initial',
        action: 'seed.created',
        after: {},
        timestamp: createdAt
      })
    ],
    formTemplates: [
      {
        id: formTemplateId,
        firmId,
        name: 'Financial Discovery',
        description: 'Core onboarding discovery form',
        sections: [
          {
            id: randomUUID(),
            title: 'Household',
            fields: [
              { key: 'goals', label: 'Goals', type: 'textarea' },
              {
                key: 'riskTolerance',
                label: 'Risk Tolerance',
                type: 'select',
                options: ['Conservative', 'Moderate', 'Aggressive']
              }
            ]
          },
          {
            id: randomUUID(),
            title: 'Assets',
            repeatable: true,
            fields: [
              { key: 'accountName', label: 'Account Name', type: 'text' },
              { key: 'value', label: 'Value', type: 'number' }
            ]
          }
        ],
        createdAt,
        updatedAt: createdAt
      }
    ],
    formSubmissions: [
      {
        id: submissionId,
        firmId,
        clientId,
        templateId: formTemplateId,
        status: 'submitted',
        data: { goals: 'Retire at 60', riskTolerance: 'Moderate', assets: [{ accountName: '401k', value: 450000 }] },
        createdAt,
        updatedAt: createdAt
      }
    ],
    documentTemplates: [
      {
        id: templateId,
        firmId,
        name: 'Client Intake PDF Template',
        fileName: 'client-intake.pdf',
        blueprint: { sections: ['client', 'household', 'assets'] },
        mappings: [{ pdfField: 'client_name', sourcePath: 'profile.firstName' }],
        createdAt,
        updatedAt: createdAt
      }
    ],
    exportJobs: [
      {
        id: exportId,
        firmId,
        clientId,
        templateId,
        type: 'pdf',
        status: 'completed',
        output: {
          fileName: 'client-intake-demo.json',
          object: {
            bucket: objectStorage.bucketExports,
            key: `${firmId}/exports/client-intake-demo.json`,
            checksum: null,
            contentType: 'application/json',
            retentionClass: 'export_artifact'
          }
        },
        createdAt,
        updatedAt: createdAt
      }
    ],
    documentUploads: [
      {
        id: documentUploadId,
        firmId,
        clientId,
        name: 'Driver License - Morgan',
        category: 'identification',
        visibility: 'shared',
        status: 'uploaded',
        uploadedBy: 'advisor',
        object: {
          bucket: objectStorage.bucketDocuments,
          key: `${firmId}/documents/${clientId}/driver-license-demo.pdf`,
          checksum: null,
          contentType: 'application/pdf',
          retentionClass: 'uploaded_document'
        },
        createdAt,
        updatedAt: createdAt
      }
    ],
    pendingUploadIntents: [],
    draftStepStates: [],
    notes: [
      {
        id: randomUUID(),
        firmId,
        profileId: prospectOneId,
        body: 'Follow up after workshop and confirm beneficiary details.',
        createdByUserId: adminId,
        createdAt
      }
    ],
    invites: [],
    passwordResets: [],
    portalLinks: [],
    authAttempts: [],
    boardVersions: { [firmId]: 1 }
  }
}

export function createStore({ objectStorage = defaultObjectStorage } = {}) {
  const state = loadState(() => seedState({ objectStorage }))
  migrateTemplateSystems(state)
  state.profiles = (state.profiles || []).map(normalizeProfileRecord)
  saveState(state)
  state.pendingUploadIntents ||= []
  state.draftStepStates ||= []

  function normalizeObjectMetadata(metadata = {}, defaultRetentionClass = 'uploaded_document') {
    return {
      bucket: metadata.bucket,
      key: metadata.key,
      checksum: metadata.checksum || null,
      contentType: metadata.contentType || 'application/octet-stream',
      retentionClass: metadata.retentionClass || defaultRetentionClass
    }
  }

  function createUploadIntent({ firmId, clientId, fileName, contentType, checksum, category, source, retentionClass }) {
    const id = randomUUID()
    const key = `${firmId}/documents/${clientId}/${Date.now()}-${id}-${sanitizeFileName(fileName || 'upload.bin')}`
    const object = normalizeObjectMetadata({
      bucket: objectStorage.bucketDocuments,
      key,
      checksum: checksum || null,
      contentType: contentType || 'application/octet-stream',
      retentionClass: retentionClass || 'uploaded_document'
    })
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
    }
    state.pendingUploadIntents.push(intent)
    return intent
  }

  function normalizePortalScope(scope = {}) {
    return {
      templateIds: Array.isArray(scope.templateIds) ? [...new Set(scope.templateIds.filter(Boolean))] : null,
      uploadCategories: Array.isArray(scope.uploadCategories) ? [...new Set(scope.uploadCategories.filter(Boolean))] : null
    }
  }

  function resolvePortalLinkByToken(token) {
    const link = state.portalLinks.find((entry) => entry.token === token)
    if (!link) throw new Error('Portal link not found.')
    const nowMs = Date.now()
    if (link.revokedAt) throw new Error('Portal link revoked.')
    if (link.expiresAt && new Date(link.expiresAt).getTime() <= nowMs) throw new Error('Portal link expired.')
    if (Number(link.maxUses || 0) > 0 && Number(link.usedCount || 0) >= Number(link.maxUses)) {
      throw new Error('Portal link use limit reached.')
    }
    return link
  }

  function assertPortalTemplateScope(link, templateId) {
    if (!Array.isArray(link.scope?.templateIds) || link.scope.templateIds.length === 0) return
    if (!link.scope.templateIds.includes(templateId)) {
      throw new Error('Portal link cannot access this form.')
    }
  }

  function assertPortalUploadScope(link, category) {
    if (!Array.isArray(link.scope?.uploadCategories) || link.scope.uploadCategories.length === 0) return
    if (!link.scope.uploadCategories.includes(category || 'general')) {
      throw new Error('Portal link cannot upload this category.')
    }
  }

  function consumePortalLinkUse(link) {
    link.usedCount = Number(link.usedCount || 0) + 1
    link.lastUsedAt = now()
  }

  function normalizeMalwareScan(scan = {}) {
    const status = String(scan.status || 'pending').toLowerCase()
    const allowedStatus = new Set(['pending', 'clean', 'infected'])
    const normalizedStatus = allowedStatus.has(status) ? status : 'pending'
    return {
      status: normalizedStatus,
      provider: scan.provider || null,
      reference: scan.reference || null,
      checkedAt: scan.checkedAt || now()
    }
  }

  async function applyLifecyclePolicies() {
    const policy = objectStorage.retentionPolicies
    const nowMs = Date.now()

    for (const upload of state.documentUploads) {
      const object = upload.object
      if (!object?.bucket || !object?.key) continue
      const ageDays = daysBetween(upload.createdAt, nowMs)
      if (ageDays >= policy.uploaded_document.purgeAfterDays) {
        await objectStorage.deleteObject(object).catch(() => null)
        upload.status = 'purged'
        upload.purgedAt = now()
      } else if (ageDays >= policy.uploaded_document.archiveAfterDays && upload.status !== 'archived') {
        upload.status = 'archived'
        upload.archivedAt = now()
      }
    }

    for (const job of state.exportJobs) {
      const object = job.output?.object
      if (!object?.bucket || !object?.key) continue
      const ageDays = daysBetween(job.updatedAt || job.createdAt, nowMs)
      if (ageDays >= policy.export_artifact.purgeAfterDays) {
        await objectStorage.deleteObject(object).catch(() => null)
        job.status = job.status === 'completed' ? 'purged' : job.status
        job.output = { ...job.output, purgedAt: now() }
      } else if (ageDays >= policy.export_artifact.archiveAfterDays && !job.output.archivedAt) {
        job.output = { ...job.output, archivedAt: now() }
      }
    }

    persist()
  }
  let testHooks = {}

  const kmsAdapter = runtime.piiKeyProvider === 'kms' ? createRuntimeKmsAdapter(runtime) : null
  const keyProvider = piiKeyProvider || createKeyProvider(runtime, { kmsAdapter })
  const piiService = piiCrypto || new PiiCryptoService({ keyProvider })

  function encryptSensitiveValue(value) {
    return piiService.encrypt(value)
  }

  function decryptSensitiveValue(payload) {
    return piiService.decrypt(payload)
  }

  function persist() {
    migrateTemplateSystems(state)
    if (typeof testHooks.beforePersist === 'function') {
      testHooks.beforePersist(state)
    }
    saveState(state)
  }

  function getBoardVersion(firmId) {
    if (!state.boardVersions || typeof state.boardVersions !== 'object') {
      state.boardVersions = {}
    }
    if (!state.boardVersions[firmId]) {
      state.boardVersions[firmId] = 1
    }
    return state.boardVersions[firmId]
  }

  function bumpBoardVersion(firmId) {
    const current = getBoardVersion(firmId)
    state.boardVersions[firmId] = current + 1
    return state.boardVersions[firmId]
  }

  function listProspectsByStage(firmId, stage, excludedProfileId = null) {
    return state.profiles
      .filter(
        (profile) =>
          profile.firmId === firmId &&
          profile.kind === 'prospect' &&
          profile.stage === stage &&
          profile.id !== excludedProfileId
      )
      .sort((a, b) => {
        const indexDiff = profileOrderIndex(a) - profileOrderIndex(b)
        if (indexDiff !== 0) return indexDiff
        const updatedDiff =
          parseIso(a.updatedAt || a.createdAt || 0) - parseIso(b.updatedAt || b.createdAt || 0)
        if (updatedDiff !== 0) return updatedDiff
        return a.id.localeCompare(b.id)
      })
  }

  function compactStageIndices(firmId, stage) {
    const cards = listProspectsByStage(firmId, stage)
    let changed = false
    cards.forEach((card, index) => {
      const nextIndex = index + 1
      if (profileOrderIndex(card) !== nextIndex) {
        assignProspectOrderIndex(card, nextIndex)
        changed = true
      }
    })
    return changed
  }

  function normalizePipelineIndices(firmId, stage = null) {
    const stages = stage ? [stage] : BOARD_COLUMNS
    const normalizedStages = []
    for (const currentStage of stages) {
      if (compactStageIndices(firmId, currentStage)) {
        normalizedStages.push(currentStage)
      }
    }
    return normalizedStages
  }

  function buildBoardPayload(user, conflict = null) {
    const columns = BOARD_COLUMNS.map((stage) => ({
      stage,
      orderingVersion: getBoardVersion(user.firmId),
      cards: listProspectsByStage(user.firmId, stage)
    }))
    return {
      boardVersion: getBoardVersion(user.firmId),
      generatedAt: now(),
      ordering: {
        mode: 'sequential_stage_index',
        normalized: true
      },
      conflict,
      columns
    }
  }

  function executePipelineTransaction(mutator) {
    const snapshot = {
      profiles: state.profiles.map((profile) => ({ ...profile })),
      stageChangesLength: state.stageChanges.length,
      auditEventsLength: state.auditEvents.length,
      boardVersions: { ...(state.boardVersions || {}) }
    }
    try {
      const result = mutator()
      persist()
      return result
    } catch (error) {
      state.profiles = snapshot.profiles
      state.stageChanges = state.stageChanges.slice(0, snapshot.stageChangesLength)
      state.auditEvents = state.auditEvents.slice(0, snapshot.auditEventsLength)
      state.boardVersions = snapshot.boardVersions
      throw error
    }
  }

  function createSession(user) {
    const token = randomUUID()
    state.sessions.push({
      token,
      userId: user.id,
      firmId: user.firmId,
      createdAt: now(),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
    })
    persist()
    return { token, user: publicUser(user) }
  }

  function pruneExpiredSessions() {
    const cutoff = Date.now()
    const nextSessions = state.sessions.filter((entry) => new Date(entry.expiresAt).getTime() > cutoff)
    if (nextSessions.length !== state.sessions.length) {
      state.sessions = nextSessions
      persist()
    }
  }

  function publicUser(user) {
    return {
      id: user.id,
      firmId: user.firmId,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role
    }
  }

  function requireUser(token) {
    pruneExpiredSessions()
    const session = state.sessions.find((entry) => entry.token === token)
    if (!session) throw new Error('Authentication required.')
    const user = state.users.find((entry) => entry.id === session.userId && entry.firmId === session.firmId)
    if (!user) throw new Error('Authentication required.')
    return publicUser(user)
  }

  function addAudit(firmId, actorUserId, entityType, entityId, action, changeSet = {}, options = {}) {
    const metadataOnly = !('before' in changeSet) && !('after' in changeSet)
    const event = createCanonicalAuditEvent({
      actor: { userId: actorUserId || null },
      firmId,
      entityType,
      entityId,
      action,
      before: metadataOnly ? null : (changeSet.before ?? null),
      after: metadataOnly ? (changeSet || null) : (changeSet.after ?? null),
      requestId: options.requestId || null,
      ip: options.ip || null,
      timestamp: now()
    })
    state.auditEvents.push(event)
    if (options.persist !== false) {
      persist()
    }
  }

  function requireClientProfile(user) {
    requirePermission(user, 'portal:read')
    const profile = state.profiles.find(
      (entry) =>
        entry.firmId === user.firmId &&
        entry.kind === 'client' &&
        entry.email &&
        entry.email.toLowerCase() === user.email.toLowerCase()
    )
    if (!profile) throw new Error('Client profile not found.')
    return profile
  }

  function createAuthProvider() {
    const common = { state, persist, createSession, addAudit }
    if (runtime.authProvider === 'local') return createLocalAuthProvider(common)
    if (runtime.authProvider === 'oidc') return createOidcAuthProvider(common)
    if (runtime.authProvider === 'saml') return createSamlAuthProvider(common)
    throw new Error(`Unsupported auth provider: ${runtime.authProvider}.`)
  }

  const auth = createAuthService({ provider: createAuthProvider() })

  return {
    state,
    assertPermission(user, permission) {
      requirePermission(user, permission)
      return true
    },
    auth,
    register(input) {
      return auth.register(input)
    },
    login(input) {
      return auth.login(input)
    },
    requireUser,
    getDashboard(user) {
      requirePermission(user, 'profiles:read')
      const profiles = state.profiles.filter((profile) => profile.firmId === user.firmId)
      const prospects = profiles.filter((profile) => profile.kind === 'prospect')
      const clients = profiles.filter((profile) => profile.kind === 'client')
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
        recentAuditEvents: state.auditEvents
          .filter((event) => event.firmId === user.firmId)
          .slice(-10)
          .reverse()
      }
    },
    listProfiles(user, kind, search = '') {
      requirePermission(user, 'profiles:read')
      const q = String(search || '').toLowerCase()
      return state.profiles
        .filter((profile) => profile.firmId === user.firmId)
        .filter((profile) => !kind || profile.kind === kind)
        .filter(
          (profile) => !q || `${profile.firstName} ${profile.lastName} ${profile.email || ''}`.toLowerCase().includes(q)
        )
        .sort((a, b) =>
          (a.stage || '').localeCompare(b.stage || '') ||
          (profileOrderIndex(a) - profileOrderIndex(b)) ||
          (parseIso(a.updatedAt || a.createdAt) - parseIso(b.updatedAt || b.createdAt)) ||
          a.id.localeCompare(b.id)
        )
    },
    getProfileDetail(user, profileId) {
      requirePermission(user, 'profiles:read')
      const profile = state.profiles.find((entry) => entry.id === profileId && entry.firmId === user.firmId)
      if (!profile) throw new Error('Profile not found.')
      const household = profile.householdId
        ? state.households.find((entry) => entry.id === profile.householdId && entry.firmId === user.firmId)
        : null
      const householdMembers = household
        ? state.householdMembers.filter((entry) => entry.householdId === household.id && entry.firmId === user.firmId)
        : []
      const submissions = state.formSubmissions.filter(
        (entry) => entry.clientId === profile.id && entry.firmId === user.firmId
      )
      const stageHistory = state.stageChanges.filter(
        (entry) => entry.clientId === profile.id && entry.firmId === user.firmId
      )
      const notes = state.notes
        .filter((entry) => entry.profileId === profile.id && entry.firmId === user.firmId)
        .slice()
        .reverse()
        .map((entry) => ({ ...entry, body: entry.body || decryptSensitiveValue(entry.bodyEncrypted) || '' }))
      return { profile, household, householdMembers, submissions, stageHistory, notes }
    },
    createProfile(user, input) {
      requirePermission(user, 'profiles:write')
      const createdAt = now()
      const inStage = state.profiles.filter(
        (profile) =>
          profile.firmId === user.firmId &&
          profile.kind === 'prospect' &&
          profile.stage === (input.stage || 'discovery')
      ).length
      const profile = {
        pii: {
          maskingPolicy: 'role_based',
          ssnEncrypted: encryptSensitiveValue(input.ssn),
          taxIdEncrypted: encryptSensitiveValue(input.taxId),
          dobEncrypted: encryptSensitiveValue(input.dateOfBirth || '')
        },
        id: randomUUID(),
        firmId: user.firmId,
        advisorUserId: user.id,
        kind: input.kind,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email || '',
        phone: input.phone || '',
        dateOfBirth: '',
        source: input.source ? { ...input.source, displayValue: sourceDisplay(input.source) } : null,
        status: input.status || (input.kind === 'client' ? 'active' : 'new'),
        stage: input.kind === 'prospect' ? input.stage || 'discovery' : null,
        stageOrderIndex: input.kind === 'prospect' ? inStage + 1 : null,
        orderIndex: input.kind === 'prospect' ? inStage + 1 : null,
        pipelineVersion: input.kind === 'prospect' ? 1 : null,
        address: input.address || {},
        financialSummary: normalizeFinancialSummary(input.financialSummary, input.extensions || {}),
        extensions: normalizeExtensions(
          input.extensions || {
            schemaVersion: '1.0.0',
            values: input.customProfile || {}
          }
        ),
        householdId: input.householdId || null,
        spouseClientId: input.spouseClientId || null,
        createdAt,
        updatedAt: createdAt
      }
      state.profiles.push(profile)
      if (profile.stage) {
        state.stageChanges.push({
          id: randomUUID(),
          firmId: user.firmId,
          clientId: profile.id,
          toStage: profile.stage,
          changedByUserId: user.id,
          changedAt: createdAt
        })
      }
      addAudit(user.firmId, user.id, 'profile', profile.id, 'profile.created', { kind: profile.kind })
      persist()
      return profile
    },
    updateProfile(user, profileId, patch) {
      const firmContext = requireFirmContext(user, { method: 'store.updateProfile' })
      requirePermission(user, 'profiles:write')
      if (patch.kind === 'client') {
        patch.stage = null
        patch.stageOrderIndex = null
        patch.orderIndex = null
      }
      if (patch.kind === 'prospect' && !patch.stage) {
        patch.stage = 'discovery'
      }
      const profile = validateEntityOwnership(
        firmContext,
        state.profiles.find((entry) => entry.id === profileId),
        { entityName: 'Profile' }
      )
      const nextPatch = { ...patch }
      if ('ssn' in nextPatch) {
        profile.pii = {
          ...(profile.pii || { maskingPolicy: 'role_based' }),
          ssnEncrypted: encryptSensitiveValue(nextPatch.ssn),
          taxIdEncrypted: profile.pii?.taxIdEncrypted || profile.pii?.taxIdCiphertext || null
        }
        delete nextPatch.ssn
      }
      if ('taxId' in nextPatch) {
        profile.pii = {
          ...(profile.pii || { maskingPolicy: 'role_based' }),
          ssnEncrypted: profile.pii?.ssnEncrypted || profile.pii?.ssnCiphertext || null,
          taxIdEncrypted: encryptSensitiveValue(nextPatch.taxId)
        }
        delete nextPatch.taxId
      }
      if ('source' in nextPatch && nextPatch.source) {
        nextPatch.source = { ...nextPatch.source, displayValue: sourceDisplay(nextPatch.source) }
      }
      if ('extensions' in nextPatch) {
        nextPatch.extensions = normalizeExtensions(nextPatch.extensions)
      }
      if ('customProfile' in nextPatch && !('extensions' in nextPatch)) {
        nextPatch.extensions = normalizeExtensions({
          schemaVersion: '1.0.0',
          values: nextPatch.customProfile || {}
        })
      }
      if ('financialSummary' in nextPatch || 'extensions' in nextPatch) {
        nextPatch.financialSummary = normalizeFinancialSummary(
          nextPatch.financialSummary || profile.financialSummary || {},
          nextPatch.extensions || profile.extensions || {}
        )
      }
      if ('customProfile' in nextPatch) delete nextPatch.customProfile
      Object.assign(profile, nextPatch, { updatedAt: now() })
      addAudit(user.firmId, user.id, 'profile', profileId, 'profile.updated', { fields: Object.keys(patch) })
      persist()
      return profile
    },
    moveProfileStage(user, profileId, stage, beforeProfileId = null) {
      return this.reorderBoard(user, { profileId, toStage: stage, beforeProfileId })
    },
    reorderBoard(user, input) {
      requirePermission(user, 'pipeline:write')
      const {
        profileId,
        toStage,
        beforeProfileId = null,
        expectedVersion = null,
        expectedUpdatedAt = null,
        expectedBoardVersion = null
      } = input || {}
      if (!profileId || !toStage) {
        throw new Error('Reorder payload must include profileId and toStage.')
      }
      if (!BOARD_COLUMNS.includes(toStage)) {
        throw new Error(`Unknown stage: ${toStage}.`)
      }

      try {
        return executePipelineTransaction(() => {
          const profile = state.profiles.find((entry) => entry.id === profileId && entry.firmId === user.firmId)
          if (!profile) throw new Error('Profile not found.')

          const currentVersion = Number(profile.pipelineVersion || 1)
          if (expectedVersion !== null && Number(expectedVersion) !== currentVersion) {
            throw pipelineConflict('Profile ordering version mismatch.', {
              profileId,
              expectedVersion: Number(expectedVersion),
              actualVersion: currentVersion,
              profileUpdatedAt: profile.updatedAt
            })
          }
          if (expectedUpdatedAt && String(expectedUpdatedAt) !== String(profile.updatedAt)) {
            throw pipelineConflict('Profile updatedAt mismatch.', {
              profileId,
              expectedUpdatedAt,
              actualUpdatedAt: profile.updatedAt
            })
          }
          const boardVersion = getBoardVersion(user.firmId)
          if (expectedBoardVersion !== null && Number(expectedBoardVersion) !== Number(boardVersion)) {
            throw pipelineConflict('Board version mismatch.', {
              expectedBoardVersion: Number(expectedBoardVersion),
              actualBoardVersion: Number(boardVersion)
            })
          }

          const destinationCards = listProspectsByStage(user.firmId, toStage, profile.id)
          let insertIndex = destinationCards.length
          if (beforeProfileId) {
            insertIndex = destinationCards.findIndex((entry) => entry.id === beforeProfileId)
            if (insertIndex < 0) {
              throw new Error('beforeProfileId was not found in the destination stage.')
            }
          }

          const previousStage = profile.stage || null
          const movedAt = now()
          profile.kind = 'prospect'
          profile.stage = toStage
          profile.updatedAt = movedAt
          profile.pipelineVersion = currentVersion + 1

          destinationCards.splice(insertIndex, 0, profile)
          destinationCards.forEach((card, index) => {
            assignProspectOrderIndex(card, index + 1)
          })

          if (previousStage && previousStage !== toStage) {
            compactStageIndices(user.firmId, previousStage)
          }

          normalizePipelineIndices(user.firmId, toStage)
          const normalized = normalizePipelineIndices(user.firmId, previousStage)
          if (normalized.length > 0) {
            addAudit(
              user.firmId,
              user.id,
              'pipeline',
              profile.id,
              'pipeline.indices_normalized',
              { stages: normalized },
              { persist: false }
            )
          }
          bumpBoardVersion(user.firmId)
          state.stageChanges.push({
            id: randomUUID(),
            firmId: user.firmId,
            clientId: profile.id,
            fromStage: previousStage,
            toStage,
            changedByUserId: user.id,
            changedAt: movedAt
          })
          addAudit(
            user.firmId,
            user.id,
            'profile',
            profile.id,
            'pipeline.stage_changed',
            { fromStage: previousStage, toStage, beforeProfileId },
            { persist: false }
          )
          return {
            moved: profile,
            board: buildBoardPayload(user),
            conflict: null
          }
        })
      } catch (error) {
        if (error?.code === 'PIPELINE_ORDER_CONFLICT') {
          error.details = {
            ...(error.details || {}),
            serverBoard: buildBoardPayload(user, {
              code: error.code,
              message: error.message
            })
          }
        }
        throw error
      }
    },
    normalizeBoardOrdering(user) {
      requirePermission(user, 'pipeline:write')
      return executePipelineTransaction(() => {
        const normalizedStages = normalizePipelineIndices(user.firmId)
        if (normalizedStages.length > 0) {
          bumpBoardVersion(user.firmId)
          addAudit(
            user.firmId,
            user.id,
            'pipeline',
            user.firmId,
            'pipeline.indices_normalized',
            { stages: normalizedStages },
            { persist: false }
          )
        }
        return {
          normalizedStages,
          board: buildBoardPayload(user),
          changed: normalizedStages.length > 0
        }
      })
    },
    getBoard(user) {
      requirePermission(user, 'profiles:read')
      normalizePipelineIndices(user.firmId)
      return buildBoardPayload(user)
    },
    listStageHistory(user, profileId) {
      requirePermission(user, 'profiles:read')
      return state.stageChanges.filter((entry) => entry.firmId === user.firmId && entry.clientId === profileId)
    },
    createHousehold(user, input) {
      requirePermission(user, 'households:write')
      const household = {
        id: randomUUID(),
        firmId: user.firmId,
        name: input.name,
        primaryClientId: input.primaryClientId,
        createdAt: now()
      }
      state.households.push(household)
      state.householdMembers.push({
        householdId: household.id,
        clientId: input.primaryClientId,
        role: 'primary',
        firmId: user.firmId,
        createdAt: household.createdAt
      })
      const profile = state.profiles.find((entry) => entry.id === input.primaryClientId && entry.firmId === user.firmId)
      if (profile) profile.householdId = household.id
      addAudit(user.firmId, user.id, 'household', household.id, 'household.created', { name: household.name })
      persist()
      return household
    },
    addHouseholdMember(user, householdId, input) {
      const firmContext = requireFirmContext(user, { method: 'store.addHouseholdMember' })
      requirePermission(user, 'households:write')
      const household = validateEntityOwnership(
        firmContext,
        state.households.find((entry) => entry.id === householdId),
        { entityName: 'Household' }
      )
      const member = { householdId, clientId: input.clientId, role: input.role, firmId: user.firmId, createdAt: now() }
      state.householdMembers.push(member)
      const profile = state.profiles.find((entry) => entry.id === input.clientId && entry.firmId === user.firmId)
      if (profile) profile.householdId = householdId
      addAudit(user.firmId, user.id, 'household', householdId, 'household.member_added', input)
      persist()
      return member
    },
    listHouseholds(user) {
      requirePermission(user, 'profiles:read')
      return state.households
        .filter((entry) => entry.firmId === user.firmId)
        .map((household) => ({
          ...household,
          members: state.householdMembers.filter(
            (member) => member.firmId === user.firmId && member.householdId === household.id
          )
        }))
    },
    listNotes(user, profileId) {
      requirePermission(user, 'profiles:read')
      return state.notes
        .filter((entry) => entry.firmId === user.firmId && entry.profileId === profileId)
        .slice()
        .reverse()
        .map((entry) => ({ ...entry, body: entry.body || decryptSensitiveValue(entry.bodyEncrypted) || '' }))
    },
    addNote(user, profileId, body) {
      requirePermission(user, 'profiles:write')
      const profile = state.profiles.find((entry) => entry.id === profileId && entry.firmId === user.firmId)
      if (!profile) throw new Error('Profile not found.')
      const note = {
        id: randomUUID(),
        firmId: user.firmId,
        profileId,
        body: '',
        bodyEncrypted: encryptSensitiveValue(body),
        createdByUserId: user.id,
        createdAt: now()
      }
      state.notes.push(note)
      addAudit(user.firmId, user.id, 'profile_note', note.id, 'profile.note_added', { profileId })
      persist()
      return note
    },
    listTemplateAggregates(user, filters = {}) {
      requirePermission(user, 'profiles:read')
      const kind = filters.kind || null
      return state.templateAggregates.filter((entry) => {
        if (entry.firmId !== user.firmId) return false
        if (kind === 'form') return entry.kind === 'form'
        if (kind === 'document') return entry.kind !== 'form'
        return true
      })
    },
    createTemplateAggregate(user, input) {
      const createdAt = now()
      const formSchema = validateFormDefinitionSchema({ sections: input.sections || [] }, { contextPath: '/sections' }).schema
      const template = normalizeTemplateAggregate(
        {
          id: randomUUID(),
          firmId: user.firmId,
          kind,
          name: input.name,
          description: input.description || '',
          formSchema,
          blueprint: { sections: [] },
          mappings: [],
          publishState: 'draft',
          versions: [
            {
              version: 1,
              event: 'created',
              formSchema,
              blueprint: { sections: [] },
              mappings: [],
              publishState: 'draft',
              createdAt,
              actorUserId: user.id
            }
          ],
          createdAt,
          updatedAt: createdAt
        },
        kind
      )
      state.templateAggregates.push(template)
      addAudit(user.firmId, user.id, 'template_aggregate', template.id, 'template_aggregate.created', {
        kind: template.kind,
        name: template.name
      })
      persist()
      return template
    },
    updateTemplateAggregate(user, templateId, patch = {}) {
      requirePermission(user, 'templates:write')
      const template = state.templateAggregates.find((entry) => entry.id === templateId && entry.firmId === user.firmId)
      if (!template) throw new Error('Template not found.')
      if (patch.mappings) {
        template.mappings = patch.mappings
        template.mappingRules = patch.mappings
      }
      if (patch.formSchema) template.formSchema = patch.formSchema
      if (patch.blueprint) template.blueprint = patch.blueprint
      if (Array.isArray(patch.extractedFields)) template.extractedFields = patch.extractedFields
      if (typeof patch.description === 'string') template.description = patch.description
      template.versions.push(
        createTemplateVersion(template, 'updated', {
          mappings: template.mappings,
          blueprint: template.blueprint,
          formSchema: template.formSchema,
          diff: { patchApplied: true },
          actorUserId: user.id
        })
      )
      template.updatedAt = now()
      persist()
      return template
    },
    transitionTemplateLifecycle(user, templateId, nextState) {
      requirePermission(user, 'templates:write')
      const template = state.templateAggregates.find((entry) => entry.id === templateId && entry.firmId === user.firmId)
      if (!template) throw new Error('Template not found.')
      const allowed = new Set(['draft', 'published', 'archived'])
      if (!allowed.has(nextState)) throw new Error('Invalid publish state.')
      const previousState = template.publishState || 'draft'
      template.publishState = nextState
      template.status = nextState
      template.publishTransitions ||= []
      template.publishTransitions.push({ from: previousState, to: nextState, at: now(), actorUserId: user.id })
      template.versions.push(
        createTemplateVersion(template, `lifecycle_${nextState}`, {
          publishState: nextState,
          diff: { publishTransition: { from: previousState, to: nextState } },
          actorUserId: user.id
        })
      )
      template.updatedAt = now()
      persist()
      return template
    },
    listFormTemplates(user) {
      return this.listTemplateAggregates(user, { kind: 'form' }).map(formTemplateAdapter)
    },
    createFormTemplate(user, input) {
      const template = this.createTemplateAggregate(user, {
        kind: 'form',
        name: input.name,
        description: input.description || '',
        formSchema: { sections: input.sections || [] },
        blueprint: { sections: [] },
        mappings: []
      })
      return formTemplateAdapter(template)
    },
    listFormSubmissions(user, status = null) {
      requirePermission(user, 'profiles:read')
      const currentTime = Date.now()
      return state.formSubmissions
        .filter((entry) => entry.firmId === user.firmId)
        .filter((entry) => !status || entry.status === status)
        .map((entry) => {
          if (entry.lock && parseIso(entry.lock.expiresAt) <= currentTime) {
            return { ...entry, lock: null }
          }
          return entry
        })
        .slice()
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
    },
    getClientWorkspace(user) {
      const profile = requireClientProfile(user)
      const submissions = state.formSubmissions
        .filter((entry) => entry.firmId === user.firmId && entry.clientId === profile.id)
        .slice()
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
      const templatesFromAggregates = state.templateAggregates
        .filter((entry) => entry.firmId === user.firmId && entry.kind === 'form')
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          description: entry.description || '',
          sections: entry.formSchema?.sections || []
        }))
      const uploads = state.documentUploads
        .filter((entry) => entry.firmId === user.firmId && entry.clientId === profile.id)
        .slice()
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
      const submissionByTemplate = new Map()
      submissions.forEach((submission) => {
        if (!submissionByTemplate.has(submission.templateId))
          submissionByTemplate.set(submission.templateId, submission.status)
      })
      const templateProgress = templatesFromAggregates.map((template) => ({
        templateId: template.id,
        templateName: template.name,
        status: submissionByTemplate.get(template.id) || 'not_started'
      }))
      return { profile, submissions, templates: templatesFromAggregates, templateProgress, uploads }
    },
    submitClientForm(user, input) {
      requirePermission(user, 'client:write')
      const profile = requireClientProfile(user)
      const template = state.templateAggregates.find(
        (entry) => entry.id === input.templateId && entry.firmId === user.firmId && entry.kind === 'form'
      )
      if (!template) throw new Error('Form template not found.')
      const status = input.status === 'draft' ? 'draft' : 'submitted'
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
      }
      state.formSubmissions.push(submission)
      addAudit(user.firmId, user.id, 'form_submission', submission.id, 'client.form_submission.created', {
        templateId: input.templateId,
        status
      })
      persist()
      return submission
    },
    async createClientUploadPresign(user, input) {
      requirePermission(user, 'client:write')
      const profile = requireClientProfile(user)
      const intent = createUploadIntent({
        firmId: user.firmId,
        clientId: profile.id,
        fileName: input.fileName,
        contentType: input.contentType,
        checksum: input.checksum,
        category: input.category,
        source: 'client',
        retentionClass: input.retentionClass
      })
      const presigned = await objectStorage.createPresignedUploadUrl({
        ...intent.object,
        expiresInSeconds: Number(input.expiresInSeconds || 900)
      })
      persist()
      return { uploadId: intent.id, object: intent.object, presigned }
    },
    submitClientUpload(user, input) {
      requirePermission(user, 'client:write')
      const profile = requireClientProfile(user)
      const intent = input.uploadId
        ? state.pendingUploadIntents.find((entry) => entry.id === input.uploadId && entry.firmId === user.firmId)
        : null
      const object = normalizeObjectMetadata(input.object || intent?.object || {}, input.retentionClass || 'uploaded_document')
      const malwareScan = normalizeMalwareScan(input.malwareScan)
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
        malwareScan,
        object,
        createdAt: now(),
        updatedAt: now()
      }
      state.pendingUploadIntents = state.pendingUploadIntents.filter((entry) => entry.id !== input.uploadId)
      state.documentUploads.push(upload)
      addAudit(user.firmId, user.id, 'document_upload', upload.id, 'client.document_upload.created', {
        category: upload.category,
        key: upload.object.key
      })
      persist()
      return upload
    },
    async createClientUploadDownloadUrl(user, uploadId) {
      requirePermission(user, 'client:write')
      const profile = requireClientProfile(user)
      const upload = state.documentUploads.find(
        (entry) => entry.id === uploadId && entry.firmId === user.firmId && entry.clientId === profile.id
      )
      if (!upload) throw new Error('Upload not found.')
      return objectStorage.createPresignedDownloadUrl({ ...upload.object, expiresInSeconds: 900 })
    },
    listFormDrafts(user) {
      return this.listFormSubmissions(user, 'draft')
    },
    createFormSubmission(user, input) {
      requirePermission(user, 'forms:write')
      const status = input.status || 'draft'
      const createdAt = now()
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
      }
      state.formSubmissions.push(submission)
      addAudit(user.firmId, user.id, 'form_submission', submission.id, 'form_submission.created', {
        templateId: input.templateId,
        clientId: input.clientId
      })
      persist()
      return submission
    },
    acquireDraftLock(user, submissionId, input = {}) {
      requirePermission(user, 'forms:write')
      const submission = state.formSubmissions.find(
        (entry) => entry.id === submissionId && entry.firmId === user.firmId && entry.status === 'draft'
      )
      if (!submission) throw new Error('Draft submission not found.')

      const nowTime = Date.now()
      const leaseMs = Math.max(5_000, Math.min(120_000, Number(input.leaseMs || 30_000)))
      const existing = submission.lock
      const active = existing && parseIso(existing.expiresAt) > nowTime
      const force = input.force === true
      if (active && existing.holderUserId !== user.id && !force) {
        return {
          ok: false,
          conflict: true,
          reason: 'Draft is currently locked by another advisor.',
          lock: existing,
          revisionId: submission.revisionId || 1
        }
      }

      const lock = {
        leaseId: randomUUID(),
        holderUserId: user.id,
        acquiredAt: now(),
        expiresAt: new Date(nowTime + leaseMs).toISOString(),
        leaseMs
      }
      submission.lock = lock
      submission.updatedAt = now()
      addAudit(user.firmId, user.id, 'form_submission', submission.id, 'form_submission.lock_acquired', {
        leaseMs,
        force
      })
      persist()
      return { ok: true, lock, revisionId: submission.revisionId || 1 }
    },
    releaseDraftLock(user, submissionId, leaseId = '') {
      requirePermission(user, 'forms:write')
      const submission = state.formSubmissions.find(
        (entry) => entry.id === submissionId && entry.firmId === user.firmId && entry.status === 'draft'
      )
      if (!submission) throw new Error('Draft submission not found.')
      const existing = submission.lock
      if (!existing) return { ok: true, released: false }
      if (existing.holderUserId !== user.id && leaseId && existing.leaseId !== leaseId) {
        throw new Error('Cannot release lock held by another advisor.')
      }
      submission.lock = null
      submission.updatedAt = now()
      addAudit(user.firmId, user.id, 'form_submission', submission.id, 'form_submission.lock_released', {})
      persist()
      return { ok: true, released: true }
    },
    reviseDraftSubmission(user, submissionId, input = {}) {
      requirePermission(user, 'forms:write')
      const submission = state.formSubmissions.find(
        (entry) => entry.id === submissionId && entry.firmId === user.firmId && entry.status === 'draft'
      )
      if (!submission) throw new Error('Draft submission not found.')

      const currentRevision = Number(submission.revisionId || 1)
      const expectedRevision = Number(input.expectedRevisionId || 0)
      if (!Number.isFinite(expectedRevision) || expectedRevision < 1) {
        throw new Error('expectedRevisionId is required.')
      }

      const lock = submission.lock
      const lockActive = lock && parseIso(lock.expiresAt) > Date.now()
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
        }
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
        }
      }

      submission.data = input.data && typeof input.data === 'object' ? input.data : {}
      submission.revisionId = currentRevision + 1
      submission.updatedAt = now()
      if (input.status === 'submitted') {
        submission.status = 'submitted'
        submission.lock = null
      } else {
        submission.lock = {
          ...lock,
          expiresAt: new Date(Date.now() + Number(lock.leaseMs || 30_000)).toISOString()
        }
      }
      addAudit(user.firmId, user.id, 'form_submission', submission.id, 'form_submission.draft_revised', {
        revisionId: submission.revisionId,
        submitted: submission.status === 'submitted'
      })
      persist()
      return { ok: true, submission }
    },
    listDocumentTemplates(user) {
      return this.listTemplateAggregates(user, { kind: 'document' }).map(documentTemplateAdapter)
    },
    createDocumentTemplate(user, input) {
      requirePermission(user, 'templates:write')
      const createdAt = now()
      const formSchemaResult = validateFormDefinitionSchema(input.formSchema || { sections: [] }, { contextPath: '/formSchema' })
      const mappings = validateMappingRules(input.mappings || [], {
        contextPath: '/mappings',
        repeaterPaths: formSchemaResult.repeaterPaths
      })
      const template = normalizeTemplateAggregate(
        {
          id: randomUUID(),
          firmId: user.firmId,
          kind: 'document',
          name: input.name,
          description: input.description || '',
          documentMetadata: { fileName: input.fileName || 'template.pdf' },
          blueprint: input.blueprint || { sections: [] },
          mappings,
          formSchema: formSchemaResult.schema,
          publishState: 'draft',
          versions: [
            {
              version: 1,
              event: 'created',
              blueprint: input.blueprint || { sections: [] },
              mappings,
              formSchema: formSchemaResult.schema,
              publishState: 'draft',
              createdAt,
              actorUserId: user.id
            }
          ],
          createdAt,
          updatedAt: createdAt
        },
        'document'
      )
      state.templateAggregates.push(template)
      addAudit(user.firmId, user.id, 'template_aggregate', template.id, 'document_template.created', {
        name: template.name
      })
      return documentTemplateAdapter(template)
    },
    updateTemplateMappings(user, templateId, mappings, input = {}) {
      requirePermission(user, 'templates:write')
      const expectedVersionHash = input.expectedVersionHash || null
      const template = state.templateAggregates.find(
        (entry) => entry.id === templateId && entry.firmId === user.firmId && entry.kind !== 'form'
      )
      if (!template) throw new Error('Template not found.')
      const currentHash = templateVersionHash(template)
      if (expectedVersionHash && expectedVersionHash !== currentHash) {
        const error = new Error('Template has changed since last load.')
        error.statusCode = 409
        error.code = 'TEMPLATE_VERSION_CONFLICT'
        error.details = { expectedVersionHash, currentVersionHash: currentHash }
        throw error
      }
      template.mappings = mappings || []
      template.mappingRules = template.mappings
      template.versions.push(
        createTemplateVersion(template, 'mappings_updated', {
          mappings: template.mappings,
          diff: { mappings: { changed: true } },
          actorUserId: user.id
        })
      )
      template.updatedAt = now()
      addAudit(user.firmId, user.id, 'template_aggregate', template.id, 'document_template.mappings_updated', {
        before: { mappings: previousMappings, count: previousMappings.length },
        after: { mappings: deepClone(template.mappings), count: template.mappings.length }
      })
      persist()
      return documentTemplateAdapter(template)
    },
    publishTemplate(user, templateId, input = {}) {
      requirePermission(user, 'templates:write')
      const template = validateEntityOwnership(
        firmContext,
        state.templateAggregates.find((entry) => entry.id === templateId && entry.kind !== 'form'),
        { entityName: 'Template' }
      )
      if (!template) throw new Error('Template not found.')
      const previousState = normalizeTemplateState(template.publishState || 'draft')
      if (!input.versionBump || !String(input.versionBump).trim()) {
        throw new Error('Publish requires versionBump.')
      }
      if (!input.changelog || !String(input.changelog).trim()) {
        throw new Error('Publish requires changelog.')
      }
      template.publishState = 'published'
      template.status = 'published'
      template.publishTransitions ||= []
      template.publishTransitions.push({ from: previousState, to: 'published', at: now(), actorUserId: user.id })
      const versionHash = templateVersionHash(template)
      template.versions.push(
        createTemplateVersion(template, 'published', {
          publishState: 'published',
          immutable: true,
          changelog: {
            versionBump: String(input.versionBump),
            body: String(input.changelog).trim()
          },
          versionHash,
          diff: {
            publishTransition: { from: previousState, to: 'published' },
            versionBump: String(input.versionBump)
          },
          actorUserId: user.id
        })
      )
      template.updatedAt = now()
      addAudit(user.firmId, user.id, 'template_aggregate', template.id, 'document_template.published', {
        before: { publishState: previousState },
        after: { publishState: 'published' }
      })
      persist()
      return documentTemplateAdapter(template)
    },
    compareTemplateVersions(user, templateId, baseVersion, targetVersion) {
      requirePermission(user, 'templates:write')
      const template = state.templateAggregates.find(
        (entry) => entry.id === templateId && entry.firmId === user.firmId && entry.kind !== 'form'
      )
      if (!template) throw new Error('Template not found.')
      const versions = template.versions || []
      const base = versions.find((entry) => Number(entry.version) === Number(baseVersion))
      const target = versions.find((entry) => Number(entry.version) === Number(targetVersion))
      if (!base || !target) throw new Error('Template version not found.')
      return {
        templateId,
        baseVersion: Number(base.version),
        targetVersion: Number(target.version),
        changed: stableSerialize(base.blueprint) !== stableSerialize(target.blueprint) ||
          stableSerialize(base.mappings) !== stableSerialize(target.mappings) ||
          base.publishState !== target.publishState,
        diff: {
          blueprintChanged: stableSerialize(base.blueprint) !== stableSerialize(target.blueprint),
          mappingsChanged: stableSerialize(base.mappings) !== stableSerialize(target.mappings),
          publishStateChanged: base.publishState !== target.publishState
        },
        base,
        target
      }
    },
    revertTemplateVersion(user, templateId, targetVersion, input = {}) {
      requirePermission(user, 'templates:write')
      const template = state.templateAggregates.find(
        (entry) => entry.id === templateId && entry.firmId === user.firmId && entry.kind !== 'form'
      )
      if (!template) throw new Error('Template not found.')
      const target = (template.versions || []).find((entry) => Number(entry.version) === Number(targetVersion))
      if (!target) throw new Error('Template version not found.')
      if (!input.changelog || !String(input.changelog).trim()) {
        throw new Error('Revert requires changelog.')
      }
      template.blueprint = deepClone(target.blueprint || { sections: [] })
      template.mappings = deepClone(target.mappings || [])
      template.mappingRules = template.mappings
      template.publishState = normalizeTemplateState(target.publishState || 'draft')
      template.status = template.publishState
      template.versions.push(
        createTemplateVersion(template, 'reverted', {
          changelog: { body: String(input.changelog).trim(), fromVersion: Number(target.version) },
          diff: { revertedToVersion: Number(target.version) },
          actorUserId: user.id
        })
      )
      template.updatedAt = now()
      persist()
      return {
        template: documentTemplateAdapter(template),
        revertedToVersion: Number(target.version),
        currentVersion: template.versions.length
      }
    },
    listTemplateVersions(user, templateId) {
      requirePermission(user, 'templates:write')
      const template = state.templateAggregates.find(
        (entry) => entry.id === templateId && entry.firmId === user.firmId && entry.kind !== 'form'
      )
      if (!template) throw new Error('Template not found.')
      return template.versions || []
    },
    listPublishTransitions(user, templateId) {
      requirePermission(user, 'templates:write')
      const template = state.templateAggregates.find(
        (entry) => entry.id === templateId && entry.firmId === user.firmId && entry.kind !== 'form'
      )
      if (!template) throw new Error('Template not found.')
      return template.publishTransitions || []
    },
    listExports(user) {
      requirePermission(user, 'exports:write')
      state.exportJobs = listExportQueueJobs()
      return state.exportJobs.filter((entry) => entry.firmId === user.firmId)
    },
    createExport(user, input) {
      requirePermission(user, 'exports:write')
      const template = state.templateAggregates.find(
        (entry) => entry.id === input.templateId && entry.firmId === user.firmId && entry.kind !== 'form'
      )
      if (!template) throw new Error('Template not found.')
      const queued = enqueueExportJob({
        id: randomUUID(),
        firmId: user.firmId,
        clientId: input.clientId,
        templateId: input.templateId,
        createdByUserId: user.id,
        type: input.type || 'pdf',
        idempotencyKey: input.idempotencyKey || null,
        maxAttempts: Number(input.maxAttempts || 3),
        metadata: input.metadata || {}
      })
      addAudit(user.firmId, user.id, 'export_job', queued.id, 'export_job.created', {
        clientId: input.clientId,
        templateId: input.templateId,
        type: queued.type
      })
      state.exportJobs = state.exportJobs.filter((entry) => entry.id !== queued.id)
      state.exportJobs.push(queued)
      persist()
      return queued
    },
    retryExport(user, exportId) {
      const firmContext = requireFirmContext(user, { method: 'store.retryExport' })
      requirePermission(user, 'exports:write')
      validateEntityOwnership(firmContext, state.exportJobs.find((entry) => entry.id === exportId), {
        entityName: 'Export'
      })
      const updated = requeueExportJob(exportId)
      if (!updated) throw new Error('Export not found.')
      state.exportJobs = state.exportJobs.map((entry) => (entry.id === exportId ? updated : entry))
      addAudit(user.firmId, user.id, 'export_job', exportId, 'export_job.retry_requested', {
        before: { attempts: job.attempts || 0, status: job.status },
        after: { attempts: updated.attempts || 0, status: updated.status }
      })
      persist()
      return updated
    },
    getExportQueueHealth(user) {
      requirePermission(user, 'exports:read')
      const queue = readExportWorkerStatus()
      return {
        generatedAt: now(),
        queue
      }
    },
    retryFailedExports(user, options = {}) {
      requirePermission(user, 'exports:write')
      const limit = Math.max(1, Math.min(Number(options.limit || 25), 200))
      const includeDeadLetter = options.includeDeadLetter === true
      const dryRun = options.dryRun === true
      const candidates = listExportQueueJobs()
        .filter((entry) => entry.firmId === user.firmId)
        .filter((entry) => entry.status === 'failed' || (includeDeadLetter && entry.status === 'dead-letter'))
        .slice(0, limit)
      if (dryRun) {
        return { dryRun: true, limit, includeDeadLetter, candidateCount: candidates.length, ids: candidates.map((c) => c.id) }
      }
      const retried = []
      for (const candidate of candidates) {
        const updated = requeueExportJob(candidate.id)
        if (updated) retried.push(updated.id)
      }
      state.exportJobs = listExportQueueJobs()
      persist()
      return { dryRun: false, limit, includeDeadLetter, retriedCount: retried.length, ids: retried }
    },
    async processQueuedExports() {
      const result = processExportQueueTick({
        workerId: 'api-process-endpoint',
        limit: 10,
        leaseMs: 15_000,
        processor(job) {
          const failCount = Number(job?.metadata?.simulateFailuresRemaining || 0)
          if (failCount > 0) {
            job.metadata.simulateFailuresRemaining = failCount - 1
            throw new Error(`Simulated export failure for ${job.id}`)
          }
          const fileName = `${job.type}-${Date.now()}.json`
          const key = `${job.firmId}/exports/${fileName}`
          return {
            fileName,
            preview: { clientId: job.clientId, templateId: job.templateId },
            object: {
              bucket: objectStorage.bucketExports,
              key,
              checksum: null,
              contentType: 'application/json',
              retentionClass: 'export_artifact'
            }
          }
        }
      })
      return { processed: result.processed, leased: result.leased, failed: result.failed }
    },
    listAudit(user) {
      requirePermission(user, 'profiles:read')
      return state.auditEvents
        .filter((entry) => entry.firmId === user.firmId)
        .slice()
        .reverse()
    },
    logout(token) {
      const session = state.sessions.find((entry) => entry.token === token)
      state.sessions = state.sessions.filter((entry) => entry.token !== token)
      if (session) {
        addAudit(session.firmId, session.userId, 'user', session.userId, 'auth.logout', {
          after: { sessionToken: token }
        })
      }
      persist()
      return { ok: true }
    },
    listUsers(user) {
      requirePermission(user, 'analytics:read')
      return state.users.filter((entry) => entry.firmId === user.firmId).map(publicUser)
    },
    inviteUser(user, input) {
      requirePermission(user, 'profiles:write')
      const invite = {
        id: randomUUID(),
        firmId: user.firmId,
        email: input.email.toLowerCase(),
        role: input.role || 'advisor',
        invitedByUserId: user.id,
        token: randomUUID(),
        createdAt: now()
      }
      state.invites.push(invite)
      addAudit(user.firmId, user.id, 'invite', invite.id, 'invite.created', { email: invite.email, role: invite.role })
      persist()
      return invite
    },
    acceptInvite(input) {
      assertStrongPassword(input.password)
      const invite = state.invites.find((entry) => entry.token === input.token)
      if (!invite) throw new Error('Invite not found.')
      const user = {
        id: randomUUID(),
        firmId: invite.firmId,
        email: invite.email,
        passwordHash: hash(input.password),
        firstName: input.firstName,
        lastName: input.lastName,
        role: invite.role,
        createdAt: now()
      }
      state.users.push(user)
      state.invites = state.invites.filter((entry) => entry.id !== invite.id)
      addAudit(user.firmId, user.id, 'user', user.id, 'user.role_assigned', {
        before: { role: null },
        after: { role: user.role, invitedByUserId: invite.invitedByUserId }
      })
      persist()
      return createSession(user)
    },
    requestPasswordReset(email) {
      return auth.requestReset({ email })
    },
    resetPassword(input) {
      return auth.resetPassword(input)
    },
    objectStorage,
    removeHouseholdMember(user, householdId, clientId) {
      const firmContext = requireFirmContext(user, { method: 'store.removeHouseholdMember' })
      requirePermission(user, 'households:write')
      const beforeCount = state.householdMembers.filter(
        (entry) => entry.householdId === householdId && entry.firmId === user.firmId
      ).length
      state.householdMembers = state.householdMembers.filter(
        (entry) => !(entry.householdId === householdId && entry.clientId === clientId && entry.firmId === user.firmId)
      )
      const profile = state.profiles.find((entry) => entry.id === clientId && entry.firmId === user.firmId)
      if (profile) profile.householdId = null
      addAudit(user.firmId, user.id, 'household', householdId, 'household.split', {
        before: { memberCount: beforeCount, clientId },
        after: {
          memberCount: state.householdMembers.filter(
            (entry) => entry.householdId === householdId && entry.firmId === user.firmId
          ).length
        }
      })
      persist()
      return { ok: true }
    },
    linkSpouse(user, primaryClientId, spouseClientId) {
      requirePermission(user, 'households:write')
      const primary = state.profiles.find((entry) => entry.id === primaryClientId && entry.firmId === user.firmId)
      const spouse = state.profiles.find((entry) => entry.id === spouseClientId && entry.firmId === user.firmId)
      if (!primary || !spouse) throw new Error('Profile not found.')
      primary.spouseClientId = spouse.id
      spouse.spouseClientId = primary.id
      let householdId = primary.householdId
      if (!householdId) {
        householdId = this.createHousehold(user, {
          name: `${primary.lastName} Household`,
          primaryClientId: primary.id
        }).id
      }
      spouse.householdId = householdId
      state.householdMembers.push({
        householdId,
        clientId: spouse.id,
        role: 'spouse',
        firmId: user.firmId,
        createdAt: now()
      })
      addAudit(user.firmId, user.id, 'household', householdId, 'household.merge', {
        after: { primaryClientId: primary.id, spouseClientId: spouse.id }
      })
      persist()
      return { primary, spouse }
    },
    createSpouse(user, primaryClientId, input) {
      const spouse = this.createProfile(user, { ...input, kind: 'client' })
      this.linkSpouse(user, primaryClientId, spouse.id)
      return spouse
    },
    updateSubmission(user, submissionId, patch) {
      const firmContext = requireFirmContext(user, { method: 'store.updateSubmission' })
      requirePermission(user, 'forms:write')
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('Submission patch must be an object.')
      }
      const submission = state.formSubmissions.find(
        (entry) => entry.id === submissionId && entry.firmId === user.firmId
      )
      if (!submission) throw new Error('Submission not found.')
      const nextUpdatedAt = patch?.updatedAt || now()
      Object.assign(submission, patch, { updatedAt: nextUpdatedAt })
      persist()
      return submission
    },
    deleteSubmission(user, submissionId) {
      const firmContext = requireFirmContext(user, { method: 'store.deleteSubmission' })
      requirePermission(user, 'forms:write')
      const existing = state.formSubmissions.find((entry) => entry.id === submissionId && entry.firmId === user.firmId)
      if (!existing) throw new Error('Submission not found.')
      state.formSubmissions = state.formSubmissions.filter(
        (entry) => !(entry.id === submissionId && entry.firmId === user.firmId)
      )
      addAudit(user.firmId, user.id, 'form_submission', submissionId, 'form_submission.deleted', {
        templateId: existing.templateId,
        clientId: existing.clientId
      })
      persist()
      return { ok: true }
    },
    autoBuildTemplate(user, input) {
      requirePermission(user, 'templates:write')
      const sections = (input.fields || []).reduce((acc, field) => {
        const sectionKey = field.split('.')[0] || 'general'
        acc[sectionKey] ||= []
        acc[sectionKey].push(field)
        return acc
      }, {})
      return this.createDocumentTemplate(user, {
        name: input.name,
        fileName: input.fileName || 'uploaded.pdf',
        blueprint: { sections },
        mappings: (input.fields || []).map((field) => ({
          pdfField: field,
          sourcePath: field.replace(/\s+/g, '_').toLowerCase()
        }))
      })
    },
    createPortalLink(user, profileId, options = {}) {
      requirePermission(user, 'profiles:read')
      const createdAt = now()
      const expiresAt = options.expiresAt || new Date(Date.now() + Number(options.expiresInHours || 24) * 3600 * 1000).toISOString()
      const maxUses = Math.max(1, Number(options.maxUses || 1))
      const link = {
        id: randomUUID(),
        firmId: user.firmId,
        profileId,
        token: randomUUID(),
        createdAt,
        expiresAt,
        maxUses,
        usedCount: 0,
        revokedAt: null,
        lastUsedAt: null,
        scope: normalizePortalScope(options.scope || options)
      }
      state.portalLinks.push(link)
      persist()
      return link
    },
    revokePortalLink(user, linkId) {
      requirePermission(user, 'profiles:read')
      const link = state.portalLinks.find((entry) => entry.id === linkId && entry.firmId === user.firmId)
      if (!link) throw new Error('Portal link not found.')
      if (!link.revokedAt) {
        link.revokedAt = now()
      }
      persist()
      return link
    },
    getPortalSession(token) {
      const link = resolvePortalLinkByToken(token)
      return {
        id: link.id,
        firmId: link.firmId,
        profileId: link.profileId,
        token: link.token,
        scope: link.scope,
        expiresAt: link.expiresAt,
        maxUses: link.maxUses,
        usedCount: link.usedCount,
        revokedAt: link.revokedAt
      }
    },
    getPortalData(token) {
      const link = resolvePortalLinkByToken(token)
      const firm = state.firms.find((entry) => entry.id === link.firmId) || null
      const profile = state.profiles.find((entry) => entry.id === link.profileId && entry.firmId === link.firmId)
      const submissions = state.formSubmissions
        .filter((entry) => entry.clientId === link.profileId && entry.firmId === link.firmId)
        .filter(
          (entry) =>
            !Array.isArray(link.scope?.templateIds) ||
            link.scope.templateIds.length === 0 ||
            entry.templateId === 'portal' ||
            link.scope.templateIds.includes(entry.templateId)
        )
        .slice()
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
      const availableTemplates = state.templateAggregates
        .filter((entry) => entry.firmId === link.firmId && entry.kind === 'form')
        .filter((entry) => !Array.isArray(link.scope?.templateIds) || link.scope.templateIds.length === 0 || link.scope.templateIds.includes(entry.id))
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          description: entry.description || '',
          sections: entry.formSchema?.sections || []
        }))
      const uploads = state.documentUploads
        .filter((entry) => entry.firmId === link.firmId && entry.clientId === link.profileId)
        .filter(
          (entry) =>
            !Array.isArray(link.scope?.uploadCategories) ||
            link.scope.uploadCategories.length === 0 ||
            link.scope.uploadCategories.includes(entry.category || 'general')
        )
        .slice()
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
      return { firm, profile, submissions, availableTemplates, uploads }
    },
    portalSubmit(token, input) {
      const link = resolvePortalLinkByToken(token)
      const templateId = input.templateId || 'portal'
      const template =
        templateId === 'portal'
          ? null
          : state.templateAggregates.find(
              (entry) => entry.id === templateId && entry.firmId === link.firmId && entry.kind === 'form'
            )
      if (templateId !== 'portal' && !template) throw new Error('Form template not found.')
      if (templateId !== 'portal') assertPortalTemplateScope(link, templateId)
      const status = input.status === 'draft' ? 'draft' : 'submitted'
      if (status === 'draft') {
        const existingDraft = state.formSubmissions.find(
          (entry) =>
            entry.firmId === link.firmId &&
            entry.clientId === link.profileId &&
            entry.templateId === templateId &&
            entry.status === 'draft' &&
            entry.source === 'portal'
        )
        if (existingDraft) {
          existingDraft.data = input.data && typeof input.data === 'object' ? input.data : {}
          existingDraft.updatedAt = now()
          persist()
          return existingDraft
        }
      }
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
      }
      consumePortalLinkUse(link)
      state.formSubmissions.push(submission)
      persist()
      return submission
    },
    getPortalDraftSectionState(token, draftId, sectionId) {
      const link = findPortalLink(token)
      findDraftForScope({ draftId, firmId: link.firmId, clientId: link.profileId })
      const normalizedSectionId = normalizeSectionIdentifier(sectionId)
      const entry = state.draftStepStates.find(
        (item) =>
          item.firmId === link.firmId &&
          item.clientId === link.profileId &&
          item.draftId === draftId &&
          item.sectionId === normalizedSectionId
      )
      if (!entry) return null
      return deepClone(entry)
    },
    listPortalDraftSectionStates(token, draftId) {
      const link = findPortalLink(token)
      findDraftForScope({ draftId, firmId: link.firmId, clientId: link.profileId })
      return state.draftStepStates
        .filter((item) => item.firmId === link.firmId && item.clientId === link.profileId && item.draftId === draftId)
        .map((item) => deepClone(item))
    },
    savePortalDraftSectionState(token, draftId, sectionId, input = {}) {
      const link = findPortalLink(token)
      findDraftForScope({ draftId, firmId: link.firmId, clientId: link.profileId })
      const normalizedSectionId = normalizeSectionIdentifier(sectionId)
      const expectedVersion = Number(input.expectedVersion || 0)
      const nowIso = now()
      const existing = state.draftStepStates.find(
        (item) =>
          item.firmId === link.firmId &&
          item.clientId === link.profileId &&
          item.draftId === draftId &&
          item.sectionId === normalizedSectionId
      )
      const currentVersion = Number(existing?.version || 0)
      if (expectedVersion !== currentVersion) {
        return {
          ok: false,
          conflict: true,
          reason: 'Section draft state is stale.',
          state: existing ? deepClone(existing) : null
        }
      }
      const next = {
        firmId: link.firmId,
        clientId: link.profileId,
        draftId,
        sectionId: normalizedSectionId,
        version: currentVersion + 1,
        data: input.data && typeof input.data === 'object' ? deepClone(input.data) : {},
        updatedAt: nowIso
      }
      if (existing) Object.assign(existing, next)
      else state.draftStepStates.push(next)
      persist()
      return { ok: true, state: deepClone(next) }
    },
    async createPortalUploadPresign(token, input) {
      const link = resolvePortalLinkByToken(token)
      assertPortalUploadScope(link, input.category)
      const intent = createUploadIntent({
        firmId: link.firmId,
        clientId: link.profileId,
        fileName: input.fileName,
        contentType: input.contentType,
        checksum: input.checksum,
        category: input.category,
        source: 'portal',
        retentionClass: input.retentionClass
      })
      const presigned = await objectStorage.createPresignedUploadUrl({
        ...intent.object,
        expiresInSeconds: Number(input.expiresInSeconds || 900)
      })
      persist()
      return { uploadId: intent.id, object: intent.object, presigned }
    },
    portalUpload(token, input) {
      const link = resolvePortalLinkByToken(token)
      const intent = input.uploadId
        ? state.pendingUploadIntents.find((entry) => entry.id === input.uploadId && entry.firmId === link.firmId)
        : null
      const uploadCategory = input.category || intent?.category || 'general'
      assertPortalUploadScope(link, uploadCategory)
      const object = normalizeObjectMetadata(
        input.object || intent?.object || {},
        input.retentionClass || intent?.object?.retentionClass || 'uploaded_document'
      )
      const malwareScan = normalizeMalwareScan(input.malwareScan)
      const upload = {
        id: randomUUID(),
        firmId: link.firmId,
        clientId: link.profileId,
        name: input.name || input.fileName || intent?.fileName || 'Portal upload',
        category: uploadCategory,
        visibility: 'shared',
        status: 'uploaded',
        uploadedBy: 'portal',
        notes: input.notes || '',
        malwareScan,
        object,
        createdAt: now(),
        updatedAt: now()
      }
      consumePortalLinkUse(link)
      state.pendingUploadIntents = state.pendingUploadIntents.filter((entry) => entry.id !== input.uploadId)
      state.documentUploads.push(upload)
      persist()
      return upload
    },
    async createPortalUploadDownloadUrl(token, uploadId) {
      const link = resolvePortalLinkByToken(token)
      const upload = state.documentUploads.find(
        (entry) => entry.id === uploadId && entry.firmId === link.firmId && entry.clientId === link.profileId
      )
      if (!upload) throw new Error('Upload not found.')
      return objectStorage.createPresignedDownloadUrl({ ...upload.object, expiresInSeconds: 900 })
    },
    buildAnalyticsSnapshot(user, filters = {}) {
      requirePermission(user, 'analytics:read')
      const startDate = toIsoDate(filters.startDate)
      const endDate = toIsoDate(filters.endDate)
      const cohortBy = filters.cohortBy || 'all'
      const cohortValue = filters.cohortValue ? String(filters.cohortValue) : null
      const nowMs = parseIso(process.env.TEST_NOW || '') || Date.now()

      const firmProfiles = state.profiles.filter((entry) => entry.firmId === user.firmId)
      const prospects = firmProfiles.filter((entry) => {
        if (entry.kind !== 'prospect') return false
        const created = toIsoDate(entry.createdAt)
        if (startDate && created && created < startDate) return false
        if (endDate && created && created > endDate) return false
        if (cohortBy === 'stage' && cohortValue && (entry.stage || 'unassigned') !== cohortValue) return false
        if (cohortBy === 'advisor' && cohortValue && entry.advisorUserId !== cohortValue) return false
        return true
      })
      const stageCounts = prospects.reduce((acc, profile) => {
        const stage = profile.stage || 'unassigned'
        acc[stage] = (acc[stage] || 0) + 1
        return acc
      }, {})
      const totalProspects = prospects.length || 1
      const stageOrder = [
        'discovery',
        'gather_oi',
        'analysis',
        'advisor_proposal_meeting',
        'intake',
        'on_boarding',
        'investment_strategy',
        'completed'
      ]
      const funnel = stageOrder.map((stage) => {
        const count = stageCounts[stage] || 0
        return { stage, count, conversionRate: Number((count / totalProspects).toFixed(4)) }
      })
      const firstStage = stageCounts[stageOrder[0]] || 0
      const lastStage = stageCounts.completed || 0

      const stageEvents = state.stageChanges
        .filter((entry) => entry.firmId === user.firmId)
        .slice()
        .sort((a, b) => parseIso(a.changedAt) - parseIso(b.changedAt))
      const stageEntryTimes = new Map()
      stageEvents.forEach((event) => {
        const key = `${event.clientId}:${event.toStage || 'unassigned'}`
        if (!stageEntryTimes.has(key)) stageEntryTimes.set(key, parseIso(event.changedAt))
      })
      const stageAging = Object.fromEntries(stageOrder.map((stage) => [stage, { count: 0, avgDays: 0 }]))
      prospects.forEach((profile) => {
        const stage = profile.stage || 'unassigned'
        if (!stageAging[stage]) stageAging[stage] = { count: 0, avgDays: 0 }
        const enteredAt = stageEntryTimes.get(`${profile.id}:${stage}`) || parseIso(profile.createdAt)
        const ageDays = Math.max(0, (nowMs - enteredAt) / 86_400_000)
        stageAging[stage].count += 1
        stageAging[stage].avgDays += ageDays
      })
      Object.values(stageAging).forEach((entry) => {
        if (entry.count) entry.avgDays = Number((entry.avgDays / entry.count).toFixed(2))
      })

      const templateIds = new Set(
        state.templateAggregates
          .filter((entry) => entry.firmId === user.firmId && entry.kind === 'form')
          .map((entry) => entry.id)
      )
      const formsByTemplate = {}
      templateIds.forEach((templateId) => {
        formsByTemplate[templateId] = { templateId, drafts: 0, submitted: 0, completionRate: 0 }
      })
      const relevantSubmissions = state.formSubmissions
        .filter((entry) => entry.firmId === user.firmId)
        .filter((entry) => {
          const created = toIsoDate(entry.createdAt)
          if (startDate && created && created < startDate) return false
          if (endDate && created && created > endDate) return false
          return true
        })
      relevantSubmissions.forEach((submission) => {
          formsByTemplate[submission.templateId] ||= {
            templateId: submission.templateId,
            drafts: 0,
            submitted: 0,
            completionRate: 0
          }
          if (submission.status === 'submitted') formsByTemplate[submission.templateId].submitted += 1
          else formsByTemplate[submission.templateId].drafts += 1
        })
      Object.values(formsByTemplate).forEach((entry) => {
        const total = entry.drafts + entry.submitted
        entry.completionRate = total ? Number((entry.submitted / total).toFixed(4)) : 0
      })
      const formCompletionLatency = relevantSubmissions
        .filter((entry) => entry.status === 'submitted')
        .map((entry) => {
          const latencyHours = Number(((parseIso(entry.updatedAt) - parseIso(entry.createdAt)) / 3_600_000).toFixed(2))
          return {
            submissionId: entry.id,
            templateId: entry.templateId || 'unknown',
            latencyHours: Math.max(0, latencyHours)
          }
        })

      const latencyByTemplate = Object.values(
        formCompletionLatency.reduce((acc, entry) => {
          acc[entry.templateId] ||= { templateId: entry.templateId, submissions: 0, totalHours: 0 }
          acc[entry.templateId].submissions += 1
          acc[entry.templateId].totalHours += entry.latencyHours
          return acc
        }, {})
      ).map((entry) => ({
        templateId: entry.templateId,
        submissions: entry.submissions,
        avgHours: Number((entry.totalHours / entry.submissions).toFixed(2))
      }))

      const advisors = state.users.filter(
        (entry) => entry.firmId === user.firmId && ['advisor', 'admin'].includes(entry.role)
      )
      const advisorProductivity = advisors.map((advisor) => {
        const assignedProfiles = firmProfiles.filter((entry) => entry.advisorUserId === advisor.id)
        const notesCount = state.notes.filter(
          (entry) => entry.firmId === user.firmId && entry.createdByUserId === advisor.id
        ).length
        const stageMoves = state.stageChanges.filter(
          (entry) => entry.firmId === user.firmId && entry.changedByUserId === advisor.id
        ).length
        const submissions = state.formSubmissions.filter(
          (entry) => entry.firmId === user.firmId && entry.createdByUserId === advisor.id
        ).length
        return {
          advisorUserId: advisor.id,
          advisorName: `${advisor.firstName} ${advisor.lastName}`,
          profilesManaged: assignedProfiles.length,
          notesAuthored: notesCount,
          stageMoves,
          formSubmissionsAuthored: submissions,
          productivityScore: assignedProfiles.length + notesCount + stageMoves + submissions
        }
      })

      const exportJobs = state.exportJobs.filter((entry) => {
        if (entry.firmId !== user.firmId) return false
        const created = toIsoDate(entry.createdAt)
        if (startDate && created && created < startDate) return false
        if (endDate && created && created > endDate) return false
        return true
      })
      const advisorById = new Map(advisors.map((entry) => [entry.id, `${entry.firstName} ${entry.lastName}`]))
      const exportUsageByAdvisor = Object.values(
        exportJobs.reduce((acc, job) => {
          const advisorUserId = job.createdByUserId || job.metadata?.requestedByUserId || 'unknown'
          acc[advisorUserId] ||= { advisorUserId, advisorName: advisorById.get(advisorUserId) || 'Unknown', total: 0 }
          acc[advisorUserId].total += 1
          return acc
        }, {})
      )
      const exportUsageByFirm = {
        firmId: user.firmId,
        total: exportJobs.length,
        byStatus: exportJobs.reduce((acc, job) => {
          acc[job.status || 'unknown'] = (acc[job.status || 'unknown'] || 0) + 1
          return acc
        }, {})
      }

      const bottlenecks = Object.entries(stageAging)
        .map(([stage, value]) => ({ stage, ...value }))
        .filter((entry) => entry.count > 0)
        .sort((a, b) => b.avgDays - a.avgDays)

      return {
        filters: { startDate, endDate, cohortBy, cohortValue },
        stageCounts,
        funnel,
        overallConversionRate: firstStage ? Number((lastStage / firstStage).toFixed(4)) : 0,
        stageAging,
        bottlenecks,
        formCompletionRates: Object.values(formsByTemplate),
        formCompletionLatency: latencyByTemplate,
        advisorProductivity,
        exportUsage: { byAdvisor: exportUsageByAdvisor, byFirm: exportUsageByFirm },
        profileCount: firmProfiles.length,
        householdCount: state.households.filter((entry) => entry.firmId === user.firmId).length,
        exportCount: state.exportJobs.filter((entry) => entry.firmId === user.firmId).length,
        templateCount: state.templateAggregates.filter((entry) => entry.firmId === user.firmId && entry.kind !== 'form')
          .length,
        avgProspectStageAgeDays: Number(
          average(Object.values(stageAging).map((entry) => entry.avgDays || 0)).toFixed(2)
        )
      }
    },
    getAnalytics(user, filters = {}) {
      return this.buildAnalyticsSnapshot(user, filters)
    },
    getAnalyticsDashboard(user, filters = {}) {
      const snapshot = this.buildAnalyticsSnapshot(user, filters)
      return {
        filters: snapshot.filters,
        funnel: snapshot.funnel,
        stageAging: snapshot.stageAging,
        bottlenecks: snapshot.bottlenecks,
        formCompletionLatency: snapshot.formCompletionLatency,
        exportUsage: snapshot.exportUsage
      }
    },
    exportAnalyticsCsv(user, filters = {}) {
      const snapshot = this.buildAnalyticsSnapshot(user, filters)
      const rows = [['report', 'dimension', 'metric', 'value']]
      snapshot.funnel.forEach((entry) => rows.push(['funnel', entry.stage, 'count', entry.count]))
      snapshot.bottlenecks.forEach((entry) => rows.push(['stage_aging', entry.stage, 'avg_days', entry.avgDays]))
      snapshot.formCompletionLatency.forEach((entry) =>
        rows.push(['form_latency', entry.templateId, 'avg_hours', entry.avgHours])
      )
      snapshot.exportUsage.byAdvisor.forEach((entry) =>
        rows.push(['export_usage_advisor', entry.advisorName, 'total', entry.total])
      )
      Object.entries(snapshot.exportUsage.byFirm.byStatus).forEach(([status, count]) =>
        rows.push(['export_usage_firm', status, 'total', count])
      )
      return rows.map((row) => row.map(csvCell).join(',')).join('\n')
    },

    async createExportDownloadUrl(user, exportId) {
      requirePermission(user, 'exports:write')
      const job = state.exportJobs.find((entry) => entry.id === exportId && entry.firmId === user.firmId)
      if (!job) throw new Error('Export not found.')
      const object = job.output?.object
      if (!object) throw new Error('Export output object not available.')
      return objectStorage.createPresignedDownloadUrl({ ...object, expiresInSeconds: 900 })
    },
    async runLifecyclePolicies(user) {
      requirePermission(user, 'exports:write')
      await applyLifecyclePolicies()
      return {
        uploads: state.documentUploads.filter((entry) => entry.firmId === user.firmId),
        exports: state.exportJobs.filter((entry) => entry.firmId === user.firmId),
        retention: objectStorage.retentionPolicies
      }
    },
    getMaskedSensitiveData(user, profileId, request = {}) {
      requirePermission(user, 'profiles:read')
      const profile = state.profiles.find((entry) => entry.id === profileId && entry.firmId === user.firmId)
      if (!profile) throw new Error('Profile not found.')
      const ssn = decryptSensitiveValue(profile.pii?.ssnEncrypted || profile.pii?.ssnCiphertext)
      const taxId = decryptSensitiveValue(profile.pii?.taxIdEncrypted || profile.pii?.taxIdCiphertext)
      const requestedUnmask = request.unmask === true
      const commonMetadata = {
        actor: { userId: user.id, role: user.role },
        requestedUnmask,
        grantedUnmask: false,
        fieldScope: ['ssn', 'taxId'],
        purpose: request.purpose || null,
        reason: {
          code: request.reasonCode || null,
          justification: String(request.justification || ''),
          privilegedPolicy: request.privilegedPolicy || null
        }
      }

      if (requestedUnmask) {
        try {
          validateUnmaskRequest(request)
        } catch (error) {
          addAudit(user.firmId, user.id, 'profile', profileId, 'sensitive.read_denied', {
            ...commonMetadata,
            outcome: 'denied',
            denialReason: error.message
          })
          throw error
        }
      }

      const canUnmask = requestedUnmask && canUnmaskSensitiveData(user, request)
      if (requestedUnmask && !canUnmask) {
        addAudit(user.firmId, user.id, 'profile', profileId, 'sensitive.read_denied', {
          ...commonMetadata,
          outcome: 'denied',
          denialReason: 'Sensitive read unmask denied by least-privilege policy.'
        })
        throw new Error('Sensitive read denied.')
      }

      addAudit(user.firmId, user.id, 'profile', profileId, 'sensitive.read', {
        ...commonMetadata,
        grantedUnmask: canUnmask,
        outcome: 'granted'
      })

      if (canUnmask) {
        return {
          ssn,
          taxId,
          ssnMasked: maskSsn(ssn),
          taxIdMasked: maskTaxId(taxId)
        }
      }
      return { ssnMasked: maskSsn(ssn), taxIdMasked: maskTaxId(taxId) }
    },
    reencryptSensitiveData({ firmId, actorUserId }) {
      let rotatedProfiles = 0
      for (const profile of state.profiles) {
        if (firmId && profile.firmId !== firmId) continue
        const pii = profile.pii || {}
        const fields = ['ssnEncrypted', 'taxIdEncrypted', 'dobEncrypted']
        let changed = false
        for (const field of fields) {
          const legacy = field === 'ssnEncrypted' ? 'ssnCiphertext' : field === 'taxIdEncrypted' ? 'taxIdCiphertext' : null
          const current = pii[field] || (legacy ? pii[legacy] : null)
          if (!current) continue
          if (piiService.needsReencryption(current)) {
            pii[field] = piiService.reencrypt(current)
            changed = true
          }
        }
        if (changed) {
          profile.pii = pii
          profile.updatedAt = now()
          rotatedProfiles += 1
        }
      }
      if (rotatedProfiles > 0) {
        addAudit(firmId, actorUserId || null, 'profile', firmId || 'all', 'sensitive.write_reencrypted', { rotatedProfiles })
      }
      return { rotatedProfiles }
    },
    addAuditEvent(user, payload = {}) {
      addAudit(user.firmId, user.id, payload.entityType || 'generic', payload.entityId || 'n/a', payload.action || 'event', payload.metadata || {})
      return true
    },
    _internal: { piiCrypto: piiService, keyProvider },
    __setTestHooks(hooks = {}) {
      testHooks = { ...hooks }
    },
    __clearTestHooks() {
      testHooks = {}
    }
  }
}

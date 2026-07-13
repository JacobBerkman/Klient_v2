import { createHash } from 'node:crypto'
import { convertLegacyFormDefinition } from '../modules/forms/schema/form-definition-validator.mjs'
import { collectMissingRequiredFields } from '../form-conditions.mjs'
import { upsertDocumentTemplateRow, upsertFormTemplateRow, upsertTemplateAggregateRow } from '../storage.mjs'
import {
  CUSTOM_FIELD_TYPES,
  DEFAULT_ANALYTICS_STAGE_DEFINITIONS,
  DEFAULT_STAGE_DEFINITIONS,
  MAX_PROFILE_TAGS,
  MAX_PROFILE_TAG_LENGTH,
  PERMISSIONS,
  TEMPLATE_STATES
} from './constants.mjs'

export function defaultStageLabel(key) {
  return String(key || '')
    .split('_')
    .filter(Boolean)
    .map((segment) => `${segment[0]?.toUpperCase() || ''}${segment.slice(1)}`)
    .join(' ')
}

export function normalizeStageRole(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  if (normalized === 'start') return 'start'
  if (normalized === 'end' || normalized === 'complete' || normalized === 'completed') return 'end'
  if (normalized === 'dropped' || normalized === 'drop' || normalized === 'loss') return 'dropped'
  if (normalized === 'legacy' || normalized === 'unassigned') return 'legacy'
  return 'active'
}

export function normalizeConfiguredStageDefinitions(stages = []) {
  return stages
    .map((entry, index) => {
      if (typeof entry === 'string') {
        const id = entry.trim()
        if (!id) return null
        return { id, order: index, role: 'active' }
      }
      if (!entry || typeof entry !== 'object') return null
      const id = String(entry.id || entry.key || entry.stage || entry.slug || entry.value || '').trim()
      if (!id) return null
      const rawOrder = Number(entry.order ?? entry.position ?? entry.index ?? index)
      const order = Number.isFinite(rawOrder) ? rawOrder : index
      let role = normalizeStageRole(entry.role || entry.stageRole)
      if (entry.isStart === true) role = 'start'
      if (entry.isEnd === true) role = 'end'
      return { id, order, role }
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

export function resolveFirmAnalyticsStages(firm) {
  const pipelineSettings =
    firm?.stageConfig ||
    firm?.pipeline ||
    firm?.pipelineConfig ||
    firm?.settings?.pipeline ||
    firm?.settings?.stages ||
    null
  const stageEntries =
    (Array.isArray(firm?.stages) && firm.stages) ||
    (Array.isArray(pipelineSettings?.stages) && pipelineSettings.stages) ||
    (Array.isArray(pipelineSettings) && pipelineSettings) ||
    []
  const configured = normalizeConfiguredStageDefinitions(stageEntries)
  const definitions = configured.length
    ? configured
    : DEFAULT_ANALYTICS_STAGE_DEFINITIONS.map((entry, index) => ({ ...entry, order: index }))
  const stageOrder = definitions.map((entry) => entry.id)
  const stageIdSet = new Set(stageOrder)
  const configuredStart = String(
    pipelineSettings?.startStageId || pipelineSettings?.startStage || firm?.startStageId || firm?.startStage || ''
  ).trim()
  const configuredEnd = String(
    pipelineSettings?.endStageId || pipelineSettings?.endStage || firm?.endStageId || firm?.endStage || ''
  ).trim()
  const startStage =
    (configuredStart && stageIdSet.has(configuredStart) && configuredStart) ||
    definitions.find((entry) => entry.role === 'start')?.id ||
    stageOrder[0]
  const endStage =
    (configuredEnd && stageIdSet.has(configuredEnd) && configuredEnd) ||
    definitions.find((entry) => entry.role === 'end')?.id ||
    stageOrder.at(-1) ||
    startStage
  return { stageOrder, stageIdSet, startStage, endStage }
}

export function can(role, permission) {
  return PERMISSIONS[role]?.includes('*') || PERMISSIONS[role]?.includes(permission)
}

export function requirePermission(user, permission) {
  if (!can(user.role, permission)) {
    throw new Error(`Missing permission: ${permission}`)
  }
}

export function now() {
  return new Date().toISOString()
}

export function parseIso(value) {
  const time = new Date(value || '').getTime()
  return Number.isFinite(time) ? time : 0
}

export function normalizeDraftCollaborators(entry, fallbackUserId = '') {
  const seed = []
  if (fallbackUserId) {
    seed.push({ userId: fallbackUserId, permission: 'write' })
  }
  if (entry?.createdByUserId) {
    seed.push({ userId: entry.createdByUserId, permission: 'write' })
  }
  if (Array.isArray(entry?.collaborators)) {
    seed.push(...entry.collaborators)
  }
  const byUser = new Map()
  seed.forEach((item) => {
    const userId = String(item?.userId || '').trim()
    if (!userId) return
    const permission = String(item?.permission || '').toLowerCase() === 'write' ? 'write' : 'read'
    if (!byUser.has(userId) || permission === 'write') {
      byUser.set(userId, { userId, permission })
    }
  })
  return Array.from(byUser.values())
}

export function resolveUserId(user) {
  return String(user?.id || user?.userId || user?.user?.id || '').trim()
}

export function profileOrderIndex(profile) {
  const raw = profile?.orderIndex ?? profile?.stageOrderIndex ?? null
  const numeric = Number(raw)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : Number.MAX_SAFE_INTEGER
}

export function assignProspectOrderIndex(profile, index) {
  const normalized = Number(index)
  const next = Number.isFinite(normalized) && normalized > 0 ? normalized : null
  profile.orderIndex = next
  profile.stageOrderIndex = next
}

export function average(values) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function toIsoDate(value) {
  if (!value) return null
  const stamp = new Date(value).getTime()
  if (!Number.isFinite(stamp)) return null
  return new Date(stamp).toISOString().slice(0, 10)
}

export function csvCell(value) {
  const text = String(value ?? '')
  if (/[,"\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

export function hash(password) {
  return createHash('sha256').update(password).digest('hex')
}

export function assertStrongPassword(password) {
  const value = String(password || '')
  if (value.length < 12) throw new Error('Password must be at least 12 characters long.')
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) {
    throw new Error('Password must include uppercase, lowercase, and numeric characters.')
  }
}

export function sanitizeFileName(value = 'file.bin') {
  return (
    String(value || 'file.bin')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .slice(0, 120) || 'file.bin'
  )
}

export function daysBetween(thenIso, nowMs) {
  const thenMs = new Date(thenIso || 0).getTime()
  if (!Number.isFinite(thenMs) || thenMs <= 0) return 0
  return Math.floor((nowMs - thenMs) / (1000 * 60 * 60 * 24))
}

export function normalizeProfileTag(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PROFILE_TAG_LENGTH)
}

export function normalizeProfileTags(input) {
  const list = Array.isArray(input) ? input : input == null ? [] : [input]
  const seen = new Set()
  const result = []
  for (const raw of list) {
    const tag = normalizeProfileTag(raw)
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(tag)
    if (result.length >= MAX_PROFILE_TAGS) break
  }
  return result
}

export function toFiniteNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function normalizeExtensions(extensions = {}) {
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

export function normalizeCustomFieldType(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  if (normalized === 'string') return 'text'
  return normalized
}

export function customFieldValidationError(message, fieldErrors = {}) {
  const error = new Error(message)
  error.statusCode = 422
  error.code = 'CUSTOM_FIELD_VALIDATION'
  error.details = { fieldErrors }
  return error
}

export function normalizeCustomFieldRequired(value) {
  if (typeof value === 'boolean') return { value, error: '' }
  if (value == null) return { value: false, error: '' }
  const normalized = String(value).trim().toLowerCase()
  if (!normalized) return { value: false, error: '' }
  if (['true', '1', 'yes', 'y'].includes(normalized)) return { value: true, error: '' }
  if (['false', '0', 'no', 'n'].includes(normalized)) return { value: false, error: '' }
  return { value: false, error: 'Required must be a boolean (true/false).' }
}

export function validateCustomFieldRowInput(row = {}, { requireKnownKey = false, knownKeys = new Set() } = {}) {
  const key = String(row?.key || '')
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, '_')
  const type = normalizeCustomFieldType(row?.type)
  const label = String(row?.label || key).trim() || key
  const requiredResult = normalizeCustomFieldRequired(row?.required)
  const fieldErrors = {}
  if (!key) fieldErrors.key = 'Key is required.'
  if (requireKnownKey && key && !knownKeys.has(key)) fieldErrors.key = 'Field key was not found.'
  if (!CUSTOM_FIELD_TYPES.has(type)) fieldErrors.type = 'Type must be one of: text, number, boolean, date.'
  if (requiredResult.error) fieldErrors.required = requiredResult.error
  if (row?.metadata != null && (typeof row.metadata !== 'object' || Array.isArray(row.metadata))) {
    fieldErrors.metadata = 'Metadata must be a JSON object.'
  }
  return {
    normalized: {
      key,
      type,
      label,
      required: requiredResult.value,
      metadata:
        row?.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? { ...row.metadata } : {}
    },
    fieldErrors
  }
}

export function normalizeCustomFieldSchema(schema = {}) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { fields: [], updatedAt: now() }
  }
  const seen = new Set()
  const fields = Array.isArray(schema.fields)
    ? schema.fields
        .map((field) => {
          const key = String(field?.key || field?.fieldKey || '')
            .trim()
            .replace(/[^a-zA-Z0-9_]+/g, '_')
          if (!key || seen.has(key)) return null
          const type = normalizeCustomFieldType(field?.type)
          if (!CUSTOM_FIELD_TYPES.has(type)) return null
          seen.add(key)
          return {
            key,
            type,
            label: String(field?.label || key).trim() || key,
            required: Boolean(field?.required),
            metadata:
              field?.metadata && typeof field.metadata === 'object' && !Array.isArray(field.metadata)
                ? { ...field.metadata }
                : {}
          }
        })
        .filter(Boolean)
    : []
  return {
    fields,
    updatedAt: schema.updatedAt || now()
  }
}

export function normalizeFinancialSummary(input = {}, extensions = {}) {
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

export function normalizeProfileRecord(profile) {
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

export function normalizeStageConfiguration(input = []) {
  if (!Array.isArray(input) || !input.length) {
    return DEFAULT_STAGE_DEFINITIONS.map((stage, index) => ({ ...stage, order: index + 1 }))
  }
  return input
    .map((stage, index) => {
      const id = String(stage?.id || stage?.stageId || '').trim()
      if (!id) return null
      const label = String(stage?.label || stage?.displayLabel || id).trim() || id
      return {
        id,
        label,
        order: index + 1,
        isTerminal: Boolean(stage?.isTerminal),
        isDrop: Boolean(stage?.isDrop)
      }
    })
    .filter(Boolean)
}

export function deepClone(value) {
  return JSON.parse(JSON.stringify(value))
}

export function normalizeSectionIdentifier(value, fallback = 'section') {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return normalized || fallback
}

export function normalizeTemplateState(value, fallback = 'draft') {
  return TEMPLATE_STATES.has(value) ? value : fallback
}

export function stableSerialize(value) {
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

export function templateVersionHash(template) {
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

export function createTemplateVersion(template, event, overrides = {}) {
  const publishState = normalizeTemplateState(overrides.publishState || template.publishState || 'draft')
  const blueprint = deepClone(overrides.blueprint || template.blueprint || { sections: [] })
  const mappings = deepClone(overrides.mappings || template.mappings || [])
  const formSchema = deepClone(overrides.formSchema || template.formSchema || { sections: [] })
  const extractedFields = deepClone(overrides.extractedFields || template.extractedFields || [])
  const extraction = deepClone(
    overrides.extraction || template.extraction || { status: 'completed', reasonCode: null, error: null }
  )
  const sourceArtifact = deepClone(overrides.sourceArtifact || template.sourceArtifact || null)
  const autoBuildSummary = deepClone(overrides.autoBuildSummary || template.autoBuildSummary || null)
  const pdfLayout = deepClone(overrides.pdfLayout || template.pdfLayout || { fields: [] })
  return {
    version: (template.versions?.length || 0) + 1,
    event,
    blueprint,
    mappings,
    formSchema,
    extractedFields,
    extraction,
    sourceArtifact,
    linkedFormTemplateId: overrides.linkedFormTemplateId || template.linkedFormTemplateId || null,
    autoBuildSummary,
    pdfLayout,
    publishState,
    immutable: overrides.immutable === true,
    changelog: overrides.changelog || null,
    versionHash: overrides.versionHash || templateVersionHash({ blueprint, mappings, publishState }),
    diff: overrides.diff || null,
    actorUserId: overrides.actorUserId || null,
    createdAt: now()
  }
}

export function resolveTemplateFormSections(template) {
  if (!template || typeof template !== 'object') return []
  const fromSchema =
    template.formSchema && Array.isArray(template.formSchema.sections) ? template.formSchema.sections : null
  if (fromSchema) return fromSchema
  return Array.isArray(template.sections) ? template.sections : []
}

// Enforce required fields when a form is FINALIZED (status transitions to
// 'submitted'). Draft saves are never blocked. A field hidden by its visibleIf
// condition against the submitted data is NOT required (even if required:true);
// its stale value is preserved but excluded from this check. Repeatable sections
// validate per-row. Absence of required fields = no-op, so existing templates
// (and generated PDF forms, which carry no conditions) are unaffected.
export function assertRequiredFieldsForSubmission(template, data) {
  const sections = resolveTemplateFormSections(template)
  const missing = collectMissingRequiredFields(sections, data)
  if (missing.length) {
    const error = new Error('Form submission is missing required fields.')
    error.statusCode = 400
    error.code = 'FORMS_REQUIRED_FIELDS_MISSING'
    error.details = { missing }
    throw error
  }
}

export function normalizeTemplateAggregate(template, fallbackKind = 'document') {
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
    extraction: template.extraction || { status: 'completed', reasonCode: null, error: null },
    sourceArtifact: template.sourceArtifact || template.documentMetadata?.sourceArtifact || null,
    linkedFormTemplateId: template.linkedFormTemplateId || null,
    pdfLayout: template.pdfLayout || null,
    generatedFromDocumentTemplateId: template.generatedFromDocumentTemplateId || null,
    generation: template.generation || null,
    autoBuildSummary: template.autoBuildSummary || null,
    exportReadiness: template.exportReadiness || null,
    publishState,
    status: publishState, // deprecated internal alias for compatibility payloads
    versions: (template.versions || []).map((entry, index) => ({
      version: entry.version || index + 1,
      event: entry.event || 'snapshot',
      blueprint: deepClone(entry.blueprint || blueprint),
      mappings: deepClone(entry.mappings || mappings),
      formSchema: deepClone(entry.formSchema || formSchema),
      extractedFields: deepClone(entry.extractedFields || template.extractedFields || []),
      extraction: deepClone(
        entry.extraction || template.extraction || { status: 'completed', reasonCode: null, error: null }
      ),
      sourceArtifact: deepClone(entry.sourceArtifact || template.sourceArtifact || null),
      linkedFormTemplateId: entry.linkedFormTemplateId || template.linkedFormTemplateId || null,
      pdfLayout: deepClone(entry.pdfLayout || template.pdfLayout || { fields: [] }),
      autoBuildSummary: deepClone(entry.autoBuildSummary || template.autoBuildSummary || null),
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

export function formTemplateAdapter(entry) {
  return {
    id: entry.id,
    firmId: entry.firmId,
    name: entry.name,
    description: entry.description || '',
    sections: deepClone(entry.formSchema?.sections || []),
    generatedFromDocumentTemplateId: entry.generatedFromDocumentTemplateId || null,
    generation: deepClone(entry.generation || null),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  }
}

export function documentTemplateAdapter(entry) {
  const extraction = deepClone(entry.extraction || { status: 'completed', reasonCode: null, error: null })
  const extractedFields = deepClone(entry.extractedFields || [])
  const sourceArtifact = deepClone(entry.sourceArtifact || entry.documentMetadata?.sourceArtifact || null)
  const mappingCount = Array.isArray(entry.mappings) ? entry.mappings.length : 0
  const exportReadiness =
    entry.exportReadiness ||
    (extraction.status === 'failed'
      ? {
          status: 'blocked',
          reason: extraction.reasonCode || 'extraction_failed',
          message: extraction.error?.message || 'Template extraction failed.'
        }
      : {
          status: sourceArtifact ? 'ready' : 'summary_fallback',
          reason: sourceArtifact ? null : 'missing_source_artifact',
          message: sourceArtifact
            ? 'Source PDF is available for template-driven export.'
            : 'No source PDF artifact is linked; exports use explicit summary fallback.'
        })
  return {
    id: entry.id,
    firmId: entry.firmId,
    name: entry.name,
    fileName: entry.documentMetadata?.fileName || 'template.pdf',
    documentMetadata: deepClone(entry.documentMetadata || {}),
    blueprint: deepClone(entry.blueprint || { sections: [] }),
    formSchema: deepClone(entry.formSchema || { sections: [] }),
    mappings: deepClone(entry.mappings || []),
    extractedFields,
    extraction: {
      ...extraction,
      fields: Array.isArray(extraction.fields) ? deepClone(extraction.fields) : extractedFields
    },
    sourceArtifact,
    linkedFormTemplateId: entry.linkedFormTemplateId || entry.autoBuildSummary?.linkedFormTemplateId || null,
    pdfLayout: deepClone(entry.pdfLayout || { fields: [] }),
    autoBuildSummary:
      entry.autoBuildSummary ||
      (extractedFields.length || mappingCount
        ? {
            fieldCount: extractedFields.length,
            mappingCount,
            linkedFormTemplateId: entry.linkedFormTemplateId || entry.autoBuildSummary?.linkedFormTemplateId || null,
            repeatableSectionCount: 0,
            ambiguousRepeaterCount: 0
          }
        : null),
    exportReadiness,
    versions: deepClone(entry.versions || []),
    status: entry.publishState || 'draft',
    publishState: entry.publishState || 'draft',
    versionHash: templateVersionHash(entry),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  }
}

export function collectSchemaPaths(fields = [], parentPath = '', output = new Map()) {
  for (const field of fields) {
    const segment = String(field?.path || field?.key || '').trim()
    if (!segment) continue
    const fullPath = parentPath ? `${parentPath}.${segment}` : segment
    const normalizedType = String(field?.type || 'text').trim() || 'text'
    output.set(fullPath, { source: 'formSchema', type: normalizedType })
    if (normalizedType === 'repeater') {
      collectSchemaPaths(field.fields || [], fullPath, output)
    }
  }
  return output
}

export function collectFormSchemaSourcePaths(sections = [], output = new Map()) {
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue
    const repeatable =
      section.repeatable === true || section.repeater === true || String(section.type || '') === 'repeater'
    const sectionKey = String(section.key || section.path || section.id || section.title || `section_${index + 1}`)
      .trim()
      .replace(/\s+/g, '_')
      .replace(/[^a-zA-Z0-9_]/g, '')
      .toLowerCase()
    collectSchemaPaths(section.fields || [], repeatable ? sectionKey : '', output)
  }
  return output
}

export function profileSourcePaths() {
  // Sensitive values (SSN, tax ids) live encrypted in profile.pii and are
  // deliberately NOT exposed as mapping source paths. Never add pii.* here.
  return new Map([
    ['profile.firstName', { source: 'profile', type: 'text' }],
    ['profile.lastName', { source: 'profile', type: 'text' }],
    ['profile.email', { source: 'profile', type: 'text' }],
    ['profile.phone', { source: 'profile', type: 'text' }],
    ['profile.dateOfBirth', { source: 'profile', type: 'date' }],
    ['profile.kind', { source: 'profile', type: 'text' }],
    ['profile.stage', { source: 'profile', type: 'text' }],
    ['profile.source.sourceCity', { source: 'profile', type: 'text' }],
    ['profile.source.sourceVenue', { source: 'profile', type: 'text' }],
    ['profile.source.sourceDate', { source: 'profile', type: 'date' }],
    ['spouse.firstName', { source: 'spouse', type: 'text' }],
    ['spouse.lastName', { source: 'spouse', type: 'text' }],
    ['spouse.email', { source: 'spouse', type: 'text' }],
    ['spouse.phone', { source: 'spouse', type: 'text' }],
    ['spouse.dateOfBirth', { source: 'spouse', type: 'date' }],
    ['household.name', { source: 'household', type: 'text' }],
    ['household.primary.firstName', { source: 'household', type: 'text' }],
    ['household.primary.lastName', { source: 'household', type: 'text' }],
    ['household.primary.email', { source: 'household', type: 'text' }],
    ['household.primary.phone', { source: 'household', type: 'text' }],
    ['household.primary.dateOfBirth', { source: 'household', type: 'date' }]
  ])
}

export function profileSourcePathsForFirm(firm) {
  const allowedSourcePaths = profileSourcePaths()
  const customFieldSchema = normalizeCustomFieldSchema(firm?.customFieldSchema)
  const sortedFields = [...customFieldSchema.fields].sort((a, b) => String(a.key).localeCompare(String(b.key)))
  for (const field of sortedFields) {
    const key = String(field?.key || '').trim()
    if (!key) continue
    allowedSourcePaths.set(`profile.extensions.values.${key}`, {
      source: 'profile_custom_field',
      type: field.type,
      customFieldKey: key
    })
  }
  return allowedSourcePaths
}

export function extractedFieldName(entry) {
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) return String(entry.fieldName || '').trim()
  return String(entry || '').trim()
}

export function normalizeRequiredPdfFields(input = []) {
  return Array.from(
    new Set((Array.isArray(input) ? input : []).map((entry) => extractedFieldName(entry)).filter(Boolean))
  )
}

export function normalizeExtractedFields(input = []) {
  return Array.isArray(input) ? deepClone(input) : []
}

// template_aggregates is the relational source of truth (migration 010): the
// canonical aggregate is written by upsertTemplateAggregateRow, and the two
// companion projection tables (form_templates / document_templates) are kept in
// sync through this single helper — its adapter view of the aggregate is what
// the old syncQueryTables projected via replaceRows, now written non-
// destructively per mutation. EVERY template mutation site must route through
// here (or upsertTemplateAggregateRow directly); persist() no longer flushes
// these tables, so a missed upsert silently drops the mutation on reload.
export function persistTemplateAggregateRow(template) {
  upsertTemplateAggregateRow(template)
  if (template.kind === 'form') {
    upsertFormTemplateRow(formTemplateAdapter(template))
  } else {
    upsertDocumentTemplateRow(documentTemplateAdapter(template))
  }
  return template
}

export function pipelineConflict(message, details = {}) {
  const error = new Error(message)
  error.statusCode = 409
  error.code = 'PIPELINE_ORDER_CONFLICT'
  error.details = details
  return error
}

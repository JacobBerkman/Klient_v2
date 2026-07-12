import { createHash, randomUUID } from 'node:crypto'
import { runtime } from './runtime.mjs'
import {
  applyExportJobLifecycleUpdate,
  countAuditEvents as countAuditEventsInTable,
  countFormSubmissionsByFirm,
  countPipelineStageRecordRows,
  countProspectRowsInStage,
  deleteExpiredSessions,
  deleteExpiredUploadIntents,
  deleteFormSubmission,
  deleteInviteRow,
  deleteSession,
  deleteSessionsByUser,
  deleteUploadIntent,
  ensureBoardVersionRow,
  findClientProfileRowByEmail,
  findInviteRowByToken,
  findPortalDraftSubmission,
  findPortalLinkRowByToken,
  getDocumentUploadRow,
  getDraftSectionState,
  getExportJob,
  getFirmRow,
  getFormSubmissionById,
  getHouseholdRow,
  getPipelineStageRecordRow,
  getPortalLinkRow,
  getProfileRow,
  getSessionByToken,
  getTemplateAggregateRow,
  getUploadIntent,
  getUploadIntentById,
  getUserByEmail,
  getUserRow,
  insertOidcLoginState,
  findOidcLoginStateByState,
  markOidcLoginStateUsed,
  incrementBoardVersionGuarded,
  insertAuditEvent,
  insertStageChange,
  insertUploadIntent,
  upsertEventRow,
  getEventRow,
  listEventRowsByFirm,
  upsertMeetingRow,
  getMeetingRow,
  listMeetingRowsByProfile,
  listMeetingRowsByFirm,
  deleteMeetingRow,
  listAllDocumentUploadRows,
  listAuditEvents,
  queryAuditEventsPage,
  listDocumentUploadRowsByFirm,
  listDocumentUploadRowsByFirmClient,
  listDraftSectionStates,
  listExportQueueJobs,
  listFirmRows,
  listFormSubmissionsByClient,
  listFormSubmissionsByFirm,
  listHouseholdRows,
  listNoteRowsByFirm,
  listNoteRowsByProfile,
  listPipelineStageRecordRows,
  listPortalLinkRowsByProfile,
  listProfileRows,
  listProspectRowsByStage,
  listProspectStageIds,
  listDocumentTemplateRows,
  listFormTemplateRows,
  listStageChangeRowsByClient,
  listStageChangeRowsByFirm,
  listTemplateAggregateRows,
  listUserRows,
  loadState,
  processExportQueueTickAsync,
  runInTransaction,
  saveDraftSectionStateGuarded,
  saveState,
  touchSession,
  updateFormSubmissionGuarded,
  upsertDocumentTemplateRow,
  upsertDocumentUploadRow,
  upsertFirmRow,
  upsertFormSubmission,
  upsertFormTemplateRow,
  upsertHouseholdRow,
  upsertInviteRow,
  upsertNoteRow,
  upsertPipelineStageRecord,
  upsertPortalLinkRow,
  upsertProfileRow,
  upsertPasswordResetRow,
  upsertSession,
  upsertTemplateAggregateRow,
  upsertUserRow
} from './storage.mjs'
import { createAuthService } from './auth/service.mjs'
import { createLocalAuthProvider } from './auth/local-provider.mjs'
import { createOidcAuthProvider } from './auth/oidc-provider.mjs'
import { createSamlAuthProvider } from './auth/saml-provider.mjs'
import { createGoogleOidcProvider } from './auth/google-oidc.mjs'
import { objectStorage as defaultObjectStorage } from './object-storage/index.mjs'
import { formatProfileSourceDisplay, migrateProfileSource, normalizeProfileSource } from './modules/profiles/source.mjs'
import { createCanonicalAuditEvent } from './modules/audit/schema.mjs'
import { createKeyProvider, PiiCryptoService } from './pii-crypto.mjs'
import { createRuntimeKmsAdapter } from './kms-adapter.mjs'
import { canUnmaskSensitiveData, maskSsn, maskTaxId, validateUnmaskRequest } from './security/pii-policy.mjs'
import { renderExportArtifact } from './export-artifact.mjs'
import { resolveExportData } from './export-data-resolution.mjs'
import { renderPdfFromTemplate } from './export-renderers/pdf-template.mjs'
import { createStoreExportsRepository } from './modules/exports/store-repository.mjs'
import {
  requireFirmContext,
  validateEntityOwnership as validateTenantEntityOwnership
} from './modules/shared/tenancy.mjs'
import {
  convertLegacyFormDefinition,
  validateFormDefinitionSchema
} from './modules/forms/schema/form-definition-validator.mjs'
import { validateMappingRules } from './modules/templates/schema/mapping-rules-validator.mjs'
import { collectMissingRequiredFields } from './form-conditions.mjs'
import { extractTemplateFieldsFromPdfBytes } from './modules/templates/template-ingestion.mjs'
import { buildFormTemplateFromExtractedFields } from './modules/templates/template-form-builder.mjs'
import { createDefaultFirmStageConfig, getStageKey, normalizeFirmStageConfig } from './stage-config.mjs'

import {
  CUSTOM_FIELD_TYPES,
  DEFAULT_PIPELINE_STAGES,
  INVITE_TTL_MS,
  LEGACY_STAGE_BUCKET,
  MEETING_TYPES,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_MAX_AGE_MS,
  STAGE_KEY_PATTERN,
  SYNTHETIC_STAGE_CHANGE_TARGETS
} from './store/constants.mjs'
import {
  assertRequiredFieldsForSubmission,
  assertStrongPassword,
  assignProspectOrderIndex,
  average,
  can,
  collectFormSchemaSourcePaths,
  createTemplateVersion,
  csvCell,
  customFieldValidationError,
  daysBetween,
  deepClone,
  defaultStageLabel,
  documentTemplateAdapter,
  formTemplateAdapter,
  hash,
  normalizeCustomFieldSchema,
  normalizeCustomFieldType,
  normalizeDraftCollaborators,
  normalizeExtensions,
  normalizeExtractedFields,
  normalizeFinancialSummary,
  normalizeProfileRecord,
  normalizeProfileTag,
  normalizeProfileTags,
  normalizeRequiredPdfFields,
  normalizeSectionIdentifier,
  normalizeStageConfiguration,
  normalizeTemplateAggregate,
  normalizeTemplateState,
  now,
  parseIso,
  persistTemplateAggregateRow,
  pipelineConflict,
  profileOrderIndex,
  profileSourcePathsForFirm,
  requirePermission,
  resolveFirmAnalyticsStages,
  resolveUserId,
  sanitizeFileName,
  stableSerialize,
  templateVersionHash,
  toIsoDate,
  validateCustomFieldRowInput
} from './store/helpers.mjs'
import { migrateFirmStageConfig, migrateTemplateSystems, seedState } from './store/boot.mjs'
import { createEventsDomain } from './store/events-domain.mjs'
import { createAnalyticsDomain } from './store/analytics-domain.mjs'

export function createStore({
  objectStorage = defaultObjectStorage,
  piiKeyProvider = null,
  piiCrypto = null,
  onSessionInvalidated = () => {}
} = {}) {
  const state = loadState(() => seedState({ objectStorage }))
  migrateTemplateSystems(state)
  migrateFirmStageConfig()
  ;(state.profiles || []).forEach((profile) => migrateProfileSource(profile))
  saveState(state)
  state.pipelineStagesByFirm ||= {}
  // Sessions live exclusively in the sessions table: migration 002 backfilled
  // (and normalized) legacy blob sessions, migration 003 cleared the blob, and
  // loadState always returns an empty sessions array. All session reads and
  // writes below go through the storage helpers.
  //
  // Form submissions, portal draft section states, and pending upload intents
  // live exclusively in their relational tables (migration 005): loadState
  // seeds/clears the blob mirrors, saveState serializes empty arrays for the
  // three keys, and every read/write below goes through the storage helpers.
  //
  // Profiles, stage changes, board versions, and pipeline stage records live
  // exclusively in their relational tables (migration 006): profile-record
  // normalization and prospect-ordering fixups were ported into the
  // migration, every read/write below goes through the storage helpers, and
  // executePipelineTransaction wraps board mutations in a real SQL
  // transaction.

  function normalizeObjectMetadata(metadata = {}, defaultRetentionClass = 'uploaded_document') {
    return {
      bucket: metadata.bucket,
      key: metadata.key,
      checksum: metadata.checksum || null,
      contentType: metadata.contentType || 'application/octet-stream',
      retentionClass: metadata.retentionClass || defaultRetentionClass
    }
  }

  // Resolve the object metadata to record for an upload COMPLETION, closing the
  // caller-supplied-key trust hole. Two cases:
  //   - Intent present: the intent's reserved object (minted server-side under
  //     `${firmId}/...` at presign time) is authoritative. A caller-supplied
  //     input.object may only ECHO the reserved bucket/key (used to carry an
  //     optional checksum hint); any bucket/key divergence is a tamper attempt
  //     and is rejected. This prevents registering/downloading an object at an
  //     arbitrary key (including another firm's) via a completion call.
  //   - No intent (legacy completion): the caller supplies the whole object, so
  //     the key MUST live under the caller's own firm namespace (`${firmId}/`,
  //     the prefix createUploadIntent and every server-minted key use). This
  //     blocks writing/registering an object outside the firm's prefix.
  function resolveCompletionObject({ intent, input = {}, firmId, defaultRetentionClass = 'uploaded_document' }) {
    const reject = (message) => {
      const error = new Error(message)
      error.statusCode = 403
      error.code = 'UPLOAD_OBJECT_KEY_FORBIDDEN'
      return error
    }
    const suppliedObject = input.object || {}
    if (intent?.object?.key) {
      if (suppliedObject.key && String(suppliedObject.key) !== String(intent.object.key)) {
        throw reject('Upload object key does not match the reserved upload intent.')
      }
      if (suppliedObject.bucket && String(suppliedObject.bucket) !== String(intent.object.bucket)) {
        throw reject('Upload object bucket does not match the reserved upload intent.')
      }
      return normalizeObjectMetadata(
        // Pin bucket/key to the intent; only adopt a caller checksum hint.
        { ...intent.object, checksum: suppliedObject.checksum || intent.object.checksum || null },
        input.retentionClass || intent.object.retentionClass || defaultRetentionClass
      )
    }
    const object = normalizeObjectMetadata(suppliedObject, input.retentionClass || defaultRetentionClass)
    // The register/download hijack requires an actual key. A keyless legacy record
    // (metadata-only, no object) has nothing to register or fetch, so we leave it
    // untouched; but ANY supplied key MUST live under the caller's own firm prefix
    // (the shape createUploadIntent and every server-minted key use) so it can
    // never point at another firm's object.
    if (object.key && !String(object.key).startsWith(`${firmId}/`)) {
      throw reject('Upload object key is outside this firm’s storage namespace.')
    }
    return object
  }

  function createUploadIntent({
    firmId,
    clientId,
    fileName,
    contentType,
    checksum,
    category,
    source,
    retentionClass,
    maxSizeBytes
  }) {
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
      // Per-flow byte ceiling the raw upload endpoint enforces alongside the
      // global 25 MB hard cap; null means "hard cap only".
      maxSizeBytes: Number(maxSizeBytes) > 0 ? Number(maxSizeBytes) : null,
      // Raw-PUT lifecycle marker: 'pending' at presign time, flipped to 'stored'
      // once bytes land at the reserved key. A single-use guard against re-PUTs.
      status: 'pending',
      createdAt: now(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    }
    // pending_upload_intents is the source of truth: targeted row insert
    // instead of pushing onto a blob-backed array.
    insertUploadIntent(intent)
    return intent
  }

  function normalizePortalScope(scope = {}) {
    return {
      templateIds: Array.isArray(scope.templateIds) ? [...new Set(scope.templateIds.filter(Boolean))] : null,
      uploadCategories: Array.isArray(scope.uploadCategories)
        ? [...new Set(scope.uploadCategories.filter(Boolean))]
        : null
    }
  }

  function resolvePortalLinkByToken(token) {
    const link = findPortalLinkRowByToken(token)
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

  // portal_links is the source of truth now, so the consumed link (mutated
  // usedCount/lastUsedAt) is written back with a targeted upsert instead of
  // relying on a blob-resident reference being flushed by persist().
  function consumePortalLinkUse(link) {
    link.usedCount = Number(link.usedCount || 0) + 1
    link.lastUsedAt = now()
    upsertPortalLinkRow(link)
  }

  function findPortalLink(token) {
    const link = findPortalLinkRowByToken(token)
    if (!link) throw new Error('Portal link not found.')
    return link
  }

  // A portal link is "active" when it is still usable by a portal visitor —
  // exactly the liveness contract resolvePortalLinkByToken enforces (not
  // revoked, not expired, and not use-exhausted). The archive guard reuses this
  // so archiving is blocked ONLY by links that could still grant portal access;
  // spent/revoked/expired links are dead and never block.
  function isPortalLinkActive(link) {
    if (!link || link.revokedAt) return false
    if (link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now()) return false
    if (Number(link.maxUses || 0) > 0 && Number(link.usedCount || 0) >= Number(link.maxUses)) return false
    return true
  }

  function listActivePortalLinksForProfile(firmId, profileId) {
    return listPortalLinkRowsByProfile(firmId, profileId).filter(isPortalLinkActive)
  }

  function findDraftForScope({ draftId, firmId, clientId }) {
    const submission = getFormSubmissionById(draftId, { firmId })
    if (!submission || submission.clientId !== clientId || submission.status !== 'draft') {
      throw new Error('Draft submission not found.')
    }
    return submission
  }

  // Draft submissions for the advisor lock/collaborator flows: firm-scoped by
  // id with the same status filter the old in-memory find applied.
  function findDraftSubmission(submissionId, firmId) {
    const submission = getFormSubmissionById(submissionId, { firmId })
    if (!submission || submission.status !== 'draft') return null
    return submission
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

    // document_uploads is the sole source of truth: iterate every row
    // (unscoped, across all firms) and write each mutated upload back as a
    // targeted row update instead of mutating an in-memory mirror.
    for (const upload of listAllDocumentUploadRows()) {
      const object = upload.object
      if (!object?.bucket || !object?.key) continue
      const ageDays = daysBetween(upload.createdAt, nowMs)
      if (ageDays >= policy.uploaded_document.purgeAfterDays) {
        await objectStorage.deleteObject(object).catch(() => null)
        upload.status = 'purged'
        upload.purgedAt = now()
        upsertDocumentUploadRow(upload)
      } else if (ageDays >= policy.uploaded_document.archiveAfterDays && upload.status !== 'archived') {
        upload.status = 'archived'
        upload.archivedAt = now()
        upsertDocumentUploadRow(upload)
      }
    }

    // export_jobs is the sole source of truth for the queue: read jobs from
    // the table and apply lifecycle transitions as targeted row updates
    // instead of mutating an in-memory mirror.
    for (const job of listExportQueueJobs()) {
      const object = job.output?.object
      if (!object?.bucket || !object?.key) continue
      const ageDays = daysBetween(job.updatedAt || job.createdAt, nowMs)
      if (ageDays >= policy.export_artifact.purgeAfterDays) {
        await objectStorage.deleteObject(object).catch(() => null)
        applyExportJobLifecycleUpdate(job.id, {
          status: job.status === 'completed' ? 'purged' : job.status,
          output: { ...job.output, purgedAt: now() }
        })
      } else if (ageDays >= policy.export_artifact.archiveAfterDays && !job.output.archivedAt) {
        applyExportJobLifecycleUpdate(job.id, {
          output: { ...job.output, archivedAt: now() }
        })
      }
    }

    // Stale presign intents that were never consumed: targeted delete on the
    // pending_upload_intents table (source of truth) once their expiry lapses.
    deleteExpiredUploadIntents(now())

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
    // Templates are no longer re-normalized/re-projected here: migrateTemplateSystems
    // runs once at boot, and each template mutation upserts its own row (aggregate
    // + companion projection). persist() only serializes the app_state blob (with
    // the relational arrays emptied) and rebuilds the materialized analytics.
    if (typeof testHooks.beforePersist === 'function') {
      testHooks.beforePersist(state)
    }
    saveState(state)
  }

  const exportsRepository = createStoreExportsRepository({
    state,
    persist,
    addAuditEvent: (user, payload) => {
      addAudit(
        user.firmId,
        user.id,
        payload.entityType || 'generic',
        payload.entityId || 'n/a',
        payload.action || 'event',
        payload.metadata || {}
      )
    },
    objectStorage,
    now
  })

  // board_versions is the source of truth; reading lazily creates the row at
  // version 1, exactly like the old in-memory map defaulted missing firms.
  function getBoardVersion(firmId) {
    return ensureBoardVersionRow(firmId)
  }

  // firms is a relational source of truth (migration 009): scoped row read.
  function getFirmRecord(firmId) {
    return getFirmRow(firmId)
  }

  function getFirmStageConfig(firmId) {
    const firm = getFirmRecord(firmId)
    if (!firm) return createDefaultFirmStageConfig()
    // Lazy normalization on read; the firm row is normalized at boot
    // (migrateFirmStageConfig) so this is a stable, idempotent transform and
    // does not need to be written back here.
    return firm.stageConfig ? normalizeFirmStageConfig(firm.stageConfig) : createDefaultFirmStageConfig()
  }

  function getActiveFirmStages(firmId) {
    const config = getFirmStageConfig(firmId)
    const activeKeys = config.stages
      .filter((stage) => stage.active !== false)
      .map((stage) => getStageKey(stage))
      .filter(Boolean)
    return activeKeys.length ? activeKeys : [getStageKey(config.stages[0] || { key: 'discovery' })]
  }

  function getDefaultFirmStage(firmId) {
    return getActiveFirmStages(firmId)[0] || 'discovery'
  }

  // Guarded UPDATE ... WHERE version = current: the relational concurrency
  // primitive for board mutations. Inside a pipeline transaction the guard
  // cannot lose (same connection, BEGIN IMMEDIATE), but a null result still
  // maps onto the standard 409 contract for safety.
  function bumpBoardVersion(firmId) {
    const current = getBoardVersion(firmId)
    const next = incrementBoardVersionGuarded(firmId, current)
    if (next === null) {
      throw pipelineConflict('Board version mismatch.', {
        expectedBoardVersion: Number(current),
        actualBoardVersion: Number(getBoardVersion(firmId))
      })
    }
    return next
  }

  function sanitizeStageId(value) {
    const id = String(value || '').trim()
    return id || null
  }

  function toStageLabel(stageId) {
    return stageId
      .split('_')
      .filter(Boolean)
      .map((segment) => `${segment[0]?.toUpperCase() || ''}${segment.slice(1)}`)
      .join(' ')
  }

  function firmPipelineStageRecords(firmId) {
    return listPipelineStageRecordRows(firmId)
  }

  function ensureFirmPipelineStageRecords(firmId) {
    if (countPipelineStageRecordRows(firmId) > 0) return
    const createdAt = now()
    const seeded = getFirmPipelineStageDefinitions(firmId)
      .filter((definition) => !definition.legacy)
      .map((definition, index) => ({
        id: randomUUID(),
        firmId,
        key: definition.id,
        label: definition.label,
        color: null,
        isActive: definition.active !== false,
        order: index + 1,
        createdAt,
        updatedAt: createdAt,
        deactivatedAt: null
      }))
    for (const record of seeded) {
      upsertPipelineStageRecord(record)
    }
  }

  function listFirmPipelineStages(firmId) {
    ensureFirmPipelineStageRecords(firmId)
    return firmPipelineStageRecords(firmId)
  }

  // --- Analytics stage config <-> pipeline stage records coupling -------------
  // The pipeline stage RECORDS (relational pipeline_stage_records rows) are the
  // source of truth mutated by the stage-management admin API (create / rename /
  // reorder / deactivate). Analytics, however, reads firm.stageConfig via
  // resolveFirmAnalyticsStages / buildAnalyticsSnapshot. Left decoupled, a
  // prospect sitting in a custom-created stage fails toAnalyticsStage's
  // stageIdSet membership check and collapses into LEGACY_STAGE_BUCKET.
  //
  // To keep ONE source of truth we rewrite firm.stageConfig from the current
  // stage records after every stage mutation, INSIDE the same persist() cycle so
  // analytics reflects the change immediately. Firms are relational rows: an
  // in-place firm mutation is not flushed by persist() on its own, so this helper
  // performs the required upsertFirmRow itself (mutation -> upsert discipline).
  //
  // Design choices baked in here:
  //  - Ordering: stageConfig mirrors record order, so the analytics funnel and
  //    stage-aging follow pipeline order and new custom stages slot into the
  //    funnel exactly where the pipeline places them.
  //  - Labels: record labels propagate into stageConfig, so a rename updates the
  //    analytics label (surfaced via getFirmStageMetadata -> stageMetadata /
  //    stageAging.stageLabel).
  //  - Deactivation: deactivated stages are KEPT in stageConfig (active:false),
  //    NOT dropped. This deliberately keeps their historical prospect counts as
  //    their own funnel / stage-aging entries instead of dumping those profiles
  //    into legacy_unassigned. The legacy bucket is reserved for genuinely
  //    orphaned stage ids — profiles referencing a stage that no record and no
  //    config entry knows about (pre-stage-management data, or a stage id removed
  //    out-of-band).
  function syncFirmStageConfigFromRecords(firmId) {
    const firm = getFirmRow(firmId)
    if (!firm) return
    const records = firmPipelineStageRecords(firmId)
    if (!records.length) return
    const stageConfig = normalizeFirmStageConfig({
      stages: records.map((record) => ({
        id: record.key,
        key: record.key,
        label: record.label || record.key,
        active: record.isActive !== false,
        order: record.order
      }))
    })
    upsertFirmRow({ ...firm, stageConfig })
  }

  function getFirmPipelineStageDefinitions(firmId) {
    const firm = getFirmRow(firmId)
    const stageRecords = firmPipelineStageRecords(firmId)
    const configured =
      (stageRecords.length > 0 &&
        stageRecords.map((entry) => ({
          id: entry.key,
          label: entry.label,
          order: entry.order,
          active: entry.isActive !== false
        }))) ||
      (Array.isArray(firm?.pipelineStages) && firm.pipelineStages) ||
      (Array.isArray(firm?.pipeline?.stages) && firm.pipeline.stages) ||
      (Array.isArray(firm?.config?.pipeline?.stages) && firm.config.pipeline.stages) ||
      null

    const source = configured && configured.length > 0 ? configured : DEFAULT_PIPELINE_STAGES
    const byId = new Map()
    source.forEach((entry, index) => {
      const id = sanitizeStageId(entry?.id || entry?.stage || entry?.key)
      if (!id || byId.has(id)) return
      byId.set(id, {
        id,
        label: String(entry?.label || toStageLabel(id)),
        order: Number.isFinite(Number(entry?.order)) ? Number(entry.order) : index + 1,
        active: entry?.active !== false,
        legacy: false
      })
    })

    const normalized = [...byId.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    const knownIds = new Set(normalized.map((stage) => stage.id))
    const legacyIds = new Set(
      listProspectStageIds(firmId)
        .map((stageId) => sanitizeStageId(stageId))
        .filter((stageId) => stageId && !knownIds.has(stageId))
    )
    const legacyStages = [...legacyIds]
      .sort((a, b) => a.localeCompare(b))
      .map((id, index) => ({
        id,
        label: `${toStageLabel(id)} (Legacy)`,
        order: normalized.length + index + 1,
        active: false,
        legacy: true
      }))

    return [...normalized, ...legacyStages]
  }

  function getActiveStageIds(firmId) {
    return getFirmPipelineStageDefinitions(firmId)
      .filter((stage) => stage.active)
      .map((stage) => stage.id)
  }

  function getDefaultProspectStage(firmId) {
    const first = getFirmPipelineStageDefinitions(firmId).find((stage) => stage.active)
    if (!first) {
      throw new Error('No active pipeline stages are configured for this firm.')
    }
    return first.id
  }

  function assertActiveStageForFirm(firmId, stage, fieldName = 'stage') {
    const stageId = sanitizeStageId(stage)
    const activeStageIds = new Set(getActiveStageIds(firmId))
    if (!stageId || !activeStageIds.has(stageId)) {
      throw new Error(`Unknown or inactive ${fieldName}: ${stage}.`)
    }
    return stageId
  }

  // Rows come back from SQL already in board order, but the in-memory sort is
  // reapplied so tie-breaking stays byte-identical to the old in-memory path.
  function listProspectsByStage(firmId, stage, excludedProfileId = null) {
    return listProspectRowsByStage(firmId, stage, excludedProfileId).sort((a, b) => {
      const indexDiff = profileOrderIndex(a) - profileOrderIndex(b)
      if (indexDiff !== 0) return indexDiff
      const updatedDiff = parseIso(a.updatedAt || a.createdAt || 0) - parseIso(b.updatedAt || b.createdAt || 0)
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
        upsertProfileRow(card)
        changed = true
      }
    })
    return changed
  }

  function normalizePipelineIndices(firmId, stage = null) {
    const stages = stage ? [stage] : getFirmPipelineStageDefinitions(firmId).map((entry) => entry.id)
    const normalizedStages = []
    for (const currentStage of stages) {
      if (compactStageIndices(firmId, currentStage)) {
        normalizedStages.push(currentStage)
      }
    }
    return normalizedStages
  }

  function getFirmStageMetadata(firmId) {
    const firm = getFirmRow(firmId)
    const analyticsStages = resolveFirmAnalyticsStages(firm)
    const definitionsById = new Map(getFirmPipelineStageDefinitions(firmId).map((stage) => [stage.id, stage]))
    return analyticsStages.stageOrder.map((stageId, index) => {
      const definition = definitionsById.get(stageId)
      return {
        id: stageId,
        label: definition?.label || toStageLabel(stageId),
        order: index + 1,
        active: definition?.active !== false,
        legacy: Boolean(definition?.legacy),
        isStart: stageId === analyticsStages.startStage,
        isTerminal: stageId === analyticsStages.endStage,
        isDrop: stageId.startsWith('drop_')
      }
    })
  }

  function buildBoardPayload(user, conflict = null) {
    const stageDefinitions = getFirmPipelineStageDefinitions(user.firmId)
    const columns = stageDefinitions.map((stageDefinition) => ({
      stage: stageDefinition.id,
      label: stageDefinition.label,
      active: stageDefinition.active,
      legacy: stageDefinition.legacy,
      order: stageDefinition.order,
      orderingVersion: getBoardVersion(user.firmId),
      cards: listProspectsByStage(user.firmId, stageDefinition.id)
    }))
    return {
      boardVersion: getBoardVersion(user.firmId),
      generatedAt: now(),
      stages: stageDefinitions.map((stage) => ({
        id: stage.id,
        label: stage.label,
        order: stage.order,
        active: stage.active,
        legacy: stage.legacy
      })),
      ordering: {
        mode: 'sequential_stage_index',
        normalized: true
      },
      conflict,
      columns,
      stageMetadata: getFirmStageMetadata(user.firmId)
    }
  }

  // Audit events recorded while a pipeline transaction is in flight are
  // buffered and inserted just before commit, INSIDE the same SQL
  // transaction: a failure anywhere (mutator, persist, audit insert) rolls
  // the whole unit back — profile rows, stage changes, board version, blob,
  // and audit rows together. Failed transactions never leak audit rows.
  let pipelineAuditBuffer = null

  // Real BEGIN IMMEDIATE transaction (via the storage-layer runInTransaction
  // helper). Profiles/stageChanges/boardVersions are relational rows now, so
  // rollback is SQL rollback — the old in-memory snapshot/restore is gone.
  function executePipelineTransaction(mutator) {
    pipelineAuditBuffer = []
    try {
      return runInTransaction(() => {
        const result = mutator()
        persist()
        const buffered = pipelineAuditBuffer
        pipelineAuditBuffer = null
        for (const event of buffered) {
          insertAuditEvent(event)
        }
        return result
      })
    } finally {
      pipelineAuditBuffer = null
    }
  }

  function createSession(user) {
    const token = randomUUID()
    const createdAt = now()
    const lastActivityAt = createdAt
    const session = {
      token,
      userId: user.id,
      firmId: user.firmId,
      createdAt,
      lastActivityAt,
      expiresAt: new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString(),
      idleExpiresAt: new Date(Date.now() + SESSION_IDLE_TIMEOUT_MS).toISOString()
    }
    upsertSession(session)
    persist()
    return { token, user: publicUser(user) }
  }

  function invalidateSession(session, reason = 'unknown') {
    if (!session?.token) return false
    const removed = deleteSession(session.token)
    if (removed) {
      onSessionInvalidated({
        token: session.token,
        userId: session.userId,
        firmId: session.firmId,
        reason
      })
    }
    return removed
  }

  // Deletes every expired session row and fires the per-session invalidation
  // callback (CSRF cleanup) for each. A session expires either absolutely
  // (expiresAt passed) or by idling out (idleExpiresAt passed) — the reason
  // computation mirrors the old in-memory check exactly: a session that is
  // still absolutely valid can only have idled out. No persist(): sessions no
  // longer live in the blob, so a prune touches only the sessions table.
  function pruneExpiredSessions() {
    const nowMs = Date.now()
    const expired = deleteExpiredSessions(new Date(nowMs).toISOString())
    for (const entry of expired) {
      const absoluteValid = new Date(entry.expiresAt).getTime() > nowMs
      onSessionInvalidated({
        token: entry.token,
        userId: entry.userId,
        firmId: entry.firmId,
        reason: absoluteValid ? 'idle_timeout' : 'max_age_expired'
      })
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
    // Prune first so an expired-but-still-present row can never authenticate:
    // any session row that survives the prune is both absolutely valid and
    // idle-valid at this instant.
    pruneExpiredSessions()
    const session = getSessionByToken(token)
    if (!session) throw new Error('Authentication required.')
    // users is a relational source of truth (migration 009): scoped row read,
    // firm-matched exactly like the old in-memory find.
    const user = getUserRow(session.userId)
    if (!user || user.firmId !== session.firmId) throw new Error('Authentication required.')
    // Activity touches happen on EVERY authenticated request and used to call
    // persist(), serializing the entire state blob and rebuilding ~10 derived
    // tables per GET. A single-row UPDATE on the sessions table replaces that;
    // the blob does not carry sessions at all anymore.
    touchSession(session.token, {
      lastActivityAt: now(),
      idleExpiresAt: new Date(Date.now() + SESSION_IDLE_TIMEOUT_MS).toISOString()
    })
    return publicUser(user)
  }

  function rotateSession(token, reason = 'privilege_transition') {
    pruneExpiredSessions()
    const session = getSessionByToken(token)
    if (!session) throw new Error('Authentication required.')
    const user = getUserRow(session.userId)
    if (!user || user.firmId !== session.firmId) throw new Error('Authentication required.')
    invalidateSession(session, reason)
    persist()
    return createSession(user)
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
      after: metadataOnly ? changeSet || null : (changeSet.after ?? null),
      requestId: options.requestId || null,
      ip: options.ip || null,
      timestamp: now()
    })
    // audit_events is the append-only source of truth: insert the canonical
    // event directly instead of pushing onto a blob-backed array. Inside a
    // pipeline transaction the event is buffered and inserted only after the
    // transaction succeeds (see executePipelineTransaction).
    if (pipelineAuditBuffer) {
      pipelineAuditBuffer.push(event)
      return
    }
    insertAuditEvent(event)
    // persist() still runs by default: many callers mutate other blob-backed
    // state (users, invites, profiles) right before recording the audit event
    // and rely on this to flush it.
    if (options.persist !== false) {
      persist()
    }
  }

  // Resolve profile.source with an optional eventId linkage. The referenced
  // event must exist and be firm-scoped (else a validation error is thrown at
  // write time). Missing source venue/city/date are auto-filled from the event
  // so a profile linked to an event inherits its attribution; explicitly
  // provided source fields always win. normalizeProfileSource then validates the
  // merged object (it still requires city/venue/date to be present after the
  // auto-fill). Returns whatever normalizeProfileSource returns (including null
  // for an absent source).
  function resolveProfileSource(firmId, source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      return normalizeProfileSource(source)
    }
    const eventId = source.eventId == null ? null : String(source.eventId).trim()
    if (!eventId) {
      return normalizeProfileSource(source)
    }
    const event = getEventRow(eventId, { firmId })
    if (!event || event.archivedAt) {
      const error = new Error('Profile source references an unknown or archived event.')
      error.statusCode = 400
      error.code = 'PROFILE_SOURCE_EVENT_NOT_FOUND'
      error.details = { eventId }
      throw error
    }
    const merged = {
      ...source,
      eventId,
      sourceCity: source.sourceCity ?? source.cityOrLocation ?? event.city ?? undefined,
      sourceVenue: source.sourceVenue ?? source.venue ?? event.venue ?? undefined,
      sourceDate: source.sourceDate ?? source.occurredOn ?? event.eventDate ?? undefined
    }
    return normalizeProfileSource(merged)
  }

  function requireClientProfile(user) {
    requirePermission(user, 'portal:read')
    const userEmail = String(user?.email || '').toLowerCase()
    if (!userEmail) throw new Error('Client profile not found.')
    const profile = findClientProfileRowByEmail(user.firmId, userEmail)
    if (!profile) throw new Error('Client profile not found.')
    // Archive semantics: archiving a client SUSPENDS their portal/client access.
    // findClientProfileRowByEmail is a plain email lookup that still resolves
    // archived rows (its other caller — invite-accept de-dup — needs that), so we
    // exclude archived profiles HERE, at the auth-resolution site, rather than in
    // the shared lookup. An archived client is treated as if no profile exists.
    if (profile.archivedAt) throw new Error('Client profile not found.')
    return profile
  }

  function createAuthProvider() {
    // deleteSessionsByUser: bulk revocation for password reset — the sessions
    // table is the only place sessions live, so providers revoke through it.
    const common = { state, persist, createSession, addAudit, deleteSessionsByUser }
    if (runtime.authProvider === 'local') return createLocalAuthProvider(common)
    // firms/users are relational sources of truth (migration 009): the federated
    // providers upsert synced identities into their tables.
    const federatedCommon = { ...common, upsertUserRow, upsertFirmRow }
    if (runtime.authProvider === 'oidc') return createOidcAuthProvider(federatedCommon)
    if (runtime.authProvider === 'saml') return createSamlAuthProvider(federatedCommon)
    throw new Error(`Unsupported auth provider: ${runtime.authProvider}.`)
  }

  const auth = createAuthService({ provider: createAuthProvider() })

  // Google interactive sign-in sits ALONGSIDE the configured auth provider (it is
  // not the AUTH_PROVIDER selection). It is inert unless GOOGLE_CLIENT_ID +
  // GOOGLE_CLIENT_SECRET are set. It establishes sessions the same way local
  // login does (createSession + auth.login audit), matching an existing pilot
  // user by verified email — no auto-provisioning.
  const googleOidc = createGoogleOidcProvider({
    config: runtime.googleOidc,
    storage: {
      insertLoginState: insertOidcLoginState,
      findLoginStateByState: findOidcLoginStateByState,
      markLoginStateUsed: markOidcLoginStateUsed
    },
    createSession,
    addAudit,
    getUserByEmail
  })

  // Domain method groups. Each factory receives only the closure-bound
  // dependencies it needs (state/persist/audit/etc.); everything else it imports
  // directly from the shared store/* modules. The returned method groups are
  // spread into the store facade below with no key collisions.
  const eventsDomain = createEventsDomain({ addAudit, persist })
  const analyticsDomain = createAnalyticsDomain({ state, getFirmStageMetadata })

  return {
    ...eventsDomain,
    ...analyticsDomain,
    state,
    googleOidc,
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
      requirePermission(user, 'dashboard:read')
      // Insertion-order table read: recentProfiles keeps showing the last
      // five created profiles, exactly like the old in-memory array slice.
      // Archived profiles/households are soft-deleted: excluded from every count
      // and from the recent-profiles strip. They remain readable at their detail
      // route but never inflate dashboard stats.
      const profiles = listProfileRows({ firmId: user.firmId }).filter((profile) => !profile.archivedAt)
      const prospects = profiles.filter((profile) => profile.kind === 'prospect')
      const clients = profiles.filter((profile) => profile.kind === 'client')
      return {
        firm: getFirmRow(user.firmId),
        stats: {
          totalProfiles: profiles.length,
          prospects: prospects.length,
          clients: clients.length,
          households: listHouseholdRows({ firmId: user.firmId }).filter((household) => !household.archivedAt).length,
          forms: countFormSubmissionsByFirm(user.firmId),
          exports: listExportQueueJobs().filter((job) => job.firmId === user.firmId).length
        },
        recentProfiles: profiles.slice(-5).reverse(),
        // Firm-scoped SQL read: audit_events is the source of truth.
        recentAuditEvents: listAuditEvents(user.firmId, { limit: 10 })
      }
    },
    listProfiles(user, kind, search = '', options = {}) {
      requirePermission(user, 'profiles:read')
      const q = String(search || '').toLowerCase()
      // Archived profiles are hidden by default (client pickers, portal-link
      // targets, and the directory all read through here). `includeArchived`
      // opts a single caller — the directory's "Show archived" toggle — back in.
      const includeArchived = Boolean(options?.includeArchived)
      return listProfileRows({ firmId: user.firmId })
        .filter((profile) => includeArchived || !profile.archivedAt)
        .filter((profile) => !kind || profile.kind === kind)
        .filter(
          (profile) => !q || `${profile.firstName} ${profile.lastName} ${profile.email || ''}`.toLowerCase().includes(q)
        )
        .sort(
          (a, b) =>
            (a.stage || '').localeCompare(b.stage || '') ||
            profileOrderIndex(a) - profileOrderIndex(b) ||
            parseIso(a.updatedAt || a.createdAt) - parseIso(b.updatedAt || b.createdAt) ||
            a.id.localeCompare(b.id)
        )
    },
    getProfileDetail(user, profileId) {
      const firmContext = requireFirmContext(user, { method: 'store.getProfileDetail' })
      requirePermission(user, 'profiles:read')
      const profile = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
        entityName: 'Profile'
      })
      const household = profile.householdId
        ? getHouseholdRow(profile.householdId, { firmId: user.firmId })
        : null
      const householdMembers = household
        ? state.householdMembers.filter((entry) => entry.householdId === household.id && entry.firmId === user.firmId)
        : []
      const submissions = listFormSubmissionsByClient(user.firmId, profile.id)
      const stageHistory = listStageChangeRowsByClient(user.firmId, profile.id)
      const notes = listNoteRowsByProfile(user.firmId, profile.id)
        .reverse()
        .map((entry) => ({ ...entry, body: entry.body || decryptSensitiveValue(entry.bodyEncrypted) || '' }))
      return { profile, household, householdMembers, submissions, stageHistory, notes }
    },
    createProfile(user, input) {
      requirePermission(user, 'profiles:write')
      const createdAt = now()
      const nextProspectStage =
        input.kind === 'prospect'
          ? assertActiveStageForFirm(user.firmId, input.stage || getDefaultProspectStage(user.firmId), 'stage')
          : null
      const inStage = nextProspectStage ? countProspectRowsInStage(user.firmId, nextProspectStage) : 0
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
        source: resolveProfileSource(user.firmId, input.source),
        status: input.status || (input.kind === 'client' ? 'active' : 'new'),
        stage: nextProspectStage,
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
      upsertProfileRow(profile)
      if (profile.stage) {
        insertStageChange({
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
      const profile = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
        entityName: 'Profile'
      })
      const nextKind = patch.kind || profile.kind
      if (nextKind === 'prospect' && !patch.stage && 'kind' in patch) {
        patch.stage = getDefaultProspectStage(user.firmId)
      }
      if (nextKind === 'prospect' && 'stage' in patch) {
        patch.stage = assertActiveStageForFirm(user.firmId, patch.stage, 'stage')
      }
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
      if ('source' in nextPatch) {
        nextPatch.source = resolveProfileSource(user.firmId, nextPatch.source)
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
      if ('tags' in nextPatch) nextPatch.tags = normalizeProfileTags(nextPatch.tags)
      Object.assign(profile, nextPatch, { updatedAt: now() })
      upsertProfileRow(profile)
      addAudit(user.firmId, user.id, 'profile', profileId, 'profile.updated', { fields: Object.keys(patch) })
      persist()
      return profile
    },
    // Promote a prospect to an active client. This is a board-touching write
    // (it vacates the prospect's stage), so it runs inside the same pipeline
    // transaction machinery as reorderBoard: deferred audits, SQL rollback on
    // failure, and a board-version bump so open kanban sessions reconcile.
    convertProspectToClient(user, profileId, options = {}) {
      const firmContext = requireFirmContext(user, { method: 'store.convertProspectToClient' })
      requirePermission(user, 'profiles:write')
      const { expectedUpdatedAt = null } = options || {}
      return executePipelineTransaction(() => {
        const profile = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
          entityName: 'Profile'
        })
        if (profile.kind !== 'prospect') {
          const error = new Error('Only prospects can be converted to clients.')
          error.statusCode = 409
          error.code = 'PROFILE_NOT_PROSPECT'
          error.details = { profileId, kind: profile.kind }
          throw error
        }
        // Same optimistic-concurrency contract as updateProfile's service-layer
        // precondition (PROFILE_UPDATE_CONFLICT), enforced here inside the
        // transaction so a concurrent edit between read and convert also loses.
        if (expectedUpdatedAt && String(expectedUpdatedAt) !== String(profile.updatedAt)) {
          const error = new Error('Profile update conflict: updatedAt precondition failed.')
          error.statusCode = 409
          error.code = 'PROFILE_UPDATE_CONFLICT'
          error.details = {
            expectedUpdatedAt,
            currentUpdatedAt: profile.updatedAt,
            mergePrompt: {
              suggestion: 'Conflict detected: another change was saved first. Review latest data and retry.'
            }
          }
          throw error
        }

        const fromStage = profile.stage || null
        const convertedAt = now()
        profile.kind = 'client'
        profile.stage = null
        profile.stageOrderIndex = null
        profile.orderIndex = null
        profile.pipelineVersion = null
        if (profile.status === 'new') profile.status = 'active'
        profile.updatedAt = convertedAt
        upsertProfileRow(profile)

        // Compact the vacated stage so the remaining prospects keep contiguous
        // 1..n order indices (same hygiene as reorderBoard's previous-stage path).
        if (fromStage) {
          compactStageIndices(user.firmId, fromStage)
        }
        bumpBoardVersion(user.firmId)
        // Terminal marker row. toStage:'converted' is a synthetic sentinel, not a
        // real stage id: analytics' toAnalyticsStage() buckets any unknown stage
        // into LEGACY_STAGE_BUCKET, and both the funnel and stage-aging loops
        // iterate only kind==='prospect' profiles — a converted profile is now a
        // client, so this row is never read for funnel/aging math. It exists only
        // as an audit-grade "left the pipeline" marker in the profile's stage
        // history, where 'converted' renders as a readable destination.
        insertStageChange({
          id: randomUUID(),
          firmId: user.firmId,
          clientId: profile.id,
          fromStage,
          toStage: 'converted',
          changedByUserId: user.id,
          changedAt: convertedAt
        })
        addAudit(
          user.firmId,
          user.id,
          'profile',
          profile.id,
          'profile.converted',
          { fromKind: 'prospect', toKind: 'client', fromStage },
          { persist: false }
        )
        return { profile, board: buildBoardPayload(user) }
      })
    },
    // Soft-delete a profile (archive). Conservative semantics documented inline:
    //  - A PROSPECT leaves the board exactly like conversion does: its stage and
    //    order indices are cleared, the vacated stage is compacted, and the board
    //    version is bumped so open kanban sessions reconcile. The previous stage
    //    is remembered in `archivedFromStage` so restore can re-seat the card.
    //    Nulling the stage means the SQL board reads (listProspectRowsByStage,
    //    countProspectRowsInStage) naturally exclude it — no column/migration
    //    needed. kind stays 'prospect'; only in-memory profile readers must skip
    //    archived rows (see getDashboard/listProfiles/buildAnalyticsSnapshot).
    //  - A CLIENT is never on the board, so archiving just stamps archivedAt.
    //  - EITHER remains fully readable at its detail route (with its notes,
    //    uploads, and submissions intact); it is only hidden from lists/counts.
    //  - Guard: a profile with a live portal link is blocked (409) rather than
    //    silently orphaning that access — the advisor must revoke the link first.
    archiveProfile(user, profileId, options = {}) {
      const firmContext = requireFirmContext(user, { method: 'store.archiveProfile' })
      requirePermission(user, 'profiles:write')
      const { expectedUpdatedAt = null } = options || {}

      const assertArchivePreconditions = (profile) => {
        if (profile.archivedAt) {
          const error = new Error('Profile is already archived.')
          error.statusCode = 409
          error.code = 'PROFILE_ALREADY_ARCHIVED'
          error.details = { profileId }
          throw error
        }
        if (expectedUpdatedAt && String(expectedUpdatedAt) !== String(profile.updatedAt)) {
          const error = new Error('Profile update conflict: updatedAt precondition failed.')
          error.statusCode = 409
          error.code = 'PROFILE_UPDATE_CONFLICT'
          error.details = {
            expectedUpdatedAt,
            currentUpdatedAt: profile.updatedAt,
            mergePrompt: {
              suggestion: 'Conflict detected: another change was saved first. Review latest data and retry.'
            }
          }
          throw error
        }
        const activeLinks = listActivePortalLinksForProfile(user.firmId, profileId)
        if (activeLinks.length) {
          const error = new Error(
            'Profile has active portal links. Revoke them before archiving so no live portal access is orphaned.'
          )
          error.statusCode = 409
          error.code = 'PROFILE_HAS_ACTIVE_PORTAL_LINKS'
          error.details = { profileId, activePortalLinkIds: activeLinks.map((link) => link.id) }
          throw error
        }
      }

      // Prospect archive touches the board, so it runs inside the same pipeline
      // transaction machinery as convert (deferred audit, SQL rollback, board
      // version bump). The preconditions are re-checked INSIDE the transaction
      // to close the read/archive race.
      const preview = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
        entityName: 'Profile'
      })
      if (preview.kind === 'prospect') {
        return executePipelineTransaction(() => {
          const profile = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
            entityName: 'Profile'
          })
          assertArchivePreconditions(profile)
          const fromStage = profile.stage || null
          const archivedAt = now()
          profile.archivedAt = archivedAt
          // Remember where the card was so restore can re-enter the same stage.
          profile.archivedFromStage = fromStage
          profile.stage = null
          profile.stageOrderIndex = null
          profile.orderIndex = null
          profile.pipelineVersion = null
          profile.updatedAt = archivedAt
          upsertProfileRow(profile)
          if (fromStage) {
            compactStageIndices(user.firmId, fromStage)
          }
          bumpBoardVersion(user.firmId)
          // Audit-grade "left the board" marker in stage history. toStage
          // 'archived' is a synthetic sentinel (like convert's 'converted'):
          // analytics only reads stage history for kind==='prospect' &&
          // !archivedAt profiles, so this row never distorts funnel/aging math.
          insertStageChange({
            id: randomUUID(),
            firmId: user.firmId,
            clientId: profile.id,
            fromStage,
            toStage: 'archived',
            changedByUserId: user.id,
            changedAt: archivedAt
          })
          addAudit(
            user.firmId,
            user.id,
            'profile',
            profile.id,
            'profile.archived',
            { kind: 'prospect', fromStage },
            { persist: false }
          )
          return { profile, board: buildBoardPayload(user) }
        })
      }

      // Client archive: no board involvement, so a plain mutate + persist.
      const profile = preview
      assertArchivePreconditions(profile)
      const archivedAt = now()
      profile.archivedAt = archivedAt
      profile.updatedAt = archivedAt
      upsertProfileRow(profile)
      addAudit(user.firmId, user.id, 'profile', profile.id, 'profile.archived', { kind: profile.kind })
      persist()
      return { profile, board: buildBoardPayload(user) }
    },
    // Restore (un-archive) a profile. Clears archivedAt. A restored PROSPECT
    // re-enters the board at the END of its previous stage when that stage still
    // exists AND is active; otherwise it falls back to the default start stage
    // (same stage-assignment rule createProfile uses). Order indices are assigned
    // contiguously after the current occupants and the board version is bumped. A
    // restored CLIENT simply clears archivedAt.
    restoreProfile(user, profileId, options = {}) {
      const firmContext = requireFirmContext(user, { method: 'store.restoreProfile' })
      requirePermission(user, 'profiles:write')
      const { expectedUpdatedAt = null } = options || {}

      const assertRestorePreconditions = (profile) => {
        if (!profile.archivedAt) {
          const error = new Error('Profile is not archived.')
          error.statusCode = 409
          error.code = 'PROFILE_NOT_ARCHIVED'
          error.details = { profileId }
          throw error
        }
        if (expectedUpdatedAt && String(expectedUpdatedAt) !== String(profile.updatedAt)) {
          const error = new Error('Profile update conflict: updatedAt precondition failed.')
          error.statusCode = 409
          error.code = 'PROFILE_UPDATE_CONFLICT'
          error.details = {
            expectedUpdatedAt,
            currentUpdatedAt: profile.updatedAt,
            mergePrompt: {
              suggestion: 'Conflict detected: another change was saved first. Review latest data and retry.'
            }
          }
          throw error
        }
      }

      const preview = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
        entityName: 'Profile'
      })
      if (preview.kind === 'prospect') {
        return executePipelineTransaction(() => {
          const profile = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
            entityName: 'Profile'
          })
          assertRestorePreconditions(profile)
          const activeStageIds = new Set(getActiveStageIds(user.firmId))
          const previousStage = profile.archivedFromStage || null
          const targetStage =
            previousStage && activeStageIds.has(previousStage) ? previousStage : getDefaultProspectStage(user.firmId)
          // Append after the current occupants of the target stage (1-based).
          const inStage = countProspectRowsInStage(user.firmId, targetStage)
          const restoredAt = now()
          profile.archivedAt = null
          delete profile.archivedFromStage
          profile.stage = targetStage
          profile.stageOrderIndex = inStage + 1
          profile.orderIndex = inStage + 1
          profile.pipelineVersion = 1
          profile.updatedAt = restoredAt
          upsertProfileRow(profile)
          insertStageChange({
            id: randomUUID(),
            firmId: user.firmId,
            clientId: profile.id,
            toStage: targetStage,
            changedByUserId: user.id,
            changedAt: restoredAt
          })
          bumpBoardVersion(user.firmId)
          addAudit(
            user.firmId,
            user.id,
            'profile',
            profile.id,
            'profile.restored',
            { kind: 'prospect', toStage: targetStage },
            { persist: false }
          )
          return { profile, board: buildBoardPayload(user) }
        })
      }

      const profile = preview
      assertRestorePreconditions(profile)
      const restoredAt = now()
      profile.archivedAt = null
      if ('archivedFromStage' in profile) delete profile.archivedFromStage
      profile.updatedAt = restoredAt
      upsertProfileRow(profile)
      addAudit(user.firmId, user.id, 'profile', profile.id, 'profile.restored', { kind: profile.kind })
      persist()
      return { profile, board: buildBoardPayload(user) }
    },
    addProfileTag(user, profileId, tag) {
      const firmContext = requireFirmContext(user, { method: 'store.addProfileTag' })
      requirePermission(user, 'profiles:write')
      const profile = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
        entityName: 'Profile'
      })
      const normalized = normalizeProfileTag(tag)
      if (!normalized) throw new Error('Tag is required.')
      const nextTags = normalizeProfileTags([...(profile.tags || []), normalized])
      const changed = nextTags.length !== (profile.tags || []).length
      profile.tags = nextTags
      if (changed) {
        profile.updatedAt = now()
        upsertProfileRow(profile)
        addAudit(user.firmId, user.id, 'profile', profileId, 'profile.tag_added', { tag: normalized })
        persist()
      }
      return profile
    },
    removeProfileTag(user, profileId, tag) {
      const firmContext = requireFirmContext(user, { method: 'store.removeProfileTag' })
      requirePermission(user, 'profiles:write')
      const profile = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
        entityName: 'Profile'
      })
      const target = normalizeProfileTag(tag).toLowerCase()
      const nextTags = (profile.tags || []).filter((entry) => normalizeProfileTag(entry).toLowerCase() !== target)
      const changed = nextTags.length !== (profile.tags || []).length
      profile.tags = nextTags
      if (changed) {
        profile.updatedAt = now()
        upsertProfileRow(profile)
        addAudit(user.firmId, user.id, 'profile', profileId, 'profile.tag_removed', { tag: normalizeProfileTag(tag) })
        persist()
      }
      return profile
    },
    getProfileCustomFieldSchema(user) {
      requirePermission(user, 'profiles:read')
      const firm = getFirmRow(user.firmId)
      if (!firm) throw new Error('Firm not found.')
      firm.customFieldSchema = normalizeCustomFieldSchema(firm.customFieldSchema)
      return deepClone(firm.customFieldSchema)
    },
    createProfileCustomField(user, input = {}) {
      requirePermission(user, 'users:manage')
      const firm = getFirmRow(user.firmId)
      if (!firm) throw new Error('Firm not found.')
      firm.customFieldSchema = normalizeCustomFieldSchema(firm.customFieldSchema)
      const key = String(input?.key || '')
        .trim()
        .replace(/[^a-zA-Z0-9_]+/g, '_')
      if (!key) throw customFieldValidationError('Custom field key is required.', { key: 'Key is required.' })
      if (firm.customFieldSchema.fields.some((field) => field.key === key)) {
        throw customFieldValidationError('Custom field key already exists.', { key: 'Key already exists.' })
      }
      const type = normalizeCustomFieldType(input?.type)
      if (!CUSTOM_FIELD_TYPES.has(type)) {
        throw customFieldValidationError('Custom field type must be one of: text, number, boolean, date.', {
          type: 'Type must be one of: text, number, boolean, date.'
        })
      }
      if (input?.metadata != null && (typeof input.metadata !== 'object' || Array.isArray(input.metadata))) {
        throw customFieldValidationError('Custom field metadata must be a JSON object.', {
          metadata: 'Metadata must be a JSON object.'
        })
      }
      const field = {
        key,
        type,
        label: String(input?.label || key).trim() || key,
        required: Boolean(input?.required),
        metadata:
          input?.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
            ? { ...input.metadata }
            : {}
      }
      firm.customFieldSchema.fields.push(field)
      firm.customFieldSchema.updatedAt = now()
      // firms is a source-of-truth table now: the mutated firm must be upserted
      // (persist() no longer flushes firm rows).
      upsertFirmRow(firm)
      persist()
      return deepClone(field)
    },
    updateProfileCustomField(user, fieldKey, patch = {}) {
      requirePermission(user, 'users:manage')
      const firm = getFirmRow(user.firmId)
      if (!firm) throw new Error('Firm not found.')
      firm.customFieldSchema = normalizeCustomFieldSchema(firm.customFieldSchema)
      const field = firm.customFieldSchema.fields.find((entry) => entry.key === fieldKey)
      if (!field) throw new Error('Custom field not found.')
      if ('type' in patch) {
        const nextType = normalizeCustomFieldType(patch.type)
        if (!CUSTOM_FIELD_TYPES.has(nextType)) {
          throw customFieldValidationError('Custom field type must be one of: text, number, boolean, date.', {
            type: 'Type must be one of: text, number, boolean, date.'
          })
        }
        field.type = nextType
      }
      if ('label' in patch) field.label = String(patch.label || field.key).trim() || field.key
      if ('required' in patch) field.required = Boolean(patch.required)
      if ('metadata' in patch) {
        if (patch.metadata != null && (typeof patch.metadata !== 'object' || Array.isArray(patch.metadata))) {
          throw customFieldValidationError('Custom field metadata must be a JSON object.', {
            metadata: 'Metadata must be a JSON object.'
          })
        }
        field.metadata =
          patch.metadata && typeof patch.metadata === 'object' && !Array.isArray(patch.metadata)
            ? { ...patch.metadata }
            : {}
      }
      firm.customFieldSchema.updatedAt = now()
      upsertFirmRow(firm)
      persist()
      return deepClone(field)
    },
    previewProfileCustomFieldSchema(user, input = {}) {
      requirePermission(user, 'users:manage')
      const firm = getFirmRow(user.firmId)
      if (!firm) throw new Error('Firm not found.')
      firm.customFieldSchema = normalizeCustomFieldSchema(firm.customFieldSchema)
      const rows = Array.isArray(input?.rows) ? input.rows : []
      const knownKeys = new Set(firm.customFieldSchema.fields.map((field) => field.key))
      const seenKeys = new Set()
      const normalizedRows = []
      const validation = []
      rows.forEach((row, index) => {
        const checked = validateCustomFieldRowInput(row, { requireKnownKey: false, knownKeys })
        const fieldErrors = { ...checked.fieldErrors }
        if (checked.normalized.key && seenKeys.has(checked.normalized.key))
          fieldErrors.key = 'Duplicate key in bulk payload.'
        if (checked.normalized.key) seenKeys.add(checked.normalized.key)
        if (Object.keys(fieldErrors).length) {
          validation.push({ index, key: checked.normalized.key || String(row?.key || ''), fieldErrors })
        }
        normalizedRows.push(checked.normalized)
      })
      const nextByKey = new Map(normalizedRows.map((row) => [row.key, row]))
      const currentByKey = new Map(firm.customFieldSchema.fields.map((field) => [field.key, field]))
      const added = []
      const updated = []
      const unchanged = []
      const removed = []
      nextByKey.forEach((row, key) => {
        if (!key) return
        const current = currentByKey.get(key)
        if (!current) {
          added.push(row)
          return
        }
        const hasChange =
          current.type !== row.type ||
          (current.label || current.key) !== row.label ||
          Boolean(current.required) !== Boolean(row.required) ||
          JSON.stringify(current.metadata || {}) !== JSON.stringify(row.metadata || {})
        if (hasChange) updated.push({ before: current, after: row })
        else unchanged.push(row)
      })
      currentByKey.forEach((field, key) => {
        if (!nextByKey.has(key)) removed.push(field)
      })
      return {
        dryRun: true,
        normalizedRows,
        validation,
        valid: validation.length === 0,
        diff: {
          added,
          updated,
          removed,
          unchanged,
          counts: {
            added: added.length,
            updated: updated.length,
            removed: removed.length,
            unchanged: unchanged.length
          }
        }
      }
    },
    deleteProfileCustomField(user, fieldKey) {
      requirePermission(user, 'users:manage')
      const firm = getFirmRow(user.firmId)
      if (!firm) throw new Error('Firm not found.')
      firm.customFieldSchema = normalizeCustomFieldSchema(firm.customFieldSchema)
      const before = firm.customFieldSchema.fields.length
      firm.customFieldSchema.fields = firm.customFieldSchema.fields.filter((entry) => entry.key !== fieldKey)
      if (firm.customFieldSchema.fields.length === before) {
        const error = new Error('Custom field not found.')
        error.statusCode = 404
        error.code = 'CUSTOM_FIELD_NOT_FOUND'
        error.details = { fieldErrors: { key: 'Field key was not found.' } }
        throw error
      }
      firm.customFieldSchema.updatedAt = now()
      upsertFirmRow(firm)
      persist()
      return { ok: true }
    },
    listPipelineStages(firmContext) {
      const context = requireFirmContext(firmContext, { method: 'store.listPipelineStages' })
      requirePermission(context.user || context, 'pipeline:read')
      return {
        stages: listFirmPipelineStages(context.firmId)
      }
    },
    createPipelineStage(firmContext, input) {
      const context = requireFirmContext(firmContext, { method: 'store.createPipelineStage' })
      requirePermission(context.user || context, 'pipeline:write')
      const key = String(input?.key || '')
        .trim()
        .toLowerCase()
      if (!STAGE_KEY_PATTERN.test(key)) {
        throw new Error('Stage key must be snake_case alphanumeric.')
      }
      const stages = listFirmPipelineStages(context.firmId)
      if (stages.some((entry) => entry.key === key)) {
        throw new Error('Stage key already exists.')
      }
      const order = stages.length + 1
      const createdAt = now()
      const stage = {
        id: randomUUID(),
        firmId: context.firmId,
        key,
        label: String(input?.label || defaultStageLabel(key)).trim(),
        color: input?.color ? String(input.color).trim() : null,
        isActive: true,
        order,
        createdAt,
        updatedAt: createdAt,
        deactivatedAt: null
      }
      upsertPipelineStageRecord(stage)
      // Couple analytics to the new stage in the same persist cycle so a prospect
      // moved into it appears as its own funnel entry, not legacy_unassigned.
      syncFirmStageConfigFromRecords(context.firmId)
      addAudit(context.firmId, context.userId, 'pipeline', stage.id, 'pipeline.stage_config_created', {
        key: stage.key,
        label: stage.label
      })
      persist()
      return stage
    },
    updatePipelineStageMetadata(firmContext, stageId, patch) {
      const context = requireFirmContext(firmContext, { method: 'store.updatePipelineStageMetadata' })
      requirePermission(context.user || context, 'pipeline:write')
      ensureFirmPipelineStageRecords(context.firmId)
      const stage = validateTenantEntityOwnership(context, getPipelineStageRecordRow(stageId), {
        entityName: 'Pipeline stage'
      })
      if (patch?.label !== undefined) stage.label = String(patch.label || '').trim() || defaultStageLabel(stage.key)
      if (patch?.color !== undefined) stage.color = patch.color ? String(patch.color).trim() : null
      stage.updatedAt = now()
      upsertPipelineStageRecord(stage)
      // Propagate label (and any future metadata) into the analytics stage config.
      syncFirmStageConfigFromRecords(context.firmId)
      addAudit(context.firmId, context.userId, 'pipeline', stage.id, 'pipeline.stage_config_updated', {
        fields: Object.keys(patch || {})
      })
      persist()
      return stage
    },
    deactivatePipelineStage(firmContext, stageId) {
      const context = requireFirmContext(firmContext, { method: 'store.deactivatePipelineStage' })
      requirePermission(context.user || context, 'pipeline:write')
      ensureFirmPipelineStageRecords(context.firmId)
      const stage = validateTenantEntityOwnership(context, getPipelineStageRecordRow(stageId), {
        entityName: 'Pipeline stage'
      })
      stage.isActive = false
      stage.deactivatedAt = now()
      stage.updatedAt = stage.deactivatedAt
      upsertPipelineStageRecord(stage)
      // Keep the deactivated stage in the analytics config (active:false) so its
      // historical prospect counts stay in the funnel rather than collapsing into
      // legacy_unassigned. See syncFirmStageConfigFromRecords for rationale.
      syncFirmStageConfigFromRecords(context.firmId)
      addAudit(context.firmId, context.userId, 'pipeline', stage.id, 'pipeline.stage_config_deactivated', {
        key: stage.key
      })
      persist()
      return stage
    },
    reorderPipelineStages(firmContext, input) {
      const context = requireFirmContext(firmContext, { method: 'store.reorderPipelineStages' })
      requirePermission(context.user || context, 'pipeline:write')
      const stageIds = Array.isArray(input?.stageIds) ? input.stageIds.filter(Boolean) : []
      const stages = listFirmPipelineStages(context.firmId)
      if (stageIds.length !== stages.length) {
        throw new Error('stageIds must include every stage id for the firm.')
      }
      const idSet = new Set(stageIds)
      if (idSet.size !== stages.length || stages.some((entry) => !idSet.has(entry.id))) {
        throw new Error('stageIds must include every stage id exactly once.')
      }
      stageIds.forEach((id, index) => {
        const stage = stages.find((entry) => entry.id === id)
        stage.order = index + 1
        stage.updatedAt = now()
        upsertPipelineStageRecord(stage)
      })
      // Reorder the analytics funnel to match the new pipeline order.
      syncFirmStageConfigFromRecords(context.firmId)
      addAudit(context.firmId, context.userId, 'pipeline', context.firmId, 'pipeline.stage_config_reordered', {
        stageIds
      })
      persist()
      return { stages: listFirmPipelineStages(context.firmId) }
    },
    moveProfileStage(user, profileId, stage, beforeProfileId = null) {
      return this.reorderBoard(user, { profileId, toStage: stage, beforeProfileId })
    },
    reorderBoard(user, input) {
      const firmContext = requireFirmContext(user, { method: 'store.reorderBoard' })
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
      const destinationStage = assertActiveStageForFirm(user.firmId, toStage, 'toStage')

      try {
        return executePipelineTransaction(() => {
          const profile = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
            entityName: 'Profile'
          })

          // Footgun guard: the board only holds prospects (clients have a null
          // stage). A direct moveCard call targeting a converted client must NOT
          // silently re-prospect it, so reject rather than reach the
          // kind='prospect' assignment below.
          if (profile.kind !== 'prospect') {
            const error = new Error('Only prospects can be moved on the pipeline board.')
            error.statusCode = 409
            error.code = 'PROFILE_NOT_PROSPECT'
            error.details = { profileId, kind: profile.kind }
            throw error
          }

          // Archive guard: an archived prospect keeps kind==='prospect' but has a
          // nulled stage and is soft-deleted from every list/analytics read. The
          // kind check above therefore does NOT catch it, so a stage move here
          // would re-assign stage/order/board-version WITHOUT clearing archivedAt,
          // producing a split-brain row that is visible on the board yet hidden
          // everywhere else. Reject; the caller must restore the profile first
          // (restoreProfile re-seats it on the board cleanly).
          if (profile.archivedAt) {
            const error = new Error('Archived profiles cannot be moved on the pipeline board. Restore it first.')
            error.statusCode = 409
            error.code = 'PROFILE_ARCHIVED'
            error.details = { profileId }
            throw error
          }

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

          const destinationCards = listProspectsByStage(user.firmId, destinationStage, profile.id)
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
          profile.stage = destinationStage
          profile.updatedAt = movedAt
          profile.pipelineVersion = currentVersion + 1

          destinationCards.splice(insertIndex, 0, profile)
          destinationCards.forEach((card, index) => {
            assignProspectOrderIndex(card, index + 1)
            upsertProfileRow(card)
          })

          if (previousStage && previousStage !== destinationStage) {
            compactStageIndices(user.firmId, previousStage)
          }

          normalizePipelineIndices(user.firmId, destinationStage)
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
          insertStageChange({
            id: randomUUID(),
            firmId: user.firmId,
            clientId: profile.id,
            fromStage: previousStage,
            toStage: destinationStage,
            changedByUserId: user.id,
            changedAt: movedAt
          })
          addAudit(
            user.firmId,
            user.id,
            'profile',
            profile.id,
            'pipeline.stage_changed',
            { fromStage: previousStage, toStage: destinationStage, beforeProfileId },
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
      requirePermission(user, 'pipeline:read')
      normalizePipelineIndices(user.firmId)
      return buildBoardPayload(user)
    },
    listStageHistory(user, profileId) {
      requirePermission(user, 'pipeline:read')
      return listStageChangeRowsByClient(user.firmId, profileId)
    },
    createHousehold(user, input) {
      const firmContext = requireFirmContext(user, { method: 'store.createHousehold' })
      requirePermission(user, 'households:write')
      validateTenantEntityOwnership(firmContext, getProfileRow(input.primaryClientId), {
        entityName: 'Profile'
      })
      const household = {
        id: randomUUID(),
        firmId: user.firmId,
        name: input.name,
        primaryClientId: input.primaryClientId,
        createdAt: now()
      }
      // households is a source-of-truth table now: targeted upsert instead of
      // pushing onto a blob array. householdMembers stays blob-resident (out of
      // scope), so the persist() below still flushes the member side.
      upsertHouseholdRow(household)
      state.householdMembers.push({
        householdId: household.id,
        clientId: input.primaryClientId,
        role: 'primary',
        firmId: user.firmId,
        createdAt: household.createdAt
      })
      const profile = getProfileRow(input.primaryClientId, { firmId: user.firmId })
      if (profile) {
        profile.householdId = household.id
        upsertProfileRow(profile)
      }
      addAudit(user.firmId, user.id, 'household', household.id, 'household.created', { name: household.name })
      persist()
      return household
    },
    addHouseholdMember(user, householdId, input) {
      const firmContext = requireFirmContext(user, { method: 'store.addHouseholdMember' })
      requirePermission(user, 'households:write')
      const household = validateTenantEntityOwnership(firmContext, getHouseholdRow(householdId), {
        entityName: 'Household'
      })
      validateTenantEntityOwnership(firmContext, getProfileRow(input.clientId), {
        entityName: 'Profile'
      })
      const member = { householdId, clientId: input.clientId, role: input.role, firmId: user.firmId, createdAt: now() }
      state.householdMembers.push(member)
      const profile = getProfileRow(input.clientId, { firmId: user.firmId })
      if (profile) {
        profile.householdId = householdId
        upsertProfileRow(profile)
      }
      addAudit(user.firmId, user.id, 'household', householdId, 'household.member_added', input)
      persist()
      return member
    },
    listHouseholds(user, options = {}) {
      requirePermission(user, 'households:read')
      // Archived households are hidden by default (they are auto-created via
      // spouse linkage, so the directory is the main surface). includeArchived
      // opts back in for an admin view.
      const includeArchived = Boolean(options?.includeArchived)
      return listHouseholdRows({ firmId: user.firmId })
        .filter((household) => includeArchived || !household.archivedAt)
        .map((household) => ({
          ...household,
          members: state.householdMembers.filter(
            (member) => member.firmId === user.firmId && member.householdId === household.id
          )
        }))
    },
    // Soft-delete a household. Scope is deliberately minimal and documented:
    // ONLY the household row is stamped with archivedAt. Member profiles are NOT
    // cascaded (they stay active and readable) and spouse links are left intact,
    // so restoring the household brings back exactly the prior grouping. Archived
    // households drop out of listHouseholds and the dashboard/analytics counts.
    archiveHousehold(user, householdId, options = {}) {
      const firmContext = requireFirmContext(user, { method: 'store.archiveHousehold' })
      requirePermission(user, 'households:write')
      const household = validateTenantEntityOwnership(firmContext, getHouseholdRow(householdId), {
        entityName: 'Household'
      })
      if (household.archivedAt) {
        const error = new Error('Household is already archived.')
        error.statusCode = 409
        error.code = 'HOUSEHOLD_ALREADY_ARCHIVED'
        error.details = { householdId }
        throw error
      }
      household.archivedAt = now()
      upsertHouseholdRow(household)
      addAudit(user.firmId, user.id, 'household', householdId, 'household.archived', { name: household.name })
      persist()
      return household
    },
    restoreHousehold(user, householdId) {
      const firmContext = requireFirmContext(user, { method: 'store.restoreHousehold' })
      requirePermission(user, 'households:write')
      const household = validateTenantEntityOwnership(firmContext, getHouseholdRow(householdId), {
        entityName: 'Household'
      })
      if (!household.archivedAt) {
        const error = new Error('Household is not archived.')
        error.statusCode = 409
        error.code = 'HOUSEHOLD_NOT_ARCHIVED'
        error.details = { householdId }
        throw error
      }
      household.archivedAt = null
      upsertHouseholdRow(household)
      addAudit(user.firmId, user.id, 'household', householdId, 'household.restored', { name: household.name })
      persist()
      return household
    },
    listNotes(user, profileId) {
      requirePermission(user, 'profiles:read')
      return listNoteRowsByProfile(user.firmId, profileId)
        .reverse()
        .map((entry) => ({ ...entry, body: entry.body || decryptSensitiveValue(entry.bodyEncrypted) || '' }))
    },
    addNote(user, profileId, body) {
      const firmContext = requireFirmContext(user, { method: 'store.addNote' })
      requirePermission(user, 'profiles:write')
      validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
        entityName: 'Profile'
      })
      const note = {
        id: randomUUID(),
        firmId: user.firmId,
        profileId,
        body: '',
        bodyEncrypted: encryptSensitiveValue(body),
        createdByUserId: user.id,
        createdAt: now()
      }
      upsertNoteRow(note)
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
      const kind = input.kind === 'document' ? 'document' : 'form'
      const createdAt = now()
      const formSchema = validateFormDefinitionSchema(input.formSchema || { sections: input.sections || [] }, {
        contextPath: input.formSchema ? '/formSchema' : '/sections'
      }).schema
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
          generatedFromDocumentTemplateId: input.generatedFromDocumentTemplateId || null,
          generation: input.generation || null,
          publishState: 'draft',
          versions: [
            {
              version: 1,
              event: 'created',
              formSchema,
              blueprint: { sections: [] },
              mappings: [],
              generation: input.generation || null,
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
      persistTemplateAggregateRow(template)
      addAudit(user.firmId, user.id, 'template_aggregate', template.id, 'template_aggregate.created', {
        kind: template.kind,
        name: template.name
      })
      persist()
      return template
    },
    updateTemplateAggregate(user, templateId, patch = {}) {
      const firmContext = requireFirmContext(user, { method: 'store.updateTemplateAggregate' })
      requirePermission(user, 'templates:write')
      const template = validateTenantEntityOwnership(
        firmContext,
        state.templateAggregates.find((entry) => entry.id === templateId),
        { entityName: 'Template' }
      )
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
      persistTemplateAggregateRow(template)
      persist()
      return template
    },
    transitionTemplateLifecycle(user, templateId, nextState) {
      const firmContext = requireFirmContext(user, { method: 'store.transitionTemplateLifecycle' })
      requirePermission(user, 'templates:write')
      const template = validateTenantEntityOwnership(
        firmContext,
        state.templateAggregates.find((entry) => entry.id === templateId),
        { entityName: 'Template' }
      )
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
      persistTemplateAggregateRow(template)
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
        sections: input.sections || input.formSchema?.sections || [],
        formSchema: input.formSchema,
        generatedFromDocumentTemplateId: input.generatedFromDocumentTemplateId || null,
        generation: input.generation || null,
        blueprint: { sections: [] },
        mappings: []
      })
      return formTemplateAdapter(template)
    },
    listFormSubmissions(user, status = null) {
      requirePermission(user, 'forms:read')
      const actorUserId = resolveUserId(user)
      const currentTime = Date.now()
      return listFormSubmissionsByFirm(user.firmId)
        .filter((entry) => {
          if (entry.status !== 'draft') return true
          const collaborators = normalizeDraftCollaborators(entry)
          return collaborators.some((item) => item.userId === actorUserId)
        })
        .filter((entry) => !status || entry.status === status)
        .map((entry) => {
          const collaborators = normalizeDraftCollaborators(entry)
          if (entry.lock && parseIso(entry.lock.expiresAt) <= currentTime) {
            return { ...entry, lock: null, collaborators }
          }
          return { ...entry, collaborators }
        })
        .slice()
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
    },
    // Advisor-side draft-resume search. Firm-scoped and gated on forms:write
    // (drafts are being resumed for EDITING, so readonly is denied). Query
    // semantics:
    //  - Text (default): case-insensitive substring over firstName/lastName/
    //    full name/email.
    //  - SSN last-4: ONLY when q is exactly four digits do we enter the PII
    //    branch and decrypt each firm profile's SSN envelope in memory to
    //    compare the last four digits. Non-4-digit queries never touch
    //    decryptSensitiveValue — the decrypt call is lexically inside the
    //    `isSsn4` guard, so it is structurally provable that a text query
    //    performs zero decryption.
    // The scan is bounded to this firm's non-archived profiles (pilot scale),
    // and no plaintext last-4 column/index is introduced. If the PII key can't
    // be resolved (rotated away / absent), decryption throws per profile; we
    // catch it, flip ssnSearchAvailable=false, and degrade to name/email-only
    // rather than erroring. Every search is audited (queryType + match count);
    // the raw query string is logged ONLY for text queries, never for SSN4.
    searchDrafts(user, rawQuery = '') {
      requirePermission(user, 'forms:write')
      const actorUserId = resolveUserId(user)
      const q = String(rawQuery || '').trim()
      const isSsn4 = /^\d{4}$/.test(q)
      const queryType = q ? (isSsn4 ? 'ssn4' : 'text') : 'empty'

      // The one and only candidate set the SSN decrypt scan ever iterates.
      const firmProfiles = listProfileRows({ firmId: user.firmId }).filter((profile) => !profile.archivedAt)
      const qLower = q.toLowerCase()
      let ssnSearchAvailable = true

      function textMatch(profile) {
        if (!qLower) return false
        const haystack = `${profile.firstName || ''} ${profile.lastName || ''} ${profile.email || ''}`.toLowerCase()
        return haystack.includes(qLower)
      }

      function ssn4Match(profile) {
        const envelope = profile.pii?.ssnEncrypted || profile.pii?.ssnCiphertext
        if (!envelope) return false
        let ssn
        try {
          ssn = decryptSensitiveValue(envelope)
        } catch {
          // Missing/unresolvable key: degrade gracefully. Flag it once and stop
          // treating SSN4 as a viable match path for the rest of this scan.
          ssnSearchAvailable = false
          return false
        }
        if (!ssn) return false
        const digits = String(ssn).replace(/\D/g, '')
        return digits.length >= 4 && digits.slice(-4) === q
      }

      const matchedProfiles = firmProfiles.filter((profile) => {
        const byText = textMatch(profile)
        // Decrypt is reached ONLY through this guard — never for text queries.
        const bySsn = isSsn4 ? ssn4Match(profile) : false
        return byText || bySsn
      })

      const matches = []
      for (const profile of matchedProfiles) {
        const drafts = listFormSubmissionsByClient(user.firmId, profile.id)
          .filter((entry) => entry.status === 'draft')
          .map((entry) => {
            const template = state.templateAggregates.find((candidate) => candidate.id === entry.templateId)
            const sections = template?.formSchema?.sections || template?.sections || []
            return {
              id: entry.id,
              templateId: entry.templateId,
              templateName: template?.name || entry.templateId,
              status: entry.status,
              updatedAt: entry.updatedAt || entry.createdAt,
              createdAt: entry.createdAt,
              revisionId: entry.revisionId || 1,
              sectionCount: Array.isArray(sections) ? sections.length : 0
            }
          })
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        // "Resume a draft" only surfaces profiles that actually have an
        // in-progress draft to resume.
        if (!drafts.length) continue
        matches.push({
          id: profile.id,
          firstName: profile.firstName || '',
          lastName: profile.lastName || '',
          name: `${profile.firstName || ''} ${profile.lastName || ''}`.trim(),
          email: profile.email || '',
          kind: profile.kind,
          archived: Boolean(profile.archivedAt),
          drafts
        })
      }
      matches.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))

      // Audit EVERY search. Log the raw query for text; for SSN4 log only the
      // queryType (never the four digits).
      const auditMetadata = { queryType, matches: matches.length, ssnSearchAvailable }
      if (queryType === 'text') auditMetadata.query = q
      addAudit(user.firmId, actorUserId, 'form_submission', user.firmId, 'drafts.searched', auditMetadata)

      return {
        query: queryType === 'ssn4' ? '' : q,
        queryType,
        ssnSearchAvailable,
        matches
      }
    },
    getClientWorkspace(user) {
      const profile = requireClientProfile(user)
      const submissions = listFormSubmissionsByClient(user.firmId, profile.id).sort(
        (a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
      )
      const templatesFromAggregates = state.templateAggregates
        .filter((entry) => entry.firmId === user.firmId && entry.kind === 'form')
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          description: entry.description || '',
          sections: entry.formSchema?.sections || []
        }))
      const uploads = listDocumentUploadRowsByFirmClient(user.firmId, profile.id).sort(
        (a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
      )
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
      const submissionData = input.data && typeof input.data === 'object' ? input.data : {}
      if (status === 'submitted') assertRequiredFieldsForSubmission(template, submissionData)
      const submission = {
        id: randomUUID(),
        firmId: user.firmId,
        clientId: profile.id,
        templateId: input.templateId,
        status,
        data: submissionData,
        source: 'client_portal',
        createdByUserId: user.id,
        createdAt: now(),
        updatedAt: now()
      }
      upsertFormSubmission(submission)
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
      const intent = input.uploadId ? getUploadIntent(input.uploadId, user.firmId) : null
      const object = resolveCompletionObject({ intent, input, firmId: user.firmId })
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
      if (input.uploadId) deleteUploadIntent(input.uploadId)
      upsertDocumentUploadRow(upload)
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
      const upload = getDocumentUploadRow(uploadId, { firmId: user.firmId, clientId: profile.id })
      if (!upload) throw new Error('Upload not found.')
      return objectStorage.createPresignedDownloadUrl({ ...upload.object, expiresInSeconds: 900 })
    },
    // --- Raw binary upload endpoint (PUT /api/storage/uploads/:uploadId) ------
    // Capability-based, deliberately session-agnostic. The presign step (advisor,
    // portal, or client — all already authenticated/authorized) mints a pending
    // upload intent with an unguessable id and a reserved object key. Possessing
    // that intent id + supplying the exact reserved key IS the authorization for
    // the raw byte PUT: it works uniformly for cookie-session advisors and
    // token-only portal callers without either a session lookup or a CSRF token,
    // the same single-use-capability argument the OIDC `state` and portal tokens
    // rely on. The route is CSRF-exempt for this reason (documented in server.mjs).
    // Guards enforced here: intent exists, not expired, not already consumed
    // ('stored'), reserved key matches, recorded content-type matches (when a
    // specific one was presigned), and the byte length respects the per-flow and
    // 25 MB hard caps. Success putObject's to the reserved key and flips the
    // intent to 'stored' so the later completion POST can proceed byte-free.
    async storeUploadedBytes({ uploadId, objectKey, contentType, body } = {}) {
      const failWith = (message, statusCode) => {
        const error = new Error(message)
        error.statusCode = statusCode
        return error
      }
      if (!uploadId) throw failWith('Upload id is required.', 400)
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || [])
      const intent = getUploadIntentById(uploadId)
      if (!intent) throw failWith('Upload intent not found or already consumed.', 404)
      if (intent.expiresAt && new Date(intent.expiresAt).getTime() <= Date.now()) {
        deleteUploadIntent(uploadId)
        persist()
        throw failWith('Upload intent expired.', 410)
      }
      if (intent.status === 'stored') {
        throw failWith('Upload has already been stored for this intent.', 409)
      }
      // A prior request already claimed this intent and is mid-putObject (see the
      // atomic claim below). Reject the concurrent PUT rather than double-write.
      if (intent.status === 'storing') {
        throw failWith('Upload is already being stored for this intent.', 409)
      }
      const object = intent.object || {}
      if (!object.bucket || !object.key) {
        throw failWith('Upload intent has no reserved object key.', 409)
      }
      if (objectKey && objectKey !== object.key) {
        throw failWith('Upload key does not match the reserved intent key.', 403)
      }
      // Only enforce content-type when a specific one was presigned; the generic
      // application/octet-stream default is treated as "any".
      const expectedContentType =
        object.contentType && object.contentType !== 'application/octet-stream' ? object.contentType : null
      if (expectedContentType && contentType && contentType !== expectedContentType) {
        throw failWith('Content-Type does not match the presigned upload intent.', 400)
      }
      const HARD_CAP_BYTES = 25 * 1024 * 1024
      const perFlowCap = Number(intent.maxSizeBytes) > 0 ? Number(intent.maxSizeBytes) : HARD_CAP_BYTES
      const limitBytes = Math.min(HARD_CAP_BYTES, perFlowCap)
      if (buffer.length > limitBytes) {
        throw failWith(`Upload exceeds the ${Math.floor(limitBytes / (1024 * 1024))} MB limit.`, 413)
      }
      // TOCTOU fix: claim the intent BEFORE the awaited putObject. better-sqlite3
      // is synchronous and single-writer, so the check-then-claim above runs to
      // completion with no interleaving; a second concurrent PUT that arrives
      // while this one is awaiting putObject reads status==='storing' and is
      // rejected instead of racing to a duplicate write. The cheap synchronous
      // validations above intentionally run first so a bad request never consumes
      // (and locks out) the intent.
      intent.status = 'storing'
      insertUploadIntent(intent)
      let stored
      try {
        stored = await objectStorage.putObject({
          bucket: object.bucket,
          key: object.key,
          body: buffer,
          contentType: expectedContentType || contentType || object.contentType,
          retentionClass: object.retentionClass,
          metadata: {
            fileName: intent.fileName || 'upload.bin',
            uploadIntentId: uploadId,
            source: intent.source || 'client',
            purpose: 'raw_upload'
          }
        })
      } catch (putError) {
        // Storing the bytes failed: release the claim so a legitimate retry can
        // re-attempt the PUT against the same reserved key.
        intent.status = 'pending'
        insertUploadIntent(intent)
        persist()
        throw putError
      }
      intent.status = 'stored'
      intent.storedAt = now()
      intent.storedChecksum = stored.checksum || null
      intent.storedSizeBytes = buffer.length
      insertUploadIntent(intent)
      persist()
      return {
        uploadId,
        object: { ...object, checksum: stored.checksum || object.checksum || null },
        sizeBytes: buffer.length,
        checksum: stored.checksum || null
      }
    },
    // --- Advisor-facing document uploads (profile-scoped) --------------------
    // Uploads are stored in document_uploads with clientId === profileId, the
    // same relational source of truth the portal/client flows write to. Firm
    // scoping is derived from the authenticated session user (not a portal
    // token), and each mutated row is upserted (mutation -> upsert discipline)
    // so the retention/lifecycle sweep keeps working for advisor uploads.
    listProfileUploads(user, profileId, { includeArchived = false } = {}) {
      const firmContext = requireFirmContext(user, { method: 'store.listProfileUploads' })
      requirePermission(user, 'profiles:read')
      const profile = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
        entityName: 'Profile'
      })
      const uploads = listDocumentUploadRowsByFirmClient(user.firmId, profile.id)
        .filter((upload) => {
          if (upload.status === 'purged') return false
          if (!includeArchived && upload.status === 'archived') return false
          return true
        })
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
      return { uploads }
    },
    async createProfileUploadPresign(user, profileId, input = {}) {
      const firmContext = requireFirmContext(user, { method: 'store.createProfileUploadPresign' })
      requirePermission(user, 'profiles:write')
      const profile = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
        entityName: 'Profile'
      })
      const intent = createUploadIntent({
        firmId: user.firmId,
        clientId: profile.id,
        fileName: input.fileName,
        contentType: input.contentType,
        checksum: input.checksum,
        category: input.category,
        source: 'advisor',
        retentionClass: input.retentionClass
      })
      const presigned = await objectStorage.createPresignedUploadUrl({
        ...intent.object,
        expiresInSeconds: Number(input.expiresInSeconds || 900)
      })
      persist()
      return { uploadId: intent.id, object: intent.object, presigned }
    },
    async completeProfileUpload(user, profileId, input = {}) {
      const firmContext = requireFirmContext(user, { method: 'store.completeProfileUpload' })
      requirePermission(user, 'profiles:write')
      const profile = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
        entityName: 'Profile'
      })
      const intent = input.uploadId ? getUploadIntent(input.uploadId, user.firmId) : null
      const object = resolveCompletionObject({ intent, input, firmId: user.firmId })
      // Optional inline bytes: advisors upload from the profile page, so persist
      // the payload to object storage here (server-side putObject) at the
      // intent's reserved key, which makes downloads work end-to-end without a
      // separate browser->storage PUT. The handshake shape stays identical to the
      // portal/client presign flow; only bytes are added.
      const fileBytes =
        typeof input.fileBytesBase64 === 'string' && input.fileBytesBase64
          ? Buffer.from(input.fileBytesBase64, 'base64')
          : null
      let checksum = object.checksum
      let sizeBytes = Number.isFinite(Number(input.sizeBytes)) ? Number(input.sizeBytes) : null
      if (fileBytes && fileBytes.length) {
        if (!object.bucket || !object.key) {
          throw new Error('Upload object metadata (bucket/key) is required to store file bytes.')
        }
        const stored = await objectStorage.putObject({
          bucket: object.bucket,
          key: object.key,
          body: fileBytes,
          contentType: object.contentType,
          retentionClass: object.retentionClass,
          metadata: {
            fileName: input.name || input.fileName || intent?.fileName || 'advisor-upload',
            uploadedByUserId: user.id,
            purpose: 'advisor_document_upload'
          }
        })
        checksum = stored.checksum || checksum
        sizeBytes = fileBytes.length
      } else if (intent && object.bucket && object.key) {
        // Raw-PUT completion: the browser streamed the bytes to the reserved key
        // out-of-band via PUT /api/storage/uploads/:uploadId, so no inline
        // fileBytesBase64 is present. Confirm the object actually landed (and
        // adopt its authoritative size/checksum) before recording the row —
        // completing against a missing object would create a dangling upload.
        const statResult = await objectStorage.statObject(object)
        checksum = statResult?.checksum || checksum
        if (Number.isFinite(Number(statResult?.sizeBytes))) {
          sizeBytes = Number(statResult.sizeBytes)
        }
      }
      const malwareScan = normalizeMalwareScan(input.malwareScan)
      const upload = {
        id: randomUUID(),
        firmId: user.firmId,
        clientId: profile.id,
        name: input.name || input.fileName || intent?.fileName || 'Advisor upload',
        category: input.category || intent?.category || 'general',
        visibility: 'internal',
        status: 'uploaded',
        uploadedBy: 'advisor',
        uploadedByUserId: user.id,
        notes: input.notes || '',
        sizeBytes,
        malwareScan,
        object: { ...object, checksum },
        createdAt: now(),
        updatedAt: now()
      }
      if (input.uploadId) deleteUploadIntent(input.uploadId)
      upsertDocumentUploadRow(upload)
      addAudit(user.firmId, user.id, 'document_upload', upload.id, 'advisor.document_upload.created', {
        category: upload.category,
        key: upload.object.key,
        profileId: profile.id
      })
      persist()
      return upload
    },
    async createProfileUploadDownload(user, profileId, uploadId) {
      const firmContext = requireFirmContext(user, { method: 'store.createProfileUploadDownload' })
      requirePermission(user, 'profiles:read')
      const profile = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
        entityName: 'Profile'
      })
      const upload = getDocumentUploadRow(uploadId, { firmId: user.firmId, clientId: profile.id })
      if (!upload || upload.status === 'purged') throw new Error('Upload not found.')
      const object = upload.object || {}
      if (!object.bucket || !object.key) throw new Error('Upload has no stored object.')
      const fileName = sanitizeFileName(upload.name || `${uploadId}.bin`)
      // Mirror the export download contract: hand out a short-lived presigned
      // redirect on providers that support direct HTTP downloads (S3/MinIO), and
      // otherwise stream the bytes back through the API (local provider).
      if (
        typeof objectStorage.supportsHttpPresignedDownload === 'function' &&
        objectStorage.supportsHttpPresignedDownload()
      ) {
        try {
          await objectStorage.statObject(object)
          const presigned = await objectStorage.createPresignedDownloadUrl({
            ...object,
            expiresInSeconds: 900,
            responseContentDisposition: `attachment; filename="${fileName}"`,
            ...(object.contentType ? { responseContentType: object.contentType } : {})
          })
          return {
            redirectUrl: presigned.url,
            expiresAt: presigned.expiresAt,
            fileName: upload.name,
            contentType: object.contentType || null
          }
        } catch {
          // Presign path unavailable (e.g. object missing); fall back to streaming.
        }
      }
      const stored = await objectStorage.getObject(object)
      return {
        body: stored.body,
        fileName: upload.name,
        contentType: stored.contentType || object.contentType || 'application/octet-stream',
        sizeBytes: stored.body.length
      }
    },
    archiveProfileUpload(user, profileId, uploadId) {
      const firmContext = requireFirmContext(user, { method: 'store.archiveProfileUpload' })
      requirePermission(user, 'profiles:write')
      const profile = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
        entityName: 'Profile'
      })
      const upload = getDocumentUploadRow(uploadId, { firmId: user.firmId, clientId: profile.id })
      if (!upload) throw new Error('Upload not found.')
      if (upload.status === 'archived') return upload
      // Soft delete: reuse the same 'archived' lifecycle status the retention
      // sweep assigns, so the row stays in document_uploads and keeps aging.
      upload.status = 'archived'
      upload.archivedAt = now()
      upload.updatedAt = now()
      upsertDocumentUploadRow(upload)
      addAudit(user.firmId, user.id, 'document_upload', upload.id, 'advisor.document_upload.archived', {
        key: upload.object?.key || null,
        profileId: profile.id
      })
      persist()
      return upload
    },
    listFormDrafts(user) {
      return this.listFormSubmissions(user, 'draft')
    },
    createFormSubmission(user, input) {
      requirePermission(user, 'forms:write')
      const actorUserId = resolveUserId(user)
      const status = input.status || 'draft'
      if (status === 'submitted') {
        const template = state.templateAggregates.find(
          (entry) => entry.id === input.templateId && entry.firmId === user.firmId && entry.kind === 'form'
        )
        if (template) assertRequiredFieldsForSubmission(template, input.data || {})
      }
      const createdAt = now()
      const submission = {
        id: randomUUID(),
        firmId: user.firmId,
        clientId: input.clientId,
        templateId: input.templateId,
        status,
        data: input.data || {},
        createdByUserId: actorUserId || null,
        createdAt,
        updatedAt: createdAt,
        revisionId: status === 'draft' ? 1 : null,
        lock: null,
        collaborators: status === 'draft' ? normalizeDraftCollaborators(input, actorUserId) : []
      }
      upsertFormSubmission(submission)
      addAudit(user.firmId, user.id, 'form_submission', submission.id, 'form_submission.created', {
        templateId: input.templateId,
        clientId: input.clientId
      })
      persist()
      return submission
    },
    acquireDraftLock(user, submissionId, input = {}) {
      requirePermission(user, 'forms:write')
      const actorUserId = resolveUserId(user)
      const submission = findDraftSubmission(submissionId, user.firmId)
      if (!submission) throw new Error('Draft submission not found.')
      const previousLeaseId = submission.lock?.leaseId || ''
      submission.collaborators = normalizeDraftCollaborators(submission)
      const permission = submission.collaborators.find((entry) => entry.userId === actorUserId)?.permission || null
      if (permission !== 'write') throw new Error('Draft collaborator access denied: write permission is required.')

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
        holderUserId: actorUserId,
        acquiredAt: now(),
        expiresAt: new Date(nowTime + leaseMs).toISOString(),
        leaseMs
      }
      submission.lock = lock
      submission.updatedAt = now()
      // Row-level optimistic guard: the write only lands if the stored lease
      // is still the one evaluated above. A concurrent acquisition surfaces
      // as the same lock-conflict contract the in-memory path returned.
      if (!updateFormSubmissionGuarded(submission, { expectedLockLeaseId: previousLeaseId })) {
        const latest = findDraftSubmission(submissionId, user.firmId)
        if (!latest) throw new Error('Draft submission not found.')
        return {
          ok: false,
          conflict: true,
          reason: 'Draft is currently locked by another advisor.',
          lock: latest.lock,
          revisionId: latest.revisionId || 1
        }
      }
      addAudit(user.firmId, user.id, 'form_submission', submission.id, 'form_submission.lock_acquired', {
        leaseMs,
        force
      })
      persist()
      return { ok: true, lock, revisionId: submission.revisionId || 1 }
    },
    releaseDraftLock(user, submissionId, leaseId = '') {
      requirePermission(user, 'forms:write')
      const actorUserId = resolveUserId(user)
      const submission = findDraftSubmission(submissionId, user.firmId)
      if (!submission) throw new Error('Draft submission not found.')
      const existing = submission.lock
      if (!existing) return { ok: true, released: false }
      if (existing.holderUserId !== actorUserId && leaseId && existing.leaseId !== leaseId) {
        throw new Error('Cannot release lock held by another advisor.')
      }
      submission.lock = null
      submission.updatedAt = now()
      // Guarded on the lease that was just validated: if another writer swaps
      // the lock between read and write, this refuses to clobber their lease.
      if (!updateFormSubmissionGuarded(submission, { expectedLockLeaseId: existing.leaseId || '' })) {
        throw new Error('Cannot release lock held by another advisor.')
      }
      addAudit(user.firmId, user.id, 'form_submission', submission.id, 'form_submission.lock_released', {})
      persist()
      return { ok: true, released: true }
    },
    reviseDraftSubmission(user, submissionId, input = {}) {
      requirePermission(user, 'forms:write')
      const actorUserId = resolveUserId(user)
      const submission = findDraftSubmission(submissionId, user.firmId)
      if (!submission) throw new Error('Draft submission not found.')
      submission.collaborators = normalizeDraftCollaborators(submission)
      const permission = submission.collaborators.find((entry) => entry.userId === actorUserId)?.permission || null
      if (permission !== 'write') throw new Error('Draft collaborator access denied: write permission is required.')

      const currentRevision = Number(submission.revisionId || 1)
      const expectedRevision = Number(input.expectedRevisionId || 0)
      if (!Number.isFinite(expectedRevision) || expectedRevision < 1) {
        throw new Error('expectedRevisionId is required.')
      }

      const lock = submission.lock
      const lockActive = lock && parseIso(lock.expiresAt) > Date.now()
      if (!lockActive || lock.holderUserId !== actorUserId || lock.leaseId !== input.leaseId) {
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

      const nextData = input.data && typeof input.data === 'object' ? input.data : {}
      if (input.status === 'submitted') {
        const template = state.templateAggregates.find(
          (entry) => entry.id === submission.templateId && entry.firmId === user.firmId && entry.kind === 'form'
        )
        if (template) assertRequiredFieldsForSubmission(template, nextData)
      }
      submission.data = nextData
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
      // Real optimistic concurrency: UPDATE ... WHERE revisionId = expected
      // AND lock lease unchanged. A concurrent revision loses the race here
      // and receives the same revision-conflict contract as the stale-read
      // path above.
      if (
        !updateFormSubmissionGuarded(submission, {
          expectedRevisionId: currentRevision,
          expectedLockLeaseId: lock.leaseId || ''
        })
      ) {
        const latest = getFormSubmissionById(submissionId, { firmId: user.firmId })
        return {
          ok: false,
          conflict: true,
          reason: 'Draft has changed since your last load.',
          mergePrompt: {
            type: 'revision_conflict',
            localRevisionId: expectedRevision,
            serverRevisionId: Number(latest?.revisionId || 1),
            suggestion: 'Show merge preview and choose keep-local, keep-server, or manual merge.'
          },
          serverDraft: latest
        }
      }
      addAudit(user.firmId, user.id, 'form_submission', submission.id, 'form_submission.draft_revised', {
        revisionId: submission.revisionId,
        submitted: submission.status === 'submitted'
      })
      persist()
      return { ok: true, submission }
    },
    listDraftCollaborators(user, submissionId) {
      requirePermission(user, 'forms:read')
      const actorUserId = resolveUserId(user)
      const submission = findDraftSubmission(submissionId, user.firmId)
      if (!submission) throw new Error('Draft submission not found.')
      submission.collaborators = normalizeDraftCollaborators(submission)
      if (!submission.collaborators.some((entry) => entry.userId === actorUserId))
        throw new Error('Draft collaborator access denied.')
      return submission.collaborators
    },
    addDraftCollaborator(user, submissionId, input = {}) {
      requirePermission(user, 'forms:write')
      const actorUserId = resolveUserId(user)
      const submission = findDraftSubmission(submissionId, user.firmId)
      if (!submission) throw new Error('Draft submission not found.')
      const userId = String(input.userId || '').trim()
      if (!userId) throw new Error('Collaborator userId is required.')
      if (userId === actorUserId) throw new Error('You are already a collaborator on this draft.')
      const permission = String(input.permission || '').toLowerCase() === 'write' ? 'write' : 'read'
      submission.collaborators = normalizeDraftCollaborators(submission)
      const collaboratorCandidate = getUserRow(userId)
      const existingUser =
        collaboratorCandidate && collaboratorCandidate.firmId === user.firmId ? collaboratorCandidate : null
      if (!existingUser) throw new Error('Collaborator user not found.')
      if (submission.collaborators.some((entry) => entry.userId === userId))
        throw new Error('Collaborator already added.')
      submission.collaborators = normalizeDraftCollaborators(
        { ...submission, collaborators: [...submission.collaborators, { userId, permission }] },
        submission.createdByUserId
      )
      submission.updatedAt = now()
      upsertFormSubmission(submission)
      addAudit(user.firmId, actorUserId, 'form_submission', submission.id, 'form_submission.collaborator_added', {
        collaboratorUserId: userId,
        permission
      })
      persist()
      return submission.collaborators
    },
    removeDraftCollaborator(user, submissionId, collaboratorUserId) {
      requirePermission(user, 'forms:write')
      const submission = findDraftSubmission(submissionId, user.firmId)
      if (!submission) throw new Error('Draft submission not found.')
      submission.collaborators = normalizeDraftCollaborators(submission)
      const targetUserId = String(collaboratorUserId || '').trim()
      if (!targetUserId) throw new Error('Collaborator userId is required.')
      if (targetUserId === submission.createdByUserId) throw new Error('Draft owner cannot be removed as collaborator.')
      if (!submission.collaborators.some((entry) => entry.userId === targetUserId)) {
        throw new Error('Collaborator is not assigned to this draft.')
      }
      submission.collaborators = submission.collaborators.filter((entry) => entry.userId !== targetUserId)
      submission.collaborators = normalizeDraftCollaborators(submission, submission.createdByUserId)
      submission.updatedAt = now()
      upsertFormSubmission(submission)
      addAudit(
        user.firmId,
        resolveUserId(user),
        'form_submission',
        submission.id,
        'form_submission.collaborator_removed',
        {
          collaboratorUserId: targetUserId
        }
      )
      persist()
      return submission.collaborators
    },
    listDocumentTemplates(user) {
      return this.listTemplateAggregates(user, { kind: 'document' }).map(documentTemplateAdapter)
    },
    createDocumentTemplate(user, input) {
      requirePermission(user, 'templates:write')
      const createdAt = now()
      const formSchemaResult = validateFormDefinitionSchema(input.formSchema || { sections: [] }, {
        contextPath: '/formSchema'
      })
      const allowedSourcePaths = profileSourcePathsForFirm(getFirmRow(user.firmId))
      collectFormSchemaSourcePaths(formSchemaResult.schema.sections, allowedSourcePaths)
      const normalizedExtractedFields = normalizeExtractedFields(input.extractedFields || input.requiredPdfFields || [])
      const requiredPdfFields = normalizeRequiredPdfFields(normalizedExtractedFields)
      const mappings = validateMappingRules(input.mappings || [], {
        contextPath: '/mappings',
        repeaterPaths: formSchemaResult.repeaterPaths,
        requiredPdfFields,
        allowedSourcePaths,
        enforceKnownSourcePaths: input.enforceKnownSourcePaths === true
      })
      const template = normalizeTemplateAggregate(
        {
          id: randomUUID(),
          firmId: user.firmId,
          kind: 'document',
          name: input.name,
          description: input.description || '',
          documentMetadata: {
            fileName: input.fileName || 'template.pdf',
            ...(input.documentMetadata && typeof input.documentMetadata === 'object' ? input.documentMetadata : {})
          },
          blueprint: input.blueprint || { sections: [] },
          mappings,
          extractedFields: normalizedExtractedFields,
          formSchema: formSchemaResult.schema,
          extraction: deepClone(input.extraction || { status: 'completed', reasonCode: null, error: null }),
          sourceArtifact: deepClone(input.sourceArtifact || null),
          linkedFormTemplateId: input.linkedFormTemplateId || null,
          autoBuildSummary: deepClone(input.autoBuildSummary || null),
          exportReadiness: deepClone(input.exportReadiness || null),
          pdfLayout: deepClone(input.pdfLayout || { fields: [] }),
          publishState: 'draft',
          versions: [
            {
              version: 1,
              event: 'created',
              blueprint: input.blueprint || { sections: [] },
              mappings,
              extractedFields: normalizedExtractedFields,
              formSchema: formSchemaResult.schema,
              publishState: 'draft',
              extraction: deepClone(input.extraction || { status: 'completed', reasonCode: null, error: null }),
              sourceArtifact: deepClone(input.sourceArtifact || null),
              linkedFormTemplateId: input.linkedFormTemplateId || null,
              autoBuildSummary: deepClone(input.autoBuildSummary || null),
              pdfLayout: deepClone(input.pdfLayout || { fields: [] }),
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
      persistTemplateAggregateRow(template)
      addAudit(user.firmId, user.id, 'template_aggregate', template.id, 'document_template.created', {
        name: template.name
      })
      persist()
      return documentTemplateAdapter(template)
    },
    updateTemplateMappings(user, templateId, mappings, input = {}) {
      const firmContext = requireFirmContext(user, { method: 'store.updateTemplateMappings' })
      requirePermission(user, 'templates:write')
      const expectedVersionHash = input.expectedVersionHash || null
      const template = validateTenantEntityOwnership(
        firmContext,
        state.templateAggregates.find((entry) => entry.id === templateId && entry.kind !== 'form'),
        { entityName: 'Template' }
      )
      if (!template) throw new Error('Template not found.')
      const formSchemaResult = validateFormDefinitionSchema(template.formSchema || { sections: [] }, {
        contextPath: '/formSchema'
      })
      const allowedSourcePaths = profileSourcePathsForFirm(getFirmRow(user.firmId))
      collectFormSchemaSourcePaths(formSchemaResult.schema.sections, allowedSourcePaths)
      const requiredPdfFields = normalizeRequiredPdfFields(input.requiredPdfFields || template.extractedFields || [])
      const normalizedMappings = validateMappingRules(mappings || [], {
        contextPath: '/mappings',
        repeaterPaths: formSchemaResult.repeaterPaths,
        requiredPdfFields,
        allowedSourcePaths,
        enforceKnownSourcePaths: input.enforceKnownSourcePaths === true
      })
      const currentHash = templateVersionHash(template)
      if (expectedVersionHash && expectedVersionHash !== currentHash) {
        const error = new Error('Template has changed since last load.')
        error.statusCode = 409
        error.code = 'TEMPLATE_VERSION_CONFLICT'
        error.details = { expectedVersionHash, currentVersionHash: currentHash }
        throw error
      }
      const previousMappings = deepClone(template.mappings || [])
      const previousExtractedFields = deepClone(template.extractedFields || [])
      template.mappings = normalizedMappings
      template.mappingRules = template.mappings
      if (Array.isArray(input.requiredPdfFields)) {
        template.extractedFields = normalizeExtractedFields(input.requiredPdfFields)
      }
      template.versions.push(
        createTemplateVersion(template, 'mappings_updated', {
          mappings: template.mappings,
          diff: { mappings: { changed: true } },
          actorUserId: user.id
        })
      )
      template.updatedAt = now()
      addAudit(user.firmId, user.id, 'template_aggregate', template.id, 'document_template.mappings_updated', {
        before: {
          mappings: previousMappings,
          extractedFields: previousExtractedFields,
          count: previousMappings.length
        },
        after: {
          mappings: deepClone(template.mappings),
          extractedFields: deepClone(template.extractedFields || []),
          count: template.mappings.length
        }
      })
      persistTemplateAggregateRow(template)
      persist()
      return documentTemplateAdapter(template)
    },
    async getTemplateSourcePdf(user, templateId) {
      const firmContext = requireFirmContext(user, { method: 'store.getTemplateSourcePdf' })
      requirePermission(user, 'templates:read')
      const template = validateTenantEntityOwnership(
        firmContext,
        state.templateAggregates.find((entry) => entry.id === templateId && entry.kind !== 'form'),
        { entityName: 'Template' }
      )
      const sourceArtifact = template.sourceArtifact || template.documentMetadata?.sourceArtifact || null
      if (!sourceArtifact?.bucket || !sourceArtifact?.key) {
        throw new Error('Template source PDF is not available.')
      }
      const stored = await objectStorage.getObject(sourceArtifact)
      return {
        body: stored.body,
        fileName: sourceArtifact.fileName || template.fileName || `${template.id}.pdf`,
        contentType: stored.contentType || sourceArtifact.contentType || 'application/pdf',
        checksum: stored.checksum || sourceArtifact.checksum || null,
        sizeBytes: stored.body.length
      }
    },
    async previewTemplateTestFill(user, templateId, input = {}) {
      const firmContext = requireFirmContext(user, { method: 'store.previewTemplateTestFill' })
      requirePermission(user, 'templates:write')
      const template = validateTenantEntityOwnership(
        firmContext,
        state.templateAggregates.find((entry) => entry.id === templateId && entry.kind !== 'form'),
        { entityName: 'Template' }
      )
      const sourceArtifact = template.sourceArtifact || template.documentMetadata?.sourceArtifact || null
      if (!sourceArtifact?.bucket || !sourceArtifact?.key) {
        throw new Error('Template source PDF is not available.')
      }
      const stored = await objectStorage.getObject(sourceArtifact)
      const values = input.values && typeof input.values === 'object' ? input.values : {}
      const extractedFields = Array.isArray(template.extraction?.fields)
        ? template.extraction.fields
        : template.extractedFields || []
      const resolvedRows = extractedFields
        .map((field, index) => {
          const pdfField = String(typeof field === 'string' ? field : field?.fieldName || field?.name || '').trim()
          if (!pdfField) return null
          const fieldType = String(typeof field === 'object' ? field.fieldType || field.type || '' : '').toLowerCase()
          const sampleValue =
            Object.hasOwn(values, pdfField) || Object.hasOwn(values, String(index))
              ? (values[pdfField] ?? values[String(index)])
              : fieldType.includes('checkbox')
                ? true
                : `Preview ${index + 1}`
          return {
            pdfField,
            sourcePath: `preview.${pdfField}`,
            value: sampleValue,
            required: field?.required === true
          }
        })
        .filter(Boolean)
      const rendered = await renderPdfFromTemplate({
        sourcePdfBytes: stored.body,
        resolvedRows,
        flatten: input.flatten === true
      })
      return {
        body: rendered.body,
        fileName: `${template.name || template.id}-test-fill.pdf`,
        contentType: 'application/pdf',
        diagnostics: rendered.diagnostics || [],
        sizeBytes: rendered.body.length
      }
    },
    updateTemplatePdfLayout(user, templateId, input = {}) {
      const firmContext = requireFirmContext(user, { method: 'store.updateTemplatePdfLayout' })
      requirePermission(user, 'templates:write')
      const template = validateTenantEntityOwnership(
        firmContext,
        state.templateAggregates.find((entry) => entry.id === templateId && entry.kind !== 'form'),
        { entityName: 'Template' }
      )
      const fields = Array.isArray(input.fields) ? input.fields : []
      const normalized = fields
        .map((field, index) => ({
          fieldName: String(field?.fieldName || '').trim(),
          pageIndex: Math.max(0, Number.parseInt(String(field?.pageIndex ?? 0), 10) || 0),
          x: Number(field?.x ?? 0),
          y: Number(field?.y ?? 0),
          width: Math.max(1, Number(field?.width ?? 1)),
          height: Math.max(1, Number(field?.height ?? 1)),
          locked: field?.locked === true,
          order: index
        }))
        .filter((field) => field.fieldName)
      const previousLayout = deepClone(template.pdfLayout || { fields: [] })
      template.pdfLayout = {
        fields: normalized,
        updatedAt: now(),
        updatedByUserId: user.id
      }
      template.versions.push(
        createTemplateVersion(template, 'pdf_layout_updated', {
          pdfLayout: template.pdfLayout,
          diff: { pdfLayout: { changed: true } },
          actorUserId: user.id
        })
      )
      template.updatedAt = now()
      addAudit(user.firmId, user.id, 'template_aggregate', template.id, 'document_template.pdf_layout_updated', {
        before: { pdfLayout: previousLayout },
        after: { pdfLayout: template.pdfLayout }
      })
      persistTemplateAggregateRow(template)
      persist()
      return documentTemplateAdapter(template)
    },
    previewTemplateMappings(user, templateId, input = {}) {
      const firmContext = requireFirmContext(user, { method: 'store.previewTemplateMappings' })
      requirePermission(user, 'templates:read')
      const template = validateTenantEntityOwnership(
        firmContext,
        state.templateAggregates.find((entry) => entry.id === templateId && entry.kind !== 'form'),
        { entityName: 'Template' }
      )
      const clientId = String(input.clientId || '').trim()
      const submissionId = String(input.submissionId || '').trim()
      const profile = validateTenantEntityOwnership(firmContext, getProfileRow(clientId), {
        entityName: 'Profile'
      })
      const submission = validateTenantEntityOwnership(firmContext, getFormSubmissionById(submissionId), {
        entityName: 'Submission'
      })
      const resolved = resolveExportData({
        mappings: template.mappings || [],
        profile,
        submission
      })
      const rowIdByIndex = new Map(
        (resolved.rows || [])
          .map((row) => [Number(row.rowIndex), String(row.rowId || '').trim()])
          .filter(([rowIndex, rowId]) => Number.isFinite(rowIndex) && rowId)
      )
      const formSchemaResult = validateFormDefinitionSchema(template.formSchema || { sections: [] }, {
        contextPath: '/formSchema'
      })
      const allowedSourcePaths = profileSourcePathsForFirm(getFirmRow(user.firmId))
      collectFormSchemaSourcePaths(formSchemaResult.schema.sections, allowedSourcePaths)
      let issues = []
      try {
        validateMappingRules(template.mappings || [], {
          contextPath: '/mappings',
          repeaterPaths: formSchemaResult.repeaterPaths,
          requiredPdfFields: normalizeRequiredPdfFields(template.extractedFields || []),
          allowedSourcePaths,
          enforceKnownSourcePaths: true
        })
      } catch (error) {
        const rawIssues = Array.isArray(error?.details?.issues) ? error.details.issues : []
        issues = rawIssues.map((issue) => {
          const path = String(issue?.path || '')
          const rowIndexMatch = path.match(/\/mappings\/(\d+)(?:\/|$)/)
          const field = String(issue?.field || '')
          const code = String(issue?.code || 'schema_validation_issue')
          const sourceMeta = issue?.meta && typeof issue.meta === 'object' ? issue.meta : {}
          const rowIndex = rowIndexMatch ? Number(rowIndexMatch[1]) : null
          const issueId = sourceMeta.issueId || [code, rowIndex ?? 'global', field || path || 'mapping'].join(':')
          const rowAnchor = rowIndex != null ? `#mapping-row-${rowIndex}` : ''
          const inspectorTarget = String(sourceMeta.inspectorTarget || field || sourceMeta.fieldKey || 'sourcePath')
          const rowId = Number.isFinite(rowIndex) ? rowIdByIndex.get(rowIndex) || null : null
          return {
            code,
            path,
            field,
            issueId,
            rowAnchor,
            inspectorTarget,
            message: String(issue?.message || 'Validation issue'),
            severity: 'error',
            blocking: true,
            rowIndex,
            ...(rowId ? { rowId } : {}),
            meta: {
              ...sourceMeta,
              issueId,
              rowAnchor,
              inspectorTarget,
              ...(rowId ? { rowId } : {}),
              fieldPath: sourceMeta.fieldPath || path,
              fieldKey: sourceMeta.fieldKey || field || path || 'mapping'
            }
          }
        })
      }
      return {
        templateId: template.id,
        clientId,
        submissionId,
        rows: resolved.rows,
        mappingVersionHash: resolved.mappingVersionHash,
        warningsCount: resolved.warningsCount,
        blockingWarningsCount: resolved.blockingWarningsCount,
        ...(issues.length ? { issues } : {})
      }
    },
    publishTemplate(user, templateId, input = {}) {
      requirePermission(user, 'templates:write')
      const firmContext = requireFirmContext(user, { method: 'store.publishTemplate' })
      const template = validateTenantEntityOwnership(
        firmContext,
        state.templateAggregates.find((entry) => entry.id === templateId && entry.kind !== 'form'),
        { entityName: 'Template' }
      )
      const previousState = normalizeTemplateState(template.publishState || 'draft')
      const formSchemaResult = validateFormDefinitionSchema(template.formSchema || { sections: [] }, {
        contextPath: '/formSchema'
      })
      const allowedSourcePaths = profileSourcePathsForFirm(getFirmRow(user.firmId))
      collectFormSchemaSourcePaths(formSchemaResult.schema.sections, allowedSourcePaths)
      validateMappingRules(template.mappings || [], {
        contextPath: '/mappings',
        repeaterPaths: formSchemaResult.repeaterPaths,
        requiredPdfFields: normalizeRequiredPdfFields(template.extractedFields || []),
        allowedSourcePaths,
        enforceKnownSourcePaths: input.enforceKnownSourcePaths === true
      })
      const preflightClientId = String(input.clientId || '').trim()
      const preflightSubmissionId = String(input.submissionId || '').trim()
      if (preflightClientId && preflightSubmissionId) {
        const profile = validateTenantEntityOwnership(firmContext, getProfileRow(preflightClientId), {
          entityName: 'Profile'
        })
        const submission = validateTenantEntityOwnership(firmContext, getFormSubmissionById(preflightSubmissionId), {
          entityName: 'Submission'
        })
        const preflight = resolveExportData({
          mappings: template.mappings || [],
          profile,
          submission
        })
        const blockingIssues = (preflight.rows || []).flatMap((row) =>
          (row.warnings || [])
            .filter((warning) => warning?.blocking === true)
            .map((warning) => ({
              code: String(warning.code || 'preview_blocking_warning').toLowerCase(),
              path: `/mappings/${row.rowIndex}/sourcePath`,
              field: 'sourcePath',
              issueId: `${warning.code || 'preview_blocking_warning'}:${row.rowIndex}:sourcePath`,
              rowAnchor: `#mapping-row-${row.rowIndex}`,
              inspectorTarget: 'sourcePath',
              rowIndex: row.rowIndex,
              message: String(warning.message || 'Blocking preview warning'),
              meta: {
                issueId: `${warning.code || 'preview_blocking_warning'}:${row.rowIndex}:sourcePath`,
                rowId: row.rowId || null,
                rowAnchor: `#mapping-row-${row.rowIndex}`,
                inspectorTarget: 'sourcePath'
              }
            }))
        )
        if (blockingIssues.length) {
          const error = new Error('Publish blocked: preview contains unresolved required mappings.')
          error.statusCode = 400
          error.code = 'SCHEMA_VALIDATION_FAILED'
          error.details = { issues: blockingIssues }
          throw error
        }
      }
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
      persistTemplateAggregateRow(template)
      persist()
      return documentTemplateAdapter(template)
    },
    compareTemplateVersions(user, templateId, baseVersion, targetVersion) {
      const firmContext = requireFirmContext(user, { method: 'store.compareTemplateVersions' })
      requirePermission(user, 'templates:read')
      const template = validateTenantEntityOwnership(
        firmContext,
        state.templateAggregates.find((entry) => entry.id === templateId && entry.kind !== 'form'),
        { entityName: 'Template' }
      )
      const versions = template.versions || []
      const base = versions.find((entry) => Number(entry.version) === Number(baseVersion))
      const target = versions.find((entry) => Number(entry.version) === Number(targetVersion))
      if (!base || !target) throw new Error('Template version not found.')
      return {
        templateId,
        baseVersion: Number(base.version),
        targetVersion: Number(target.version),
        changed:
          stableSerialize(base.blueprint) !== stableSerialize(target.blueprint) ||
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
      const firmContext = requireFirmContext(user, { method: 'store.revertTemplateVersion' })
      requirePermission(user, 'templates:write')
      const template = validateTenantEntityOwnership(
        firmContext,
        state.templateAggregates.find((entry) => entry.id === templateId && entry.kind !== 'form'),
        { entityName: 'Template' }
      )
      const target = (template.versions || []).find((entry) => Number(entry.version) === Number(targetVersion))
      if (!target) throw new Error('Template version not found.')
      if (!input.changelog || !String(input.changelog).trim()) {
        throw new Error('Revert requires changelog.')
      }
      template.blueprint = deepClone(target.blueprint || { sections: [] })
      template.mappings = deepClone(target.mappings || [])
      template.mappingRules = template.mappings
      template.extractedFields = deepClone(target.extractedFields || [])
      template.extraction = deepClone(target.extraction || { status: 'completed', reasonCode: null, error: null })
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
      persistTemplateAggregateRow(template)
      persist()
      return {
        template: documentTemplateAdapter(template),
        revertedToVersion: Number(target.version),
        currentVersion: template.versions.length
      }
    },
    listTemplateVersions(user, templateId) {
      const firmContext = requireFirmContext(user, { method: 'store.listTemplateVersions' })
      requirePermission(user, 'templates:read')
      const template = validateTenantEntityOwnership(
        firmContext,
        state.templateAggregates.find((entry) => entry.id === templateId && entry.kind !== 'form'),
        { entityName: 'Template' }
      )
      return template.versions || []
    },
    listPublishTransitions(user, templateId) {
      const firmContext = requireFirmContext(user, { method: 'store.listPublishTransitions' })
      requirePermission(user, 'templates:read')
      const template = validateTenantEntityOwnership(
        firmContext,
        state.templateAggregates.find((entry) => entry.id === templateId && entry.kind !== 'form'),
        { entityName: 'Template' }
      )
      return template.publishTransitions || []
    },
    listExports(user, options = {}) {
      requirePermission(user, 'exports:read')
      return exportsRepository.list(user, options)
    },
    createExport(user, input) {
      requirePermission(user, 'exports:write')
      return exportsRepository.create(user, input)
    },
    retryExport(user, exportId) {
      requirePermission(user, 'exports:write')
      return exportsRepository.retry(user, exportId)
    },
    getExportQueueHealth(user) {
      requirePermission(user, 'exports:read')
      return exportsRepository.getQueueHealth()
    },
    retryFailedExports(user, options = {}) {
      requirePermission(user, 'exports:write')
      return exportsRepository.retryFailed(user, options)
    },
    getExportDownload(user, exportId) {
      requirePermission(user, 'exports:read')
      return exportsRepository.getDownload(user, exportId)
    },
    async processQueuedExports() {
      const result = await processExportQueueTickAsync({
        workerId: 'api-process-endpoint',
        limit: 10,
        leaseMs: 15_000,
        async processor(job) {
          const failCount = Number(job?.metadata?.simulateFailuresRemaining || 0)
          if (failCount > 0) {
            throw new Error(`Simulated export failure for ${job.id}`)
          }
          const artifact = await renderExportArtifact(job, { objectStorage })
          const key = `${job.firmId}/exports/${artifact.fileName}`
          const stored = await objectStorage.putObject({
            bucket: objectStorage.bucketExports,
            key,
            body: artifact.body,
            contentType: artifact.object.contentType,
            retentionClass: artifact.object.retentionClass,
            metadata: {
              checksum: artifact.artifact.checksum,
              exportJobId: job.id,
              renderer: artifact.artifact.renderer,
              templateId: job.templateId,
              clientId: job.clientId
            }
          })
          return {
            fileName: artifact.fileName,
            preview: artifact.preview,
            artifact: {
              ...artifact.artifact,
              checksum: stored.checksum || artifact.artifact.checksum,
              sizeBytes: artifact.body.length
            },
            idempotencyKey: job.execution?.idempotencyKey || job.idempotencyKey || job.id,
            execution: job.execution || null,
            object: {
              bucket: objectStorage.bucketExports,
              key,
              checksum: stored.checksum || artifact.object.checksum,
              contentType: artifact.object.contentType,
              retentionClass: artifact.object.retentionClass
            }
          }
        }
      })
      return { processed: result.processed, leased: result.leased, failed: result.failed }
    },
    listAudit(user) {
      requirePermission(user, 'audit:read')
      // Firm-scoped SQL read, newest first — audit_events is the source of
      // truth and the blob no longer carries audit events at all.
      return listAuditEvents(user.firmId)
    },
    // Keyset-paginated, filtered activity-feed read. Permission gating and the
    // category->prefix mapping live in the activity module; this is the thin
    // firm-scoped SQL passthrough.
    queryAuditEventsPage(options = {}) {
      return queryAuditEventsPage(options)
    },
    // Actor-name directory for a firm, used to resolve audit actorUserId ->
    // display name in one batch (no N+1). Intentionally ungated: it is only
    // reached through the permission-checked activity service, and exposes just
    // id/name/role, never credentials.
    listFirmUserDirectory(firmId) {
      return listUserRows({ firmId }).map((entry) => ({
        id: entry.id,
        firstName: entry.firstName || '',
        lastName: entry.lastName || '',
        email: entry.email || '',
        role: entry.role || ''
      }))
    },
    // Total number of recorded audit events (all firms). Used by
    // runAuditedMutation's "every mutation records an audit event" guard now
    // that there is no in-memory auditEvents array to measure.
    countAuditEvents() {
      return countAuditEventsInTable()
    },
    logout(token) {
      const session = getSessionByToken(token)
      invalidateSession(session, 'logout')
      if (session) {
        addAudit(session.firmId, session.userId, 'user', session.userId, 'auth.logout', {
          after: { sessionToken: token }
        })
      }
      persist()
      return { ok: true }
    },
    rotateSession(token, reason = 'privilege_transition') {
      return rotateSession(token, reason)
    },
    listUsers(user, query = {}) {
      requirePermission(user, 'users:read')
      const mode = String(query.mode || '')
        .trim()
        .toLowerCase()
      const search = String(query.search || '')
        .trim()
        .toLowerCase()
      const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 20, 1), 50)
      const includeSelf = query.includeSelf === true || query.includeSelf === 'true'
      const firmUsers = listUserRows({ firmId: user.firmId })
      if (mode === 'lookup') {
        const users = firmUsers
          .filter((entry) => (includeSelf ? true : entry.id !== user.id))
          .filter((entry) => {
            if (!search) return true
            const haystack = [
              entry.id,
              entry.email,
              entry.firstName,
              entry.lastName,
              `${entry.firstName} ${entry.lastName}`
            ]
              .map((value) => String(value || '').toLowerCase())
              .join(' ')
            return haystack.includes(search)
          })
          .slice(0, limit)
          .map((entry) => ({
            id: entry.id,
            role: entry.role,
            email: entry.email,
            label: `${entry.firstName || ''} ${entry.lastName || ''}`.trim() || entry.email || entry.id
          }))
        return { mode: 'lookup', total: users.length, users }
      }
      return firmUsers.map(publicUser)
    },
    inviteUser(user, input) {
      requirePermission(user, 'users:manage')
      const allowedRoles = new Set(['advisor', 'readonly', 'client'])
      const role = input.role || 'advisor'
      if (!allowedRoles.has(role)) {
        throw new Error('Invalid invite role.')
      }
      const invite = {
        id: randomUUID(),
        firmId: user.firmId,
        email: input.email.toLowerCase(),
        role,
        invitedByUserId: user.id,
        token: randomUUID(),
        createdAt: now(),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString()
      }
      upsertInviteRow(invite)
      addAudit(user.firmId, user.id, 'invite', invite.id, 'invite.created', { email: invite.email, role: invite.role })
      persist()
      return invite
    },
    acceptInvite(input) {
      assertStrongPassword(input.password)
      const invite = findInviteRowByToken(input.token)
      if (!invite) throw new Error('Invite not found.')
      if (invite.expiresAt && new Date(invite.expiresAt).getTime() <= Date.now()) {
        throw new Error('Invite expired.')
      }
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
      // users is a source-of-truth table now: targeted upsert instead of a blob
      // push (persist() no longer flushes user rows).
      upsertUserRow(user)
      if (user.role === 'client' && !findClientProfileRowByEmail(user.firmId, String(user.email || '').toLowerCase())) {
        const createdAt = now()
        upsertProfileRow(
          normalizeProfileRecord({
            id: randomUUID(),
            firmId: user.firmId,
            advisorUserId: null,
            kind: 'client',
            firstName: user.firstName || '',
            lastName: user.lastName || '',
            email: user.email || '',
            phone: '',
            status: 'active',
            stage: null,
            householdId: null,
            spouseClientId: null,
            orderIndex: null,
            stageOrderIndex: null,
            pipelineVersion: null,
            source: null,
            sourceDisplay: null,
            sourceMigratedAt: null,
            sourceNormalizedAt: createdAt,
            sourceDisplayUpdatedAt: null,
            createdAt,
            updatedAt: createdAt
          })
        )
      }
      deleteInviteRow(invite.id)
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
    startTotpEnrollment(user) {
      return auth.startTotpEnrollment(user)
    },
    confirmTotpEnrollment(user, input) {
      return auth.confirmTotpEnrollment(user, input)
    },
    createMfaChallenge(user) {
      return auth.createMfaChallenge(user)
    },
    verifyMfaChallenge(user, input) {
      return auth.verifyMfaChallenge(user, input)
    },
    rotateBackupCodes(user) {
      return auth.rotateBackupCodes(user)
    },
    objectStorage,
    removeHouseholdMember(user, householdId, clientId) {
      const firmContext = requireFirmContext(user, { method: 'store.removeHouseholdMember' })
      requirePermission(user, 'households:write')
      validateTenantEntityOwnership(firmContext, getHouseholdRow(householdId), {
        entityName: 'Household'
      })
      validateTenantEntityOwnership(firmContext, getProfileRow(clientId), {
        entityName: 'Profile'
      })
      const beforeCount = state.householdMembers.filter(
        (entry) => entry.householdId === householdId && entry.firmId === user.firmId
      ).length
      state.householdMembers = state.householdMembers.filter(
        (entry) => !(entry.householdId === householdId && entry.clientId === clientId && entry.firmId === user.firmId)
      )
      const profile = getProfileRow(clientId, { firmId: user.firmId })
      if (profile) {
        profile.householdId = null
        upsertProfileRow(profile)
      }
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
      const firmContext = requireFirmContext(user, { method: 'store.linkSpouse' })
      requirePermission(user, 'households:write')
      const primary = validateTenantEntityOwnership(firmContext, getProfileRow(primaryClientId), {
        entityName: 'Profile'
      })
      const spouse = validateTenantEntityOwnership(firmContext, getProfileRow(spouseClientId), {
        entityName: 'Profile'
      })
      primary.spouseClientId = spouse.id
      spouse.spouseClientId = primary.id
      let householdId = primary.householdId
      if (!householdId) {
        householdId = this.createHousehold(user, {
          name: `${primary.lastName} Household`,
          primaryClientId: primary.id
        }).id
        // createHousehold wrote the primary's household linkage to its row;
        // keep this detached object in sync so the final upsert (and the
        // returned payload) carry it too.
        primary.householdId = householdId
      }
      spouse.householdId = householdId
      upsertProfileRow(primary)
      upsertProfileRow(spouse)
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
      const submission = validateTenantEntityOwnership(firmContext, getFormSubmissionById(submissionId), {
        entityName: 'Submission'
      })
      const nextUpdatedAt = patch?.updatedAt || now()
      Object.assign(submission, patch, { updatedAt: nextUpdatedAt })
      upsertFormSubmission(submission)
      persist()
      return submission
    },
    deleteSubmission(user, submissionId) {
      const firmContext = requireFirmContext(user, { method: 'store.deleteSubmission' })
      requirePermission(user, 'forms:write')
      const existing = validateTenantEntityOwnership(firmContext, getFormSubmissionById(submissionId), {
        entityName: 'Submission'
      })
      deleteFormSubmission(submissionId, user.firmId)
      addAudit(user.firmId, user.id, 'form_submission', submissionId, 'form_submission.deleted', {
        templateId: existing.templateId,
        clientId: existing.clientId
      })
      persist()
      return { ok: true }
    },
    // Template auto-build source PDFs are large, so they use the same presign ->
    // raw PUT -> process handshake as document uploads instead of an inline body.
    // The 20 MB per-flow ceiling matches the attachment/portal caps; the source
    // PDF has no smaller intrinsic limit.
    async createTemplateSourceUploadPresign(user, input = {}) {
      requirePermission(user, 'templates:write')
      const intent = createUploadIntent({
        firmId: user.firmId,
        clientId: 'template-source',
        fileName: input.fileName || 'template.pdf',
        contentType: input.contentType || 'application/pdf',
        category: 'template_source',
        source: 'advisor',
        retentionClass: 'uploaded_document',
        maxSizeBytes: 20 * 1024 * 1024
      })
      const presigned = await objectStorage.createPresignedUploadUrl({
        ...intent.object,
        expiresInSeconds: Number(input.expiresInSeconds || 900)
      })
      persist()
      return { uploadId: intent.id, object: intent.object, presigned }
    },
    async autoBuildTemplate(user, input = {}) {
      requirePermission(user, 'templates:write')
      let pdfBytes =
        typeof input.fileBytesBase64 === 'string'
          ? Buffer.from(input.fileBytesBase64, 'base64')
          : Array.isArray(input.fileBytes)
            ? Buffer.from(input.fileBytes)
            : null
      // Raw-upload path: bytes were streamed to a reserved key via the presign +
      // PUT /api/storage/uploads/:uploadId handshake. Load them from storage,
      // then treat them identically to the legacy inline payload below.
      let autoBuildIntent = null
      if ((!pdfBytes || !pdfBytes.length) && input.uploadId) {
        autoBuildIntent = getUploadIntent(input.uploadId, user.firmId)
        if (!autoBuildIntent) throw new Error('Auto-build upload intent not found.')
        const intentObject = autoBuildIntent.object || {}
        if (!intentObject.bucket || !intentObject.key) {
          throw new Error('Auto-build upload intent has no reserved object key.')
        }
        const fetched = await objectStorage.getObject(intentObject)
        pdfBytes = fetched.body
      }
      const fileName = input.fileName || 'uploaded.pdf'
      const legacyFields = Array.isArray(input.fields)
        ? input.fields
        : Array.isArray(input.extractedFields)
          ? input.extractedFields
          : []
      const extraction =
        pdfBytes && pdfBytes.length
          ? await extractTemplateFieldsFromPdfBytes(pdfBytes)
          : legacyFields.length
            ? {
                status: 'completed',
                reasonCode: null,
                error: null,
                diagnostics: [
                  {
                    type: 'auto_build',
                    severity: 'warning',
                    code: 'TEMPLATE_AUTOBUILD_LEGACY_FIELDS',
                    message: 'Template was generated from explicit field names without an uploaded source PDF.',
                    details: { source: 'fields' }
                  }
                ],
                fields: legacyFields
                  .map((field) =>
                    typeof field === 'string'
                      ? {
                          fieldName: field,
                          fieldType: 'text',
                          pageIndex: null,
                          required: false,
                          readOnly: false
                        }
                      : {
                          fieldName: String(field?.fieldName || field?.name || field?.key || ''),
                          fieldType: String(field?.fieldType || field?.type || 'text'),
                          pageIndex: Number.isInteger(field?.pageIndex) ? field.pageIndex : null,
                          required: field?.required === true,
                          readOnly: field?.readOnly === true
                        }
                  )
                  .filter((field) => field.fieldName)
              }
            : await extractTemplateFieldsFromPdfBytes(pdfBytes)
      let sourceArtifact = null
      if (pdfBytes && pdfBytes.length && Buffer.from(pdfBytes).toString('latin1').startsWith('%PDF-')) {
        const checksum = createHash('sha256').update(pdfBytes).digest('hex')
        const key = `${user.firmId}/templates/${randomUUID()}-${sanitizeFileName(fileName)}`
        const stored = await objectStorage.putObject({
          bucket: objectStorage.bucketDocuments,
          key,
          body: pdfBytes,
          contentType: 'application/pdf',
          retentionClass: 'uploaded_document',
          metadata: {
            checksum,
            fileName,
            templateName: input.name || fileName,
            uploadedByUserId: user.id,
            purpose: 'document_template_source'
          }
        })
        sourceArtifact = {
          bucket: objectStorage.bucketDocuments,
          key,
          fileName,
          contentType: 'application/pdf',
          checksum: stored.checksum || checksum,
          sizeBytes: pdfBytes.length,
          retentionClass: 'uploaded_document'
        }
      }

      // The auto-build handshake reserved a scratch object for the raw PUT; the
      // canonical source PDF now lives under the template's own key, so retire the
      // one-time intent and its scratch object (best effort) to avoid orphans.
      if (autoBuildIntent) {
        deleteUploadIntent(autoBuildIntent.id)
        try {
          await objectStorage.deleteObject(autoBuildIntent.object)
        } catch {
          // Scratch cleanup is non-critical; retention sweeps will not track it,
          // but a stray temp object must never fail an otherwise-successful build.
        }
      }

      const generated =
        extraction.status === 'completed'
          ? buildFormTemplateFromExtractedFields(extraction.fields || [])
          : { formSchema: { sections: [] }, mappings: [], diagnostics: [], summary: { fieldCount: 0, mappingCount: 0 } }
      const extractionDiagnostics = [
        ...(Array.isArray(extraction.diagnostics) ? extraction.diagnostics : []),
        ...(Array.isArray(generated.diagnostics) ? generated.diagnostics : [])
      ]
      const extractionEnvelope = {
        status: extraction.status,
        reasonCode: extraction.reasonCode,
        error: extraction.error || null,
        diagnostics: extractionDiagnostics,
        fields: extraction.fields || []
      }
      const pdfLayout = {
        fields: (extraction.fields || []).map((field, index) => ({
          fieldName: String(field.fieldName || field.name || `field_${index + 1}`),
          pageIndex: Number.isInteger(field.pageIndex) ? field.pageIndex : 0,
          x: Number(field.x ?? 72),
          y: Number(field.y ?? Math.max(72, 700 - index * 32)),
          width: Number(field.width ?? 180),
          height: Number(field.height ?? 24),
          locked: false
        }))
      }
      const autoBuildSummary = {
        ...generated.summary,
        linkedFormTemplateId: null,
        sourceArtifactAvailable: Boolean(sourceArtifact),
        extractionStatus: extraction.status
      }
      const documentTemplate = this.createDocumentTemplate(user, {
        name: input.name || fileName.replace(/\.pdf$/i, ''),
        fileName,
        documentMetadata: {
          fileName,
          sourceArtifact
        },
        blueprint: { sections: generated.formSchema.sections || [] },
        formSchema: generated.formSchema,
        mappings: extraction.status === 'completed' ? generated.mappings : [],
        extractedFields: extraction.fields || [],
        extraction: extractionEnvelope,
        sourceArtifact,
        pdfLayout,
        autoBuildSummary,
        exportReadiness:
          extraction.status === 'failed'
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
              }
      })

      const aggregate = state.templateAggregates.find((entry) => entry.id === documentTemplate.id)
      if (aggregate && extraction.status === 'completed') {
        const generatedForm = this.createTemplateAggregate(user, {
          kind: 'form',
          name: `${documentTemplate.name} Form`,
          description: `Generated from ${fileName}.`,
          formSchema: generated.formSchema,
          generatedFromDocumentTemplateId: documentTemplate.id,
          generation: {
            source: sourceArtifact ? 'pdf_acroform' : 'legacy_fields',
            documentTemplateId: documentTemplate.id,
            sourceFileName: fileName,
            generatedAt: now(),
            fieldCount: generated.summary.fieldCount,
            repeatableSectionCount: generated.summary.repeatableSectionCount || 0,
            diagnostics: extractionDiagnostics
          }
        })
        const linkedAggregate = state.templateAggregates.find((entry) => entry.id === documentTemplate.id) || aggregate
        linkedAggregate.linkedFormTemplateId = generatedForm.id
        linkedAggregate.autoBuildSummary = { ...autoBuildSummary, linkedFormTemplateId: generatedForm.id }
        linkedAggregate.versions.push(
          createTemplateVersion(linkedAggregate, 'linked_form_generated', {
            linkedFormTemplateId: generatedForm.id,
            autoBuildSummary: linkedAggregate.autoBuildSummary,
            sourceArtifact,
            extraction: extractionEnvelope,
            actorUserId: user.id
          })
        )
        addAudit(
          user.firmId,
          user.id,
          'template_aggregate',
          linkedAggregate.id,
          'document_template.linked_form_generated',
          {
            linkedFormTemplateId: generatedForm.id,
            source: generatedForm.generation?.source || 'auto_build'
          }
        )
        persistTemplateAggregateRow(linkedAggregate)
        persist()
        return documentTemplateAdapter(linkedAggregate)
      }

      return aggregate ? documentTemplateAdapter(aggregate) : documentTemplate
    },
    createPortalLink(user, profileId, options = {}) {
      const firmContext = requireFirmContext(user, { method: 'store.createPortalLink' })
      requirePermission(user, 'portal:manage')
      const linkedProfile = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
        entityName: 'Profile'
      })
      // Archived profiles are not valid portal-link targets: creating live access
      // for a soft-deleted profile would contradict the archive guard that blocks
      // archiving while active links exist.
      if (linkedProfile.archivedAt) {
        const error = new Error('Cannot create a portal link for an archived profile.')
        error.statusCode = 409
        error.code = 'PROFILE_ARCHIVED'
        error.details = { profileId }
        throw error
      }
      const createdAt = now()
      const expiresAt =
        options.expiresAt || new Date(Date.now() + Number(options.expiresInHours || 24) * 3600 * 1000).toISOString()
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
      upsertPortalLinkRow(link)
      persist()
      return link
    },
    revokePortalLink(user, linkId) {
      const firmContext = requireFirmContext(user, { method: 'store.revokePortalLink' })
      requirePermission(user, 'portal:manage')
      const link = validateTenantEntityOwnership(firmContext, getPortalLinkRow(linkId), {
        entityName: 'Portal link'
      })
      if (!link.revokedAt) {
        link.revokedAt = now()
        upsertPortalLinkRow(link)
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
      const firm = getFirmRow(link.firmId)
      const profile = getProfileRow(link.profileId, { firmId: link.firmId })
      const submissions = listFormSubmissionsByClient(link.firmId, link.profileId)
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
        .filter(
          (entry) =>
            !Array.isArray(link.scope?.templateIds) ||
            link.scope.templateIds.length === 0 ||
            link.scope.templateIds.includes(entry.id)
        )
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          description: entry.description || '',
          sections: entry.formSchema?.sections || []
        }))
      const uploads = listDocumentUploadRowsByFirmClient(link.firmId, link.profileId)
        .filter(
          (entry) =>
            !Array.isArray(link.scope?.uploadCategories) ||
            link.scope.uploadCategories.length === 0 ||
            link.scope.uploadCategories.includes(entry.category || 'general')
        )
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
        const existingDraft = findPortalDraftSubmission(link.firmId, link.profileId, templateId)
        if (existingDraft) {
          // Draft saves are the hottest portal write: a targeted single-row
          // update instead of a full blob rewrite (no other state changed).
          existingDraft.data = input.data && typeof input.data === 'object' ? input.data : {}
          existingDraft.updatedAt = now()
          upsertFormSubmission(existingDraft)
          return existingDraft
        }
      }
      const portalSubmissionData = input.data && typeof input.data === 'object' ? input.data : {}
      if (status === 'submitted' && template) assertRequiredFieldsForSubmission(template, portalSubmissionData)
      const submission = {
        id: randomUUID(),
        firmId: link.firmId,
        clientId: link.profileId,
        templateId,
        status,
        data: portalSubmissionData,
        createdByUserId: null,
        createdAt: now(),
        updatedAt: now(),
        source: 'portal'
      }
      consumePortalLinkUse(link)
      upsertFormSubmission(submission)
      // persist() still runs: consumePortalLinkUse mutated the blob-backed
      // portal link (usedCount/lastUsedAt).
      persist()
      return submission
    },
    getPortalDraftSectionState(token, draftId, sectionId) {
      const link = findPortalLink(token)
      findDraftForScope({ draftId, firmId: link.firmId, clientId: link.profileId })
      const normalizedSectionId = normalizeSectionIdentifier(sectionId)
      return getDraftSectionState(link.firmId, link.profileId, draftId, normalizedSectionId)
    },
    listPortalDraftSectionStates(token, draftId) {
      const link = findPortalLink(token)
      findDraftForScope({ draftId, firmId: link.firmId, clientId: link.profileId })
      return listDraftSectionStates(link.firmId, link.profileId, draftId)
    },
    savePortalDraftSectionState(token, draftId, sectionId, input = {}) {
      const link = findPortalLink(token)
      findDraftForScope({ draftId, firmId: link.firmId, clientId: link.profileId })
      const normalizedSectionId = normalizeSectionIdentifier(sectionId)
      // Optimistic versioning now lives in SQL: expectedVersion 0 races an
      // INSERT OR IGNORE, anything else races UPDATE ... WHERE version = ?.
      // Either way a losing writer gets the exact legacy contract back:
      // { ok: false, conflict: true, reason, state: <latest server state> }.
      // No persist(): section states live only in draft_step_states, so a
      // save is a single-row write instead of a full blob rewrite.
      const result = saveDraftSectionStateGuarded({
        firmId: link.firmId,
        clientId: link.profileId,
        draftId,
        sectionId: normalizedSectionId,
        expectedVersion: Number(input.expectedVersion || 0),
        data: input.data && typeof input.data === 'object' ? input.data : {},
        updatedAt: now()
      })
      if (!result.ok) {
        return { ok: false, conflict: true, reason: 'Section draft state is stale.', state: result.state }
      }
      return { ok: true, state: result.state }
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
      const intent = input.uploadId ? getUploadIntent(input.uploadId, link.firmId) : null
      const uploadCategory = input.category || intent?.category || 'general'
      assertPortalUploadScope(link, uploadCategory)
      const object = resolveCompletionObject({ intent, input, firmId: link.firmId })
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
      if (input.uploadId) deleteUploadIntent(input.uploadId)
      upsertDocumentUploadRow(upload)
      persist()
      return upload
    },
    async createPortalUploadDownloadUrl(token, uploadId) {
      const link = resolvePortalLinkByToken(token)
      const upload = getDocumentUploadRow(uploadId, { firmId: link.firmId, clientId: link.profileId })
      if (!upload) throw new Error('Upload not found.')
      return objectStorage.createPresignedDownloadUrl({ ...upload.object, expiresInSeconds: 900 })
    },
    // --- Marketing events -----------------------------------------------------
    // Firm-level marketing-event configuration. Guarded at canWriteProfiles-level
    // (profiles:write for mutations, profiles:read for reads): events are prospect
    // source-attribution data, so this is the closest existing guard — the same
    // [admin, advisor] write / [admin, advisor, readonly] read role set that
    // profile management and pipeline-stage management both use. Soft-delete
    // follows the profile archivedAt pattern (archiveEvent stamps archivedAt; no
    // hard delete).

    async createExportDownloadUrl(user, exportId) {
      const firmContext = requireFirmContext(user, { method: 'store.createExportDownloadUrl' })
      requirePermission(user, 'exports:write')
      const job = validateTenantEntityOwnership(firmContext, getExportJob(exportId), {
        entityName: 'Export'
      })
      const object = job.output?.object
      if (!object) throw new Error('Export output object not available.')
      return objectStorage.createPresignedDownloadUrl({ ...object, expiresInSeconds: 900 })
    },
    async runLifecyclePolicies(user) {
      requirePermission(user, 'exports:write')
      await applyLifecyclePolicies()
      return {
        uploads: listDocumentUploadRowsByFirm(user.firmId),
        exports: listExportQueueJobs().filter((entry) => entry.firmId === user.firmId),
        retention: objectStorage.retentionPolicies
      }
    },
    getMaskedSensitiveData(user, profileId, request = {}) {
      const firmContext = requireFirmContext(user, { method: 'store.getMaskedSensitiveData' })
      requirePermission(user, 'profiles:read')
      const profile = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
        entityName: 'Profile'
      })
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

      if (request.unmask === true) {
        validateUnmaskRequest(request)
        if (!canUnmaskSensitiveData(user, request)) {
          addAudit(user.firmId, user.id, 'profile', profileId, 'sensitive.read_denied', {
            requestedUnmask: true,
            reason: {
              code: request.reasonCode || null,
              justification: String(request.justification || '').trim() || null
            },
            actor: { userId: user.id, role: user.role }
          })
          throw new Error('Sensitive unmask request denied.')
        }

        addAudit(user.firmId, user.id, 'profile', profileId, 'sensitive.read', {
          grantedUnmask: true,
          fieldScope: ['ssn', 'taxId'],
          reason: {
            code: request.reasonCode,
            justification: String(request.justification || '').trim()
          }
        })
        return { ssnMasked: maskSsn(ssn), taxIdMasked: maskTaxId(taxId), ssn, taxId }
      }

      addAudit(user.firmId, user.id, 'profile', profileId, 'sensitive.read', {
        grantedUnmask: false,
        fieldScope: ['ssn', 'taxId'],
        reason: { code: request.reasonCode || null }
      })
      return { ssnMasked: maskSsn(ssn), taxIdMasked: maskTaxId(taxId) }
    },
    reencryptSensitiveData({ firmId, actorUserId }) {
      let rotatedProfiles = 0
      // Table iteration: profiles are relational rows; each rotated profile
      // is written back as a targeted upsert with its envelopes replaced and
      // everything else byte-identical.
      for (const profile of listProfileRows({ firmId: firmId || null })) {
        const pii = profile.pii || {}
        const fields = ['ssnEncrypted', 'taxIdEncrypted', 'dobEncrypted']
        let changed = false
        for (const field of fields) {
          const legacy =
            field === 'ssnEncrypted' ? 'ssnCiphertext' : field === 'taxIdEncrypted' ? 'taxIdCiphertext' : null
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
          upsertProfileRow(profile)
          rotatedProfiles += 1
        }
      }
      if (rotatedProfiles > 0) {
        addAudit(firmId, actorUserId || null, 'profile', firmId || 'all', 'sensitive.write_reencrypted', {
          rotatedProfiles
        })
      }
      return { rotatedProfiles }
    },
    addAuditEvent(user, payload = {}) {
      addAudit(
        user.firmId,
        user.id,
        payload.entityType || 'generic',
        payload.entityId || 'n/a',
        payload.action || 'event',
        payload.metadata || {}
      )
      return true
    },
    _internal: { piiCrypto: piiService, keyProvider },
    // Test-only: firms/users/households live in relational tables (migration
    // 009), so tests that used to read store.state.{users,firms,households}
    // read through these hooks instead.
    __listUsersForTest(firmId = null) {
      return listUserRows(firmId ? { firmId } : {})
    },
    __listFirmsForTest() {
      return listFirmRows()
    },
    __listHouseholdsForTest(firmId = null) {
      return listHouseholdRows(firmId ? { firmId } : {})
    },
    // Test-only: form/document templates and template aggregates live in
    // relational tables (migration 010). These hooks read the canonical
    // template_aggregates rows (and the companion projections) straight from the
    // tables so persistence tests can prove a mutation's upsert fired rather than
    // reading the in-memory working set.
    __listTemplateAggregatesForTest(firmId = null) {
      return listTemplateAggregateRows(firmId ? { firmId } : {})
    },
    __getTemplateAggregateForTest(templateId, firmId = null) {
      return getTemplateAggregateRow(templateId, firmId ? { firmId } : {})
    },
    __listFormTemplatesForTest(firmId = null) {
      return listFormTemplateRows(firmId ? { firmId } : {})
    },
    __listDocumentTemplatesForTest(firmId = null) {
      return listDocumentTemplateRows(firmId ? { firmId } : {})
    },
    __upsertUserForTest(user) {
      return upsertUserRow(user)
    },
    __upsertFirmForTest(firm) {
      return upsertFirmRow(firm)
    },
    __upsertHouseholdForTest(household) {
      return upsertHouseholdRow(household)
    },
    // Test-only: profiles live in the relational table, so tests that used to
    // mutate store.state.profiles in place write through this hook instead.
    __upsertProfileForTest(profile) {
      return upsertProfileRow(profile)
    },
    // Test-only: invites live in the relational table (migration 007), so
    // tests that used to mutate store.state.invites in place write through
    // this hook instead.
    __upsertInviteForTest(invite) {
      return upsertInviteRow(invite)
    },
    // Test-only: password resets live in the relational table (migration 008),
    // so tests that used to mutate store.state.passwordResets in place (e.g. to
    // push a token's expiresAt into the past) write through this hook instead.
    __upsertPasswordResetForTest(reset) {
      return upsertPasswordResetRow(reset)
    },
    __setPipelineStagesForTest(firmId, stages = []) {
      state.pipelineStagesByFirm ||= {}
      state.pipelineStagesByFirm[firmId] = normalizeStageConfiguration(stages).map(({ order, ...stage }) => ({
        ...stage
      }))
    },
    __setTestHooks(hooks = {}) {
      testHooks = { ...hooks }
    },
    __clearTestHooks() {
      testHooks = {}
    }
  }
}

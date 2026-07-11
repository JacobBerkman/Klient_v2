// Profiles, stage changes, board versions, and pipeline stage records move
// out of the app_state blob into relational tables as sources of truth. They
// migrate together because they mutate together: every board operation
// (drag, stage change, stage-config edit) touches profiles + stage_changes +
// board_versions in one transaction.
//
// profiles is the PII-bearing entity: the payload JSON column carries the
// full canonical profile object INCLUDING the envelope-encrypted
// pii.{ssnEncrypted,taxIdEncrypted,dobEncrypted} objects, which this
// migration must round-trip byte-exact (they are copied verbatim, never
// decoded). The promoted query columns reuse the existing profiles table
// from the 001 baseline (previously a derived projection rebuilt on every
// saveState; from this version on it is the sole source of truth).
//
// Boot-time fixups that used to run against the in-memory blob are ported
// into this migration as one-time row transforms:
//   - profile-record normalization (status default, extensions shape,
//     financialSummary derivation) — from store.normalizeProfileRecord
//   - prospect orderIndex backfill/compaction — from migrateProspectOrdering
//   - firm stage-config + custom-field-schema normalization — from
//     migrateFirmStageConfig (firms stay blob-resident, so this rewrites the
//     blob's firms in place)
//
// Idempotent: CREATE TABLE IF NOT EXISTS everywhere; the profiles rebuild and
// blob rewrite only happen when the blob still carries the legacy arrays;
// stage_changes/board_versions/pipeline_stage_records backfills are keyed
// INSERT OR IGNORE.
import { randomUUID } from 'node:crypto'

const DEFAULT_STAGE_KEYS = [
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

// Frozen copy of stage-config.mjs normalization at the time of this
// migration (migrations must not drift with app code).
function createDefaultFirmStageConfig() {
  return {
    stages: DEFAULT_STAGE_KEYS.map((key, index) => ({
      id: key,
      key,
      label: key,
      active: true,
      order: index + 1
    }))
  }
}

function normalizeFirmStageConfig(config) {
  const fallback = createDefaultFirmStageConfig()
  const sourceStages = Array.isArray(config?.stages) ? config.stages : []
  if (!sourceStages.length) return fallback
  const normalized = []
  sourceStages.forEach((stage, index) => {
    const key = String(stage?.key || stage?.id || '').trim()
    if (!key) return
    normalized.push({
      id: String(stage?.id || key).trim(),
      key,
      label: String(stage?.label || key).trim() || key,
      active: stage?.active !== false,
      order: Number(stage?.order ?? stage?.index ?? index + 1)
    })
  })
  if (!normalized.length) return fallback
  normalized.sort((a, b) => {
    const orderDiff = Number(a.order || 0) - Number(b.order || 0)
    if (orderDiff !== 0) return orderDiff
    return a.key.localeCompare(b.key)
  })
  return { stages: normalized.map((stage, index) => ({ ...stage, order: index + 1 })) }
}

const CUSTOM_FIELD_TYPES = new Set(['text', 'number', 'boolean', 'date'])

function normalizeCustomFieldSchema(schema, nowIso) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { fields: [], updatedAt: nowIso }
  }
  const seen = new Set()
  const fields = Array.isArray(schema.fields)
    ? schema.fields
        .map((field) => {
          const key = String(field?.key || field?.fieldKey || '')
            .trim()
            .replace(/[^a-zA-Z0-9_]+/g, '_')
          if (!key || seen.has(key)) return null
          const rawType = String(field?.type || '')
            .trim()
            .toLowerCase()
          const type = rawType === 'string' ? 'text' : rawType
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
  return { fields, updatedAt: schema.updatedAt || nowIso }
}

function toFiniteNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

// Frozen, non-throwing port of store.normalizeExtensions: unlike the store
// version, invalid extension value types must not fail the migration, so
// type validation is skipped (the values are preserved as-is).
function normalizeExtensions(extensions) {
  if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) return {}
  const schema = extensions.schema && typeof extensions.schema === 'object' ? { ...extensions.schema } : null
  const values = extensions.values && typeof extensions.values === 'object' ? { ...extensions.values } : {}
  const schemaVersion = schema?.version || extensions.schemaVersion || '1.0.0'
  return { schemaVersion, schema, values }
}

function normalizeFinancialSummary(input = {}, extensions = {}) {
  const extensionValues = extensions.values || {}
  const investableAssets = toFiniteNumber(input.investableAssets ?? extensionValues.investableAssets) || 0
  const annualIncome = toFiniteNumber(input.annualIncome ?? extensionValues.annualIncome) || 0
  const totalAssets = toFiniteNumber(input.totalAssets ?? extensionValues.totalAssets ?? investableAssets) || 0
  const totalLiabilities = toFiniteNumber(input.totalLiabilities ?? extensionValues.totalLiabilities) || 0
  const netWorth = toFiniteNumber(input.netWorth ?? extensionValues.netWorth ?? totalAssets - totalLiabilities) || 0
  return { investableAssets, annualIncome, totalAssets, totalLiabilities, netWorth }
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

function profileOrderIndex(profile) {
  const raw = profile?.orderIndex ?? profile?.stageOrderIndex ?? null
  const numeric = Number(raw)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : Number.MAX_SAFE_INTEGER
}

function parseIso(value) {
  const time = new Date(value || '').getTime()
  return Number.isFinite(time) ? time : 0
}

// Frozen port of store.migrateProspectOrdering: contiguous 1..n orderIndex
// per (firmId, stage) bucket, ordered by existing index, then recency, then
// id — exactly the boot-time backfill this migration retires.
function migrateProspectOrdering(profiles) {
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
    cards.forEach((card, index) => {
      card.orderIndex = index + 1
      card.stageOrderIndex = index + 1
    })
  }
}

export default {
  version: 6,
  name: 'board-entities-source-of-truth',
  up(db) {
    db.exec(`
  CREATE TABLE IF NOT EXISTS stage_changes (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    client_id TEXT,
    from_stage TEXT,
    to_stage TEXT,
    changed_by_user_id TEXT,
    changed_at TEXT,
    payload TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_stage_changes_firm_client ON stage_changes (firm_id, client_id);

  CREATE TABLE IF NOT EXISTS board_versions (
    firm_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS pipeline_stage_records (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    key TEXT NOT NULL,
    label TEXT,
    color TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER,
    created_at TEXT,
    updated_at TEXT,
    deactivated_at TEXT,
    UNIQUE (firm_id, key)
  );

  CREATE INDEX IF NOT EXISTS idx_pipeline_stage_records_firm ON pipeline_stage_records (firm_id);

  CREATE INDEX IF NOT EXISTS idx_profiles_firm_kind_stage ON profiles (firm_id, kind, stage);
`)

    let row = null
    try {
      row = db.prepare('SELECT payload FROM app_state WHERE id = 1').get()
    } catch {
      // app_state does not exist yet (fresh database); nothing to backfill.
      return
    }
    if (!row?.payload) return

    let parsed = null
    try {
      parsed = JSON.parse(row.payload)
    } catch {
      // Malformed blob: leave it untouched rather than failing the migration.
      return
    }

    const profiles = Array.isArray(parsed?.profiles) ? parsed.profiles : []
    const stageChanges = Array.isArray(parsed?.stageChanges) ? parsed.stageChanges : []
    const boardVersions =
      parsed?.boardVersions && typeof parsed.boardVersions === 'object' && !Array.isArray(parsed.boardVersions)
        ? parsed.boardVersions
        : {}
    const pipelineStages = Array.isArray(parsed?.pipelineStages) ? parsed.pipelineStages : []
    const hasPipelineStagesByFirm =
      parsed?.pipelineStagesByFirm &&
      typeof parsed.pipelineStagesByFirm === 'object' &&
      Object.keys(parsed.pipelineStagesByFirm).length > 0

    const hasBlobEntities =
      profiles.length > 0 ||
      stageChanges.length > 0 ||
      Object.keys(boardVersions).length > 0 ||
      pipelineStages.length > 0 ||
      hasPipelineStagesByFirm
    if (!hasBlobEntities) return

    // --- profiles: normalize + fix ordering, then rebuild the table --------
    // Pre-006 the profiles table was a derived projection rebuilt from this
    // exact blob on every saveState, so the blob is authoritative here: apply
    // the ported fixups to the blob records and rebuild the rows from them.
    if (profiles.length > 0) {
      const normalizedProfiles = profiles
        .filter((profile) => profile && typeof profile === 'object')
        .map((profile) => normalizeProfileRecord(profile))
      migrateProspectOrdering(normalizedProfiles)

      db.exec('DELETE FROM profiles')
      const insertProfile = db.prepare(`
        INSERT OR REPLACE INTO profiles (
          id, firm_id, kind, first_name, last_name, email, phone, profile_status, stage,
          stage_order_index, order_index, source_city, source_venue, source_occurred_on,
          household_id, spouse_client_id, investable_assets, annual_income, total_assets,
          total_liabilities, net_worth, extensions_payload, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const profile of normalizedProfiles) {
        insertProfile.run(
          profile.id || randomUUID(),
          profile.firmId ?? 'unknown',
          profile.kind ?? 'prospect',
          profile.firstName ?? '',
          profile.lastName ?? '',
          profile.email || null,
          profile.phone || null,
          profile.status || null,
          profile.stage || null,
          profile.stageOrderIndex || null,
          profile.orderIndex ?? profile.stageOrderIndex ?? null,
          profile.source?.cityOrLocation || null,
          profile.source?.venue || null,
          profile.source?.occurredOn || null,
          profile.householdId || null,
          profile.spouseClientId || null,
          Number(profile.financialSummary?.investableAssets || 0),
          Number(profile.financialSummary?.annualIncome || 0),
          Number(profile.financialSummary?.totalAssets || 0),
          Number(profile.financialSummary?.totalLiabilities || 0),
          Number(profile.financialSummary?.netWorth || 0),
          JSON.stringify(profile.extensions || {}),
          // Full canonical object, including the untouched PII envelopes.
          JSON.stringify(profile)
        )
      }
    }

    const insertStageChange = db.prepare(`
      INSERT OR IGNORE INTO stage_changes (
        id, firm_id, client_id, from_stage, to_stage, changed_by_user_id, changed_at, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const change of stageChanges) {
      if (!change || typeof change !== 'object') continue
      insertStageChange.run(
        change.id || randomUUID(),
        change.firmId ?? 'unknown',
        change.clientId ?? null,
        change.fromStage ?? null,
        change.toStage ?? null,
        change.changedByUserId ?? null,
        change.changedAt ?? null,
        JSON.stringify(change)
      )
    }

    const insertBoardVersion = db.prepare('INSERT OR IGNORE INTO board_versions (firm_id, version) VALUES (?, ?)')
    for (const [firmId, version] of Object.entries(boardVersions)) {
      if (!firmId) continue
      const numeric = Number(version)
      insertBoardVersion.run(firmId, Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 1)
    }

    const insertStageRecord = db.prepare(`
      INSERT OR IGNORE INTO pipeline_stage_records (
        id, firm_id, key, label, color, is_active, sort_order, created_at, updated_at, deactivated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const record of pipelineStages) {
      if (!record || typeof record !== 'object') continue
      const key = String(record.key || record.id || '').trim()
      if (!record.firmId || !key) continue
      insertStageRecord.run(
        record.id || randomUUID(),
        record.firmId,
        key,
        record.label ?? null,
        record.color ?? null,
        record.isActive === false ? 0 : 1,
        Number.isFinite(Number(record.order)) ? Number(record.order) : null,
        record.createdAt ?? null,
        record.updatedAt ?? null,
        record.deactivatedAt ?? null
      )
    }

    // --- firm stage-config normalization (ported boot fixup) ---------------
    const nowIso = new Date().toISOString()
    if (Array.isArray(parsed.firms)) {
      parsed.firms = parsed.firms.map((firm) => ({
        ...firm,
        stageConfig: normalizeFirmStageConfig(firm?.stageConfig),
        customFieldSchema: normalizeCustomFieldSchema(firm?.customFieldSchema, nowIso)
      }))
    }

    parsed.profiles = []
    parsed.stageChanges = []
    parsed.boardVersions = {}
    parsed.pipelineStagesByFirm = {}
    parsed.pipelineStages = []
    db.prepare("UPDATE app_state SET payload = ?, updated_at = datetime('now') WHERE id = 1").run(
      JSON.stringify(parsed)
    )
  }
}

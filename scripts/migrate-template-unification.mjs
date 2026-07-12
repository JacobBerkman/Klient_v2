import {
  backupState,
  listDocumentTemplateRows,
  listFormTemplateRows,
  listTemplateAggregateRows,
  upsertDocumentTemplateRow,
  upsertFormTemplateRow,
  upsertTemplateAggregateRow
} from '../apps/api/src/storage.mjs'

const stageArg = process.argv.find((arg) => arg.startsWith('--stage='))
const stage = (stageArg ? stageArg.split('=')[1] : 'plan') || 'plan'

// Templates became relational sources of truth (migration 010): the canonical
// aggregates live in template_aggregates and the two legacy projections in
// form_templates / document_templates. This one-off unification tool now reads
// and writes those tables directly (upsert per row) instead of the retired
// app_state blob arrays.

function normalizeTemplate(entry, kind) {
  const createdAt = entry.createdAt || new Date().toISOString()
  const mappings = entry.mappings || entry.mappingRules || []
  return {
    id: entry.id,
    firmId: entry.firmId,
    kind,
    name: entry.name,
    description: entry.description || '',
    documentMetadata: entry.documentMetadata || { fileName: entry.fileName || null },
    extractedFields: entry.extractedFields || [],
    formSchema: entry.formSchema || { sections: entry.sections || [] },
    blueprint: entry.blueprint || { sections: [] },
    mappings,
    mappingRules: mappings,
    publishState: entry.publishState || entry.status || 'draft',
    status: entry.publishState || entry.status || 'draft',
    versions: entry.versions || [
      {
        version: 1,
        event: 'created',
        blueprint: entry.blueprint || { sections: [] },
        mappings,
        formSchema: entry.formSchema || { sections: entry.sections || [] },
        publishState: entry.publishState || entry.status || 'draft',
        createdAt
      }
    ],
    publishTransitions: entry.publishTransitions || [],
    createdAt,
    updatedAt: entry.updatedAt || createdAt,
    legacy: entry.legacy || null
  }
}

function regenerateLegacyProjections() {
  const aggregates = listTemplateAggregateRows()
  for (const entry of aggregates) {
    if (entry.kind === 'form') {
      upsertFormTemplateRow({
        id: entry.id,
        firmId: entry.firmId,
        name: entry.name,
        description: entry.description || '',
        sections: entry.formSchema?.sections || [],
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt
      })
    } else {
      upsertDocumentTemplateRow({
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
      })
    }
  }
}

function runPlan() {
  const legacyFormIds = new Set(listFormTemplateRows().map((entry) => entry.id))
  const legacyDocumentIds = new Set(listDocumentTemplateRows().map((entry) => entry.id))
  const canonicalIds = new Set(listTemplateAggregateRows().map((entry) => entry.id))
  const missing = [...legacyFormIds, ...legacyDocumentIds].filter((id) => !canonicalIds.has(id))
  return {
    stage: 'plan',
    legacyForms: legacyFormIds.size,
    legacyDocuments: legacyDocumentIds.size,
    canonical: canonicalIds.size,
    missingInCanonical: missing,
    noop: missing.length === 0
  }
}

function runBackfill() {
  const existing = new Set(listTemplateAggregateRows().map((entry) => entry.id))
  const copied = []

  for (const form of listFormTemplateRows()) {
    if (existing.has(form.id)) continue
    upsertTemplateAggregateRow(
      normalizeTemplate(
        {
          ...form,
          kind: 'form',
          blueprint: { sections: [] },
          mappings: [],
          publishState: 'draft',
          legacy: { source: 'formTemplates', id: form.id }
        },
        'form'
      )
    )
    existing.add(form.id)
    copied.push(form.id)
  }

  for (const document of listDocumentTemplateRows()) {
    if (existing.has(document.id)) continue
    upsertTemplateAggregateRow(
      normalizeTemplate(
        {
          ...document,
          kind: 'document',
          legacy: { source: 'documentTemplates', id: document.id }
        },
        'document'
      )
    )
    existing.add(document.id)
    copied.push(document.id)
  }

  return { stage: 'backfill', copiedCount: copied.length, copiedIds: copied }
}

function runVerify() {
  const canonical = new Set(listTemplateAggregateRows().map((entry) => entry.id))
  const legacy = [...listFormTemplateRows(), ...listDocumentTemplateRows()].map((entry) => entry.id)
  const missing = legacy.filter((id) => !canonical.has(id))
  return {
    stage: 'verify',
    ok: missing.length === 0,
    missing
  }
}

const validStages = new Set(['plan', 'backfill', 'verify', 'project-legacy'])
if (!validStages.has(stage)) {
  console.error(`Unknown stage: ${stage}`)
  process.exit(1)
}

const backup = backupState()
let result

if (stage === 'plan') {
  result = runPlan()
} else if (stage === 'backfill') {
  result = runBackfill()
} else if (stage === 'verify') {
  result = runVerify()
} else {
  regenerateLegacyProjections()
  result = { stage: 'project-legacy', projected: true }
}

console.log(JSON.stringify({ backup, ...result }, null, 2))

import { backupState, loadState, saveState } from '../apps/api/src/storage.mjs'

const stageArg = process.argv.find((arg) => arg.startsWith('--stage='))
const stage = (stageArg ? stageArg.split('=')[1] : 'plan') || 'plan'

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

function regenerateLegacyProjections(state) {
  state.formTemplates = (state.templateAggregates || [])
    .filter((entry) => entry.kind === 'form')
    .map((entry) => ({
      id: entry.id,
      firmId: entry.firmId,
      name: entry.name,
      description: entry.description || '',
      sections: entry.formSchema?.sections || [],
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt
    }))

  state.documentTemplates = (state.templateAggregates || [])
    .filter((entry) => entry.kind !== 'form')
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
    }))
}

function runPlan(state) {
  const legacyFormIds = new Set((state.formTemplates || []).map((entry) => entry.id))
  const legacyDocumentIds = new Set((state.documentTemplates || []).map((entry) => entry.id))
  const canonicalIds = new Set((state.templateAggregates || []).map((entry) => entry.id))
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

function runBackfill(state) {
  state.templateAggregates ||= []
  const existing = new Set(state.templateAggregates.map((entry) => entry.id))
  const copied = []

  for (const form of state.formTemplates || []) {
    if (existing.has(form.id)) continue
    state.templateAggregates.push(
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
    copied.push(form.id)
  }

  for (const document of state.documentTemplates || []) {
    if (existing.has(document.id)) continue
    state.templateAggregates.push(
      normalizeTemplate(
        {
          ...document,
          kind: 'document',
          legacy: { source: 'documentTemplates', id: document.id }
        },
        'document'
      )
    )
    copied.push(document.id)
  }

  return { stage: 'backfill', copiedCount: copied.length, copiedIds: copied }
}

function runVerify(state) {
  const canonical = new Set((state.templateAggregates || []).map((entry) => entry.id))
  const legacy = [...(state.formTemplates || []), ...(state.documentTemplates || [])].map((entry) => entry.id)
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
const state = loadState(() => ({}))
let result

if (stage === 'plan') {
  result = runPlan(state)
} else if (stage === 'backfill') {
  result = runBackfill(state)
  saveState(state)
} else if (stage === 'verify') {
  result = runVerify(state)
} else {
  regenerateLegacyProjections(state)
  saveState(state)
  result = { stage: 'project-legacy', projected: true }
}

console.log(JSON.stringify({ backup, ...result }, null, 2))

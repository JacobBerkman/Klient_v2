import { randomUUID } from 'node:crypto'
import { objectStorage as defaultObjectStorage } from '../object-storage/index.mjs'
import { formatProfileSourceDisplay } from '../modules/profiles/source.mjs'
import { createCanonicalAuditEvent } from '../modules/audit/schema.mjs'
import { createDefaultFirmStageConfig, normalizeFirmStageConfig } from '../stage-config.mjs'
import {
  listDocumentTemplateRows,
  listFirmRows,
  listFormTemplateRows,
  listTemplateAggregateRows,
  upsertFirmRow
} from '../storage.mjs'
import { DEFAULT_STAGE_DEFINITIONS } from './constants.mjs'
import { hashPassword } from '../auth/passwords.mjs'
import {
  normalizeCustomFieldSchema,
  normalizeExtensions,
  normalizeFinancialSummary,
  normalizeTemplateAggregate,
  now,
  persistTemplateAggregateRow
} from './helpers.mjs'

// Boot-time normalization + hydration for the template system. This runs ONCE
// per store boot (not on every persist): it reads the canonical aggregates from
// the relational table, normalizes them (filling versions/versionHashes/derived
// readiness), rehydrates the in-memory working set the store's read paths use,
// and re-upserts each row (aggregate + companion projection). The legacy path
// — a database whose only template rows are the pre-aggregate form_templates /
// document_templates projections (a fresh seed, or a very old blob) — derives
// aggregates from those projection tables, mirroring the original in-memory
// migrateTemplateSystems. After this pass the blob's template arrays stay empty
// (saveState serializes them so); state.templateAggregates is the live cache.
export function migrateTemplateSystems(state) {
  const aggregateRows = listTemplateAggregateRows()
  let aggregates
  if (aggregateRows.length > 0) {
    aggregates = aggregateRows.map((entry) => normalizeTemplateAggregate(entry, entry.kind || 'document'))
  } else {
    const forms = listFormTemplateRows().map((entry) =>
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
    const documents = listDocumentTemplateRows().map((entry) =>
      normalizeTemplateAggregate(
        {
          ...entry,
          kind: 'document',
          legacy: { source: 'documentTemplates', id: entry.id }
        },
        'document'
      )
    )
    aggregates = [...forms, ...documents]
  }
  state.templateAggregates = aggregates
  for (const aggregate of aggregates) {
    persistTemplateAggregateRow(aggregate)
  }
  // The in-memory projection arrays are deprecated (nothing reads them; the
  // companion tables are the projection now). Keep the shape but empty.
  state.formTemplates = []
  state.documentTemplates = []
}

// migrateProspectOrdering (contiguous per-stage orderIndex backfill) and the
// profile-record normalization pass were ported into migration 006: profiles
// are relational rows now, so boot-time blob fixups no longer apply to them.

// Firms are relational rows now (migration 009), and migration 006 already
// ported this normalization for legacy blob firms. This boot pass keeps
// freshly seeded / newly registered firms eagerly normalized (stageConfig
// order/keys, customFieldSchema shape) by rewriting each firm row through a
// targeted upsert instead of mutating a blob-resident array.
export function migrateFirmStageConfig() {
  for (const firm of listFirmRows()) {
    upsertFirmRow({
      ...firm,
      stageConfig: normalizeFirmStageConfig(firm?.stageConfig),
      customFieldSchema: normalizeCustomFieldSchema(firm?.customFieldSchema)
    })
  }
}

export function seedState({ objectStorage = defaultObjectStorage } = {}) {
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
    firms: [
      {
        id: firmId,
        name: 'Demo Advisory Group',
        slug: 'demo-advisory-group',
        stageConfig: createDefaultFirmStageConfig(),
        createdAt
      }
    ],
    users: [
      {
        id: adminId,
        firmId,
        email: 'admin@demo.test',
        passwordHash: hashPassword('ChangeMe123!'),
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
          displayValue: formatProfileSourceDisplay({
            sourceCity: 'Dallas',
            sourceVenue: 'Referral',
            sourceDate: '2026-03-01'
          })
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
          displayValue: formatProfileSourceDisplay({
            sourceCity: 'Austin',
            sourceVenue: 'Seminar',
            sourceDate: '2026-03-10'
          })
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
          displayValue: formatProfileSourceDisplay({
            sourceCity: 'Houston',
            sourceVenue: 'CPA Referral',
            sourceDate: '2026-03-15'
          })
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
    portalLinks: [],
    boardVersions: { [firmId]: 1 },
    pipelineStagesByFirm: {
      [firmId]: DEFAULT_STAGE_DEFINITIONS.map((stage) => ({ ...stage }))
    }
  }
}

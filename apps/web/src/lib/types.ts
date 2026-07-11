export type Role = 'admin' | 'advisor' | 'readonly' | 'client' | 'anonymous'

export interface Firm {
  id: string
  name?: string | null
  slug?: string | null
  branding?: Record<string, unknown> | null
  [key: string]: unknown
}

export interface User {
  id: string
  firmId: string
  email: string
  firstName: string
  lastName: string
  role: Role
}

export interface AuditEvent {
  id: string
  action: string
  entityType?: string | null
  entityId?: string | null
  timestamp?: string | null
  actor?: {
    userId?: string | null
  }
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  [key: string]: unknown
}

export interface Profile {
  id: string
  firmId: string
  firstName: string
  lastName: string
  email?: string | null
  phone?: string | null
  kind: 'prospect' | 'client'
  stage?: string | null
  householdId?: string | null
  spouseClientId?: string | null
  advisorUserId?: string | null
  createdAt?: string
  updatedAt?: string
  dateOfBirth?: string | null
  source?: Record<string, unknown> | null
  address?: Record<string, unknown> | null
  extensions?: {
    values?: Record<string, unknown>
  } | null
  [key: string]: unknown
}

export interface DashboardPayload {
  firm?: Firm | null
  stats: {
    totalProfiles: number
    prospects: number
    clients: number
    households: number
    forms: number
    exports: number
  }
  recentProfiles: Profile[]
  recentAuditEvents: AuditEvent[]
}

export interface PipelineStage {
  id: string
  label: string
  order: number
  active: boolean
  legacy?: boolean
  isStart?: boolean
  isTerminal?: boolean
  isDrop?: boolean
  [key: string]: unknown
}

export interface PipelineStageRecord {
  id: string
  firmId: string
  key: string
  label: string
  color?: string | null
  isActive: boolean
  order: number
  createdAt?: string
  updatedAt?: string
  deactivatedAt?: string | null
}

export interface PipelineStagesPayload {
  stages: PipelineStageRecord[]
}

export interface BoardColumn {
  stage: string
  label: string
  order: number
  active: boolean
  cards: Profile[]
}

export interface BoardPayload {
  boardVersion: number
  generatedAt: string
  columns: BoardColumn[]
  stages: PipelineStage[]
  stageMetadata: PipelineStage[]
  conflict?: {
    code?: string
    message?: string
  } | null
}

export interface BoardMovePayload {
  moved: Profile
  board: BoardPayload
  conflict?: {
    code?: string
    message?: string
  } | null
}

export interface HouseholdMember {
  householdId: string
  clientId: string
  role: string
  createdAt?: string
  [key: string]: unknown
}

export interface Household {
  id: string
  firmId: string
  name: string
  primaryClientId: string
  createdAt?: string
  members: HouseholdMember[]
  [key: string]: unknown
}

export interface Note {
  id: string
  profileId: string
  body: string
  createdAt?: string
  createdByUserId?: string | null
  [key: string]: unknown
}

export interface StageHistoryEntry {
  id?: string
  clientId?: string
  fromStage?: string | null
  toStage?: string | null
  changedAt?: string
  changedByUserId?: string | null
  [key: string]: unknown
}

export interface ProfileDetailPayload {
  profile: Profile
  household?: Household | null
  householdMembers: HouseholdMember[]
  submissions: FormSubmission[]
  stageHistory: StageHistoryEntry[]
  notes: Note[]
}

export interface CustomFieldDefinition {
  key: string
  label?: string
  type: 'text' | 'number' | 'date' | 'boolean'
  required?: boolean
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface CustomFieldSchemaPayload {
  fields: CustomFieldDefinition[]
}

export interface FormField {
  key: string
  label?: string
  path?: string
  type?: string
  required?: boolean
  options?: string[]
  fields?: FormField[]
  [key: string]: unknown
}

export interface FormSection {
  id?: string
  key?: string
  title?: string
  repeatable?: boolean
  fields?: FormField[]
  [key: string]: unknown
}

export interface FormTemplate {
  id: string
  firmId: string
  name: string
  description?: string
  formSchema?: {
    sections?: FormSection[]
    [key: string]: unknown
  }
  sections: FormSection[]
  generatedFromDocumentTemplateId?: string | null
  generation?: {
    source?: string
    documentTemplateId?: string
    sourceFileName?: string
    generatedAt?: string
    fieldCount?: number
    repeatableSectionCount?: number
    diagnostics?: Array<Record<string, unknown>>
    [key: string]: unknown
  } | null
  status?: string
  publishState?: string
  createdAt?: string
  updatedAt?: string
}

export interface DraftCollaborator {
  userId: string
  permission: 'read' | 'write'
}

export interface DraftLock {
  leaseId: string
  holderUserId: string
  acquiredAt: string
  expiresAt: string
  leaseMs: number
}

export interface FormSubmission {
  id: string
  firmId: string
  clientId: string
  templateId: string
  status: 'draft' | 'submitted'
  data: Record<string, unknown>
  createdByUserId?: string | null
  createdAt?: string
  updatedAt?: string
  revisionId?: number | null
  lock?: DraftLock | null
  collaborators?: DraftCollaborator[]
  [key: string]: unknown
}

export interface DraftCollaboratorsPayload {
  ok?: boolean
  action: string
  draftId: string
  collaborators: DraftCollaborator[]
  collaboratorCount: number
  actor?: {
    userId?: string
    canManage?: boolean
  }
  feedback?: {
    code?: string
    message?: string
  }
}

export interface DraftLockPayload {
  ok: boolean
  conflict?: boolean
  reason?: string
  lock?: DraftLock | null
  revisionId?: number
  serverDraft?: FormSubmission
  submission?: FormSubmission
  mergePrompt?: {
    suggestion?: string
    type?: string
    localRevisionId?: number | null
    serverRevisionId?: number | null
  }
}

export interface MappingRow {
  pdfField?: string
  fieldLabel?: string
  sourcePath?: string
  repeaterPath?: string
  required?: boolean
  transformType?: string
  transformExpression?: string
  [key: string]: unknown
}

export interface TemplateVersion {
  version: number
  event?: string
  publishState?: string
  createdAt?: string
  actorUserId?: string | null
  changelog?: Record<string, unknown> | null
  versionHash?: string | null
  diff?: Record<string, unknown> | null
  [key: string]: unknown
}

export interface PublishReadiness {
  blockers?: Array<Record<string, unknown>>
  warnings?: Array<Record<string, unknown>>
  summary?: {
    status?: string
    blockersCount?: number
    warningsCount?: number
  }
}

export interface TemplatePreviewPayload {
  issues?: Array<Record<string, unknown>>
  rows?: Array<Record<string, unknown>>
  publishReadiness?: PublishReadiness
  [key: string]: unknown
}

export interface TemplateVersionComparePayload {
  templateId: string
  baseVersion: number
  targetVersion: number
  changed: boolean
  diff?: Record<string, unknown>
  base?: Record<string, unknown>
  target?: Record<string, unknown>
}

export interface DocumentTemplate {
  id: string
  firmId: string
  name: string
  fileName: string
  blueprint: Record<string, unknown>
  formSchema: {
    sections: FormSection[]
  }
  mappings: MappingRow[]
  extractedFields: Array<Record<string, unknown> | string>
  extraction?: {
    status?: string
    reasonCode?: string | null
    error?: {
      code?: string
      message?: string
    } | null
    diagnostics?: Array<Record<string, unknown>>
    fields?: Array<Record<string, unknown>>
  }
  documentMetadata?: Record<string, unknown>
  sourceArtifact?: {
    bucket?: string
    key?: string
    fileName?: string
    contentType?: string
    checksum?: string
    sizeBytes?: number
    retentionClass?: string
    [key: string]: unknown
  } | null
  linkedFormTemplateId?: string | null
  autoBuildSummary?: {
    fieldCount?: number
    mappingCount?: number
    linkedFormTemplateId?: string | null
    sourceArtifactAvailable?: boolean
    extractionStatus?: string
    repeatableSectionCount?: number
    ambiguousRepeaterCount?: number
    [key: string]: unknown
  } | null
  exportReadiness?: {
    status?: string
    reason?: string | null
    message?: string
    [key: string]: unknown
  } | null
  pdfLayout?: {
    fields?: Array<{
      fieldName?: string
      pageIndex?: number
      x?: number
      y?: number
      width?: number
      height?: number
      locked?: boolean
      [key: string]: unknown
    }>
    updatedAt?: string
    updatedByUserId?: string
    [key: string]: unknown
  } | null
  versions: TemplateVersion[]
  versionHash?: string | null
  publishState?: string
  status?: string
  createdAt?: string
  updatedAt?: string
}

export interface ExportJob {
  id: string
  clientId?: string | null
  submissionId?: string | null
  templateId?: string | null
  createdAt?: string
  updatedAt?: string
  status?: string
  statusLabel?: string
  attempts?: number
  maxAttempts?: number
  artifactReady?: boolean
  artifactAvailable?: boolean
  failureReason?: string | null
  deadLetterReason?: string | null
  retryState?: {
    eligible?: boolean
    class?: string
    hint?: string
  }
  output?: Record<string, unknown> | null
  artifact?: {
    format?: string
    renderer?: string
    fallbackReason?: string | null
    diagnostics?: Array<Record<string, unknown>>
    sourceArtifactChecksum?: string | null
    fileName?: string | null
    contentType?: string | null
    checksum?: string
    [key: string]: unknown
  } | null
  [key: string]: unknown
}

export interface QueueHealthPayload {
  generatedAt?: string
  queue?: {
    total?: number
    queued?: number
    pending?: number
    queuedOnly?: number
    retrying?: number
    running?: number
    failed?: number
    deadLetter?: number
    completed?: number
    stalled?: number
    readyNow?: number
    activeLeasesCount?: number
    workerMode?: string
    manualProcessEndpointDeprecated?: boolean
    lastWorkerHeartbeatAt?: string | null
    workerObservedRecently?: boolean
    pendingWithoutWorker?: boolean
    retries?: Record<string, unknown>
    machineState?: Record<string, unknown>
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface FunnelStageRow {
  stage: string
  count: number
  conversionRate: number
  [key: string]: unknown
}

export interface StageAgingRow {
  stage: string
  stageId?: string
  stageLabel?: string
  isTerminal?: boolean
  isDrop?: boolean
  count: number
  avgDays: number
  [key: string]: unknown
}

export interface FormCompletionRateRow {
  templateId: string
  drafts: number
  submitted: number
  completionRate: number
  [key: string]: unknown
}

export interface FormLatencyRow {
  templateId: string
  submissions: number
  avgHours: number
  [key: string]: unknown
}

export interface AdvisorProductivityRow {
  advisorUserId: string
  advisorName: string
  profilesManaged: number
  notesAuthored: number
  stageMoves: number
  formSubmissionsAuthored: number
  productivityScore: number
  [key: string]: unknown
}

export interface ExportUsageSummary {
  byAdvisor?: Array<{ advisorUserId?: string; advisorName?: string; total?: number }>
  byFirm?: {
    firmId?: string
    total?: number
    byStatus?: Record<string, number>
  }
}

export interface AnalyticsDashboardPayload {
  filters?: Record<string, unknown>
  stageMetadata?: PipelineStage[]
  funnel?: FunnelStageRow[]
  stageAging?: Record<string, unknown>
  stageAgingOrdered?: StageAgingRow[]
  bottlenecks?: StageAgingRow[]
  formCompletionLatency?: FormLatencyRow[]
  exportUsage?: ExportUsageSummary
}

export interface AnalyticsSummary {
  funnel?: FunnelStageRow[]
  overallConversionRate?: number
  stageAgingOrdered?: StageAgingRow[]
  bottlenecks?: StageAgingRow[]
  formCompletionRates?: FormCompletionRateRow[]
  formCompletionLatency?: FormLatencyRow[]
  advisorProductivity?: AdvisorProductivityRow[]
  exportUsage?: ExportUsageSummary
  [key: string]: unknown
}

export interface AnalyticsPayload {
  stageCounts?: Array<Record<string, unknown>>
  summary?: AnalyticsSummary
}

export interface DiagnosticsPayload {
  generatedAt?: string
  startup?: Record<string, unknown>
  data?: Record<string, unknown>
  checks?: Array<Record<string, unknown>>
  releaseReadiness?: Record<string, unknown>
  links?: Array<Record<string, unknown>>
  [key: string]: unknown
}

export interface HealthPayload {
  status?: string
  ready?: boolean
  checks?: Record<string, boolean>
  diagnostics?: Record<string, unknown>
  links?: Record<string, string>
  [key: string]: unknown
}

export interface ExportRuntimePayload {
  generatedAt?: string
  queueStatus?: Record<string, unknown>
  workerStatus?: Record<string, unknown>
  recentFailures?: Array<Record<string, unknown>>
}

export interface RuntimePayload {
  enableDemoMode: boolean
}

export interface ClientWorkspacePayload {
  profile: Profile
  submissions: FormSubmission[]
  templates: FormTemplate[]
  templateProgress: Array<Record<string, unknown>>
  uploads: Array<Record<string, unknown>>
}

export interface PortalPayload {
  firm?: Firm | null
  profile?: Profile | null
  submissions?: FormSubmission[]
  availableTemplates?: FormTemplate[]
  uploads?: Array<Record<string, unknown>>
}

export interface PortalLink {
  id: string
  firmId: string
  profileId: string
  token: string
  createdAt?: string
  expiresAt?: string
  maxUses?: number
  usedCount?: number
  revokedAt?: string | null
  scope?: Record<string, unknown>
}

export interface UserLookup {
  id: string
  email?: string
  firstName?: string
  lastName?: string
  role?: string
  label?: string
  [key: string]: unknown
}

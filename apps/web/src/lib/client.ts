import type { BoardPayload, BoardMovePayload, PipelineStageRecord, PipelineStagesPayload, Profile } from './types'

type QueryValue = string | number | boolean | null | undefined

function trimTrailingSlash(value: string) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function joinPath(...parts: Array<string | undefined | null>) {
  return parts
    .filter(Boolean)
    .map((part, index) => {
      const raw = String(part)
      return index === 0 ? trimTrailingSlash(raw) : raw.replace(/^\/+|\/+$/g, '')
    })
    .join('/')
}

function withQuery(path: string, query: Record<string, QueryValue> = {}) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const queryString = search.toString()
  return queryString ? `${path}?${queryString}` : path
}

export const routes = {
  csrf: () => '/api/csrf',
  runtime: () => '/api/runtime',
  login: () => '/api/login',
  register: () => '/api/register',
  logout: () => '/api/logout',
  session: () => '/api/session',
  users: (query: Record<string, QueryValue> = {}) => withQuery('/api/users', query),
  dashboard: () => '/api/dashboard',
  notifications: (query: Record<string, QueryValue> = {}) => withQuery('/api/notifications', query),
  notificationsUnreadCount: () => '/api/notifications/unread-count',
  notificationRead: (notificationId: string) => joinPath('/api/notifications', notificationId, 'read'),
  notificationsReadAll: () => '/api/notifications/read-all',
  board: () => '/api/board',
  pipelineStages: () => '/api/pipeline/stages',
  pipelineStage: (stageId: string) => joinPath('/api/pipeline/stages', stageId),
  pipelineStageDeactivate: (stageId: string) => joinPath('/api/pipeline/stages', stageId, 'deactivate'),
  pipelineStagesReorder: () => '/api/pipeline/stages/reorder',
  pipelineReorder: () => '/api/pipeline/reorder',
  profiles: (query: Record<string, QueryValue> = {}) => withQuery('/api/profiles', query),
  profileDetail: (profileId: string) => joinPath('/api/profiles', profileId),
  profileConvert: (profileId: string) => joinPath('/api/profiles', profileId, 'convert'),
  profileArchive: (profileId: string) => joinPath('/api/profiles', profileId, 'archive'),
  profileRestore: (profileId: string) => joinPath('/api/profiles', profileId, 'restore'),
  profileStage: (profileId: string) => joinPath('/api/profiles', profileId, 'stage'),
  profileNotes: (profileId: string) => joinPath('/api/profiles', profileId, 'notes'),
  profileMeetings: (profileId: string) => joinPath('/api/profiles', profileId, 'meetings'),
  profileMeeting: (profileId: string, meetingId: string) => joinPath('/api/profiles', profileId, 'meetings', meetingId),
  profileTags: (profileId: string) => joinPath('/api/profiles', profileId, 'tags'),
  profileTag: (profileId: string, tag: string) => joinPath('/api/profiles', profileId, 'tags', tag),
  profileSensitive: (profileId: string) => joinPath('/api/profiles', profileId, 'sensitive'),
  profileUploads: (profileId: string, query: Record<string, QueryValue> = {}) =>
    withQuery(joinPath('/api/profiles', profileId, 'uploads'), query),
  profileUploadsPresign: (profileId: string) => joinPath('/api/profiles', profileId, 'uploads', 'presign'),
  profileUploadDownload: (profileId: string, uploadId: string) =>
    joinPath('/api/profiles', profileId, 'uploads', uploadId, 'download'),
  profileUploadArchive: (profileId: string, uploadId: string) =>
    joinPath('/api/profiles', profileId, 'uploads', uploadId, 'archive'),
  profileCustomFieldSchema: () => '/api/profiles/custom-fields/schema',
  households: (query: Record<string, QueryValue> = {}) => withQuery('/api/households', query),
  householdMembers: (householdId: string) => joinPath('/api/households', householdId, 'members'),
  householdLinkSpouse: () => '/api/households/link-spouse',
  householdCreateSpouse: () => '/api/households/create-spouse',
  formTemplates: (query: Record<string, QueryValue> = {}) => withQuery('/api/forms/templates', query),
  formSubmissions: (query: Record<string, QueryValue> = {}) => withQuery('/api/forms/submissions', query),
  formSubmission: (submissionId: string) => joinPath('/api/forms/submissions', submissionId),
  formSubmissionSectionItem: (submissionId: string, sectionKey: string, itemKey: string) =>
    joinPath('/api/forms/submissions', submissionId, 'sections', sectionKey, 'items', itemKey),
  formDrafts: () => '/api/forms/drafts',
  formDraftsSearch: (query: string) => withQuery('/api/forms/drafts/search', { q: query }),
  formDraft: (draftId: string) => joinPath('/api/forms/drafts', draftId),
  formDraftLock: (draftId: string) => joinPath('/api/forms/drafts', draftId, 'lock'),
  formDraftCollaborators: (draftId: string) => joinPath('/api/forms/drafts', draftId, 'collaborators'),
  formDraftCollaborator: (draftId: string, userId: string) =>
    joinPath('/api/forms/drafts', draftId, 'collaborators', userId),
  documentTemplates: () => '/api/templates',
  documentTemplateAutoBuild: () => '/api/templates/auto-build',
  documentTemplateMappings: (templateId: string) => joinPath('/api/templates', templateId, 'mappings'),
  documentTemplateSourcePdf: (templateId: string) => joinPath('/api/templates', templateId, 'source-pdf'),
  documentTemplatePdfLayout: (templateId: string) => joinPath('/api/templates', templateId, 'pdf-layout'),
  documentTemplateTestFillPreview: (templateId: string) => joinPath('/api/templates', templateId, 'test-fill-preview'),
  documentTemplateMappingsPreview: (templateId: string) =>
    joinPath('/api/templates', templateId, 'mappings', 'preview'),
  documentTemplatePublish: (templateId: string) => joinPath('/api/templates', templateId, 'publish'),
  documentTemplateVersions: (templateId: string) => joinPath('/api/templates', templateId, 'versions'),
  documentTemplatePublishTransitions: (templateId: string) =>
    joinPath('/api/templates', templateId, 'publish-transitions'),
  documentTemplateCompare: (templateId: string, query: Record<string, QueryValue>) =>
    withQuery(joinPath('/api/templates', templateId, 'compare'), query),
  documentTemplateRevert: (templateId: string) => joinPath('/api/templates', templateId, 'revert'),
  exports: (query: Record<string, QueryValue> = {}) => withQuery('/api/exports', query),
  exportRetry: (exportId: string) => joinPath('/api/exports', exportId, 'retry'),
  exportDownload: (exportId: string) => joinPath('/api/exports', exportId, 'download'),
  exportsProcess: () => '/api/exports/process',
  exportsQueueHealth: () => '/api/ops/exports/queue',
  exportRuntime: () => '/api/ops/export-runtime',
  audit: () => '/api/audit',
  search: (query: Record<string, QueryValue> = {}) => withQuery('/api/search', query),
  activity: (query: Record<string, QueryValue> = {}) => withQuery('/api/activity', query),
  analytics: (query: Record<string, QueryValue> = {}) => withQuery('/api/analytics', query),
  analyticsDashboard: (query: Record<string, QueryValue> = {}) => withQuery('/api/analytics/dashboard', query),
  analyticsExport: (query: Record<string, QueryValue> = {}) => withQuery('/api/analytics/export', query),
  events: (query: Record<string, QueryValue> = {}) => withQuery('/api/events', query),
  eventArchive: (eventId: string) => joinPath('/api/events', eventId, 'archive'),
  event: (eventId: string) => joinPath('/api/events', eventId),
  meetingsUpcoming: (query: Record<string, QueryValue> = {}) => withQuery('/api/meetings/upcoming', query),
  diagnostics: () => '/api/ops/diagnostics',
  health: () => '/health',
  ready: () => '/ready',
  systemStatus: () => '/system/status',
  portalLinks: () => '/api/portal-links',
  portalLinkRevoke: (linkId: string) => joinPath('/api/portal-links', linkId, 'revoke'),
  clientWorkspace: () => '/api/client/workspace',
  clientFormSubmissions: () => '/api/client/forms/submissions',
  clientUploadsPresign: () => '/api/client/uploads/presign',
  clientUploads: () => '/api/client/uploads',
  portal: (token: string) => joinPath('/api/portal', token),
  portalSubmissions: (token: string) => joinPath('/api/portal', token, 'submissions'),
  portalDraftSections: (token: string, draftId: string) =>
    joinPath('/api/portal', token, 'drafts', draftId, 'sections'),
  portalDraftSection: (token: string, draftId: string, sectionId: string) =>
    joinPath('/api/portal', token, 'drafts', draftId, 'sections', sectionId),
  portalUploadsPresign: (token: string) => joinPath('/api/portal', token, 'uploads', 'presign'),
  portalUploads: (token: string) => joinPath('/api/portal', token, 'uploads'),
  documentTemplateAutoBuildPresign: () => '/api/templates/auto-build/presign',
  // Raw binary upload endpoint. The reserved object key is echoed via ?key= so a
  // mismatched key is rejected server-side.
  storageUpload: (uploadId: string, objectKey: string) =>
    `${joinPath('/api/storage/uploads', uploadId)}?key=${encodeURIComponent(objectKey)}`
}

export class ApiError extends Error {
  status: number
  code: string | null
  details: unknown
  requestId: string | null
  body: unknown

  constructor(
    message: string,
    {
      status,
      code = null,
      details = null,
      requestId = null,
      body = null
    }: {
      status: number
      code?: string | null
      details?: unknown
      requestId?: string | null
      body?: unknown
    }
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
    this.requestId = requestId
    this.body = body
  }
}

function isJsonContentType(response: Response) {
  return String(response.headers.get('content-type') || '').includes('application/json')
}

type RequestOptions = RequestInit & {
  skipCsrf?: boolean
}

// The server rejects a stale CSRF token pre-handler with 403 CSRF_VALIDATION_FAILED
// (see validateCsrf in apps/api/src/server.mjs); the mutation never executed, so one
// transparent token refresh + retry is safe and heals the multi-tab stale-token case.
function isCsrfRejection(status: number, body: unknown) {
  if (status !== 403 || !body || typeof body !== 'object') return false
  const error = (body as Record<string, unknown>).error
  if (!error || typeof error !== 'object') return false
  return (error as Record<string, unknown>).code === 'CSRF_VALIDATION_FAILED'
}

class ApiClient {
  private csrfToken = ''

  setCsrfToken(token: string | null | undefined) {
    this.csrfToken = String(token || '').trim()
  }

  clearCsrfToken() {
    this.csrfToken = ''
  }

  private async ensureCsrf() {
    if (this.csrfToken) return this.csrfToken
    const response = await fetch(routes.csrf(), { credentials: 'same-origin' })
    const body = (await response.json()) as { csrfToken?: string; message?: string }
    if (!response.ok || !body?.csrfToken) {
      throw new ApiError(body?.message || 'CSRF bootstrap failed.', { status: response.status, body })
    }
    this.setCsrfToken(body.csrfToken)
    return this.csrfToken
  }

  async request<T>(path: string, options: RequestOptions = {}) {
    return this.performRequest<T>(path, options, false)
  }

  private async performRequest<T>(path: string, options: RequestOptions, hasRetriedCsrf: boolean): Promise<T> {
    const method = String(options.method || 'GET').toUpperCase()
    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && path.startsWith('/api/')
    if (mutating && !options.skipCsrf) {
      await this.ensureCsrf()
    }

    const headers = new Headers(options.headers || {})
    if (options.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    if (mutating && !options.skipCsrf && this.csrfToken) {
      headers.set('X-CSRF-Token', this.csrfToken)
    }

    const response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers
    })

    const nextToken = response.headers.get('x-csrf-token')
    if (nextToken) {
      this.setCsrfToken(nextToken)
    }

    const body = isJsonContentType(response)
      ? ((await response.json()) as unknown)
      : ((await response.text()) as unknown)

    if (response.ok) {
      if (!nextToken && body && typeof body === 'object' && 'csrfToken' in (body as Record<string, unknown>)) {
        this.setCsrfToken(String((body as Record<string, unknown>).csrfToken || ''))
      }
      return body as T
    }

    // Mutating requests consume the single-use CSRF token server-side, and error
    // responses do not reissue one. Drop the stale token so the next mutation
    // re-bootstraps from /api/csrf instead of failing as a replay.
    if (mutating && !options.skipCsrf && !nextToken) {
      this.clearCsrfToken()
    }

    // Multi-tab staleness: another tab's mutation rotated the CSRF cookie/token pair,
    // so this tab's in-memory token was rejected before the handler ran. Refresh the
    // token and retry exactly once; every other error surfaces unchanged.
    if (mutating && !options.skipCsrf && !hasRetriedCsrf && isCsrfRejection(response.status, body)) {
      this.clearCsrfToken()
      return this.performRequest<T>(path, options, true)
    }

    const errorBody = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    throw new ApiError(
      String(
        errorBody?.error && typeof errorBody.error === 'object'
          ? (errorBody.error as Record<string, unknown>).message
          : errorBody.message || response.statusText || 'Request failed.'
      ),
      {
        status: response.status,
        code:
          errorBody?.error && typeof errorBody.error === 'object'
            ? String((errorBody.error as Record<string, unknown>).code || '')
            : null,
        details:
          errorBody?.error && typeof errorBody.error === 'object'
            ? (errorBody.error as Record<string, unknown>).details || null
            : null,
        requestId:
          errorBody?.error && typeof errorBody.error === 'object'
            ? String((errorBody.error as Record<string, unknown>).requestId || '')
            : response.headers.get('x-request-id'),
        body
      }
    )
  }

  get<T>(path: string) {
    return this.request<T>(path)
  }

  post<T>(path: string, payload?: unknown, options: RequestOptions = {}) {
    return this.request<T>(path, {
      method: 'POST',
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      ...options
    })
  }

  async postBlob(path: string, payload?: unknown, options: RequestOptions = {}) {
    return this.performPostBlob(path, payload, options, false)
  }

  private async performPostBlob(
    path: string,
    payload: unknown,
    options: RequestOptions,
    hasRetriedCsrf: boolean
  ): Promise<{ blob: Blob; headers: Headers }> {
    if (path.startsWith('/api/') && !options.skipCsrf) await this.ensureCsrf()
    const headers = new Headers(options.headers || {})
    if (payload !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    if (path.startsWith('/api/') && !options.skipCsrf && this.csrfToken) headers.set('X-CSRF-Token', this.csrfToken)
    const response = await fetch(path, {
      ...options,
      method: 'POST',
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      credentials: 'same-origin',
      headers
    })
    const nextToken = response.headers.get('x-csrf-token')
    if (nextToken) this.setCsrfToken(nextToken)
    if (!response.ok) {
      const errorBody = response.headers.get('content-type')?.includes('application/json')
        ? ((await response.json()) as unknown)
        : ((await response.text()) as unknown)
      if (!nextToken) this.clearCsrfToken()
      // Same pre-handler CSRF rejection recovery as performRequest: retry exactly once.
      if (
        path.startsWith('/api/') &&
        !options.skipCsrf &&
        !hasRetriedCsrf &&
        isCsrfRejection(response.status, errorBody)
      ) {
        return this.performPostBlob(path, payload, options, true)
      }
      const message =
        errorBody && typeof errorBody === 'object'
          ? String((errorBody as { message?: string }).message || '')
          : String(errorBody || '')
      throw new ApiError(message || response.statusText || 'Request failed.', {
        status: response.status,
        requestId: response.headers.get('x-request-id')
      })
    }
    return {
      blob: await response.blob(),
      headers: response.headers
    }
  }

  patch<T>(path: string, payload?: unknown, options: RequestOptions = {}) {
    return this.request<T>(path, {
      method: 'PATCH',
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      ...options
    })
  }

  put<T>(path: string, payload?: unknown, options: RequestOptions = {}) {
    return this.request<T>(path, {
      method: 'PUT',
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      ...options
    })
  }

  // Stream a File's raw bytes to the capability-authorized upload endpoint
  // (PUT /api/storage/uploads/:uploadId). The unguessable intent id is the
  // anti-CSRF token, so this route carries no CSRF header; the file is sent as an
  // opaque binary body rather than base64-inlined in a JSON envelope.
  async uploadRaw(uploadId: string, objectKey: string, file: File) {
    const response = await fetch(routes.storageUpload(uploadId, objectKey), {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file
    })
    if (!response.ok) {
      const errorBody = isJsonContentType(response) ? ((await response.json()) as Record<string, unknown>) : {}
      const nested =
        errorBody?.error && typeof errorBody.error === 'object' ? (errorBody.error as Record<string, unknown>) : {}
      throw new ApiError(String(nested.message || errorBody.message || response.statusText || 'Upload failed.'), {
        status: response.status,
        requestId: response.headers.get('x-request-id')
      })
    }
    return (await response.json()) as {
      uploadId: string
      object: { bucket: string; key: string; checksum?: string | null }
      sizeBytes: number
      checksum: string | null
    }
  }

  delete<T>(path: string, payload?: unknown, options: RequestOptions = {}) {
    return this.request<T>(path, {
      method: 'DELETE',
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      ...options
    })
  }
}

export const api = new ApiClient()

export interface ProfileConvertPayload {
  profile: Profile
  board: BoardPayload
}

export const profilesApi = {
  // ApiClient.post attaches the CSRF token automatically for /api/ mutations.
  convert: (profileId: string, input: { expectedUpdatedAt?: string | null } = {}) =>
    api.post<ProfileConvertPayload>(routes.profileConvert(profileId), input),
  archive: (profileId: string, input: { expectedUpdatedAt?: string | null } = {}) =>
    api.post<ProfileConvertPayload>(routes.profileArchive(profileId), input),
  restore: (profileId: string, input: { expectedUpdatedAt?: string | null } = {}) =>
    api.post<ProfileConvertPayload>(routes.profileRestore(profileId), input)
}

export const pipelineApi = {
  listStages: () => api.get<PipelineStagesPayload>(routes.pipelineStages()),
  createStage: (input: { key: string; label?: string; color?: string | null }) =>
    api.post<PipelineStageRecord>(routes.pipelineStages(), input),
  updateStageMetadata: (stageId: string, patch: { label?: string; color?: string | null }) =>
    api.patch<PipelineStageRecord>(routes.pipelineStage(stageId), patch),
  deactivateStage: (stageId: string) => api.post<PipelineStageRecord>(routes.pipelineStageDeactivate(stageId)),
  reorderStages: (stageIds: string[]) => api.patch<PipelineStagesPayload>(routes.pipelineStagesReorder(), { stageIds }),
  moveCard: (input: {
    profileId: string
    toStage: string
    beforeProfileId?: string | null
    expectedBoardVersion?: number | null
  }) => api.patch<BoardMovePayload>(routes.pipelineReorder(), input)
}

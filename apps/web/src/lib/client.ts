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
  board: () => '/api/board',
  pipelineStages: () => '/api/pipeline/stages',
  profiles: (query: Record<string, QueryValue> = {}) => withQuery('/api/profiles', query),
  profileDetail: (profileId: string) => joinPath('/api/profiles', profileId),
  profileStage: (profileId: string) => joinPath('/api/profiles', profileId, 'stage'),
  profileNotes: (profileId: string) => joinPath('/api/profiles', profileId, 'notes'),
  profileSensitive: (profileId: string) => joinPath('/api/profiles', profileId, 'sensitive'),
  profileCustomFieldSchema: () => '/api/profiles/custom-fields/schema',
  households: () => '/api/households',
  householdMembers: (householdId: string) => joinPath('/api/households', householdId, 'members'),
  householdLinkSpouse: () => '/api/households/link-spouse',
  householdCreateSpouse: () => '/api/households/create-spouse',
  formTemplates: () => '/api/forms/templates',
  formSubmissions: () => '/api/forms/submissions',
  formSubmission: (submissionId: string) => joinPath('/api/forms/submissions', submissionId),
  formSubmissionSectionItem: (submissionId: string, sectionKey: string, itemKey: string) =>
    joinPath('/api/forms/submissions', submissionId, 'sections', sectionKey, 'items', itemKey),
  formDrafts: () => '/api/forms/drafts',
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
  analytics: (query: Record<string, QueryValue> = {}) => withQuery('/api/analytics', query),
  analyticsDashboard: (query: Record<string, QueryValue> = {}) => withQuery('/api/analytics/dashboard', query),
  analyticsExport: (query: Record<string, QueryValue> = {}) => withQuery('/api/analytics/export', query),
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
  portalUploadsPresign: (token: string) => joinPath('/api/portal', token, 'uploads', 'presign'),
  portalUploads: (token: string) => joinPath('/api/portal', token, 'uploads')
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
      const message = response.headers.get('content-type')?.includes('application/json')
        ? ((await response.json()) as { message?: string })?.message
        : await response.text()
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

  delete<T>(path: string, payload?: unknown, options: RequestOptions = {}) {
    return this.request<T>(path, {
      method: 'DELETE',
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      ...options
    })
  }
}

export const api = new ApiClient()

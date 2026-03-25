const API_PREFIX = '/api'

function trimTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function joinPath(...parts) {
  return parts
    .filter(Boolean)
    .map((part, index) => {
      if (index === 0) return trimTrailingSlash(part)
      return String(part).replace(/^\/+|\/+$/g, '')
    })
    .join('/')
}

function withQuery(path, query = {}) {
  const search = new URLSearchParams()
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  })
  const qs = search.toString()
  return qs ? `${path}?${qs}` : path
}

export const routes = {
  register: () => joinPath(API_PREFIX, 'register'),
  login: () => joinPath(API_PREFIX, 'login'),
  dashboard: () => joinPath(API_PREFIX, 'dashboard'),
  profiles: (query = {}) => withQuery(joinPath(API_PREFIX, 'profiles'), query),
  profileDetail: (profileId) => joinPath(API_PREFIX, 'profiles', profileId),
  profileStage: (profileId) => joinPath(API_PREFIX, 'profiles', profileId, 'stage'),
  profileNotes: (profileId) => joinPath(API_PREFIX, 'profiles', profileId, 'notes'),
  households: () => joinPath(API_PREFIX, 'households'),
  formTemplates: () => joinPath(API_PREFIX, 'forms', 'templates'),
  formSubmissions: () => joinPath(API_PREFIX, 'forms', 'submissions'),
  submissionSectionItems: (submissionId, sectionKey) =>
    joinPath(API_PREFIX, 'forms', 'submissions', submissionId, 'sections', sectionKey, 'items'),
  submissionSectionItem: (submissionId, sectionKey, itemKey) =>
    joinPath(API_PREFIX, 'forms', 'submissions', submissionId, 'sections', sectionKey, 'items', itemKey),
  formDrafts: () => joinPath(API_PREFIX, 'forms', 'drafts'),
  documentTemplates: () => joinPath(API_PREFIX, 'templates'),
  invites: () => joinPath(API_PREFIX, 'invites'),
  portalLinks: () => joinPath(API_PREFIX, 'portal-links'),
  exports: () => joinPath(API_PREFIX, 'exports'),
  audit: () => joinPath(API_PREFIX, 'audit'),
  analytics: (query = {}) => withQuery(joinPath(API_PREFIX, 'analytics'), query),
  analyticsExport: (query = {}) => withQuery(joinPath(API_PREFIX, 'analytics', 'export'), query),
  board: () => joinPath(API_PREFIX, 'board'),
  portal: (token) => joinPath(API_PREFIX, 'portal', token),
  portalSubmissions: (token) => joinPath(API_PREFIX, 'portal', token, 'submissions')
}

function defaultDecode(body) {
  if (body && typeof body === 'object' && 'data' in body && Object.keys(body).length === 1) return body.data
  return body
}

function createApiError(response, body) {
  const message = body?.error?.message || body?.message || response.statusText || 'Request failed'
  const error = new Error(message)
  error.name = 'ApiError'
  error.status = response.status
  error.code = body?.error?.code || body?.code || null
  error.details = body?.error?.details || body?.issues || null
  error.requestId = body?.error?.requestId || response.headers.get('x-request-id')
  error.body = body
  return error
}

export function decodeJsonResponse(response, body, decode = defaultDecode) {
  if (!response.ok) throw createApiError(response, body)
  return decode(body)
}

export function createJsonApiClient({ getToken = () => '', fetchImpl = fetch } = {}) {
  return async function request(path, options = {}, decode = defaultDecode) {
    const token = getToken()
    const headers = {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }

    const response = await fetchImpl(path, { ...options, headers })
    const text = await response.text()
    const body = text ? JSON.parse(text) : null
    return decodeJsonResponse(response, body, decode)
  }
}

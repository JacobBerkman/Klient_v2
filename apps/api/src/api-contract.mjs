export const API_BASE_PATH = '/api';
export const API_VERSION_PATH = '/api/v1';
export const API_VERSION = 'v1';

const AUTH_HEADER = 'Authorization: Bearer <session-token>';

export const AUTH_EXPECTATIONS = Object.freeze({
  scheme: 'Bearer',
  header: AUTH_HEADER,
  tokenSource: 'POST /api/login or POST /api/register',
  behavior: {
    missingToken: { status: 401, code: 'AUTH_REQUIRED' },
    invalidToken: { status: 401, code: 'AUTH_REQUIRED' },
    forbidden: { status: 403, code: 'FORBIDDEN' }
  }
});

export const KEY_RESOURCE_PAYLOADS = Object.freeze({
  session: {
    token: 'string',
    user: { id: 'string', firmId: 'string', email: 'string', firstName: 'string', lastName: 'string', role: 'admin|advisor|readonly|client' }
  },
  profile: {
    id: 'string',
    firmId: 'string',
    kind: 'prospect|client',
    firstName: 'string',
    lastName: 'string',
    stage: 'string|null',
    stageOrderIndex: 'number|null',
    source: 'object|null',
    createdAt: 'ISO-8601 string',
    updatedAt: 'ISO-8601 string'
  },
  household: {
    id: 'string',
    firmId: 'string',
    name: 'string',
    primaryClientId: 'string',
    createdAt: 'ISO-8601 string'
  },
  formTemplate: {
    id: 'string',
    firmId: 'string',
    name: 'string',
    description: 'string',
    sections: 'array',
    createdAt: 'ISO-8601 string',
    updatedAt: 'ISO-8601 string'
  },
  exportJob: {
    id: 'string',
    firmId: 'string',
    clientId: 'string',
    templateId: 'string',
    type: 'pdf|docx',
    status: 'queued|processing|completed|failed',
    output: 'object|null',
    createdAt: 'ISO-8601 string',
    updatedAt: 'ISO-8601 string'
  },
  auditEvent: {
    id: 'string',
    firmId: 'string',
    actorUserId: 'string',
    entityType: 'string',
    entityId: 'string',
    action: 'string',
    occurredAt: 'ISO-8601 string',
    metadata: 'object'
  }
});

export function normalizeApiPath(pathname) {
  if (pathname === API_VERSION_PATH || pathname.startsWith(`${API_VERSION_PATH}/`)) {
    return { normalizedPath: pathname.replace(API_VERSION_PATH, API_BASE_PATH), isVersioned: true };
  }

  return { normalizedPath: pathname, isVersioned: false };
}

export function successPayload(body, requestId, isVersioned) {
  if (!isVersioned) return body;
  if (body && typeof body === 'object' && 'data' in body && 'meta' in body) return body;
  return {
    data: body,
    meta: {
      apiVersion: API_VERSION,
      requestId
    }
  };
}

export function errorPayload({ status, message, requestId, code = 'BAD_REQUEST', details }) {
  const payload = {
    error: {
      code,
      message,
      status,
      requestId
    },
    message,
    meta: { apiVersion: API_VERSION, requestId }
  };

  if (details !== undefined) {
    payload.error.details = details;
  }

  return payload;
}

export function classifyError(error) {
  const message = error?.message || 'Request failed';
  if (/authentication required/i.test(message)) return { status: 401, code: 'AUTH_REQUIRED', message };
  if (/missing permission/i.test(message)) return { status: 403, code: 'FORBIDDEN', message };
  if (/payload too large/i.test(message)) return { status: 413, code: 'PAYLOAD_TOO_LARGE', message };
  if (/invalid json payload/i.test(message)) return { status: 400, code: 'INVALID_JSON', message };
  if (/not found/i.test(message)) return { status: 404, code: 'NOT_FOUND', message };
  return { status: 400, code: 'BAD_REQUEST', message };
}

export function getApiContractDocument() {
  return {
    version: API_VERSION,
    basePaths: [API_BASE_PATH, API_VERSION_PATH],
    authentication: AUTH_EXPECTATIONS,
    errorShape: {
      error: { code: 'string', message: 'string', status: 'number', requestId: 'string', details: 'unknown (optional)' },
      message: 'string',
      meta: { apiVersion: API_VERSION, requestId: 'string' }
    },
    keyResources: KEY_RESOURCE_PAYLOADS,
    note: 'Use /api/v1/* for the versioned response envelope. Legacy /api/* remains for compatibility.'
  };
}

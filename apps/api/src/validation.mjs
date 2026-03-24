export class AppError extends Error {
  constructor(message, { statusCode = 400, code = 'request_failed', details = null } = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, { statusCode: 422, code: 'invalid_request', details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required.') {
    super(message, { statusCode: 401, code: 'unauthorized' });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden.') {
    super(message, { statusCode: 403, code: 'forbidden' });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found.') {
    super(message, { statusCode: 404, code: 'not_found' });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict.') {
    super(message, { statusCode: 409, code: 'conflict' });
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function ensureObject(value, label = 'body') {
  if (!isObject(value)) {
    throw new ValidationError(`${label} must be an object.`, [{ field: label, issue: 'expected_object' }]);
  }
  return value;
}

export function getString(value, field, { required = true, allowEmpty = false } = {}) {
  if (value == null) {
    if (required) throw new ValidationError(`${field} is required.`, [{ field, issue: 'required' }]);
    return undefined;
  }
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string.`, [{ field, issue: 'expected_string' }]);
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) throw new ValidationError(`${field} cannot be empty.`, [{ field, issue: 'empty_string' }]);
  return trimmed;
}

export function getOptionalObject(value, field) {
  if (value == null) return undefined;
  if (!isObject(value)) throw new ValidationError(`${field} must be an object.`, [{ field, issue: 'expected_object' }]);
  return value;
}

export function getOptionalArray(value, field) {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be an array.`, [{ field, issue: 'expected_array' }]);
  return value;
}

export function getEnum(value, field, options, { required = true } = {}) {
  if (value == null) {
    if (required) throw new ValidationError(`${field} is required.`, [{ field, issue: 'required' }]);
    return undefined;
  }
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string.`, [{ field, issue: 'expected_string' }]);
  if (!options.includes(value)) throw new ValidationError(`${field} must be one of: ${options.join(', ')}.`, [{ field, issue: 'invalid_enum', options }]);
  return value;
}

export function validateRegisterPayload(body) {
  const payload = ensureObject(body);
  return {
    firmName: getString(payload.firmName, 'firmName'),
    firstName: getString(payload.firstName, 'firstName'),
    lastName: getString(payload.lastName, 'lastName'),
    email: getString(payload.email, 'email'),
    password: getString(payload.password, 'password')
  };
}

export function validateLoginPayload(body) {
  const payload = ensureObject(body);
  return { email: getString(payload.email, 'email'), password: getString(payload.password, 'password') };
}

export function validateInviteAcceptPayload(body) {
  const payload = ensureObject(body);
  return {
    token: getString(payload.token, 'token'),
    firstName: getString(payload.firstName, 'firstName'),
    lastName: getString(payload.lastName, 'lastName'),
    password: getString(payload.password, 'password')
  };
}

export function validatePasswordResetRequestPayload(body) {
  const payload = ensureObject(body);
  return { email: getString(payload.email, 'email') };
}

export function validatePasswordResetConfirmPayload(body) {
  const payload = ensureObject(body);
  return { token: getString(payload.token, 'token'), password: getString(payload.password, 'password') };
}

export function validateProfilePayload(body, { partial = false } = {}) {
  const payload = ensureObject(body);
  const kind = getEnum(payload.kind, 'kind', ['client', 'prospect'], { required: !partial });
  const firstName = getString(payload.firstName, 'firstName', { required: !partial });
  const lastName = getString(payload.lastName, 'lastName', { required: !partial });
  const stage = getString(payload.stage, 'stage', { required: false });
  if (partial && Object.keys(payload).length === 0) {
    throw new ValidationError('At least one profile field must be provided.', [{ field: 'body', issue: 'empty_object' }]);
  }
  return {
    ...payload,
    ...(kind ? { kind } : {}),
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(stage ? { stage } : {})
  };
}

export function validateStageMovePayload(body) {
  const payload = ensureObject(body);
  return { stage: getString(payload.stage, 'stage'), beforeProfileId: getString(payload.beforeProfileId, 'beforeProfileId', { required: false }) || null };
}

export function validateHouseholdMemberAddPayload(body) {
  const payload = ensureObject(body);
  return {
    clientId: getString(payload.clientId, 'clientId'),
    role: getEnum(payload.role, 'role', ['primary', 'spouse', 'dependent', 'other'])
  };
}

export function validateHouseholdMemberRemovePayload(body) {
  const payload = ensureObject(body);
  return { clientId: getString(payload.clientId, 'clientId') };
}

export function validateSpouseLinkPayload(body) {
  const payload = ensureObject(body);
  return {
    primaryClientId: getString(payload.primaryClientId, 'primaryClientId'),
    spouseClientId: getString(payload.spouseClientId, 'spouseClientId')
  };
}

export function validateSpouseCreatePayload(body) {
  const payload = ensureObject(body);
  const spouse = getOptionalObject(payload.spouse, 'spouse');
  if (!spouse) {
    throw new ValidationError('spouse is required.', [{ field: 'spouse', issue: 'required' }]);
  }
  return {
    primaryClientId: getString(payload.primaryClientId, 'primaryClientId'),
    spouse: {
      ...spouse,
      firstName: getString(spouse.firstName, 'spouse.firstName'),
      lastName: getString(spouse.lastName, 'spouse.lastName')
    }
  };
}

export function validateTemplateCreatePayload(body) {
  const payload = ensureObject(body);
  return {
    ...payload,
    name: getString(payload.name, 'name'),
    fileName: getString(payload.fileName, 'fileName', { required: false }),
    blueprint: getOptionalObject(payload.blueprint, 'blueprint') || payload.blueprint,
    mappings: getOptionalArray(payload.mappings, 'mappings') || payload.mappings
  };
}

export function validateTemplateUpdatePayload(body) {
  const payload = ensureObject(body);
  return { mappings: getOptionalArray(payload.mappings, 'mappings') || [] };
}

export function validateFormSubmissionCreatePayload(body) {
  const payload = ensureObject(body);
  return {
    ...payload,
    clientId: getString(payload.clientId, 'clientId'),
    templateId: getString(payload.templateId, 'templateId'),
    data: getOptionalObject(payload.data, 'data') || payload.data
  };
}

export function validateFormSubmissionUpdatePayload(body) {
  const payload = ensureObject(body);
  if (Object.keys(payload).length === 0) {
    throw new ValidationError('At least one submission field must be provided.', [{ field: 'body', issue: 'empty_object' }]);
  }
  if ('status' in payload) getEnum(payload.status, 'status', ['draft', 'submitted']);
  if ('data' in payload) getOptionalObject(payload.data, 'data');
  return payload;
}

export function validatePortalSubmissionPayload(body) {
  const payload = ensureObject(body);
  if ('status' in payload) getEnum(payload.status, 'status', ['draft', 'submitted']);
  if ('templateId' in payload) getString(payload.templateId, 'templateId');
  if ('data' in payload) getOptionalObject(payload.data, 'data');
  return payload;
}

export function validateExportCreatePayload(body) {
  const payload = ensureObject(body);
  return {
    clientId: getString(payload.clientId, 'clientId'),
    templateId: getString(payload.templateId, 'templateId'),
    type: getEnum(payload.type, 'type', ['pdf', 'csv', 'json'], { required: false }) || 'pdf'
  };
}

export function toErrorResponse(error, requestId) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 400;
  const code = error?.code || 'request_failed';
  const message = error?.message || 'Request failed';
  return {
    statusCode,
    body: {
      error: {
        code,
        message,
        details: error?.details || null
      },
      message,
      requestId
    }
  };
}

export class ApplicationError extends Error {
  constructor({ message, statusCode = 400, code = null, cause = null }) {
    super(message || 'Request failed');
    this.name = 'ApplicationError';
    this.statusCode = statusCode;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

export function appError(statusCode, message, code = null, cause = null) {
  return new ApplicationError({ statusCode, message, code, cause });
}

export function normalizeError(error) {
  if (error instanceof ApplicationError) return error;
  return appError(500, 'Internal server error', 'INTERNAL_SERVER_ERROR', error);
}

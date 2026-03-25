function createTenancyError(message, code, details = null, statusCode = 400) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  error.details = details
  return error
}

export function createFirmContext(user, metadata = {}) {
  const firmId = user?.firmId ? String(user.firmId) : ''
  if (!firmId) {
    throw createTenancyError('firmId is required for tenant-scoped operations.', 'TENANCY_FIRM_ID_MISSING', {
      metadata
    })
  }
  return {
    firmId,
    userId: user?.id || null,
    role: user?.role || null,
    user,
    metadata
  }
}

export function requireFirmContext(firmContext, metadata = {}) {
  const firmId = firmContext?.firmId ? String(firmContext.firmId) : ''
  if (!firmId) {
    throw createTenancyError('firmId is required for tenant-scoped operations.', 'TENANCY_FIRM_ID_MISSING', {
      metadata
    })
  }
  return firmContext
}

export function validateEntityOwnership(firmContext, entity, options = {}) {
  const context = requireFirmContext(firmContext, options)
  const { entityName = 'Entity', statusCode = 404, errorCode = 'TENANCY_ENTITY_NOT_FOUND' } = options
  if (!entity) {
    throw createTenancyError(`${entityName} not found.`, errorCode, { firmId: context.firmId }, statusCode)
  }
  if (String(entity.firmId || '') !== String(context.firmId)) {
    throw createTenancyError(`${entityName} not found.`, errorCode, { firmId: context.firmId }, statusCode)
  }
  return entity
}

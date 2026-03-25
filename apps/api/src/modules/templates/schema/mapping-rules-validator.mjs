const TRANSFORM_TYPES = new Set(['date', 'phone', 'currency', 'checkbox', 'expression'])

function validationError(message, issues) {
  const error = new Error(message)
  error.statusCode = 400
  error.code = 'SCHEMA_VALIDATION_FAILED'
  error.details = { issues }
  return error
}

function pushIssue(issues, path, message) {
  issues.push({ path, message })
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizePath(value) {
  return String(value || '')
    .replace(/\[(\*|\d+)\]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.|\.$/g, '')
}

function toTransformObject(transform) {
  if (!transform) return null
  if (typeof transform === 'string') {
    const normalized = transform === 'custom' ? 'expression' : transform
    return { type: normalized }
  }
  if (isObject(transform)) {
    const normalized = transform.type === 'custom' ? 'expression' : transform.type
    return { ...transform, type: normalized }
  }
  return transform
}

export function convertLegacyMappingRules(input) {
  if (!Array.isArray(input)) return []
  return input.map((rule) => {
    if (!isObject(rule)) return rule
    const next = { ...rule }
    next.pdfField ||= rule.targetField || rule.field || rule.key
    next.sourcePath ||= rule.path || rule.source
    if ('transform' in next) {
      next.transform = toTransformObject(next.transform)
    } else if (rule.formatter) {
      next.transform = toTransformObject(rule.formatter)
    }
    if (next.transform?.type === 'expression' && !next.transform.expression && rule.expression) {
      next.transform.expression = rule.expression
    }
    return next
  })
}

function validateTransform(rule, issues, path) {
  if (!('transform' in rule) || rule.transform === null) return
  const transform = toTransformObject(rule.transform)
  if (!isObject(transform)) {
    pushIssue(issues, `${path}/transform`, 'transform must be an object or registered transform string.')
    return
  }
  if (!TRANSFORM_TYPES.has(transform.type)) {
    pushIssue(
      issues,
      `${path}/transform/type`,
      `Unsupported transform type "${transform.type}". Allowed: date, phone, currency, checkbox, expression.`
    )
    return
  }
  if (transform.type === 'expression' && !String(transform.expression || '').trim()) {
    pushIssue(issues, `${path}/transform/expression`, 'expression transform requires a non-empty expression.')
  }
}

function normalizeAllowedSourcePaths(allowedSourcePaths = null) {
  if (!allowedSourcePaths) return null
  const normalized = new Map()
  if (allowedSourcePaths instanceof Map) {
    for (const [path, metadata] of allowedSourcePaths.entries()) {
      normalized.set(normalizePath(path), metadata || {})
    }
    return normalized
  }
  if (Array.isArray(allowedSourcePaths)) {
    for (const value of allowedSourcePaths) {
      normalized.set(normalizePath(value), {})
    }
    return normalized
  }
  if (isObject(allowedSourcePaths)) {
    for (const [path, metadata] of Object.entries(allowedSourcePaths)) {
      normalized.set(normalizePath(path), metadata || {})
    }
    return normalized
  }
  return null
}

export function validateMappingRules(input, options = {}) {
  const contextPath = options.contextPath || '/mappings'
  const repeaterPaths = options.repeaterPaths || new Set()
  const requiredPdfFields = new Set((options.requiredPdfFields || []).map((value) => String(value || '').trim()).filter(Boolean))
  const allowedSourcePaths = normalizeAllowedSourcePaths(options.allowedSourcePaths)
  const enforceKnownSourcePaths = options.enforceKnownSourcePaths === true
  const mappings = convertLegacyMappingRules(input)
  const issues = []
  const usedTargets = new Map()

  if (!Array.isArray(mappings)) {
    pushIssue(issues, contextPath, 'Mapping rules must be an array.')
  } else {
    mappings.forEach((rule, index) => {
      const rulePath = `${contextPath}/${index}`
      if (!isObject(rule)) {
        pushIssue(issues, rulePath, 'Mapping rule must be an object.')
        return
      }
      if (!String(rule.pdfField || '').trim()) {
        pushIssue(issues, `${rulePath}/pdfField`, 'pdfField is required.')
      }
      if (!String(rule.sourcePath || '').trim()) {
        pushIssue(issues, `${rulePath}/sourcePath`, 'sourcePath is required.')
      }
      const pdfField = String(rule.pdfField || '').trim()
      if (pdfField) {
        if (usedTargets.has(pdfField)) {
          pushIssue(issues, `${rulePath}/pdfField`, `Duplicate pdfField "${pdfField}" is not allowed.`)
        } else {
          usedTargets.set(pdfField, index)
        }
      }
      validateTransform(rule, issues, rulePath)

      const repeaterPath = String(rule.repeaterPath || '').trim()
      const sourcePath = normalizePath(rule.sourcePath)
      if (enforceKnownSourcePaths && allowedSourcePaths && sourcePath && !allowedSourcePaths.has(sourcePath)) {
        pushIssue(issues, `${rulePath}/sourcePath`, `sourcePath "${String(rule.sourcePath)}" is not a known profile/form schema path.`)
      }
      const expectedTargetType = String(rule.targetType || '').trim()
      const sourceMeta = sourcePath && allowedSourcePaths ? allowedSourcePaths.get(sourcePath) : null
      const sourceType = String(sourceMeta?.type || '').trim()
      if (expectedTargetType && sourceType && expectedTargetType !== sourceType) {
        pushIssue(
          issues,
          `${rulePath}/targetType`,
          `targetType "${expectedTargetType}" does not match source type "${sourceType}" for "${sourcePath}".`
        )
      }
      if (repeaterPath) {
        const normalizedRepeater = normalizePath(repeaterPath)
        if (!repeaterPaths.has(normalizedRepeater)) {
          pushIssue(
            issues,
            `${rulePath}/repeaterPath`,
            `repeaterPath "${repeaterPath}" does not match any repeater in the form definition.`
          )
        }
        if (sourcePath && sourcePath !== normalizedRepeater && !sourcePath.startsWith(`${normalizedRepeater}.`)) {
          pushIssue(
            issues,
            `${rulePath}/sourcePath`,
            'sourcePath must be within repeaterPath when repeaterPath is provided.'
          )
        }
      }
      if (!repeaterPath && /\[(\*|\d+)\]/.test(String(rule.sourcePath || ''))) {
        pushIssue(
          issues,
          `${rulePath}/repeaterPath`,
          'repeaterPath is required when sourcePath uses array/repeater selectors.'
        )
      }
    })
  }

  requiredPdfFields.forEach((requiredField) => {
    if (!usedTargets.has(requiredField)) {
      pushIssue(issues, contextPath, `Required mapping for pdfField "${requiredField}" is missing.`)
    }
  })

  if (issues.length) {
    throw validationError('Template mapping schema validation failed.', issues)
  }

  return mappings
}

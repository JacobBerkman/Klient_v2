const TRANSFORM_TYPES = new Set(['date', 'phone', 'currency', 'checkbox', 'expression'])

function validationError(message, issues) {
  const error = new Error(message)
  error.statusCode = 400
  error.code = 'SCHEMA_VALIDATION_FAILED'
  error.details = { issues }
  return error
}

function buildIssueMeta({ code, path, rowIndex, field, meta }) {
  const issueRowIndex = Number.isInteger(rowIndex) ? rowIndex : null
  const normalizedPath = String(path || '')
  const normalizedField = String(field || '')
  const issueId = [code, issueRowIndex ?? 'global', normalizedField || normalizedPath || 'mapping'].join(':')
  return {
    ...(meta && isObject(meta) ? meta : {}),
    issueId,
    fieldPath: normalizedPath,
    fieldKey: normalizedField || normalizedPath || 'mapping'
  }
}

function pushIssue(issues, { code, path, rowIndex = null, field, message, meta }) {
  const issue = { code, path, rowIndex, field, message }
  issue.meta = buildIssueMeta({ code, path, rowIndex, field, meta })
  issues.push(issue)
}

function sortIssues(issues) {
  return issues.sort((left, right) => {
    const leftRow = Number.isInteger(left.rowIndex) ? left.rowIndex : Number.POSITIVE_INFINITY
    const rightRow = Number.isInteger(right.rowIndex) ? right.rowIndex : Number.POSITIVE_INFINITY
    if (leftRow !== rightRow) return leftRow - rightRow
    const fieldCompare = String(left.field || '').localeCompare(String(right.field || ''))
    if (fieldCompare !== 0) return fieldCompare
    const codeCompare = String(left.code || '').localeCompare(String(right.code || ''))
    if (codeCompare !== 0) return codeCompare
    return String(left.path || '').localeCompare(String(right.path || ''))
  })
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
    next.pdfField ||= rule.targetField || rule.target || rule.field || rule.key
    next.sourcePath ||= rule.path || rule.source || rule.source_field
    if (!('fieldLabel' in next) && (rule.label || rule.name)) next.fieldLabel = rule.label || rule.name
    if (!('required' in next) && ('isRequired' in rule || 'mandatory' in rule)) {
      next.required = rule.isRequired === true || rule.mandatory === true
    }
    if (!('enabled' in next) && ('disabled' in rule || 'isEnabled' in rule)) {
      next.enabled = rule.disabled === true ? false : rule.isEnabled !== false
    }
    if (!('targetType' in next) && (rule.type || rule.valueType)) next.targetType = rule.type || rule.valueType
    if ('transform' in next) {
      next.transform = toTransformObject(next.transform)
    } else if (rule.formatter || rule.format || rule.transformer) {
      next.transform = toTransformObject(rule.formatter || rule.format || rule.transformer)
    }
    if (next.transform?.type === 'expression' && !next.transform.expression && rule.expression) {
      next.transform.expression = rule.expression
    }
    return next
  })
}

function validateTransform(rule, issues, path, rowIndex) {
  if (!('transform' in rule) || rule.transform === null) return
  const transform = toTransformObject(rule.transform)
  if (!isObject(transform)) {
    pushIssue(issues, {
      code: 'invalid_transform_shape',
      path: `${path}/transform`,
      rowIndex,
      field: 'transform',
      message: 'transform must be an object or registered transform string.'
    })
    return
  }

  const transformType = String(transform.type || '').trim()
  if (!transformType) {
    pushIssue(issues, {
      code: 'missing_transform_type',
      path: `${path}/transform/type`,
      rowIndex,
      field: 'transform.type',
      message: 'transform.type is required when transform is provided.'
    })
  } else if (!TRANSFORM_TYPES.has(transformType)) {
    pushIssue(issues, {
      code: 'unsupported_transform_type',
      path: `${path}/transform/type`,
      rowIndex,
      field: 'transform.type',
      message: `Unsupported transform type "${transform.type}". Allowed: date, phone, currency, checkbox, expression.`
    })
  }

  if (transformType === 'expression' && !String(transform.expression || '').trim()) {
    pushIssue(issues, {
      code: 'missing_transform_expression',
      path: `${path}/transform/expression`,
      rowIndex,
      field: 'transform.expression',
      message: 'expression transform requires a non-empty expression.'
    })
  }
  if (transformType === 'expression') {
    const expression = String(transform.expression || '').trim()
    if (!expression) return
    const assignmentMatch = expression.match(/(^|[^=!<>])=($|[^=])/)
    if (assignmentMatch) {
      pushIssue(issues, {
        code: 'expression_operator_assignment',
        path: `${path}/transform/expression`,
        rowIndex,
        field: 'transform.expression',
        message: 'Expression appears to use assignment (=). Use ==/=== for equality checks.',
        meta: {
          operator: '=',
          suggestion: 'Replace assignment (=) with equality operator (== or ===).'
        }
      })
    }
    if (/\bAND\b|\bOR\b/.test(expression)) {
      pushIssue(issues, {
        code: 'expression_operator_textual_logic',
        path: `${path}/transform/expression`,
        rowIndex,
        field: 'transform.expression',
        message: 'Expression uses textual AND/OR. Use && and || logical operators.',
        meta: {
          suggestion: 'Replace AND with &&, and OR with ||.'
        }
      })
    }
    const openedParens = (expression.match(/\(/g) || []).length
    const closedParens = (expression.match(/\)/g) || []).length
    if (openedParens !== closedParens) {
      pushIssue(issues, {
        code: 'expression_unbalanced_parentheses',
        path: `${path}/transform/expression`,
        rowIndex,
        field: 'transform.expression',
        message: 'Expression has unbalanced parentheses.',
        meta: {
          openedParens,
          closedParens,
          suggestion: 'Balance opening and closing parentheses.'
        }
      })
    }
    if (expression.includes('?') && !expression.includes(':')) {
      pushIssue(issues, {
        code: 'expression_incomplete_ternary',
        path: `${path}/transform/expression`,
        rowIndex,
        field: 'transform.expression',
        message: 'Expression appears to start a ternary condition but is missing ":" branch.',
        meta: {
          suggestion: 'Use full ternary syntax: condition ? truthyValue : falsyValue.'
        }
      })
    }
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
    pushIssue(issues, {
      code: 'invalid_mapping_rules_type',
      path: contextPath,
      rowIndex: null,
      field: 'mappings',
      message: 'Mapping rules must be an array.'
    })
  } else {
    mappings.forEach((rule, index) => {
      const rulePath = `${contextPath}/${index}`
      if (!isObject(rule)) {
        pushIssue(issues, {
          code: 'invalid_mapping_rule',
          path: rulePath,
          rowIndex: index,
          field: 'mapping',
          message: 'Mapping rule must be an object.'
        })
        return
      }
      if (!String(rule.pdfField || '').trim()) {
        pushIssue(issues, {
          code: 'required_pdf_field',
          path: `${rulePath}/pdfField`,
          rowIndex: index,
          field: 'pdfField',
          message: 'pdfField is required.'
        })
      }
      if (!String(rule.sourcePath || '').trim()) {
        pushIssue(issues, {
          code: 'required_source_path',
          path: `${rulePath}/sourcePath`,
          rowIndex: index,
          field: 'sourcePath',
          message: 'sourcePath is required.'
        })
      }
      const pdfField = String(rule.pdfField || '').trim()
      if (pdfField) {
        if (usedTargets.has(pdfField)) {
          pushIssue(issues, {
            code: 'duplicate_pdf_field',
            path: `${rulePath}/pdfField`,
            rowIndex: index,
            field: 'pdfField',
            message: `Duplicate pdfField "${pdfField}" is not allowed.`
          })
        } else {
          usedTargets.set(pdfField, index)
        }
      }
      validateTransform(rule, issues, rulePath, index)

      const repeaterPath = String(rule.repeaterPath || '').trim()
      const sourcePath = normalizePath(rule.sourcePath)
      if (enforceKnownSourcePaths && allowedSourcePaths && sourcePath && !allowedSourcePaths.has(sourcePath)) {
        const sourceLeaf = sourcePath.split('.').pop() || sourcePath
        const sourceLeafNormalized = sourceLeaf.toLowerCase().replace(/[^a-z0-9]+/g, '')
        const candidateSuggestions = [...allowedSourcePaths.keys()]
          .map((candidatePath) => {
            const candidateLeaf = String(candidatePath || '').split('.').pop() || String(candidatePath || '')
            const normalizedCandidateLeaf = candidateLeaf.toLowerCase().replace(/[^a-z0-9]+/g, '')
            let score = 0
            if (sourceLeafNormalized && normalizedCandidateLeaf) {
              if (sourceLeafNormalized === normalizedCandidateLeaf) score = 1
              else if (sourceLeafNormalized.includes(normalizedCandidateLeaf) || normalizedCandidateLeaf.includes(sourceLeafNormalized)) score = 0.82
            }
            return {
              path: candidatePath,
              score
            }
          })
          .filter((entry) => entry.score >= 0.75)
          .sort((left, right) => right.score - left.score)
          .slice(0, 3)
        pushIssue(issues, {
          code: 'unknown_source_path',
          path: `${rulePath}/sourcePath`,
          rowIndex: index,
          field: 'sourcePath',
          message: `sourcePath "${String(rule.sourcePath)}" is not a known profile/form schema path.`,
          meta: {
            providedSourcePath: String(rule.sourcePath || ''),
            normalizedSourcePath: sourcePath,
            ...(candidateSuggestions.length ? { suggestedSourcePaths: candidateSuggestions } : {})
          }
        })
      }
      const expectedTargetType = String(rule.targetType || '').trim()
      const sourceMeta = sourcePath && allowedSourcePaths ? allowedSourcePaths.get(sourcePath) : null
      const sourceType = String(sourceMeta?.type || '').trim()
      if (expectedTargetType && sourceType && expectedTargetType !== sourceType) {
        pushIssue(issues, {
          code: 'target_type_mismatch',
          path: `${rulePath}/targetType`,
          rowIndex: index,
          field: 'targetType',
          message: `targetType "${expectedTargetType}" does not match source type "${sourceType}" for "${sourcePath}".`
        })
      }
      if (repeaterPath) {
        const normalizedRepeater = normalizePath(repeaterPath)
        if (!repeaterPaths.has(normalizedRepeater)) {
          pushIssue(issues, {
            code: 'unknown_repeater_path',
            path: `${rulePath}/repeaterPath`,
            rowIndex: index,
            field: 'repeaterPath',
            message: `repeaterPath "${repeaterPath}" does not match any repeater in the form definition.`
          })
        }
        if (sourcePath && sourcePath !== normalizedRepeater && !sourcePath.startsWith(`${normalizedRepeater}.`)) {
          pushIssue(issues, {
            code: 'source_path_outside_repeater',
            path: `${rulePath}/sourcePath`,
            rowIndex: index,
            field: 'sourcePath',
            message: 'sourcePath must be within repeaterPath when repeaterPath is provided.'
          })
        }
      }
      if (!repeaterPath && /\[(\*|\d+)\]/.test(String(rule.sourcePath || ''))) {
        pushIssue(issues, {
          code: 'required_repeater_path',
          path: `${rulePath}/repeaterPath`,
          rowIndex: index,
          field: 'repeaterPath',
          message: 'repeaterPath is required when sourcePath uses array/repeater selectors.'
        })
      }
    })
  }

  requiredPdfFields.forEach((requiredField) => {
    if (!usedTargets.has(requiredField)) {
      pushIssue(issues, {
        code: 'required_pdf_field_missing',
        path: contextPath,
        rowIndex: null,
        field: 'pdfField',
        message: `Required mapping for pdfField "${requiredField}" is missing.`,
        meta: { requiredPdfField: requiredField }
      })
    }
  })

  if (issues.length) {
    sortIssues(issues)
    throw validationError('Template mapping schema validation failed.', issues)
  }

  return mappings
}

import { runAuditedMutation } from '../audit/service.mjs'
import { createFirmContext } from '../shared/tenancy.mjs'

function normalizeIssueRowIndex(issue = {}) {
  if (Number.isInteger(issue?.rowIndex)) return issue.rowIndex
  const path = String(issue?.path || '')
  const match = path.match(/\/mappings\/(\d+)(?:\/|$)/)
  return match ? Number(match[1]) : null
}

function normalizeRepeaterPath(value) {
  return String(value || '')
    .trim()
    .replace(/\[(\*|\d+)\]/g, '')
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('.')
}

const TEMPLATE_VALIDATION_MESSAGES = {
  unknown_source_path: 'Mapping source path is not recognized by the profile/form schema.',
  required_pdf_field_missing: 'A required PDF field is not mapped.',
  required_pdf_field: 'PDF field is required.',
  required_source_path: 'Source path is required.',
  duplicate_pdf_field: 'PDF field is mapped more than once.',
  required_repeater_path: 'Repeater path is required for array selector source paths.',
  expression_operator_assignment: 'Expression appears to use assignment (=) instead of equality.',
  expression_operator_textual_logic: 'Expression uses textual logical operators; use && or ||.',
  expression_unbalanced_parentheses: 'Expression has unbalanced parentheses.',
  expression_incomplete_ternary: 'Expression ternary appears incomplete.'
}

function normalizePublishPreflightIssue(issue = {}, index = 0) {
  const code = String(issue?.code || 'schema_validation_issue')
  const path = String(issue?.path || '')
  const field = String(issue?.field || '')
  const rowIndex = normalizeIssueRowIndex(issue)
  const message = String(issue?.message || 'Validation issue')
  const sourceMeta = issue?.meta && typeof issue.meta === 'object' ? issue.meta : {}
  const repeaterPath = normalizeRepeaterPath(
    issue?.repeaterPath || sourceMeta.repeaterPath || sourceMeta.normalizedRepeaterPath
  )
  const issueId = sourceMeta.issueId || [code, rowIndex ?? 'global', field || path || index].join(':')
  const rowAnchor = rowIndex != null ? `#mapping-row-${rowIndex}` : ''
  const inspectorTarget = String(sourceMeta.inspectorTarget || field || sourceMeta.fieldKey || 'sourcePath')
  const rowId = String(issue?.rowId || sourceMeta.rowId || '').trim()
  const severity =
    String(issue?.severity || sourceMeta.severity || 'error').toLowerCase() === 'warning' ? 'warning' : 'error'
  const blocking = issue?.blocking === false || sourceMeta.blocking === false ? false : severity !== 'warning'
  return {
    code,
    errorCode: `TEMPLATE_VALIDATION_${code.toUpperCase()}`,
    path,
    field,
    rowIndex,
    issueId,
    rowAnchor,
    inspectorTarget,
    message,
    errorMessage: TEMPLATE_VALIDATION_MESSAGES[code] || message,
    severity,
    blocking,
    ...(Array.isArray(sourceMeta.suggestedSourcePaths) && sourceMeta.suggestedSourcePaths.length
      ? { suggestedSourcePaths: sourceMeta.suggestedSourcePaths }
      : {}),
    action: {
      field: inspectorTarget,
      suggestion: String(sourceMeta.suggestion || ''),
      ...(sourceMeta.operator ? { operator: sourceMeta.operator } : {})
    },
    ...(rowId ? { rowId } : {}),
    ...(repeaterPath ? { repeaterPath } : {}),
    meta: {
      ...sourceMeta,
      issueId,
      rowAnchor,
      inspectorTarget,
      ...(rowId ? { rowId } : {}),
      ...(repeaterPath ? { repeaterPath, normalizedRepeaterPath: repeaterPath } : {}),
      fieldPath: sourceMeta.fieldPath || path,
      fieldKey: sourceMeta.fieldKey || field || path || 'mapping'
    }
  }
}

function normalizePublishPreflightIssues(issues = []) {
  return Array.isArray(issues) ? issues.map((issue, index) => normalizePublishPreflightIssue(issue, index)) : []
}

function normalizeExtractionEnvelope(extraction = {}) {
  const reasonCode = String(extraction?.reasonCode || '').trim() || null
  const rawError = extraction?.error && typeof extraction.error === 'object' ? extraction.error : {}
  const normalizedError =
    extraction?.status === 'failed'
      ? {
          reasonCode,
          code: String(rawError.code || 'TEMPLATE_INGESTION_FAILED'),
          message: String(rawError.message || 'Template ingestion failed.')
        }
      : null
  const diagnostics = Array.isArray(extraction?.diagnostics)
    ? extraction.diagnostics.map((diagnostic = {}) => ({
        type: String(diagnostic.type || 'ingestion'),
        severity: String(diagnostic.severity || 'error'),
        reasonCode: String(diagnostic.reasonCode || reasonCode || ''),
        code: String(diagnostic.code || normalizedError?.code || 'TEMPLATE_INGESTION_FAILED'),
        message: String(diagnostic.message || normalizedError?.message || 'Template ingestion failed.'),
        details: diagnostic.details && typeof diagnostic.details === 'object' ? diagnostic.details : {}
      }))
    : normalizedError
      ? [
          {
            type: 'ingestion',
            severity: 'error',
            reasonCode: reasonCode || '',
            code: normalizedError.code,
            message: normalizedError.message,
            details: {}
          }
        ]
      : []
  return {
    status: extraction?.status === 'failed' ? 'failed' : 'completed',
    reasonCode,
    error: normalizedError,
    diagnostics,
    fields: Array.isArray(extraction?.fields) ? extraction.fields : []
  }
}

function classifyPreflightCategory(issue = {}) {
  const code = String(issue.code || '').toLowerCase()
  if (
    code.includes('required_pdf_field') ||
    code.includes('required_source_path') ||
    code.includes('required_repeater_path') ||
    code.includes('unresolved_source_path') ||
    code.includes('unknown_source_path')
  ) {
    return 'missingMappings'
  }
  if (code.includes('transform') || code.startsWith('expression_')) return 'invalidTransforms'
  if (code.includes('unpublished_dependenc')) return 'unpublishedDependencies'
  return null
}

function buildPublishReadiness(issues = []) {
  const blockers = issues.filter((issue) => issue.blocking !== false)
  const warnings = issues.filter((issue) => issue.blocking === false || issue.severity === 'warning')
  const categories = {
    missingMappings: [],
    invalidTransforms: [],
    unpublishedDependencies: []
  }
  issues.forEach((issue) => {
    const category = classifyPreflightCategory(issue)
    if (category) categories[category].push(issue)
  })
  const quickLinks = issues
    .map((issue) => {
      const rowIndex = Number(issue?.rowIndex)
      if (!Number.isFinite(rowIndex)) return null
      const rowId = String(issue?.rowId || issue?.meta?.rowId || '').trim()
      return {
        rowIndex,
        ...(rowId ? { rowId } : {}),
        field: String(issue?.inspectorTarget || issue?.field || issue?.meta?.fieldKey || 'sourcePath'),
        anchor: String(issue?.rowAnchor || `#mapping-row-${rowIndex}`),
        label: `Row ${rowIndex + 1}`
      }
    })
    .filter(Boolean)

  return {
    blockers,
    warnings,
    categories,
    quickLinks,
    summary: {
      status: blockers.length ? 'blocked' : warnings.length ? 'warning' : 'ready',
      blockersCount: blockers.length,
      warningsCount: warnings.length,
      missingMappingsCount: categories.missingMappings.length,
      invalidTransformsCount: categories.invalidTransforms.length,
      unpublishedDependenciesCount: categories.unpublishedDependencies.length
    }
  }
}

export function createTemplatesService({ templateRepository, policy, store = null, templatesCompatibility = null }) {
  const runMutation = (fn) => (store ? runAuditedMutation(store, fn) : fn())

  return {
    list(user) {
      if (templatesCompatibility?.listDocuments) {
        return templatesCompatibility.listDocuments(user)
      }
      policy.requireGuard(user, 'canReadTemplate')
      return templateRepository.listDocumentTemplates(createFirmContext(user))
    },
    create(user, input) {
      if (templatesCompatibility?.createDocument) {
        return templatesCompatibility.createDocument(user, input)
      }
      policy.requireGuard(user, 'canEditTemplate')
      return runMutation(() => templateRepository.createDocumentTemplate(user, input))
    },
    async autoBuild(user, input) {
      policy.requireGuard(user, 'canEditTemplate')
      const template = await runMutation(() => templateRepository.autoBuildTemplate(user, input))
      return {
        ...template,
        extraction: normalizeExtractionEnvelope(template?.extraction || {})
      }
    },
    // Presign a scratch object for the source PDF so the browser can stream it via
    // the raw upload endpoint instead of inlining it in the auto-build JSON body.
    autoBuildPresign(user, input) {
      policy.requireGuard(user, 'canEditTemplate')
      return store.createTemplateSourceUploadPresign(user, input)
    },
    publish(user, templateId, input) {
      policy.requireGuard(user, 'canPublishTemplate')
      try {
        return templateRepository.publishTemplate(user, templateId, input)
      } catch (error) {
        if (Array.isArray(error?.details?.issues)) {
          const issues = normalizePublishPreflightIssues(error.details.issues)
          error.details = {
            ...error.details,
            issues,
            publishReadiness: buildPublishReadiness(issues)
          }
        }
        throw error
      }
    },
    updateMappings(user, templateId, mappings, input = {}) {
      policy.requireGuard(user, 'canEditTemplate')
      return templateRepository.updateTemplateMappings(user, templateId, mappings, input)
    },
    getSourcePdf(user, templateId) {
      policy.requireGuard(user, 'canReadTemplate')
      return templateRepository.getTemplateSourcePdf(user, templateId)
    },
    previewTestFill(user, templateId, input = {}) {
      policy.requireGuard(user, 'canEditTemplate')
      return templateRepository.previewTemplateTestFill(user, templateId, input)
    },
    updatePdfLayout(user, templateId, input = {}) {
      policy.requireGuard(user, 'canEditTemplate')
      return runMutation(() => templateRepository.updateTemplatePdfLayout(user, templateId, input))
    },
    previewMappings(user, templateId, input = {}) {
      policy.requireGuard(user, 'canReadTemplate')
      const preview = templateRepository.previewTemplateMappings(user, templateId, input)
      const issues = Array.isArray(preview?.issues) ? normalizePublishPreflightIssues(preview.issues) : []
      return {
        ...preview,
        ...(Array.isArray(preview?.issues) ? { issues } : {}),
        publishReadiness: buildPublishReadiness(issues)
      }
    },
    listVersions(user, templateId) {
      policy.requireGuard(user, 'canReadTemplate')
      return templateRepository.listTemplateVersions(user, templateId)
    },
    listPublishTransitions(user, templateId) {
      policy.requireGuard(user, 'canReadTemplate')
      return templateRepository.listPublishTransitions(user, templateId)
    },
    compareVersions(user, templateId, baseVersion, targetVersion) {
      policy.requireGuard(user, 'canReadTemplate')
      return templateRepository.compareTemplateVersions(user, templateId, baseVersion, targetVersion)
    },
    revertVersion(user, templateId, targetVersion, input) {
      policy.requireGuard(user, 'canEditTemplate')
      return templateRepository.revertTemplateVersion(user, templateId, targetVersion, input)
    }
  }
}

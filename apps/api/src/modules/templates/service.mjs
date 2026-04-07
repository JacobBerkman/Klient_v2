import { runAuditedMutation } from '../audit/service.mjs'
import { createFirmContext } from '../shared/tenancy.mjs'

function normalizeIssueRowIndex(issue = {}) {
  if (Number.isInteger(issue?.rowIndex)) return issue.rowIndex
  const path = String(issue?.path || '')
  const match = path.match(/\/mappings\/(\d+)(?:\/|$)/)
  return match ? Number(match[1]) : null
}

const TEMPLATE_VALIDATION_MESSAGES = {
  unknown_source_path: 'Mapping source path is not recognized by the profile/form schema.',
  required_pdf_field_missing: 'A required PDF field is not mapped.',
  required_pdf_field: 'PDF field is required.',
  required_source_path: 'Source path is required.',
  duplicate_pdf_field: 'PDF field is mapped more than once.',
  required_repeater_path: 'Repeater path is required for array selector source paths.'
}

function normalizePublishPreflightIssue(issue = {}, index = 0) {
  const code = String(issue?.code || 'schema_validation_issue')
  const path = String(issue?.path || '')
  const field = String(issue?.field || '')
  const rowIndex = normalizeIssueRowIndex(issue)
  const message = String(issue?.message || 'Validation issue')
  const sourceMeta = issue?.meta && typeof issue.meta === 'object' ? issue.meta : {}
  const issueId = sourceMeta.issueId || [code, rowIndex ?? 'global', field || path || index].join(':')
  return {
    code,
    errorCode: `TEMPLATE_VALIDATION_${code.toUpperCase()}`,
    path,
    field,
    rowIndex,
    message,
    errorMessage: TEMPLATE_VALIDATION_MESSAGES[code] || message,
    severity: 'error',
    blocking: true,
    meta: {
      ...sourceMeta,
      issueId,
      fieldPath: sourceMeta.fieldPath || path,
      fieldKey: sourceMeta.fieldKey || field || path || 'mapping'
    }
  }
}

function normalizePublishPreflightIssues(issues = []) {
  return Array.isArray(issues) ? issues.map((issue, index) => normalizePublishPreflightIssue(issue, index)) : []
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
    autoBuild(user, input) {
      policy.requireGuard(user, 'canEditTemplate')
      return runMutation(() => templateRepository.autoBuildTemplate(user, input))
    },
    publish(user, templateId, input) {
      policy.requireGuard(user, 'canPublishTemplate')
      try {
        return templateRepository.publishTemplate(user, templateId, input)
      } catch (error) {
        if (Array.isArray(error?.details?.issues)) {
          error.details = {
            ...error.details,
            issues: normalizePublishPreflightIssues(error.details.issues)
          }
        }
        throw error
      }
    },
    updateMappings(user, templateId, mappings, input = {}) {
      policy.requireGuard(user, 'canEditTemplate')
      return templateRepository.updateTemplateMappings(user, templateId, mappings, input)
    },
    previewMappings(user, templateId, input = {}) {
      policy.requireGuard(user, 'canReadTemplate')
      const preview = templateRepository.previewTemplateMappings(user, templateId, input)
      if (!Array.isArray(preview?.issues)) return preview
      return {
        ...preview,
        issues: normalizePublishPreflightIssues(preview.issues)
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

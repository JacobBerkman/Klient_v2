import { runAuditedMutation } from '../audit/service.mjs'

export function createTemplatesService({ templateRepository, policy, store = null }) {
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
      return templateRepository.publishTemplate(user, templateId, input)
    },
    updateMappings(user, templateId, mappings, input = {}) {
      policy.requireGuard(user, 'canEditTemplate')
      return templateRepository.updateTemplateMappings(user, templateId, mappings, input)
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

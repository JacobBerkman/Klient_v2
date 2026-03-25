export function createTemplatesService({ templateRepository, policy }) {
  return {
    list(user) {
      policy.requireGuard(user, 'canReadTemplate')
      return templateRepository.listDocumentTemplates(user)
    },
    create(user, input) {
      policy.requireGuard(user, 'canEditTemplate')
      return templateRepository.createDocumentTemplate(user, input)
    },
    autoBuild(user, input) {
      policy.requireGuard(user, 'canEditTemplate')
      return templateRepository.autoBuildTemplate(user, input)
    },
    publish(user, templateId) {
      policy.requireGuard(user, 'canPublishTemplate')
      return templateRepository.publishTemplate(user, templateId)
    },
    updateMappings(user, templateId, mappings) {
      policy.requireGuard(user, 'canEditTemplate')
      return templateRepository.updateTemplateMappings(user, templateId, mappings)
    }
  }
}

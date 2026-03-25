export function createTemplatesService({ templateRepository, policy, templatesCompatibility = null }) {
  return {
    list(user) {
      if (templatesCompatibility?.listDocuments) {
        return templatesCompatibility.listDocuments(user)
      }
      policy.requireGuard(user, 'canReadTemplate')
      return templateRepository.listDocumentTemplates(user)
    },
    create(user, input) {
      if (templatesCompatibility?.createDocument) {
        return templatesCompatibility.createDocument(user, input)
      }
      policy.requireGuard(user, 'canEditTemplate')
      return templateRepository.createDocumentTemplate(user, input)
    },
    autoBuild(user, input) {
      policy.requireGuard(user, 'canEditTemplate')
      return templateRepository.autoBuildTemplate(user, input)
    },
    publish(user, templateId) {
      if (templatesCompatibility?.publishDocument) {
        return templatesCompatibility.publishDocument(user, templateId)
      }
      policy.requireGuard(user, 'canPublishTemplate')
      return templateRepository.publishTemplate(user, templateId)
    },
    updateMappings(user, templateId, mappings) {
      if (templatesCompatibility?.updateDocumentMappings) {
        return templatesCompatibility.updateDocumentMappings(user, templateId, mappings)
      }
      policy.requireGuard(user, 'canEditTemplate')
      return templateRepository.updateTemplateMappings(user, templateId, mappings)
    }
  }
}

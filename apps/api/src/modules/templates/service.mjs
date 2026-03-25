import { createFirmContext } from '../shared/tenancy.mjs'

export function createTemplatesService({ templateRepository, policy }) {
  return {
    list(user) {
      policy.requireGuard(user, 'canReadTemplate')
      return templateRepository.listDocumentTemplates(createFirmContext(user))
    },
    create(user, input) {
      policy.requireGuard(user, 'canEditTemplate')
      return templateRepository.createDocumentTemplate(createFirmContext(user), input)
    },
    autoBuild(user, input) {
      policy.requireGuard(user, 'canEditTemplate')
      return templateRepository.autoBuildTemplate(createFirmContext(user), input)
    },
    publish(user, templateId) {
      policy.requireGuard(user, 'canPublishTemplate')
      return templateRepository.publishTemplate(createFirmContext(user), templateId)
    },
    updateMappings(user, templateId, mappings) {
      policy.requireGuard(user, 'canEditTemplate')
      return templateRepository.updateTemplateMappings(createFirmContext(user), templateId, mappings)
    }
  }
}

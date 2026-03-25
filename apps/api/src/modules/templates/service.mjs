import { runAuditedMutation } from '../audit/service.mjs'

export function createTemplatesService({ templateRepository, policy, store = null }) {
  const runMutation = (fn) => (store ? runAuditedMutation(store, fn) : fn())

  return {
    list(user) {
      policy.requireGuard(user, 'canReadTemplate')
      return templateRepository.listDocumentTemplates(user)
    },
    create(user, input) {
      policy.requireGuard(user, 'canEditTemplate')
      return runMutation(() => templateRepository.createDocumentTemplate(user, input))
    },
    autoBuild(user, input) {
      policy.requireGuard(user, 'canEditTemplate')
      return runMutation(() => templateRepository.autoBuildTemplate(user, input))
    },
    publish(user, templateId) {
      policy.requireGuard(user, 'canPublishTemplate')
      return runMutation(() => templateRepository.publishTemplate(user, templateId))
    },
    updateMappings(user, templateId, mappings) {
      policy.requireGuard(user, 'canEditTemplate')
      return runMutation(() => templateRepository.updateTemplateMappings(user, templateId, mappings))
    }
  }
}

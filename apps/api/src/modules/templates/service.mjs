export function createTemplatesService({ templateRepository }) {
  return {
    list(user) { return templateRepository.listDocumentTemplates(user); },
    create(user, input) { return templateRepository.createDocumentTemplate(user, input); },
    autoBuild(user, input) { return templateRepository.autoBuildTemplate(user, input); },
    publish(user, templateId) { return templateRepository.publishTemplate(user, templateId); },
    updateMappings(user, templateId, mappings) { return templateRepository.updateTemplateMappings(user, templateId, mappings); }
  };
}

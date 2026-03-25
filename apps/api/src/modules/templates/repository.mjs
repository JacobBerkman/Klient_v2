export class TemplateRepository {
  listDocumentTemplates(_firmContext) {
    throw new Error('TemplateRepository.listDocumentTemplates not implemented')
  }
  createDocumentTemplate(_firmContext, _input) {
    throw new Error('TemplateRepository.createDocumentTemplate not implemented')
  }
  updateTemplateMappings(_firmContext, _templateId, _mappings) {
    throw new Error('TemplateRepository.updateTemplateMappings not implemented')
  }
  publishTemplate(_firmContext, _templateId) {
    throw new Error('TemplateRepository.publishTemplate not implemented')
  }
  compareTemplateVersions() {
    throw new Error('TemplateRepository.compareTemplateVersions not implemented')
  }
  revertTemplateVersion() {
    throw new Error('TemplateRepository.revertTemplateVersion not implemented')
  }
  listTemplateVersions() {
    throw new Error('TemplateRepository.listTemplateVersions not implemented')
  }
  listPublishTransitions() {
    throw new Error('TemplateRepository.listPublishTransitions not implemented')
  }
  autoBuildTemplate() {
    throw new Error('TemplateRepository.autoBuildTemplate not implemented')
  }
}

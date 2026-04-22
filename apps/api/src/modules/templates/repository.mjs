import { throwRepositoryScaffoldError } from '../shared/repository-scaffold.mjs'

export class TemplateRepository {
  listDocumentTemplates(_firmContext) {
    throwRepositoryScaffoldError('TemplateRepository', 'listDocumentTemplates')
  }
  createDocumentTemplate(_firmContext, _input) {
    throwRepositoryScaffoldError('TemplateRepository', 'createDocumentTemplate')
  }
  updateTemplateMappings(_firmContext, _templateId, _mappings) {
    throwRepositoryScaffoldError('TemplateRepository', 'updateTemplateMappings')
  }
  publishTemplate(_firmContext, _templateId) {
    throwRepositoryScaffoldError('TemplateRepository', 'publishTemplate')
  }
  previewTemplateMappings(_firmContext, _templateId, _input) {
    throwRepositoryScaffoldError('TemplateRepository', 'previewTemplateMappings')
  }
  previewTemplateTestFill(_firmContext, _templateId, _input) {
    throwRepositoryScaffoldError('TemplateRepository', 'previewTemplateTestFill')
  }
  compareTemplateVersions() {
    throwRepositoryScaffoldError('TemplateRepository', 'compareTemplateVersions')
  }
  revertTemplateVersion() {
    throwRepositoryScaffoldError('TemplateRepository', 'revertTemplateVersion')
  }
  listTemplateVersions() {
    throwRepositoryScaffoldError('TemplateRepository', 'listTemplateVersions')
  }
  listPublishTransitions() {
    throwRepositoryScaffoldError('TemplateRepository', 'listPublishTransitions')
  }
  autoBuildTemplate() {
    throwRepositoryScaffoldError('TemplateRepository', 'autoBuildTemplate')
  }
}

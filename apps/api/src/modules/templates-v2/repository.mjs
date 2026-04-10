import { throwRepositoryScaffoldError } from '../shared/repository-scaffold.mjs'

export class TemplatesV2Repository {
  listCanonicalTemplates(_user, _filters = {}) {
    throwRepositoryScaffoldError('TemplatesV2Repository', 'listCanonicalTemplates')
  }
  createCanonicalTemplate(_user, _input) {
    throwRepositoryScaffoldError('TemplatesV2Repository', 'createCanonicalTemplate')
  }
  updateCanonicalTemplate(_user, _templateId, _patch) {
    throwRepositoryScaffoldError('TemplatesV2Repository', 'updateCanonicalTemplate')
  }
  transitionLifecycle(_user, _templateId, _nextState) {
    throwRepositoryScaffoldError('TemplatesV2Repository', 'transitionLifecycle')
  }
}

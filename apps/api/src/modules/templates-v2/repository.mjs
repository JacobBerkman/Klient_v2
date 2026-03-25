export class TemplatesV2Repository {
  listCanonicalTemplates(_user, _filters = {}) {
    throw new Error('TemplatesV2Repository.listCanonicalTemplates not implemented')
  }
  createCanonicalTemplate(_user, _input) {
    throw new Error('TemplatesV2Repository.createCanonicalTemplate not implemented')
  }
  updateCanonicalTemplate(_user, _templateId, _patch) {
    throw new Error('TemplatesV2Repository.updateCanonicalTemplate not implemented')
  }
  transitionLifecycle(_user, _templateId, _nextState) {
    throw new Error('TemplatesV2Repository.transitionLifecycle not implemented')
  }
}

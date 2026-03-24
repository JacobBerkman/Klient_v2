export function createExportsService({ store }) {
  return {
    list(user) { return store.listExports(user); },
    create(user, input) { return store.createExport(user, input); },
    processQueuedExports() { return store.processQueuedExports(); },
    retry(user, exportId) { return store.retryExport(user, exportId); }
  };
}

export function createExportsService({ exportsRepository }) {
  return {
    list(user) { return exportsRepository.list(user); },
    create(user, input) { return exportsRepository.create(user, input); },
    processQueuedExports() { return exportsRepository.processQueued(); },
    retry(user, exportId) { return exportsRepository.retry(user, exportId); }
  };
}

export const EXPORT_JOB_LIFECYCLE_STATES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  RETRYING: 'retrying',
  COMPLETED: 'completed',
  FAILED: 'failed',
  DEAD_LETTER: 'dead-letter'
})

export class ExportsRepository {
  static lifecycleStates = EXPORT_JOB_LIFECYCLE_STATES

  list(_firmContext) {
    throw new Error('Not implemented')
  }
  create(_firmContext, _input) {
    throw new Error('Not implemented')
  }
  processQueued() {
    throw new Error('Not implemented')
  }
  retry(_firmContext, _exportId) {
    throw new Error('Not implemented')
  }
  getQueueHealth(_firmContext) {
    throw new Error('Not implemented')
  }
  retryFailed(_firmContext, _options) {
    throw new Error('Not implemented')
  }
}

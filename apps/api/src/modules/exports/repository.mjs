export const EXPORT_JOB_LIFECYCLE_STATES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  RETRYING: 'retrying',
  COMPLETED: 'completed',
  FAILED: 'failed',
  DEAD_LETTER: 'dead-letter'
})

export const EXPORT_JOB_TERMINAL_STATES = Object.freeze([
  EXPORT_JOB_LIFECYCLE_STATES.COMPLETED,
  EXPORT_JOB_LIFECYCLE_STATES.FAILED,
  EXPORT_JOB_LIFECYCLE_STATES.DEAD_LETTER
])

export const EXPORT_JOB_ACTIVE_STATES = Object.freeze([
  EXPORT_JOB_LIFECYCLE_STATES.QUEUED,
  EXPORT_JOB_LIFECYCLE_STATES.RUNNING,
  EXPORT_JOB_LIFECYCLE_STATES.RETRYING
])

export class ExportsRepository {
  static lifecycleStates = EXPORT_JOB_LIFECYCLE_STATES

  list(_firmContext, _options = {}) {
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
  getDownload(_firmContext, _exportId) {
    throw new Error('Not implemented')
  }
}

import test from 'node:test'
import assert from 'node:assert/strict'

import { createExportsService } from '../modules/exports/service.mjs'

function createHarness(repositoryOverrides = {}) {
  const store = { state: { auditEvents: [] } }
  const policy = {
    requireGuard() {
      return true
    }
  }
  const exportsRepository = {
    list() {
      return []
    },
    retry() {
      return null
    },
    ...repositoryOverrides
  }

  const service = createExportsService({ exportsRepository, policy, store })
  const user = { id: 'advisor-1', firmId: 'firm-1', role: 'advisor' }
  return { service, user, store }
}

test('completed jobs expose artifactReady/artifactAvailable together when artifact pointers exist', () => {
  const { service, user } = createHarness({
    list() {
      return [
        {
          id: 'exp-1',
          status: 'completed',
          output: { object: { key: 'firm-1/exports/exp-1.pdf' }, artifact: { mappingVersionHash: 'mvh-1' } }
        },
        { id: 'exp-2', status: 'completed', artifact: { key: 'firm-1/exports/exp-2.pdf' }, artifactAvailable: true }
      ]
    }
  })

  const jobs = service.list(user)

  assert.equal(jobs[0].artifactReady, true)
  assert.equal(jobs[0].artifactAvailable, true)
  assert.equal(jobs[1].artifactReady, true)
  assert.equal(jobs[1].artifactAvailable, true)
})

test('non-completed jobs never report artifactReady/artifactAvailable even if stale artifact pointers are present', () => {
  const { service, user } = createHarness({
    list() {
      return [
        { id: 'exp-retrying', status: 'retrying', output: { object: { key: 'firm-1/exports/retrying.pdf' } } },
        { id: 'exp-failed', status: 'failed', artifactAvailable: true },
        { id: 'exp-dead-letter', status: 'dead-letter', artifactReady: true }
      ]
    }
  })

  const jobs = service.list(user)

  for (const job of jobs) {
    assert.equal(job.artifactReady, false)
    assert.equal(job.artifactAvailable, false)
  }
})

test('retry response normalizes artifact semantics consistently', () => {
  const { service, user, store } = createHarness({
    retry() {
      store.state.auditEvents.push({ id: 'audit-1' })
      return {
        id: 'exp-3',
        status: 'retrying',
        output: { object: { key: 'firm-1/exports/exp-3.pdf' } },
        retryEligible: true
      }
    }
  })

  const retried = service.retry(user, 'exp-3')

  assert.equal(retried.status, 'retrying')
  assert.equal(retried.artifactReady, false)
  assert.equal(retried.artifactAvailable, false)
  assert.equal(retried.retryState.eligible, true)
})

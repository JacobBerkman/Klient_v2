import test from 'node:test'
import assert from 'node:assert/strict'

import { createExportsService } from '../modules/exports/service.mjs'

test('exports getDownload requires canReadExports and uses tenant-scoped firm context', async () => {
  const calls = []
  const repositoryCalls = []
  const policy = {
    requireGuard(user, guard) {
      calls.push(`policy:${user.id}:${guard}`)
    }
  }
  const exportsRepository = {
    getDownload(firmContext, exportId) {
      repositoryCalls.push({ firmContext, exportId })
      return { fileName: `${exportId}.pdf`, contentType: 'application/pdf', sizeBytes: 3, body: Buffer.from('pdf') }
    }
  }
  const store = { state: { auditEvents: [] } }
  const service = createExportsService({ exportsRepository, policy, store })
  const user = { id: 'u-export-1', firmId: 'firm-tenant-1', role: 'advisor' }

  const artifact = await service.getDownload(user, 'exp-123')
  assert.equal(artifact.fileName, 'exp-123.pdf')
  assert.deepEqual(calls, ['policy:u-export-1:canReadExports'])
  assert.equal(repositoryCalls.length, 1)
  assert.equal(repositoryCalls[0].exportId, 'exp-123')
  assert.equal(repositoryCalls[0].firmContext.firmId, 'firm-tenant-1')
  assert.equal(repositoryCalls[0].firmContext.userId, 'u-export-1')
  assert.equal(repositoryCalls[0].firmContext.role, 'advisor')
})

test('exports getDownload denies role without guard and never reaches repository', async () => {
  const policy = {
    requireGuard(_user, guard) {
      const error = new Error(`Missing permission: ${guard}`)
      error.statusCode = 403
      throw error
    }
  }
  let repoCalled = false
  const exportsRepository = {
    getDownload() {
      repoCalled = true
      return {}
    }
  }
  const service = createExportsService({ exportsRepository, policy, store: { state: { auditEvents: [] } } })

  await assert.rejects(
    () => service.getDownload({ id: 'u-readonly', firmId: 'firm-tenant-1', role: 'readonly' }, 'exp-locked'),
    /Missing permission: canReadExports/
  )
  assert.equal(repoCalled, false)
})

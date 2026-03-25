import test from 'node:test'
import assert from 'node:assert/strict'

import { createPipelineStagesService } from '../modules/pipeline-stages/service.mjs'

test('pipeline stages service enforces read guard and firm context on list', () => {
  const calls = []
  const service = createPipelineStagesService({
    policy: {
      requireGuard: (user, guard) => calls.push(`guard:${user.id}:${guard}`)
    },
    pipelineStagesRepository: {
      listStages: (firmContext) => {
        calls.push(`repo:${firmContext.firmId}`)
        return { stages: [] }
      }
    }
  })

  const result = service.listStages({ id: 'u1', firmId: 'f1', role: 'admin' })
  assert.deepEqual(result, { stages: [] })
  assert.deepEqual(calls, ['guard:u1:canReadPipeline', 'repo:f1'])
})

test('pipeline stages service enforces write guard for mutations', () => {
  const calls = []
  const service = createPipelineStagesService({
    policy: {
      requireGuard: (user, guard) => calls.push(`guard:${user.id}:${guard}`)
    },
    pipelineStagesRepository: {
      createStage: (firmContext, payload) => ({ ...payload, firmId: firmContext.firmId }),
      updateStageMetadata: (firmContext, stageId, patch) => ({ id: stageId, ...patch, firmId: firmContext.firmId }),
      deactivateStage: (firmContext, stageId) => ({ id: stageId, deactivated: true, firmId: firmContext.firmId }),
      reorderStages: (firmContext, input) => ({ ...input, firmId: firmContext.firmId })
    }
  })

  const user = { id: 'u1', firmId: 'f1', role: 'admin' }
  assert.equal(service.createStage(user, { key: 'new_stage' }).firmId, 'f1')
  assert.equal(service.updateStageMetadata(user, 's1', { label: 'Stage' }).firmId, 'f1')
  assert.equal(service.deactivateStage(user, 's1').firmId, 'f1')
  assert.equal(service.reorderStages(user, { stageIds: ['s1'] }).firmId, 'f1')
  assert.deepEqual(calls, [
    'guard:u1:canMovePipeline',
    'guard:u1:canMovePipeline',
    'guard:u1:canMovePipeline',
    'guard:u1:canMovePipeline'
  ])
})

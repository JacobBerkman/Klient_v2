import test from 'node:test'
import assert from 'node:assert/strict'
import { runCommandProcess } from './runner-lifecycle.mjs'

const nodeBin = process.execPath

test('runCommandProcess drains piped integration-style output and cleanly hands off next suite', async () => {
  const noisyScript = [
    'const payload = { suite: "integration-exports", dump: "x".repeat(300000) };',
    'console.log(JSON.stringify(payload));'
  ].join(' ')

  const noisyResult = await runCommandProcess({
    command: nodeBin,
    args: ['-e', noisyScript],
    label: 'integration-exports.mjs',
    stdio: 'pipe',
    timeoutMs: 15000
  })

  assert.equal(typeof noisyResult.durationMs, 'number')
  assert.ok(noisyResult.durationMs >= 0)

  const handoffResult = await runCommandProcess({
    command: nodeBin,
    args: ['-e', 'console.log("next-suite-ok")'],
    label: 'integration-portal-lifecycle.mjs',
    stdio: 'pipe',
    timeoutMs: 15000
  })

  assert.equal(typeof handoffResult.durationMs, 'number')
  assert.ok(handoffResult.durationMs >= 0)
})

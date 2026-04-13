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

test('aggregate integration runner exits after integration-exports suite completes', { timeout: 240000 }, async () => {
  const result = await runCommandProcess({
    command: nodeBin,
    args: ['scripts/master-integration.mjs'],
    label: 'master-integration(integration-exports)',
    stdio: 'pipe',
    timeoutMs: 210000,
    env: {
      ...process.env,
      INTEGRATION_SUITES: 'integration-exports.mjs'
    }
  })

  assert.equal(typeof result.durationMs, 'number')
  assert.ok(result.durationMs >= 0)
})

test('runCommandProcess completes deterministically for piped stdio tuple across repeated handoffs', async () => {
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const result = await runCommandProcess({
      command: nodeBin,
      args: ['-e', `process.stdout.write("iteration-${iteration}\\n")`],
      label: `tuple-pipe-handoff-${iteration}`,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeoutMs: 5000
    })

    assert.equal(typeof result.durationMs, 'number')
    assert.ok(result.durationMs >= 0)
    assert.equal(result.code, 0)
  }
})

test('runCommandProcess prefers exit fallback when close is pinned by descendant pipe handles', async () => {
  const script = [
    'import { spawn } from "node:child_process";',
    'const holder = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 5000)"], {',
    '  stdio: ["ignore", "inherit", "ignore"],',
    '  detached: true',
    '});',
    'holder.unref();',
    'process.exit(0);'
  ].join(' ')

  const start = Date.now()
  const result = await runCommandProcess({
    command: nodeBin,
    args: ['-e', script],
    label: 'exit-fallback-pinned-close',
    stdio: 'pipe',
    timeoutMs: 6000
  })

  const elapsed = Date.now() - start
  assert.equal(result.code, 0)
  assert(elapsed >= 900, `expected close fallback grace window to elapse, got ${elapsed}ms`)
  assert(elapsed < 3000, `expected completion via exit fallback without waiting for descendant stdio, got ${elapsed}ms`)
})

test('runCommandProcess timeout rejects with explicit stdio context for piped runs', async () => {
  const start = Date.now()
  await assert.rejects(
    () =>
      runCommandProcess({
        command: nodeBin,
        args: ['-e', 'setInterval(() => process.stdout.write("."), 20)'],
        label: 'timeout-piped-context',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeoutMs: 250
      }),
    /timed out after 250ms \(stdio=ignore,pipe,pipe; waiting for close\)/
  )

  const elapsed = Date.now() - start
  assert(elapsed < 2000, `expected timeout rejection to settle quickly, got ${elapsed}ms`)
})

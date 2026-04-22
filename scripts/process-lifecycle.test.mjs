import test from 'node:test'
import assert from 'node:assert/strict'
import {
  describeProcessFailure,
  normalizeChildEnv,
  releaseChildStdio,
  startManagedProcess,
  terminateManagedProcess,
  waitForManagedExit
} from './process-lifecycle.mjs'

test('normalizeChildEnv preserves platform-specific environment semantics', () => {
  const input = { PATH: 'upper', Path: 'preferred', path: 'lower', FOO: 'bar' }
  if (process.platform === 'win32') {
    const normalized = normalizeChildEnv(input)
    assert.equal(normalized.Path, 'preferred')
    assert.equal(normalized.FOO, 'bar')
    assert.equal(Object.keys(normalized).filter((key) => key.toLowerCase() === 'path').length, 1)
  } else {
    assert.equal(normalizeChildEnv(input), input)
  }
})

test('managed process captures stdio tails for timeout diagnostics', async () => {
  const managed = startManagedProcess({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("lifecycle stdout"); process.stderr.write("lifecycle stderr")'],
    label: 'stdio-tail-test',
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const result = await waitForManagedExit(managed, 5000)
  releaseChildStdio(managed)

  assert.equal(result.exited, true)
  assert.match(managed.stdoutTail, /lifecycle stdout/)
  assert.match(managed.stderrTail, /lifecycle stderr/)
  assert.match(describeProcessFailure(managed, 'diagnostic'), /stdio-tail-test/)
})

test('terminateManagedProcess stops non-detached children deterministically', async () => {
  const managed = startManagedProcess({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    label: 'non-detached-terminates',
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const result = await terminateManagedProcess(managed, { graceMs: 500, killMs: 1000 })
  releaseChildStdio(managed)

  assert.equal(result.exited, true)
})

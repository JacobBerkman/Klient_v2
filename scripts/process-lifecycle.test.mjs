import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  describeProcessFailure,
  normalizeChildEnv,
  releaseChildStdio,
  startManagedProcess,
  terminateManagedProcess,
  waitForManagedExit
} from './process-lifecycle.mjs'

function createStream() {
  const stream = new EventEmitter()
  stream.destroyed = false
  stream.resume = () => {}
  stream.destroy = () => {
    stream.destroyed = true
  }
  return stream
}

function createChild({ pid = 4242, withStreams = true } = {}) {
  const child = new EventEmitter()
  child.pid = pid
  child.exitCode = null
  child.signalCode = null
  child.stdout = withStreams ? createStream() : null
  child.stderr = withStreams ? createStream() : null
  child.kill = () => {
    child.exitCode = 0
    queueMicrotask(() => {
      child.emit('exit', 0, null)
      child.emit('close', 0, null)
    })
    return true
  }
  return child
}

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

test('startManagedProcess captures stdout and stderr tails without real child spawning', () => {
  const child = createChild()
  const managed = startManagedProcess({
    command: process.execPath,
    args: ['-e', 'console.log("ignored")'],
    label: 'fake-managed-process',
    stdio: ['ignore', 'pipe', 'pipe'],
    spawnImpl() {
      return child
    }
  })

  child.stdout.emit('data', Buffer.from('lifecycle stdout'))
  child.stderr.emit('data', Buffer.from('lifecycle stderr'))

  assert.match(managed.stdoutTail, /lifecycle stdout/)
  assert.match(managed.stderrTail, /lifecycle stderr/)
  assert.match(describeProcessFailure(managed, 'diagnostic'), /fake-managed-process/)

  releaseChildStdio(managed)
  assert.equal(child.stdout.destroyed, true)
  assert.equal(child.stderr.destroyed, true)
})

test('waitForManagedExit resolves on synthetic exit and close events', async () => {
  const child = createChild({ withStreams: false })
  const waitPromise = waitForManagedExit({ child }, 1000)
  queueMicrotask(() => {
    child.exitCode = 23
    child.emit('exit', 23, null)
    child.emit('close', 23, null)
  })

  const result = await waitPromise
  assert.equal(result.exited, true)
  assert.equal(result.code, 23)
})

test('terminateManagedProcess stops non-detached children deterministically without spawning', async () => {
  const child = createChild({ withStreams: false })
  const managed = { child, label: 'non-detached-terminates', detached: false, startedAt: Date.now() }
  const result = await terminateManagedProcess(managed, { graceMs: 500, killMs: 1000 })

  assert.equal(result.exited, true)
  assert.equal(child.exitCode, 0)
})

test('terminateManagedProcess force-kills the Windows process tree after graceful exit when requested', async () => {
  if (process.platform !== 'win32') return

  const child = createChild({ pid: 5512, withStreams: false })
  let forceKilledPid = null
  const managed = {
    child,
    label: 'windows-tree-kill',
    detached: false,
    startedAt: Date.now(),
    forceTreeKillOnWindows: true
  }

  const result = await terminateManagedProcess(managed, {
    graceMs: 500,
    killMs: 1000,
    forceKillTreeImpl: async (pid) => {
      forceKilledPid = pid
    }
  })

  assert.equal(result.exited, true)
  assert.equal(forceKilledPid, 5512)
})

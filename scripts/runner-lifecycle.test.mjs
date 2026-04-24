import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { runChildProcess, runCommandProcess } from './runner-lifecycle.mjs'

function createStream() {
  const stream = new EventEmitter()
  stream.resume = () => {
    stream.resumed = true
  }
  stream.destroy = () => {
    stream.destroyed = true
  }
  stream.removeAllListeners = EventEmitter.prototype.removeAllListeners
  return stream
}

function createManagedStub() {
  const child = new EventEmitter()
  child.stdout = createStream()
  child.stderr = createStream()
  child.kill = () => true
  child.exitCode = null
  child.signalCode = null
  return {
    child,
    label: 'stubbed-process',
    startedAt: Date.now(),
    stdoutTail: '',
    stderrTail: ''
  }
}

test('runCommandProcess resolves after piped stdout/close handoff with injected process manager', async () => {
  const managed = createManagedStub()
  const resultPromise = runCommandProcess({
    command: process.execPath,
    args: ['-e', 'console.log("ignored")'],
    label: 'piped-handoff',
    stdio: ['ignore', 'pipe', 'pipe'],
    startProcess() {
      queueMicrotask(() => {
        managed.child.stdout.emit('data', Buffer.from('suite-output'))
        managed.child.emit('exit', 0, null)
        managed.child.emit('close', 0, null)
      })
      return managed
    }
  })

  const result = await resultPromise
  assert.equal(result.code, 0)
  assert.equal(typeof result.durationMs, 'number')
  assert.equal(managed.child.stdout.resumed, true)
  assert.equal(managed.child.stderr.resumed, true)
})

test('runCommandProcess rejects with explicit timeout context and uses injected terminator', async () => {
  const managed = createManagedStub()
  let terminateCalls = 0

  await assert.rejects(
    () =>
      runCommandProcess({
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        label: 'timeout-piped-context',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeoutMs: 25,
        startProcess() {
          return managed
        },
        async terminateProcess() {
          terminateCalls += 1
          managed.child.exitCode = 0
          managed.child.emit('exit', 0, null)
          managed.child.emit('close', 0, null)
          return { exited: true, code: 0 }
        }
      }),
    /timed out after 25ms \(stdio=ignore,pipe,pipe; waiting for close\)/
  )

  assert.equal(terminateCalls, 1)
})

test('runCommandProcess preserves non-zero exits with injected child lifecycle', async () => {
  const managed = createManagedStub()

  await assert.rejects(
    () =>
      runCommandProcess({
        command: process.execPath,
        args: ['-e', 'process.exit(23)'],
        label: 'abrupt-exit-non-zero',
        stdio: ['ignore', 'pipe', 'pipe'],
        startProcess() {
          queueMicrotask(() => {
            managed.child.emit('exit', 23, null)
            managed.child.emit('close', 23, null)
          })
          return managed
        }
      }),
    /abrupt-exit-non-zero exited with code 23/
  )
})

test('runCommandProcess falls back to exit when close never arrives for piped stdio', async () => {
  const managed = createManagedStub()
  const start = Date.now()
  const resultPromise = runCommandProcess({
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    label: 'exit-fallback-pinned-close',
    stdio: 'pipe',
    timeoutMs: 6000,
    startProcess() {
      queueMicrotask(() => {
        managed.child.emit('exit', 0, null)
      })
      return managed
    }
  })

  const result = await resultPromise
  const elapsed = Date.now() - start
  assert.equal(result.code, 0)
  assert(elapsed >= 900, `expected close fallback grace window to elapse, got ${elapsed}ms`)
  assert(elapsed < 3000, `expected completion via exit fallback without waiting for descendant stdio, got ${elapsed}ms`)
})

test('runChildProcess forwards detached suite ownership through to runCommandProcess dependencies', async () => {
  const managed = createManagedStub()
  let detachedValue = null

  const result = await runChildProcess({
    scriptPath: 'scripts/integration-exports.mjs',
    label: 'integration-exports.mjs',
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    startProcess(options) {
      detachedValue = options.detached
      queueMicrotask(() => {
        managed.child.emit('exit', 0, null)
        managed.child.emit('close', 0, null)
      })
      return managed
    }
  })

  assert.equal(result.code, 0)
  assert.equal(detachedValue, true)
})

test('runCommandProcess mirrors piped output and propagates Windows tree-kill intent to termination', async () => {
  const managed = createManagedStub()
  let mirroredStdout = ''
  let mirroredStderr = ''
  let terminateOptions = null
  const stdoutWrite = process.stdout.write
  const stderrWrite = process.stderr.write

  process.stdout.write = (chunk, ...args) => {
    mirroredStdout += chunk.toString()
    return stdoutWrite.call(process.stdout, chunk, ...args)
  }
  process.stderr.write = (chunk, ...args) => {
    mirroredStderr += chunk.toString()
    return stderrWrite.call(process.stderr, chunk, ...args)
  }

  try {
    await assert.rejects(
      () =>
        runCommandProcess({
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          label: 'mirror-and-tree-kill',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeoutMs: 25,
          mirrorOutput: true,
          forceTreeKillOnWindows: true,
          startProcess(options) {
            queueMicrotask(() => {
              options.onStdout?.(Buffer.from('mirrored-stdout'))
              options.onStderr?.(Buffer.from('mirrored-stderr'))
              managed.child.stdout.emit('data', Buffer.from('mirrored-stdout'))
              managed.child.stderr.emit('data', Buffer.from('mirrored-stderr'))
            })
            return managed
          },
          async terminateProcess(_managed, options) {
            terminateOptions = options
            managed.child.exitCode = 0
            managed.child.emit('exit', 0, null)
            managed.child.emit('close', 0, null)
            return { exited: true, code: 0 }
          }
        }),
      /timed out after 25ms/
    )
  } finally {
    process.stdout.write = stdoutWrite
    process.stderr.write = stderrWrite
  }

  assert.match(mirroredStdout, /mirrored-stdout/)
  assert.match(mirroredStderr, /mirrored-stderr/)
  assert.equal(terminateOptions?.forceTreeKillOnWindows, true)
})

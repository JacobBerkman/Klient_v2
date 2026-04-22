import { spawn } from 'node:child_process'

export function normalizeChildEnv(env = process.env) {
  if (process.platform !== 'win32') return env
  const normalized = {}
  let pathValue = env.Path ?? env.PATH ?? env.path
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === 'path') {
      if (key === 'Path') pathValue = value
      continue
    }
    if (!Object.hasOwn(normalized, key)) normalized[key] = value
  }
  if (pathValue !== undefined) normalized.Path = pathValue
  return normalized
}

function stdioHasPipe(stdio, index) {
  return stdio === 'pipe' || (Array.isArray(stdio) && stdio[index] === 'pipe')
}

function appendTail(current, chunk, limit) {
  const next = `${current}${chunk.toString()}`
  return next.length > limit ? next.slice(-limit) : next
}

export function startManagedProcess({
  command,
  args = [],
  label,
  cwd = process.cwd(),
  env = process.env,
  stdio = ['ignore', 'pipe', 'pipe'],
  shell = false,
  detached = false,
  captureLimit = 16_000,
  onStdout,
  onStderr
}) {
  const displayLabel = label || `${command} ${args.join(' ')}`.trim()
  let child
  try {
    child = spawn(command, args, {
      cwd,
      env: normalizeChildEnv(env),
      stdio,
      shell,
      detached
    })
  } catch (error) {
    const wrapped = new Error(`${displayLabel} failed to start: ${error.message}`)
    wrapped.cause = error
    wrapped.code = error.code
    throw wrapped
  }
  const state = {
    child,
    label: displayLabel,
    command,
    args,
    detached,
    startedAt: Date.now(),
    stdoutTail: '',
    stderrTail: ''
  }

  if (stdioHasPipe(stdio, 1) && child.stdout) {
    child.stdout.on('data', (chunk) => {
      state.stdoutTail = appendTail(state.stdoutTail, chunk, captureLimit)
      onStdout?.(chunk)
    })
  }
  if (stdioHasPipe(stdio, 2) && child.stderr) {
    child.stderr.on('data', (chunk) => {
      state.stderrTail = appendTail(state.stderrTail, chunk, captureLimit)
      onStderr?.(chunk)
    })
  }

  return state
}

export function releaseChildStdio(processRef) {
  const child = processRef?.child || processRef
  for (const stream of [child?.stdout, child?.stderr]) {
    if (!stream) continue
    stream.removeAllListeners('data')
    if (!stream.destroyed) stream.destroy()
  }
}

export function waitForManagedExit(processRef, timeoutMs = 0) {
  const child = processRef?.child || processRef
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve({ exited: true, code: child?.exitCode ?? 0, signal: child?.signalCode ?? null })
      return
    }

    let settled = false
    let timeout = null
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      child.removeListener('exit', onExit)
      child.removeListener('close', onClose)
      child.removeListener('error', onError)
      resolve(result)
    }
    const onExit = (code, signal) => finish({ exited: true, code: code ?? 0, signal: signal || null, event: 'exit' })
    const onClose = (code, signal) => finish({ exited: true, code: code ?? 0, signal: signal || null, event: 'close' })
    const onError = (error) => finish({ exited: true, code: 1, signal: null, error, event: 'error' })
    child.once('exit', onExit)
    child.once('close', onClose)
    child.once('error', onError)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => finish({ exited: false, code: null, signal: null, event: 'timeout' }), timeoutMs)
      timeout.unref()
    }
  })
}

function killChild(processRef, signal) {
  const child = processRef?.child || processRef
  if (!child || child.exitCode !== null || child.signalCode !== null) return true
  if (process.platform !== 'win32' && processRef?.detached && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal)
      return true
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
      return true
    }
  }
  return child.kill(signal)
}

async function forceKillWindowsTree(pid) {
  if (process.platform !== 'win32' || !Number.isInteger(pid)) return
  const taskkill = startManagedProcess({
    command: 'taskkill',
    args: ['/PID', String(pid), '/T', '/F'],
    label: `taskkill ${pid}`,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  await waitForManagedExit(taskkill, 5000)
  releaseChildStdio(taskkill)
}

export async function terminateManagedProcess(
  processRef,
  { gracefulSignal = 'SIGTERM', graceMs = 3000, killMs = 2000, label = processRef?.label || 'child process' } = {}
) {
  const child = processRef?.child || processRef
  if (!child || child.exitCode !== null || child.signalCode !== null) return { exited: true }

  killChild(processRef, gracefulSignal)
  const graceful = await waitForManagedExit(child, graceMs)
  if (graceful.exited) return graceful

  if (process.platform === 'win32') {
    await forceKillWindowsTree(child.pid)
  } else {
    killChild(processRef, 'SIGKILL')
  }
  const forced = await waitForManagedExit(child, killMs)
  if (!forced.exited) {
    throw new Error(`Failed to terminate ${label} pid=${child.pid ?? '<unknown>'}`)
  }
  return forced
}

export function describeProcessFailure(processRef, message) {
  const elapsedMs = Date.now() - (processRef?.startedAt || Date.now())
  const stdout = processRef?.stdoutTail ? `\nstdout:\n${processRef.stdoutTail}` : ''
  const stderr = processRef?.stderrTail ? `\nstderr:\n${processRef.stderrTail}` : ''
  return `${message} (label=${processRef?.label || 'process'}, pid=${processRef?.child?.pid ?? '<unknown>'}, elapsedMs=${elapsedMs})${stdout}${stderr}`
}

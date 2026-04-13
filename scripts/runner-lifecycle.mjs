import { spawn } from 'node:child_process'

export function runCommandProcess({
  command,
  args = [],
  label,
  invariant,
  index,
  total,
  stdio = 'inherit',
  timeoutMs = 0,
  cwd = process.cwd(),
  env = process.env,
  shell = false
}) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const displayLabel = label || `${command} ${args.join(' ')}`.trim()

    if (typeof index === 'number' && typeof total === 'number') {
      console.log(`\n▶ [${index + 1}/${total}] ${displayLabel}`)
    } else {
      console.log(`\n▶ ${displayLabel}`)
    }
    if (invariant) {
      console.log(`   Invariant: ${invariant}`)
    }

    const child = spawn(command, args, { stdio, cwd, env, shell })

    const isPiped = (value) => value === 'pipe'
    const shouldDrainStdout = stdio === 'pipe' || (Array.isArray(stdio) && isPiped(stdio[1]))
    const shouldDrainStderr = stdio === 'pipe' || (Array.isArray(stdio) && isPiped(stdio[2]))

    // Prevent child processes from stalling when callers use piped stdio but do not actively consume it.
    if (shouldDrainStdout && child.stdout) {
      child.stdout.resume()
    }
    if (shouldDrainStderr && child.stderr) {
      child.stderr.resume()
    }

    let settled = false
    let timeoutId = null
    let closeFallbackId = null
    let exitResult = null
    const stdioMode = Array.isArray(stdio) ? stdio.join(',') : String(stdio)

    const cleanup = () => {
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      child.removeListener('close', onClose)
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      if (closeFallbackId) {
        clearTimeout(closeFallbackId)
        closeFallbackId = null
      }
    }

    const settle = (resolver, value) => {
      if (settled) return
      settled = true
      cleanup()
      resolver(value)
    }

    const onError = (error) => {
      settle(reject, new Error(`${displayLabel} failed to start: ${error.message}`))
    }

    const finalizeCompletion = (eventName, code, signal) => {
      if (settled) return

      const durationMs = Date.now() - start
      if (signal) {
        settle(reject, new Error(`${displayLabel} terminated by signal ${signal} after ${durationMs}ms (${eventName})`))
        return
      }
      if (code !== 0) {
        settle(reject, new Error(`${displayLabel} exited with code ${code} after ${durationMs}ms (${eventName})`))
        return
      }

      console.log(`✓ ${displayLabel} passed in ${durationMs}ms`)
      settle(resolve, { durationMs, code })
    }

    const shouldPreferClose = shouldDrainStdout || shouldDrainStderr

    const onExit = (code, signal) => {
      if (!shouldPreferClose) {
        finalizeCompletion('exit', code, signal)
        return
      }

      exitResult = { code, signal }
      if (!closeFallbackId) {
        closeFallbackId = setTimeout(() => {
          finalizeCompletion('exit', code, signal)
        }, 1000)
        closeFallbackId.unref()
      }
    }

    const onClose = (code, signal) => {
      const completion = exitResult ?? { code, signal }
      finalizeCompletion('close', completion.code, completion.signal)
    }

    // Prefer `exit` for inherited stdio so descendants cannot pin completion.
    // For piped stdio, prefer `close` so stream buffers fully drain before handoff.
    child.once('error', onError)
    child.once('exit', onExit)
    child.once('close', onClose)

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        child.kill('SIGTERM')
        settle(
          reject,
          new Error(
            `${displayLabel} timed out after ${timeoutMs}ms (stdio=${stdioMode}; waiting for ${shouldPreferClose ? 'close' : 'exit'})`
          )
        )
      }, timeoutMs)
      timeoutId.unref()
    }
  })
}

export function runChildProcess({ scriptPath, ...options }) {
  return runCommandProcess({
    command: process.execPath,
    args: [scriptPath],
    ...options
  })
}

export function runSuite(suite, index, total) {
  return runChildProcess({
    scriptPath: `scripts/${suite.script}`,
    label: suite.script,
    invariant: suite.invariant,
    index,
    total
  })
}

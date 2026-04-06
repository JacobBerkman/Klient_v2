import { spawn } from 'node:child_process'

export function runChildProcess({
  scriptPath,
  label,
  invariant,
  index,
  total,
  stdio = 'inherit',
  timeoutMs = 0,
  cwd = process.cwd(),
  env = process.env
}) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const displayLabel = label || scriptPath

    if (typeof index === 'number' && typeof total === 'number') {
      console.log(`\n▶ [${index + 1}/${total}] ${displayLabel}`)
    } else {
      console.log(`\n▶ ${displayLabel}`)
    }
    if (invariant) {
      console.log(`   Invariant: ${invariant}`)
    }

    const child = spawn(process.execPath, [scriptPath], { stdio, cwd, env })

    let settled = false
    let timeoutId = null
    const settle = (resolver, value) => {
      if (settled) return
      settled = true
      if (timeoutId) clearTimeout(timeoutId)
      resolver(value)
    }

    child.once('error', (error) => {
      settle(reject, new Error(`${displayLabel} failed to start: ${error.message}`))
    })

    const handleCompletion = (eventName, code, signal) => {
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

    // Prefer `exit` so we do not wait on inherited stdio held by descendants.
    // Keep `close` as a fallback for environments where only stream-closure is emitted.
    child.once('exit', (code, signal) => {
      handleCompletion('exit', code, signal)
    })

    child.once('close', (code, signal) => {
      handleCompletion('close', code, signal)
    })

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        child.kill('SIGTERM')
        settle(reject, new Error(`${displayLabel} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    }
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

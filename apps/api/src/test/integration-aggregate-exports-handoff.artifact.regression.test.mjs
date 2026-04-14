import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(testDir, '../../../..')

const EXPECTED_SUITES = ['integration-templates.mjs', 'integration-exports.mjs']
const TIMEOUT_MS = 240_000

function summarizeOutput(output, maxLines = 40) {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-maxLines)
    .join('\n')
}

function parseHandoffCompletion(output) {
  const suiteMarker = '"suite": "integration-aggregate-exports-handoff"'
  const markerIndex = output.lastIndexOf(suiteMarker)
  if (markerIndex < 0) return null

  const start = output.lastIndexOf('{', markerIndex)
  const end = output.indexOf('}', markerIndex)
  if (start < 0 || end < 0 || end <= start) return null

  try {
    return JSON.parse(output.slice(start, end + 1))
  } catch {
    return null
  }
}

function runWithCapturedOutput({ command, args, cwd, env, timeoutMs }) {
  return new Promise((resolveRun) => {
    const startedAt = Date.now()
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    const timeoutId = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
    }, timeoutMs)
    timeoutId.unref()

    child.once('close', (code, signal) => {
      clearTimeout(timeoutId)
      resolveRun({
        code,
        signal,
        timedOut,
        elapsedMs: Date.now() - startedAt,
        stdout,
        stderr
      })
    })
  })
}

test('artifact-style npm test:integration:handoff completes deterministically without fetch/socket-close failures', { concurrency: false }, async () => {
  const artifactRoot = await mkdtemp(resolve(tmpdir(), 'klient-handoff-artifact-'))
  const unpackedRoot = resolve(artifactRoot, 'unpacked')

  await cp(repoRoot, unpackedRoot, {
    recursive: true,
    filter(sourcePath) {
      return !sourcePath.includes('/.git')
    }
  })

  try {
    const result = await runWithCapturedOutput({
      command: 'npm',
      args: ['run', 'test:integration:handoff'],
      cwd: unpackedRoot,
      env: { ...process.env },
      timeoutMs: TIMEOUT_MS
    })

    const combinedOutput = `${result.stdout}\n${result.stderr}`
    const suiteList = EXPECTED_SUITES.join(' -> ')
    const diagnostics = [
      `suites=${suiteList}`,
      `elapsedMs=${result.elapsedMs}`,
      `timeoutMs=${TIMEOUT_MS}`,
      `timedOut=${result.timedOut}`,
      `code=${result.code}`,
      `signal=${result.signal}`,
      `tail:\n${summarizeOutput(combinedOutput)}`
    ].join('\n')

    assert.equal(result.timedOut, false, `handoff regression timed out.\n${diagnostics}`)
    assert.equal(result.code, 0, `handoff regression exited non-zero.\n${diagnostics}`)

    assert.match(
      combinedOutput,
      /integration-templates\.mjs/,
      `expected templates suite to execute before exports.\n${diagnostics}`
    )
    assert.match(
      combinedOutput,
      /integration-exports\.mjs/,
      `expected exports suite to execute in handoff run.\n${diagnostics}`
    )

    assert.doesNotMatch(
      combinedOutput,
      /(uncaught\s+)?fetch failed/i,
      `unexpected fetch failure observed during handoff run.\n${diagnostics}`
    )
    assert.doesNotMatch(
      combinedOutput,
      /socket\s*close|socket\s*closed|socket\s*hang\s*up/i,
      `unexpected socket-close failure path observed during handoff run.\n${diagnostics}`
    )

    const completion = parseHandoffCompletion(combinedOutput)
    assert.ok(completion, `missing handoff completion JSON from integration-aggregate-exports-handoff.mjs.\n${diagnostics}`)
    assert.equal(
      completion.suite,
      'integration-aggregate-exports-handoff',
      `unexpected handoff completion suite marker.\n${diagnostics}`
    )
    assert.deepEqual(
      completion.executed,
      EXPECTED_SUITES,
      `handoff completion JSON reported unexpected executed suites.\n${diagnostics}`
    )
  } finally {
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

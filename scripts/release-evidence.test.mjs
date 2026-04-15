import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)

async function withTempDir(prefix, fn) {
  const root = await mkdtemp(resolve(tmpdir(), prefix))
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('createEvidenceRecorder finalizes success payload with finishedAt and duration', async () => {
  await withTempDir('release-evidence-pass-', async (root) => {
    const evidenceFile = resolve(root, 'summary.json')
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { createEvidenceRecorder } from './scripts/release-evidence.mjs'; const recorder = createEvidenceRecorder({ gate: 'unit', defaultFile: 'unused.json', envVarName: 'RELEASE_EVIDENCE_UNIT_FILE', command: 'node unit' }); recorder.finalize({ status: 'passed', details: { ok: true } });"
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, RELEASE_EVIDENCE_UNIT_FILE: evidenceFile },
        encoding: 'utf8'
      }
    )

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const payload = JSON.parse(await readFile(evidenceFile, 'utf8'))
    assert.equal(payload.status, 'passed')
    assert.equal(payload.details.ok, true)
    assert.equal(typeof payload.finishedAt, 'string')
    assert.equal(typeof payload.durationMs, 'number')
    assert.equal(payload.error, null)
  })
})

test('createEvidenceRecorder auto-finalizes as failed when process exits without explicit finalize', async () => {
  await withTempDir('release-evidence-before-exit-', async (root) => {
    const evidenceFile = resolve(root, 'summary.json')
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { createEvidenceRecorder } from './scripts/release-evidence.mjs'; createEvidenceRecorder({ gate: 'unit-before-exit', defaultFile: 'unused.json', envVarName: 'RELEASE_EVIDENCE_UNIT_FILE', command: 'node unit' });"
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, RELEASE_EVIDENCE_UNIT_FILE: evidenceFile },
        encoding: 'utf8'
      }
    )

    assert.equal(result.status, 0, result.stderr || result.stdout)
    const payload = JSON.parse(await readFile(evidenceFile, 'utf8'))
    assert.equal(payload.status, 'failed')
    assert.match(String(payload.error?.message || ''), /without explicit evidence finalization/)
  })
})

test('createEvidenceRecorder auto-finalizes as failed on SIGTERM interruption', async () => {
  await withTempDir('release-evidence-sigterm-', async (root) => {
    const evidenceFile = resolve(root, 'summary.json')
    const scriptPath = resolve(root, 'recorder-sigterm.mjs')
    await writeFile(
      scriptPath,
      `import { createEvidenceRecorder } from ${JSON.stringify(resolve(repoRoot, 'scripts/release-evidence.mjs'))}; createEvidenceRecorder({ gate: 'unit-signal', defaultFile: 'unused.json', envVarName: 'RELEASE_EVIDENCE_UNIT_FILE', command: 'node unit' }); setInterval(() => {}, 250);\n`,
      'utf8'
    )

    const child = spawn(process.execPath, [scriptPath], {
      cwd: root,
      env: { ...process.env, RELEASE_EVIDENCE_UNIT_FILE: evidenceFile },
      stdio: 'ignore'
    })

    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
    child.kill('SIGTERM')

    await new Promise((resolveWait, reject) => {
      child.once('exit', () => resolveWait())
      child.once('error', reject)
    })

    const payload = JSON.parse(await readFile(evidenceFile, 'utf8'))
    assert.equal(payload.status, 'failed')
    assert.match(String(payload.error?.message || ''), /SIGTERM/)
    assert.equal(typeof payload.finishedAt, 'string')
  })
})

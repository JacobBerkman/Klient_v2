import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)

function runNode(scriptPath, cwd, args = []) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', rejectRun)
    child.on('exit', (code, signal) => {
      if (signal) {
        rejectRun(new Error(`${scriptPath} ${args.join(' ')} terminated by signal ${signal}`))
        return
      }
      if (code !== 0) {
        rejectRun(new Error(`${scriptPath} ${args.join(' ')} failed with code ${code}\n${stderr}`.trim()))
        return
      }
      resolveRun(stdout.trim())
    })
  })
}

const tempRoot = await mkdtemp(join(tmpdir(), 'klient-migration-check-'))
try {
  process.chdir(tempRoot)
  const { loadState, saveState } = await import('../apps/api/src/storage.mjs')

  const seededState = loadState(() => ({}))
  seededState.formTemplates = [{ id: 'form-legacy-1', firmId: 'firm-default', name: 'Legacy Form', sections: [] }]
  seededState.documentTemplates = [{ id: 'doc-legacy-1', firmId: 'firm-default', name: 'Legacy Doc', mappings: [] }]
  saveState(seededState)

  const migrateScript = resolve(repoRoot, 'scripts/migrate-template-unification.mjs')
  const reencryptScript = resolve(repoRoot, 'scripts/reencrypt-pii.mjs')

  const migrationRaw = await runNode(migrateScript, tempRoot, ['--stage=backfill'])
  const migration = JSON.parse(migrationRaw || '{}')
  if (migration.copiedCount !== 2) {
    throw new Error('Template aggregate migration did not produce expected aggregate count.')
  }

  const secondMigrationRaw = await runNode(migrateScript, tempRoot, ['--stage=backfill'])
  const secondMigration = JSON.parse(secondMigrationRaw || '{}')
  if (secondMigration.copiedCount !== 0) {
    throw new Error('Template aggregate migration is not idempotent.')
  }

  const verifyRaw = await runNode(migrateScript, tempRoot, ['--stage=verify'])
  const verify = JSON.parse(verifyRaw || '{}')
  if (!verify.ok) {
    throw new Error('Template migration verify stage failed.')
  }

  const rotationRaw = await runNode(reencryptScript, tempRoot, ['--validate'])
  const rotation = JSON.parse(rotationRaw || '{}')
  if (!rotation.ok || !Number.isInteger(rotation.rotatedProfiles) || !Number.isInteger(rotation.rotatedFields)) {
    throw new Error('PII re-encryption script did not return expected metrics.')
  }
  if (!rotation.validation?.ok || !Number.isInteger(rotation.validation?.profilesChecked)) {
    throw new Error('PII re-encryption validation output did not match expected schema.')
  }

  const postState = loadState(() => ({}))
  if (!Array.isArray(postState.templateAggregates) || postState.templateAggregates.length !== 2) {
    throw new Error('Template aggregate data missing after migration flow.')
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        checks: {
          templateMigration: 'pass',
          templateMigrationIdempotent: 'pass',
          templateMigrationVerify: 'pass',
          piiReencryptionPath: 'pass'
        },
        templateAggregateCount: postState.templateAggregates.length,
        rotatedProfiles: rotation.rotatedProfiles,
        rotatedFields: rotation.rotatedFields
      },
      null,
      2
    )
  )
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}

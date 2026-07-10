import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { LATEST_SCHEMA_VERSION, runMigrations } from '../apps/api/src/migrations/index.mjs'
import { createEvidenceRecorder } from './release-evidence.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function runNode(scriptPath, cwd, args = []) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      env: {
        ...process.env,
        ALLOW_DEV_FALLBACK_APP_SECRET: 'true'
      },
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

const evidence = createEvidenceRecorder({
  gate: 'migration',
  defaultFile: 'migration-summary.json',
  envVarName: 'RELEASE_EVIDENCE_MIGRATION_FILE',
  command: 'npm run check:migrations'
})

const tempRoot = await mkdtemp(join(tmpdir(), 'klient-migration-check-'))
let closeStorage = null
try {
  process.chdir(tempRoot)
  const { loadState, saveState, closeDatabase } = await import('../apps/api/src/storage.mjs')
  closeStorage = closeDatabase

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

  // Versioned schema migration runner: PRAGMA user_version must have advanced
  // to the latest known version, and re-running the runner must be a no-op.
  const versionDb = new DatabaseSync(join(tempRoot, 'data', 'app.db'))
  try {
    const userVersion = Number(versionDb.prepare('PRAGMA user_version').get()?.user_version || 0)
    if (userVersion !== LATEST_SCHEMA_VERSION) {
      throw new Error(`PRAGMA user_version is ${userVersion}; expected latest schema version ${LATEST_SCHEMA_VERSION}.`)
    }
    const rerun = runMigrations(versionDb)
    if (rerun.applied.length !== 0 || rerun.currentVersion !== LATEST_SCHEMA_VERSION) {
      throw new Error('Versioned schema migration runner is not a no-op on re-run.')
    }
  } finally {
    versionDb.close()
  }

  const summary = {
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
  }
  evidence.finalize({ status: 'passed', details: summary })
  console.log(JSON.stringify(summary, null, 2))
} catch (error) {
  evidence.finalize({ status: 'failed', error })
  throw error
} finally {
  // Release the SQLite handle and leave the temp root before deleting it; on
  // Windows an open database file or a cwd inside the tree fails with EBUSY.
  try {
    closeStorage?.()
  } catch {
    // Connection may already be closed; cleanup should still proceed.
  }
  process.chdir(repoRoot)
  await rm(tempRoot, { recursive: true, force: true })
}

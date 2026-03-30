import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'

function fail(message) {
  process.stderr.write(`\n❌ ${message}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const options = {
    phase: 'all',
    releaseId: process.env.RELEASE_ID || '',
    restorePath: process.env.RESTORE_BACKUP_PATH || '',
    restoreVerifyOnly: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--phase') {
      options.phase = argv[index + 1] || ''
      index += 1
      continue
    }
    if (token === '--release-id') {
      options.releaseId = argv[index + 1] || ''
      index += 1
      continue
    }
    if (token === '--restore-path') {
      options.restorePath = argv[index + 1] || ''
      index += 1
      continue
    }
    if (token === '--restore-verify-only') {
      options.restoreVerifyOnly = true
      continue
    }
    if (token === '--help' || token === '-h') {
      options.help = true
      continue
    }
    if (!token.startsWith('--') && !options.releaseId) {
      options.releaseId = token
      continue
    }
    fail(`Unknown argument: ${token}`)
  }

  return options
}

function printHelp() {
  process.stdout.write(`Release go/no-go operator\n\n`)
  process.stdout.write(`Usage:\n`)
  process.stdout.write(`  npm run release:go-no-go -- --release-id <release-id> [--phase all|preflight|postdeploy|restore|restore-drill] [--restore-path <backup-file>] [--restore-verify-only]\n\n`)
  process.stdout.write(`Examples:\n`)
  process.stdout.write(`  npm run release:go-no-go -- --release-id 2026-03-27.1\n`)
  process.stdout.write(`  npm run release:go-no-go -- --release-id 2026-03-27.1 --phase preflight\n`)
  process.stdout.write(`  npm run release:go-no-go -- --release-id 2026-03-27.1 --phase restore --restore-path data/backup-20260327.db\n`)
  process.stdout.write(`  npm run release:go-no-go -- --release-id 2026-03-27.1 --phase restore-drill --restore-path data/backup-20260327.db\n`)
}

function runStep({ name, command, args, outputFile = '', env = process.env }) {
  return new Promise((resolveRun, reject) => {
    const startedAt = Date.now()
    process.stdout.write(`\n▶ ${name}\n$ ${command} ${args.join(' ')}\n`)

    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text
      process.stdout.write(text)
    })

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      process.stderr.write(text)
    })

    child.on('error', (error) => reject(error))

    child.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`${name} terminated by signal ${signal}`))
        return
      }
      if (code !== 0) {
        reject(new Error(`${name} failed with exit code ${code}`))
        return
      }

      if (outputFile) {
        mkdirSync(dirname(outputFile), { recursive: true })
        writeFileSync(outputFile, stdout, 'utf8')
      }

      resolveRun({ stdout, stderr, durationMs: Date.now() - startedAt })
    })
  })
}

function parseJsonFile(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`${label} is not valid JSON at ${file}: ${error.message}`)
  }
}

function ensureBackupEvidence(backupFile) {
  const report = parseJsonFile(backupFile, 'Backup evidence')
  const valid =
    report &&
    report.ok === true &&
    report.status === 'succeeded' &&
    report.artifact?.path &&
    Number.isFinite(report.artifact?.sizeBytes) &&
    report.artifact.sizeBytes > 0 &&
    report.artifact?.sqliteQuickCheck === 'ok'

  if (!valid) {
    fail(
      `Backup evidence validation failed at ${backupFile}. Expected ok=true, status=succeeded, artifact.path, artifact.sizeBytes>0, artifact.sqliteQuickCheck=ok`
    )
  }
}

function ensureRestoreEvidence(restoreFile, expectedMode = 'live-restore') {
  const report = parseJsonFile(restoreFile, 'Restore evidence')
  const valid =
    report &&
    report.ok === true &&
    report.status === 'succeeded' &&
    report.executionMode === expectedMode &&
    report.source?.sqliteQuickCheck === 'ok' &&
    report.restoreTarget?.sqliteQuickCheck === 'ok' &&
    report.checks?.sizeMatch === true &&
    report.checks?.sha256Match === true

  if (!valid) {
    fail(
      `Restore evidence validation failed at ${restoreFile}. Expected ok=true, status=succeeded, executionMode=${expectedMode}, source/restoreTarget sqliteQuickCheck=ok, and checks.sizeMatch/checks.sha256Match=true`
    )
  }
}

function ensureEnv(name) {
  if (!process.env[name]) {
    fail(`Missing required environment variable: ${name}`)
  }
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  printHelp()
  process.exit(0)
}

const validPhases = new Set(['all', 'preflight', 'postdeploy', 'restore', 'restore-drill'])
if (!validPhases.has(options.phase)) {
  fail(`Invalid --phase value "${options.phase}". Use one of: all, preflight, postdeploy, restore, restore-drill.`)
}
if (!options.releaseId) {
  fail('Missing release id. Pass --release-id <release-id> or set RELEASE_ID.')
}

const evidenceDir = resolve(process.cwd(), 'artifacts/release-evidence', options.releaseId)
mkdirSync(evidenceDir, { recursive: true })
process.stdout.write(`Using evidence directory: ${evidenceDir}\n`)

const preflight = async () => {
  const backupFile = resolve(evidenceDir, 'backup.json')
  await runStep({
    name: 'Flow A.1 Backup metadata capture',
    command: 'npm',
    args: ['run', '--silent', 'backup'],
    outputFile: backupFile
  })
  ensureBackupEvidence(backupFile)

  await runStep({
    name: 'Flow A.2 Merge/main parity check',
    command: 'npm',
    args: ['run', '--silent', 'check:merge-main'],
    outputFile: resolve(evidenceDir, 'branch-parity.txt')
  })

  await runStep({
    name: 'Flow A.3 Hard release gate',
    command: 'npm',
    args: ['run', '--silent', 'validate:master'],
    env: { ...process.env, RELEASE_EVIDENCE_DIR: evidenceDir }
  })
}

const restoreValidation = async ({ verifyOnly = false } = {}) => {
  const restorePath = options.restorePath || process.env.RESTORE_BACKUP_PATH
  if (!restorePath) {
    fail('Restore flow requires --restore-path <backup-file> or RESTORE_BACKUP_PATH.')
  }

  const restoreFile = resolve(evidenceDir, verifyOnly ? 'restore-drill.json' : 'restore.json')
  const restoreArgs = ['run', '--silent', 'restore', '--', restorePath]
  if (verifyOnly) {
    restoreArgs.push('--verify-only', '--evidence-label', 'release-go-no-go-restore-drill')
  }

  await runStep({
    name: verifyOnly ? 'Flow B.1 Restore verify-only drill metadata capture' : 'Flow B.1 Restore metadata capture',
    command: 'npm',
    args: restoreArgs,
    outputFile: restoreFile
  })
  ensureRestoreEvidence(restoreFile, verifyOnly ? 'verify-only-drill' : 'live-restore')
}

const postdeploy = async () => {
  ensureEnv('KLIENT_BASE_URL')
  ensureEnv('KLIENT_OPS_TOKEN')

  const baseUrl = process.env.KLIENT_BASE_URL
  const opsToken = process.env.KLIENT_OPS_TOKEN

  await runStep({
    name: 'Post-deploy Step 1 Health',
    command: 'curl',
    args: ['-fsS', `${baseUrl}/health`],
    outputFile: resolve(evidenceDir, 'postdeploy-health.json')
  })

  await runStep({
    name: 'Post-deploy Step 2 Readiness',
    command: 'curl',
    args: ['-fsS', `${baseUrl}/ready`],
    outputFile: resolve(evidenceDir, 'postdeploy-ready.json')
  })

  await runStep({
    name: 'Post-deploy Step 3 Export queue diagnostics',
    command: 'curl',
    args: ['-fsS', '-H', `Authorization: Bearer ${opsToken}`, `${baseUrl}/api/ops/exports/queue`],
    outputFile: resolve(evidenceDir, 'postdeploy-exports-queue.json')
  })

  await runStep({
    name: 'Post-deploy Step 4 Telemetry bundle',
    command: 'curl',
    args: ['-fsS', '-H', `Authorization: Bearer ${opsToken}`, `${baseUrl}/api/ops/diagnostics`],
    outputFile: resolve(evidenceDir, 'postdeploy-telemetry-bundle.json')
  })
}

try {
  if (options.phase === 'preflight') {
    await preflight()
  } else if (options.phase === 'restore') {
    await restoreValidation({ verifyOnly: options.restoreVerifyOnly })
  } else if (options.phase === 'restore-drill') {
    await restoreValidation({ verifyOnly: true })
  } else if (options.phase === 'postdeploy') {
    await postdeploy()
  } else {
    await preflight()
    await postdeploy()
  }
  process.stdout.write('\n✅ release-go-no-go completed successfully.\n')
} catch (error) {
  fail(error.message)
}

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { spawn } from 'node:child_process'
import { collectArtifactMetadata } from './release-evidence.mjs'

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

function runStep({ name, command, args, outputFile = '', outputMode = 'stdout', env = process.env, allowedExitCodes = [0] }) {
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
      if (!allowedExitCodes.includes(code)) {
        reject(new Error(`${name} failed with exit code ${code}`))
        return
      }

      if (outputFile) {
        mkdirSync(dirname(outputFile), { recursive: true })
        const output = outputMode === 'combined' ? `${stdout}${stderr}` : stdout
        writeFileSync(outputFile, output, 'utf8')
      }

      resolveRun({ stdout, stderr, durationMs: Date.now() - startedAt, outputFile, exitCode: code })
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

const POSTDEPLOY_THRESHOLDS = {
  maxQueueStalled: Number.parseInt(process.env.RELEASE_POSTDEPLOY_MAX_QUEUE_STALLED || '0', 10),
  maxQueueDeadLetter: Number.parseInt(process.env.RELEASE_POSTDEPLOY_MAX_QUEUE_DEAD_LETTER || '0', 10),
  maxQueueFailedRetryable: Number.parseInt(process.env.RELEASE_POSTDEPLOY_MAX_QUEUE_FAILED_RETRYABLE || '0', 10)
}

function parseNumericThreshold(value, fallback, key) {
  if (Number.isFinite(value) && value >= 0) return value
  process.stdout.write(`\n⚠ Invalid ${key} threshold; using fallback value ${fallback}.\n`)
  return fallback
}

function normalizeBooleanSignal(payload) {
  if (typeof payload === 'boolean') return payload
  if (typeof payload === 'string') {
    const lowered = payload.trim().toLowerCase()
    if (['ok', 'pass', 'ready', 'healthy', 'up', 'true'].includes(lowered)) return true
    if (['fail', 'failed', 'error', 'down', 'false', 'unhealthy'].includes(lowered)) return false
    return null
  }
  if (!payload || typeof payload !== 'object') return null
  const keys = ['ok', 'ready', 'healthy', 'status', 'state']
  for (const key of keys) {
    if (key in payload) return normalizeBooleanSignal(payload[key])
  }
  return null
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function evaluatePostdeployPayloads({ releaseId, evidenceDir }) {
  const healthPayload = parseJsonFile(resolve(evidenceDir, 'postdeploy-health.json'), 'Postdeploy health payload')
  const readyPayload = parseJsonFile(resolve(evidenceDir, 'postdeploy-ready.json'), 'Postdeploy readiness payload')
  const queuePayload = parseJsonFile(resolve(evidenceDir, 'postdeploy-exports-queue.json'), 'Postdeploy queue payload')
  const diagnosticsPayload = parseJsonFile(resolve(evidenceDir, 'postdeploy-telemetry-bundle.json'), 'Postdeploy diagnostics payload')

  const thresholds = {
    maxQueueStalled: parseNumericThreshold(POSTDEPLOY_THRESHOLDS.maxQueueStalled, 0, 'RELEASE_POSTDEPLOY_MAX_QUEUE_STALLED'),
    maxQueueDeadLetter: parseNumericThreshold(
      POSTDEPLOY_THRESHOLDS.maxQueueDeadLetter,
      0,
      'RELEASE_POSTDEPLOY_MAX_QUEUE_DEAD_LETTER'
    ),
    maxQueueFailedRetryable: parseNumericThreshold(
      POSTDEPLOY_THRESHOLDS.maxQueueFailedRetryable,
      0,
      'RELEASE_POSTDEPLOY_MAX_QUEUE_FAILED_RETRYABLE'
    )
  }

  const queue = queuePayload?.queue || queuePayload || {}
  const diagnosticsStartupRuntime = diagnosticsPayload?.startup?.runtime || diagnosticsPayload?.data?.startup?.runtime || {}
  const readyChecks = readyPayload?.checks && typeof readyPayload.checks === 'object' ? readyPayload.checks : {}
  const failedReadyChecks = Object.entries(readyChecks).filter(([, signal]) => normalizeBooleanSignal(signal) !== true)
  const queueStalled = toNumber(queue.stalled)
  const queueDeadLetter = toNumber(queue.machineState?.deadLetter?.count ?? queue.deadLetter)
  const queueFailedRetryable = toNumber(queue.failedRetryable)

  const rules = [
    {
      id: 'health-ok',
      description: '/health must indicate healthy status',
      passed: normalizeBooleanSignal(healthPayload) === true,
      observed: {
        ok: normalizeBooleanSignal(healthPayload),
        status: healthPayload?.status
      }
    },
    {
      id: 'ready-ok',
      description: '/ready must indicate ready status',
      passed: normalizeBooleanSignal(readyPayload) === true,
      observed: {
        ok: normalizeBooleanSignal(readyPayload),
        status: readyPayload?.status
      }
    },
    {
      id: 'ready-checks-all-true',
      description: '/ready checks.* must all be true',
      passed: failedReadyChecks.length === 0 && Object.keys(readyChecks).length > 0,
      observed: {
        totalChecks: Object.keys(readyChecks).length,
        failedChecks: failedReadyChecks.map(([name, signal]) => ({ name, signal }))
      }
    },
    {
      id: 'queue-stalled-threshold',
      description: 'Queue stalled count must be within threshold',
      passed: queueStalled <= thresholds.maxQueueStalled,
      observed: { value: queueStalled, threshold: thresholds.maxQueueStalled }
    },
    {
      id: 'queue-dead-letter-threshold',
      description: 'Queue dead-letter count must be within threshold',
      passed: queueDeadLetter <= thresholds.maxQueueDeadLetter,
      observed: { value: queueDeadLetter, threshold: thresholds.maxQueueDeadLetter }
    },
    {
      id: 'queue-failed-retryable-threshold',
      description: 'Queue failed-retryable count must be within threshold',
      passed: queueFailedRetryable <= thresholds.maxQueueFailedRetryable,
      observed: { value: queueFailedRetryable, threshold: thresholds.maxQueueFailedRetryable }
    },
    {
      id: 'ready-startup-diagnostics-ok',
      description: '/ready startupDiagnostics.ok must be true when present',
      passed:
        readyPayload?.startupDiagnostics?.ok === undefined || normalizeBooleanSignal(readyPayload?.startupDiagnostics?.ok) === true,
      observed: {
        startupDiagnosticsOk: readyPayload?.startupDiagnostics?.ok ?? null,
        issues: readyPayload?.startupDiagnostics?.issues || []
      }
    },
    {
      id: 'runtime-diagnostics-ok',
      description: '/api/ops/diagnostics startup.runtime.ok must be true',
      passed: normalizeBooleanSignal(diagnosticsStartupRuntime?.ok) === true,
      observed: {
        startupRuntimeOk: diagnosticsStartupRuntime?.ok ?? null,
        issues: diagnosticsStartupRuntime?.issues || []
      }
    }
  ]

  const failedRules = rules.filter((rule) => !rule.passed)
  const evaluation = {
    schemaVersion: '1.0.0',
    releaseId,
    generatedAt: new Date().toISOString(),
    status: failedRules.length === 0 ? 'passed' : 'failed',
    thresholds,
    rules
  }
  const summaryPath = resolve(evidenceDir, 'postdeploy-evaluation-summary.json')
  writeFileSync(summaryPath, `${JSON.stringify(evaluation, null, 2)}\n`, 'utf8')

  if (failedRules.length > 0) {
    const failedRuleIds = failedRules.map((rule) => rule.id).join(', ')
    throw new Error(
      `Postdeploy evaluation failed (${failedRules.length} rule(s)): ${failedRuleIds}. See ${relative(process.cwd(), summaryPath)}`
    )
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

function parseJsonLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function ensureStartupFailfastEvidence(probeFile) {
  const report = parseJsonFile(probeFile, 'Startup fail-fast evidence')
  const valid =
    report &&
    report.ok === true &&
    report.status === 'succeeded' &&
    report.checks?.exitCodeNonZero === true &&
    report.checks?.startupBlockedLogged === true &&
    report.checks?.startupIssuesPresent === true &&
    report.checks?.listenPrevented === true

  if (!valid) {
    fail(
      `Startup fail-fast validation failed at ${probeFile}. Expected ok=true, status=succeeded, and checks exitCodeNonZero/startupBlockedLogged/startupIssuesPresent/listenPrevented=true`
    )
  }
}

function ensureEnv(name) {
  if (!process.env[name]) {
    fail(`Missing required environment variable: ${name}`)
  }
}

function resolveReleaseOpsToken() {
  const candidates = [
    process.env.KLIENT_OPS_TOKEN_ACTIVE,
    process.env.KLIENT_OPS_TOKEN,
    process.env.KLIENT_OPS_TOKEN_PREVIOUS
  ]
  for (const candidate of candidates) {
    if (String(candidate || '').trim()) return String(candidate).trim()
  }
  return ''
}

function listFilesRecursively(rootDir) {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile()) {
        files.push(fullPath)
      }
    }
  }

  walk(rootDir)
  return files
}

function resolvePhaseArtifacts({ beforePaths, afterPaths }) {
  const beforeSet = new Set(beforePaths)
  return afterPaths.filter((path) => !beforeSet.has(path)).sort((left, right) => left.localeCompare(right))
}

function initializePhaseReport(status = 'skipped') {
  return {
    status,
    artifactPaths: []
  }
}

function writeManifest({ releaseId, evidenceDir, phaseReports, generatedAt }) {
  const allArtifacts = Object.values(phaseReports)
    .flatMap((report) => report.artifactPaths)
    .filter((artifactPath) => relative(evidenceDir, artifactPath) !== 'manifest.json')

  const manifest = {
    schemaVersion: '1.0.0',
    releaseId,
    generatedAt,
    phaseStatuses: Object.fromEntries(
      Object.entries(phaseReports).map(([phaseName, report]) => [
        phaseName,
        {
          status: report.status,
          artifacts: report.artifactPaths.map((artifactPath) => relative(process.cwd(), artifactPath))
        }
      ])
    ),
    files: collectArtifactMetadata(allArtifacts).map((artifact) => ({
      ...artifact,
      path: relative(process.cwd(), artifact.path)
    }))
  }

  writeFileSync(resolve(evidenceDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
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

const phaseReports = {
  preflight: initializePhaseReport(options.phase === 'all' || options.phase === 'preflight' ? 'pending' : 'skipped'),
  restore: initializePhaseReport(options.phase === 'restore' ? 'pending' : 'skipped'),
  postdeploy: initializePhaseReport(options.phase === 'all' || options.phase === 'postdeploy' ? 'pending' : 'skipped')
}

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

  const startupFailfastOutput = resolve(evidenceDir, 'startup-failfast.txt')
  const startupFailfastEvidence = resolve(evidenceDir, 'startup-failfast.json')
  const probeEnv = {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: '3901',
    LOG_LEVEL: 'info',
    SERVICE_NAME: 'release-go-no-go-startup-probe',
    APP_SECRET: 'ProbeStrongSecretValue!2026#Alpha',
    AUTH_PROVIDER: '',
    PII_KEY_PROVIDER: 'env',
    PII_ACTIVE_KEY_ID: 'probe-key-1',
    PII_KEYRING: '{"probe-key-1":"dGVzdC1rZXktbWF0ZXJpYWw"}'
  }
  const probeResult = await runStep({
    name: 'Flow A.3 Controlled invalid-config startup fail-fast probe',
    command: 'node',
    args: ['apps/api/src/server.mjs'],
    env: probeEnv,
    outputFile: startupFailfastOutput,
    outputMode: 'combined',
    allowedExitCodes: [1]
  })
  const probeLogs = parseJsonLines(`${probeResult.stdout}\n${probeResult.stderr}`)
  const blockedEntry = probeLogs.find((entry) => entry.message === 'server.startup.blocked')
  const serverStartedEntry = probeLogs.find((entry) => entry.message === 'server.started')
  const checks = {
    exitCodeNonZero: probeResult.exitCode !== 0,
    startupBlockedLogged: Boolean(blockedEntry),
    startupIssuesPresent: Array.isArray(blockedEntry?.issues) && blockedEntry.issues.length > 0,
    listenPrevented: !serverStartedEntry
  }
  const probeReport = {
    ok: Object.values(checks).every(Boolean),
    status: Object.values(checks).every(Boolean) ? 'succeeded' : 'failed',
    generatedAt: new Date().toISOString(),
    probe: 'invalid-config-startup-failfast',
    command: {
      command: 'node',
      args: ['apps/api/src/server.mjs']
    },
    checks,
    observed: {
      exitCode: probeResult.exitCode,
      blockedIssueCount: Array.isArray(blockedEntry?.issues) ? blockedEntry.issues.length : 0,
      blockedIssues: blockedEntry?.issues || [],
      sawServerStarted: Boolean(serverStartedEntry)
    },
    artifacts: {
      rawOutput: relative(process.cwd(), startupFailfastOutput)
    }
  }
  writeFileSync(startupFailfastEvidence, `${JSON.stringify(probeReport, null, 2)}\n`, 'utf8')
  ensureStartupFailfastEvidence(startupFailfastEvidence)

  await runStep({
    name: 'Flow A.4 Hard release gate',
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
  const opsToken = resolveReleaseOpsToken()
  if (!opsToken) {
    fail(
      'Missing ops token for postdeploy checks. Set KLIENT_OPS_TOKEN_ACTIVE (recommended) or KLIENT_OPS_TOKEN/KLIENT_OPS_TOKEN_PREVIOUS during rotation windows.'
    )
  }

  const baseUrl = process.env.KLIENT_BASE_URL

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

  evaluatePostdeployPayloads({ releaseId: options.releaseId, evidenceDir })
}

async function runPhase(phaseName, runner) {
  phaseReports[phaseName].status = 'running'
  const beforePaths = listFilesRecursively(evidenceDir)
  try {
    await runner()
    const afterPaths = listFilesRecursively(evidenceDir)
    phaseReports[phaseName].artifactPaths = resolvePhaseArtifacts({ beforePaths, afterPaths })
    phaseReports[phaseName].status = 'passed'
  } catch (error) {
    const afterPaths = listFilesRecursively(evidenceDir)
    phaseReports[phaseName].artifactPaths = resolvePhaseArtifacts({ beforePaths, afterPaths })
    phaseReports[phaseName].status = 'failed'
    throw error
  }
}

try {
  if (options.phase === 'preflight') {
    await runPhase('preflight', preflight)
  } else if (options.phase === 'restore') {
    await restoreValidation({ verifyOnly: options.restoreVerifyOnly })
  } else if (options.phase === 'restore-drill') {
    await restoreValidation({ verifyOnly: true })
  } else if (options.phase === 'postdeploy') {
    await runPhase('postdeploy', postdeploy)
  } else {
    await runPhase('preflight', preflight)
    await runPhase('postdeploy', postdeploy)
  }
  writeManifest({
    releaseId: options.releaseId,
    evidenceDir,
    phaseReports,
    generatedAt: new Date().toISOString()
  })
  process.stdout.write('\n✅ release-go-no-go completed successfully.\n')
} catch (error) {
  writeManifest({
    releaseId: options.releaseId,
    evidenceDir,
    phaseReports,
    generatedAt: new Date().toISOString()
  })
  fail(error.message)
}

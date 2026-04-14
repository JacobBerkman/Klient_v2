import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
const workflowPath = resolve(repoRoot, '.github/workflows/smoke.yml')

function readWorkflow() {
  return readFileSync(workflowPath, 'utf8')
}

function getJobBlock(workflow, jobId) {
  const matcher = new RegExp(`\\n  ${jobId}:\\n([\\s\\S]*?)(?=\\n  [a-z0-9_]+:\\n|$)`)
  const match = workflow.match(matcher)
  assert.ok(match, `missing ${jobId} job in workflow`)
  return match[1]
}

test('e2e_release_blocking uses one consistent artifacts folder path', () => {
  const workflow = readWorkflow()
  const job = getJobBlock(workflow, 'e2e_release_blocking')

  const mkdirMatch = job.match(/mkdir -p (artifacts\/[^\s]+)/)
  assert.ok(mkdirMatch, 'missing e2e_release_blocking mkdir -p artifacts path')
  const artifactBase = mkdirMatch[1]

  assert.match(
    job,
    new RegExp(`\\}\\s*>\\s*${artifactBase.replaceAll('/', '\\/')}/readiness-summary\\.md`)
  )
  assert.match(
    job,
    new RegExp(`tee\\s+${artifactBase.replaceAll('/', '\\/')}/suite\\.log`)
  )
  assert.match(
    job,
    new RegExp(`\\n\\s*${artifactBase.replaceAll('/', '\\/')}/\\*\\*\\n`)
  )
})

test('hard_release_gate installs Playwright before npm run validate:master', () => {
  const workflow = readWorkflow()
  const job = getJobBlock(workflow, 'hard_release_gate')

  const installIndex = job.indexOf('npx playwright install --with-deps chromium')
  const validateIndex = job.indexOf('npm run validate:master')

  assert.ok(installIndex >= 0, 'missing Playwright install in hard_release_gate')
  assert.ok(validateIndex >= 0, 'missing npm run validate:master in hard_release_gate')
  assert.ok(
    installIndex < validateIndex,
    'Playwright install must appear before npm run validate:master in hard_release_gate'
  )
})

test('release-blocking and hard-release e2e jobs share strict env and report wiring', () => {
  const workflow = readWorkflow()
  const e2eJob = getJobBlock(workflow, 'e2e_release_blocking')
  const hardReleaseJob = getJobBlock(workflow, 'hard_release_gate')

  for (const job of [e2eJob, hardReleaseJob]) {
    assert.match(job, /npx playwright install --with-deps chromium/)
    assert.match(job, /export RELEASE_E2E_PLAYWRIGHT_REPORT=artifacts\/[a-z0-9-]+\/playwright-report\.json/)
    assert.match(job, /export PLAYWRIGHT_JSON_REPORT="\$RELEASE_E2E_PLAYWRIGHT_REPORT"/)
    assert.match(job, /RELEASE_E2E_ALLOW_FALLBACK=0/)
    assert.match(job, /RELEASE_E2E_STRICT_MODE=1/)
    assert.match(job, /echo "- playwright report: \$\{RELEASE_E2E_PLAYWRIGHT_REPORT\}"/)
  }

  assert.match(e2eJob, /echo '- filter: E2E_GREP=@release-blocking'/)
  assert.match(e2eJob, /E2E_GREP='@release-blocking' npm run test:e2e/)
})

test('release-blocking and hard-release e2e jobs install Playwright before executing blocking command', () => {
  const workflow = readWorkflow()
  const e2eJob = getJobBlock(workflow, 'e2e_release_blocking')
  const hardReleaseJob = getJobBlock(workflow, 'hard_release_gate')

  const installInE2E = e2eJob.indexOf('npx playwright install --with-deps chromium')
  const executeE2E = e2eJob.indexOf("npm run test:e2e")
  assert.ok(installInE2E >= 0, 'missing Playwright install in e2e_release_blocking')
  assert.ok(executeE2E >= 0, 'missing npm run test:e2e in e2e_release_blocking')
  assert.ok(installInE2E < executeE2E, 'Playwright install must run before npm run test:e2e')

  const installInHardRelease = hardReleaseJob.indexOf('npx playwright install --with-deps chromium')
  const executeHardRelease = hardReleaseJob.indexOf('npm run validate:master')
  assert.ok(installInHardRelease >= 0, 'missing Playwright install in hard_release_gate')
  assert.ok(executeHardRelease >= 0, 'missing npm run validate:master in hard_release_gate')
  assert.ok(installInHardRelease < executeHardRelease, 'Playwright install must run before npm run validate:master')
})

test('release-blocking and hard-release upload common Playwright artifact paths', () => {
  const workflow = readWorkflow()
  const e2eJob = getJobBlock(workflow, 'e2e_release_blocking')
  const hardReleaseJob = getJobBlock(workflow, 'hard_release_gate')

  for (const job of [e2eJob, hardReleaseJob]) {
    assert.match(job, /\n\s*test-results\/\*\*\n/)
    assert.match(job, /\n\s*playwright-report\/\*\*\n/)
    assert.match(job, /\n\s*snapshots\/\*\*\n/)
    assert.match(job, /\n\s*tmp\/\*\*\/snapshots\/\*\*\n/)
  }
})

test('merge_gate.needs references only existing workflow job IDs', () => {
  const workflow = readWorkflow()
  const jobIdMatches = [...workflow.matchAll(/^  ([a-z0-9_]+):$/gm)]
  const jobIds = new Set(jobIdMatches.map((entry) => entry[1]))
  assert.ok(jobIds.has('merge_gate'), 'missing merge_gate job')

  const mergeGate = getJobBlock(workflow, 'merge_gate')
  const needsBlockMatch = mergeGate.match(/\n    needs:\n([\s\S]*?)\n    if:/)
  assert.ok(needsBlockMatch, 'missing merge_gate.needs block')

  const needsItems = [...needsBlockMatch[1].matchAll(/^\s+- ([a-z0-9_]+)$/gm)].map((entry) => entry[1])
  assert.ok(needsItems.length > 0, 'merge_gate.needs must include at least one dependency')

  for (const dependency of needsItems) {
    assert.ok(jobIds.has(dependency), `merge_gate.needs references unknown job: ${dependency}`)
  }
})

test('e2e artifact folder naming matches docs references', () => {
  const workflow = readWorkflow()
  assert.match(workflow, /artifacts\/e2e-release-blocking\/readiness-summary\.md/)
  assert.match(workflow, /artifacts\/e2e-release-blocking\/suite\.log/)
  assert.match(workflow, /artifacts\/e2e-release-blocking\/\*\*/)
})

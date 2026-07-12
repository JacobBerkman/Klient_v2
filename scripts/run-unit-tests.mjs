#!/usr/bin/env node
// Serial runner for the apps/api backend unit-test suite (node:test files).
//
// Why a dedicated runner instead of a bare `node --test <glob>` npm script:
//   1. Hermetic env: many backend tests boot runtime.mjs/store.mjs, which hard-fail
//      when APP_SECRET is the development fallback. We inject a strong test secret
//      (only if the operator has not already provided one) so the suite is
//      self-contained and does not depend on a shell/.env being pre-loaded.
//   2. Serial execution (--test-concurrency=1): several files share the
//      working-directory-relative data/app.db SQLite database and clobber each
//      other's sessions/CSRF state when run in parallel. Serial is deterministic.
//   3. Explicit, cross-platform file enumeration: cmd.exe does not expand globs and
//      Node's directory form is version-sensitive, so we discover *.test.mjs files
//      in JS and pass explicit paths. This also lets us apply the documented
//      exclusion below without relying on negated globs (which node --test lacks).
//
// LOUD EXCLUSIONS (documented so nobody "re-adds" them by accident):
//
//   web-static-serving.test.mjs
//     The dedicated `test:ui-contract` release-gate step. Requires the compiled
//     apps/web/dist bundle (produced by `npm run web:build`). The Unit tests gate
//     step runs BEFORE web:build (fail fast on backend logic), so the built assets
//     are not guaranteed to exist yet. Running it here would be redundant with
//     test:ui-contract and order-fragile. Coverage stays in the UI contract step.
//
//   master-integration-runner-lifecycle.regression.test.mjs
//   integration-aggregate-exports-handoff.artifact.regression.test.mjs
//     These are integration / gate-orchestration META regressions, not backend
//     unit tests. They copy the whole repo to a temp dir and spawn `npm run
//     test:integration` / the full `scripts/master-validate.mjs` gate (including
//     its E2E browser step) as child processes, and use the Unix-only `ps` command
//     to hunt orphaned handles. Running them inside the fail-fast Unit tests step
//     would (a) recursively invoke the entire release gate from within one of its
//     own steps, ballooning runtime by many minutes, and (b) fail on the target
//     Windows host (`spawn npm ENOENT`, no `ps`, no Playwright browsers here).
//     Their behavior is ALREADY covered by dedicated gate steps: 'Integration
//     suites', 'Aggregate handoff regression', and 'E2E browser checks'. So this is
//     not a coverage drop — it is keeping meta-orchestration tests out of the unit
//     lane where they do not belong.

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = process.cwd()
const testDir = resolve(repoRoot, 'apps/api/src/test')

const EXCLUDED_TEST_FILES = new Set([
  'web-static-serving.test.mjs',
  'master-integration-runner-lifecycle.regression.test.mjs',
  'integration-aggregate-exports-handoff.artifact.regression.test.mjs'
])

function collectTestFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      // fixtures/ holds helper modules and PDFs, not node:test suites; recurse
      // anyway so any future nested *.test.mjs is picked up automatically.
      files.push(...collectTestFiles(fullPath))
    } else if (entry.name.endsWith('.test.mjs') && !EXCLUDED_TEST_FILES.has(entry.name)) {
      files.push(fullPath)
    }
  }
  return files
}

const testFiles = collectTestFiles(testDir).sort()

if (testFiles.length === 0) {
  process.stderr.write('❌ run-unit-tests: no *.test.mjs files discovered under apps/api/src/test\n')
  process.exit(1)
}

// Provide a hermetic, non-fallback APP_SECRET unless the operator supplied one.
const env = { ...process.env }
if (!env.APP_SECRET) {
  env.APP_SECRET = 'unit-test-suite-app-secret-0123456789abcdef0123456789abcdef'
}

process.stdout.write(`Running ${testFiles.length} backend unit test files serially (--test-concurrency=1).\n`)

const result = spawnSync(
  process.execPath,
  ['--test', '--test-concurrency=1', ...testFiles],
  { stdio: 'inherit', env }
)

if (result.error) {
  process.stderr.write(`❌ run-unit-tests: failed to launch node --test: ${result.error.message}\n`)
  process.exit(1)
}

process.exit(result.status ?? 1)

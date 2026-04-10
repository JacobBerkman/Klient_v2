import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
const e2eScriptPath = resolve(repoRoot, 'scripts/e2e-test.mjs')

function readE2eScript() {
  return readFileSync(e2eScriptPath, 'utf8')
}

test('e2e harness enforces strict CI browser runs and allows opt-in local fallback', () => {
  const content = readE2eScript()

  assert.match(content, /const browserFallbackEnvFlag = 'E2E_ALLOW_MISSING_BROWSER_FALLBACK'/)
  assert.match(content, /export function browserFallbackMode\(env = process\.env\)/)
  assert.match(content, /const fallback = browserFallbackMode\(\)/)
  assert.match(content, /if \(fallback\.enabled\) \{/)
  assert.match(content, /CI mode enforces strict browser execution/)
  assert.match(content, /browser: reportValidation\.suiteNames/)

  assert.doesNotMatch(content, /<<<<<<<|>>>>>>>|=======/)
  assert.doesNotMatch(content, /playwrightReportFile/)
  assert.doesNotMatch(content, /existsSync\(/)
  assert.doesNotMatch(content, /readFileSync\(/)
})


test('e2e script loads as an executable module and exports main entrypoint', async () => {
  const module = await import('./e2e-test.mjs')
  assert.equal(typeof module.main, 'function')
  assert.equal(typeof module.validatePlaywrightJsonReport, 'function')
})

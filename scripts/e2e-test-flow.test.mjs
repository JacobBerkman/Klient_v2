import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const e2eScriptPath = resolve(repoRoot, 'scripts/e2e-test.mjs')
const playwrightConfigPath = resolve(repoRoot, 'playwright.config.mjs')

function readE2eScript() {
  return readFileSync(e2eScriptPath, 'utf8')
}

function readPlaywrightConfig() {
  return readFileSync(playwrightConfigPath, 'utf8')
}

test('e2e harness enforces strict CI browser runs and allows opt-in local fallback', () => {
  const content = readE2eScript()

  assert.match(content, /const browserFallbackEnvFlag = 'RELEASE_E2E_ALLOW_FALLBACK'/)
  assert.match(content, /const strictModeEnvFlag = 'RELEASE_E2E_STRICT_MODE'/)
  assert.match(content, /function resolvePlaywrightReportPath\(env = process\.env\)/)
  assert.match(content, /export function browserFallbackMode\(env = process\.env\)/)
  assert.match(content, /const ciSignal = parseBooleanSignal\(env\.CI\)/)
  assert.match(content, /const strictMode = strictOverride \?\? isCi/)
  assert.match(content, /const fallback = browserFallbackMode\(\)/)
  assert.match(content, /const strictMode = fallback\.strictMode/)
  assert.match(content, /Strict browser execution is enabled \(\$\{strictModeEnvFlag\}=1\); \$\{browserFallbackEnvFlag\}=1 is ignored/)
  assert.match(content, /\$\{browserFallbackEnvFlag\}=1 enables local fallback if browser binaries are missing/)
  assert.match(content, /\$\{browserFallbackEnvFlag\} is disabled/)
  assert.match(content, /resolvePlaywrightLinkageEnv\(/)
  assert.match(content, /RELEASE_E2E_PROVISIONING_ARTIFACT/)
  assert.match(content, /RELEASE_E2E_PROVISIONING_VERSION/)
  assert.match(content, /function resolvePlaywrightGrep\(env = process\.env\)/)
  assert.match(content, /const grepSignal = resolvePlaywrightGrep\(baseEnv\)/)
  assert.match(content, /if \(grepSignal\) baseEnv\.PLAYWRIGHT_GREP = grepSignal/)
  assert.match(content, /provisionChromium\(/)
  assert.match(content, /RELEASE_E2E_STRICT_MODE: strictMode \? '1' : '0'/)
  assert.match(content, /browser: reportValidation\.suiteNames/)

  assert.doesNotMatch(content, /<<<<<<<|>>>>>>>|=======/)
  assert.doesNotMatch(content, /playwrightReportFile/)
  assert.doesNotMatch(content, /existsSync\(/)
  assert.doesNotMatch(content, /readFileSync\(/)

  const playwrightRunCalls = [
    ...content.matchAll(/await run\(command, \['playwright', 'test', browserSuitePattern\], runtimeEnv\)/g)
  ]
  assert.equal(playwrightRunCalls.length, 1, 'expected exactly one Playwright execution path via injected run(...)')
  assert.doesNotMatch(content, /runCommand\(command, \['playwright', 'test', browserSuitePattern\], runtimeEnv\)/)
  assert.doesNotMatch(content, /process\.exit\(/)
})

test('playwright config preserves PLAYWRIGHT_GREP regex wiring for tag filters', () => {
  const config = readPlaywrightConfig()
  assert.match(config, /process\.env\.PLAYWRIGHT_GREP/)
  assert.match(config, /grep: new RegExp\(process\.env\.PLAYWRIGHT_GREP, 'i'\)/)
  assert.ok(new RegExp('@release-blocking', 'i').test('@release-blocking'))
})


test('e2e script loads as an executable module and exports main entrypoint', async () => {
  const module = await import('./e2e-test.mjs')
  assert.equal(typeof module.main, 'function')
  assert.equal(typeof module.validatePlaywrightJsonReport, 'function')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)

function readScript(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

test('release preflight provisions Playwright browsers before validate:master', () => {
  const content = readScript('scripts/release-go-no-go.mjs')
  const diagnosticsIndex = content.indexOf('function emitPlaywrightProvisioningDiagnostics()')
  const provisionIndex = content.indexOf("name: 'Flow A.4a Provision Playwright browser binaries'")
  const gateIndex = content.indexOf("name: 'Flow A.4 Hard release gate'")
  const diagnosticsCallIndex = content.indexOf('emitPlaywrightProvisioningDiagnostics()')

  assert.ok(diagnosticsIndex >= 0, 'missing Playwright provisioning diagnostics helper')
  assert.ok(provisionIndex >= 0, 'missing Playwright provisioning step')
  assert.ok(gateIndex >= 0, 'missing hard release gate step')
  assert.ok(diagnosticsCallIndex >= 0, 'missing Playwright provisioning diagnostics call')
  assert.ok(diagnosticsCallIndex < provisionIndex, 'Playwright provisioning diagnostics must run before provisioning')
  assert.ok(provisionIndex < gateIndex, 'Playwright provisioning must run before validate:master')
  assert.match(content, /Playwright provisioning diagnostics: strict mode/)
  assert.match(content, /Playwright provisioning mode: .*npx playwright install --with-deps chromium/)
  assert.match(content, /args: \['playwright', 'install', '--with-deps', 'chromium'\]/)
})

test('master gate keeps canonical E2E browser step label', () => {
  const content = readScript('scripts/master-validate.mjs')
  assert.match(content, /name: 'E2E browser checks'/)
})

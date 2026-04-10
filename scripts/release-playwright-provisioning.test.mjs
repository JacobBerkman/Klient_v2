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
  const provisionIndex = content.indexOf("name: 'Flow A.4a Provision Playwright browser binaries'")
  const gateIndex = content.indexOf("name: 'Flow A.4 Hard release gate'")

  assert.ok(provisionIndex >= 0, 'missing Playwright provisioning step')
  assert.ok(gateIndex >= 0, 'missing hard release gate step')
  assert.ok(provisionIndex < gateIndex, 'Playwright provisioning must run before validate:master')
  assert.match(content, /args: \['playwright', 'install', '--with-deps', 'chromium'\]/)
})

test('master gate keeps canonical E2E browser step label', () => {
  const content = readScript('scripts/master-validate.mjs')
  assert.match(content, /name: 'E2E browser checks'/)
})

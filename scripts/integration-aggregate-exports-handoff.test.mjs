import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const handoffScriptPath = resolve(repoRoot, 'scripts/integration-aggregate-exports-handoff.mjs')

function readHandoffScript() {
  return readFileSync(handoffScriptPath, 'utf8')
}

test('aggregate exports handoff executes via master runner with deterministic suite ordering', () => {
  const content = readHandoffScript()

  assert.match(content, /const suites = \['integration-templates\.mjs', 'integration-exports\.mjs'\]/)
  assert.match(content, /const timeoutMs = 180_000/)
  assert.match(content, /args: \['scripts\/master-integration\.mjs'\]/)
  assert.match(content, /INTEGRATION_SUITES: suites\.join\(','\)/)
  assert.match(content, /timeoutMs/)
  assert.match(content, /suites=\$\{suites\.join\(' -> '\)\}/)

  assert.doesNotMatch(content, /setTimeout\(/)
  assert.doesNotMatch(content, /<<<<<<<|>>>>>>>|=======/)
})

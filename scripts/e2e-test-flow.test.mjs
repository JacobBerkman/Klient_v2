import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
const e2eScriptPath = resolve(repoRoot, 'scripts/e2e-test.mjs')

function readE2eScript() {
  return readFileSync(e2eScriptPath, 'utf8')
}

test('e2e harness keeps one coherent async flow with try/catch/finally lifecycle', () => {
  const content = readE2eScript()

  assert.match(content, /const context = await createTestContext\('e2e-browser-suite'\)/)
  assert.match(content, /try \{/)
  assert.match(content, /const uiContractResult = await runCommand\(process\.execPath, \['--test', \.\.\.uiContractSuites\], baseEnv\)/)
  assert.match(content, /const playwrightResult = await runCommand\(command, \['playwright', 'test', browserSuitePattern\], baseEnv\)/)
  assert.match(content, /evidence\.finalize\(\{[\s\S]*status: 'passed'/)
  assert.match(content, /\} catch \(error\) \{[\s\S]*evidence\.finalize\(\{[\s\S]*status: 'failed'/)
  assert.match(content, /\} finally \{\s*await context\.shutdown\(\)/)

  assert.doesNotMatch(content, /child\.on\('exit', async \(code, signal\)/)
  assert.doesNotMatch(content, /playwrightReportFile/)
  assert.doesNotMatch(content, /existsSync\(/)
  assert.doesNotMatch(content, /readFileSync\(/)
})

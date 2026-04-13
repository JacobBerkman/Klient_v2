import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
const guardScript = resolve(repoRoot, 'scripts/check-conflict-markers.mjs')

function makeWorkspace(name) {
  return mkdtempSync(resolve(tmpdir(), `${name}-`))
}

function runGuard(cwd) {
  return spawnSync(process.execPath, [guardScript], {
    cwd,
    encoding: 'utf8'
  })
}

function initGitRepo(cwd) {
  const init = spawnSync('git', ['init'], { cwd, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  const email = spawnSync('git', ['config', 'user.email', 'tests@example.com'], { cwd, encoding: 'utf8' })
  assert.equal(email.status, 0, email.stderr)
  const name = spawnSync('git', ['config', 'user.name', 'Conflict Marker Tests'], { cwd, encoding: 'utf8' })
  assert.equal(name.status, 0, name.stderr)
}

function writeFile(cwd, relativePath, contents) {
  const filePath = resolve(cwd, relativePath)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, contents)
}

test('guard fails deterministically when release-critical script has conflict marker even when git tracked file list is empty', () => {
  const workspace = makeWorkspace('conflict-marker-untracked-release-critical')
  try {
    initGitRepo(workspace)
    writeFile(
      workspace,
      'scripts/e2e-test.mjs',
      "console.log('before')\n<<<<<<< HEAD\nconsole.log('left')\n=======\nconsole.log('right')\n>>>>>>> main\n"
    )

    const result = runGuard(workspace)
    assert.equal(result.status, 1, `Expected failure.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`)
    assert.match(result.stderr, /scripts\/e2e-test\.mjs:2: <<<<<<< HEAD/)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('guard still passes in clean workspaces where release-critical scripts have no markers', () => {
  const workspace = makeWorkspace('conflict-marker-clean-release-critical')
  try {
    writeFile(workspace, 'scripts/e2e-test.mjs', "console.log('clean e2e script')\n")
    writeFile(workspace, 'scripts/master-validate.mjs', "console.log('clean validate script')\n")

    const result = runGuard(workspace)
    assert.equal(result.status, 0, `Expected success.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`)
    assert.match(result.stdout, /No merge conflict markers/)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

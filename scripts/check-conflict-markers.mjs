import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const MARKER_PATTERN = /^(<<<<<<<|=======|>>>>>>>)(?=\s|$)/m
const TRACKED_TEXT_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.txt',
  '.html',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.json',
  '.yml',
  '.yaml',
  '.sh',
  '.env',
  '.ini',
  '.toml',
  '.sql',
  '.svg',
  '.xml'
])

const SKIP_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'artifacts',
  'coverage',
  'data',
  'dist',
  'build',
  'out',
  'tmp',
  'temp',
  'logs',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo'
])

const RELEASE_CRITICAL_SCRIPTS = [
  'scripts/master-validate.mjs',
  'scripts/check-conflict-markers.mjs',
  'scripts/api-contract-test.mjs',
  'scripts/integration-rbac.mjs',
  'scripts/integration-tenancy.mjs',
  'scripts/master-integration.mjs',
  'scripts/migration-order-check.mjs',
  'scripts/smoke-test.mjs',
  'scripts/e2e-test.mjs',
  'scripts/security-checks.mjs'
]

function isTrackedTextFile(pathname) {
  const lowered = pathname.toLowerCase()
  for (const extension of TRACKED_TEXT_EXTENSIONS) {
    if (lowered.endsWith(extension)) return true
  }
  return pathname === 'Dockerfile'
}

function canUseGit(rootDir) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return true
  } catch {
    return false
  }
}

function listTrackedFilesFromGit(rootDir) {
  const output = execFileSync('git', ['ls-files'], { cwd: rootDir, encoding: 'utf8' })
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(isTrackedTextFile)
}

function listTrackedFilesFromFilesystem(rootDir) {
  const files = []
  const stack = ['']

  while (stack.length > 0) {
    const relativeDir = stack.pop()
    const absoluteDir = resolve(rootDir, relativeDir)
    const entries = readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) stack.push(relativePath)
        continue
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      if (!isTrackedTextFile(relativePath)) continue

      try {
        const fileStats = statSync(resolve(rootDir, relativePath))
        if (!fileStats.isFile()) continue
        files.push(relativePath)
      } catch {
        // Ignore broken symlinks and transient filesystem races.
      }
    }
  }

  return files.sort((a, b) => a.localeCompare(b))
}

function listTrackedFiles(rootDir) {
  const tracked = canUseGit(rootDir) ? listTrackedFilesFromGit(rootDir) : listTrackedFilesFromFilesystem(rootDir)
  const releaseCriticalExisting = RELEASE_CRITICAL_SCRIPTS.filter((relativePath) => {
    try {
      const fileStats = statSync(resolve(rootDir, relativePath))
      return fileStats.isFile()
    } catch {
      return false
    }
  })
  return [...new Set([...tracked, ...releaseCriticalExisting])].sort((a, b) => a.localeCompare(b))
}

const rootDir = process.cwd()
const offenders = []
for (const file of listTrackedFiles(rootDir)) {
  const absolute = resolve(rootDir, file)
  const contents = readFileSync(absolute, 'utf8')
  if (!MARKER_PATTERN.test(contents)) continue

  const lines = contents.split(/\r?\n/)
  lines.forEach((line, index) => {
    if (/^(<<<<<<<|=======|>>>>>>>)(?=\s|$)/.test(line)) {
      offenders.push(`${file}:${index + 1}: ${line}`)
    }
  })
}

if (offenders.length > 0) {
  process.stderr.write('❌ Merge conflict markers detected in tracked files:\n')
  process.stderr.write(`${offenders.join('\n')}\n`)
  process.exit(1)
}

process.stdout.write('✅ No merge conflict markers found in tracked source/docs files.\n')

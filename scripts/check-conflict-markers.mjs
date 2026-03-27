import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MARKER_PATTERN = /^(<<<<<<<|=======|>>>>>>>)\b/m
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

function isTrackedTextFile(pathname) {
  const lowered = pathname.toLowerCase()
  for (const extension of TRACKED_TEXT_EXTENSIONS) {
    if (lowered.endsWith(extension)) return true
  }
  return pathname === 'Dockerfile'
}

function listTrackedFiles() {
  const output = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(isTrackedTextFile)
}

const offenders = []
for (const file of listTrackedFiles()) {
  const absolute = resolve(process.cwd(), file)
  const contents = readFileSync(absolute, 'utf8')
  if (!MARKER_PATTERN.test(contents)) continue

  const lines = contents.split(/\r?\n/)
  lines.forEach((line, index) => {
    if (/^(<<<<<<<|=======|>>>>>>>)\b/.test(line)) {
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

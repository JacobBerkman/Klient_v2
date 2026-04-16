import { spawn } from 'node:child_process'

const isWindows = process.platform === 'win32'
const nodeCommand = process.execPath
const npmCommand = isWindows ? 'npm.cmd' : 'npm'

function prefixStream(stream, prefix, target) {
  let buffer = ''
  stream.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) {
      target.write(`${prefix} ${line}\n`)
    }
  })
  stream.on('end', () => {
    if (buffer) target.write(`${prefix} ${buffer}\n`)
  })
}

function startProcess({ name, command, args, env = process.env }) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: false
  })

  prefixStream(child.stdout, `[${name}]`, process.stdout)
  prefixStream(child.stderr, `[${name}]`, process.stderr)

  child.on('spawn', () => {
    process.stdout.write(`[${name}] started: ${command} ${args.join(' ')}\n`)
  })

  return child
}

const children = new Set()
let shuttingDown = false

function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true

  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }

  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) child.kill('SIGKILL')
    }
  }, 2_000).unref()

  setTimeout(() => {
    process.exit(exitCode)
  }, 2_100).unref()
}

const api = startProcess({
  name: 'api',
  command: nodeCommand,
  args: ['--env-file=.env', 'apps/api/src/server.mjs'],
  env: {
    ...process.env
  }
})

const web = startProcess({
  name: 'web',
  command: npmCommand,
  args: ['--prefix', 'apps/web', 'run', 'dev'],
  env: {
    ...process.env,
    KLIENT_API_ORIGIN: process.env.KLIENT_API_ORIGIN || 'http://127.0.0.1:3000'
  }
})

children.add(api)
children.add(web)

for (const [name, child] of [
  ['api', api],
  ['web', web]
]) {
  child.on('exit', (code, signal) => {
    children.delete(child)
    if (shuttingDown) return
    const detail = signal ? `signal ${signal}` : `code ${code ?? 0}`
    process.stderr.write(`[${name}] exited with ${detail}\n`)
    shutdown(Number.isInteger(code) ? code : 1)
  })

  child.on('error', (error) => {
    if (shuttingDown) return
    process.stderr.write(`[${name}] failed to start: ${error.message}\n`)
    shutdown(1)
  })
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

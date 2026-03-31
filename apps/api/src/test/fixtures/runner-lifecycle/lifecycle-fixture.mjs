import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const workerPath = fileURLToPath(new URL('./child-worker.mjs', import.meta.url))
const child = spawn(process.execPath, [workerPath], {
  stdio: ['ignore', 'ignore', 'ignore']
})

setTimeout(() => {
  child.kill('SIGTERM')
}, 75)

const [code, signal] = await once(child, 'exit')

if (signal && signal !== 'SIGTERM') {
  process.exit(1)
}

process.exit(code === null || code === 0 ? 0 : 1)

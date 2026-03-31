import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const childPath = fileURLToPath(new URL('./stdout-holder-child.mjs', import.meta.url))
const child = spawn(process.execPath, [childPath], {
  stdio: ['ignore', 'inherit', 'ignore']
})

child.unref()

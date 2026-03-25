import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'

const integrationSuites = [
  {
    script: 'integration-tenancy.mjs',
    invariant: 'Tenant isolation blocks cross-tenant read/write access and cross-tenant audit visibility.'
  },
  {
    script: 'integration-rbac.mjs',
    invariant: 'Direct RBAC checks enforce readonly/advisor restrictions for privileged routes.'
  },
  {
    script: 'integration-rbac-matrix.mjs',
    invariant: 'Policy matrix allow/deny behavior is enforced for every role/route guard pairing.'
  },
  {
    script: 'integration-templates.mjs',
    invariant: 'Template lifecycle remains consistent across create/update/publish pathways.'
  },
  {
    script: 'integration-exports.mjs',
    invariant: 'Export workflows maintain expected lifecycle transitions and retry behavior.'
  },
  {
    script: 'integration-portal-lifecycle.mjs',
    invariant: 'Portal access lifecycle enforces token, submission, and upload requirements.'
  },
  {
    script: 'integration-submission-repeatable-items.mjs',
    invariant: 'Repeatable submission data remains stable through create/update flows.'
  },
  {
    script: 'integration-analytics.mjs',
    invariant: 'Analytics endpoints remain queryable with authenticated data-scoped responses.'
  },
  {
    script: 'integration-csrf.mjs',
    invariant: 'CSRF protection is enforced for protected methods while exempt routes remain functional.'
  },
  {
    script: 'integration-audit.mjs',
    invariant: 'Required canonical audit events and payload fields are emitted for sensitive actions.'
  }
]

async function ensureScriptExists(script) {
  await access(new URL(`./${script}`, import.meta.url))
}

function runSuite(suite, index, total) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    console.log(`\n▶ [${index + 1}/${total}] ${suite.script}`)
    console.log(`   Invariant: ${suite.invariant}`)

    const child = spawn(process.execPath, [`scripts/${suite.script}`], {
      stdio: 'inherit'
    })

    child.on('error', (error) => {
      reject(new Error(`${suite.script} failed to start: ${error.message}`))
    })

    child.on('exit', (code, signal) => {
      const durationMs = Date.now() - start
      if (signal) {
        reject(new Error(`${suite.script} terminated by signal ${signal} after ${durationMs}ms`))
        return
      }
      if (code !== 0) {
        reject(new Error(`${suite.script} exited with code ${code} after ${durationMs}ms`))
        return
      }

      console.log(`✓ ${suite.script} passed in ${durationMs}ms`)
      resolve({ durationMs })
    })
  })
}

async function main() {
  console.log('Starting integration suite in deterministic order with explicit invariant coverage.')

  for (const suite of integrationSuites) {
    await ensureScriptExists(suite.script)
  }

  const executed = []

  for (let index = 0; index < integrationSuites.length; index += 1) {
    const suite = integrationSuites[index]
    const result = await runSuite(suite, index, integrationSuites.length)
    executed.push({ script: suite.script, durationMs: result.durationMs })
  }

  const totalDurationMs = executed.reduce((sum, run) => sum + run.durationMs, 0)
  console.log('\n✅ All integration scripts passed.')
  console.log(`Executed ${executed.length} suites in ${totalDurationMs}ms.`)
}

main().catch((error) => {
  console.error(`\n❌ Integration suite failed: ${error.message}`)
  process.exit(1)
})

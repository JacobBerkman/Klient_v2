import { spawn } from 'node:child_process';

const integrationScripts = [
  'integration-tenancy.mjs',
  'integration-rbac.mjs',
  'integration-rbac-matrix.mjs',
  'integration-templates.mjs',
  'integration-exports.mjs',
  'integration-portal-lifecycle.mjs',
  'integration-submission-repeatable-items.mjs',
  'integration-analytics.mjs',
  'integration-csrf.mjs'
];

function runScript(script) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    console.log(`\n▶ Running ${script}`);

    const child = spawn(process.execPath, [`scripts/${script}`], {
      stdio: 'inherit'
    });

    child.on('error', (error) => {
      reject(new Error(`${script} failed to start: ${error.message}`));
    });

    child.on('exit', (code, signal) => {
      const durationMs = Date.now() - start;
      if (signal) {
        reject(new Error(`${script} terminated by signal ${signal} after ${durationMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${script} exited with code ${code} after ${durationMs}ms`));
        return;
      }
      console.log(`✓ ${script} passed in ${durationMs}ms`);
      resolve();
    });
  });
}

async function main() {
  console.log('Starting integration suite in deterministic order.');

  for (const script of integrationScripts) {
    await runScript(script);
  }

  console.log('\n✅ All integration scripts passed.');
}

main().catch((error) => {
  console.error(`\n❌ Integration suite failed: ${error.message}`);
  process.exit(1);
});

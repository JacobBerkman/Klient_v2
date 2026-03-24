import { spawn } from 'node:child_process';

const gateSteps = [
  { name: 'Static syntax checks', command: 'npm', args: ['run', 'check:syntax'] },
  { name: 'API contract tests', command: 'npm', args: ['run', 'test:contract'] },
  { name: 'Integration suites', command: 'npm', args: ['run', 'test:integration'] },
  { name: 'Migration order checks', command: 'npm', args: ['run', 'check:migrations'] },
  { name: 'Smoke test', command: 'npm', args: ['run', 'test:smoke'] },
  { name: 'Security checks', command: 'npm', args: ['run', 'test:security'] },
  { name: 'Merge/main parity check', command: 'npm', args: ['run', 'check:merge-main'] }
];

function runStep(step) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`\n▶ ${step.name}\n$ ${step.command} ${step.args.join(' ')}\n\n`);
    const child = spawn(step.command, step.args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: process.env
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${step.name} terminated by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        const error = new Error(`${step.name} failed with exit code ${code}`);
        error.exitCode = code;
        reject(error);
        return;
      }
      resolve();
    });
  });
}

try {
  for (const step of gateSteps) {
    // eslint-disable-next-line no-await-in-loop
    await runStep(step);
  }
  process.stdout.write('\n✅ Hard release gate passed.\n');
} catch (error) {
  process.stderr.write(`\n❌ ${error.message}\n`);
  process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
}

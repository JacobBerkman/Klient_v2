import { spawn } from 'node:child_process';

const steps = [
  {
    name: 'Static syntax checks',
    command: 'npm',
    args: ['run', 'check:syntax'],
  },
  {
    name: 'Unit/runtime contract tests',
    command: 'npm',
    args: ['run', 'test:runtime-contract'],
  },
  {
    name: 'Smoke test',
    command: 'npm',
    args: ['run', 'test:smoke'],
  },
  {
    name: 'Integration suites',
    command: 'npm',
    args: ['run', 'test:integration'],
  },
  {
    name: 'Merge/main parity check',
    command: 'npm',
    args: ['run', 'check:merge-main'],
  },
];

const runStep = (step) =>
  new Promise((resolve, reject) => {
    process.stdout.write(`\n▶ ${step.name}\n$ ${step.command} ${step.args.join(' ')}\n\n`);

    const child = spawn(step.command, step.args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: process.env,
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

try {
  for (const step of steps) {
    // eslint-disable-next-line no-await-in-loop
    await runStep(step);
  }

  process.stdout.write('\n✅ Master validation completed successfully.\n');
} catch (error) {
  process.stderr.write(`\n❌ ${error.message}\n`);
  process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
}

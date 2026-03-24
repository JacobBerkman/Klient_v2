import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { DB_PATH } from '../apps/api/src/storage.mjs';

const sourcePath = process.argv[2];
if (!sourcePath) {
  console.error('Usage: node scripts/restore-db.mjs <backup-file>');
  process.exit(1);
}

const resolvedSource = resolve(process.cwd(), sourcePath);
if (!existsSync(resolvedSource)) {
  console.error(`Backup file not found: ${resolvedSource}`);
  process.exit(1);
}

mkdirSync(dirname(DB_PATH), { recursive: true });
copyFileSync(resolvedSource, DB_PATH);
console.log(JSON.stringify({ ok: true, sourcePath: resolvedSource, targetPath: DB_PATH }, null, 2));

import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const dataDir = resolve(process.cwd(), 'data');
const dbPath = resolve(dataDir, 'app.db');

await mkdir(dataDir, { recursive: true });
await rm(dbPath, { force: true });

// Importing storage recreates schema from a clean database deterministically.
await import('../apps/api/src/storage.mjs');

console.log(JSON.stringify({ ok: true, action: 'reset', dbPath }, null, 2));

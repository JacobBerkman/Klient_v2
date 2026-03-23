import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = resolve(process.cwd(), 'data', 'app.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

export function loadState(seedFactory) {
  const row = db.prepare('SELECT payload FROM app_state WHERE id = 1').get();
  if (row?.payload) {
    return JSON.parse(row.payload);
  }

  const state = seedFactory();
  saveState(state);
  return state;
}

export function saveState(state) {
  db.prepare(`
    INSERT INTO app_state (id, payload, updated_at)
    VALUES (1, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `).run(JSON.stringify(state));
}

export function backupState(targetPath) {
  const row = db.prepare('SELECT payload FROM app_state WHERE id = 1').get();
  return { ok: true, targetPath, bytes: row?.payload?.length || 0 };
}

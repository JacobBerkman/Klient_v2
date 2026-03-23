import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DB_PATH = resolve(process.cwd(), 'data', 'app.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS firms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    stage TEXT,
    stage_order_index INTEGER,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS households (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    name TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS form_templates (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    name TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS document_templates (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS export_jobs (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    client_id TEXT,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    action TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    payload TEXT NOT NULL
  );
`);

function replaceRows(tableName, rows, mapper) {
  db.exec(`DELETE FROM ${tableName}`);
  for (const row of rows) {
    const mapped = mapper(row);
    const placeholders = mapped.map(() => '?').join(', ');
    db.prepare(`INSERT INTO ${tableName} VALUES (${placeholders})`).run(...mapped);
  }
}

function syncQueryTables(state) {
  replaceRows('firms', state.firms || [], (firm) => [firm.id, firm.name, firm.slug, JSON.stringify(firm)]);
  replaceRows('users', state.users || [], (user) => [user.id, user.firmId, user.email, user.role, JSON.stringify(user)]);
  replaceRows('profiles', state.profiles || [], (profile) => [profile.id, profile.firmId, profile.kind, profile.firstName, profile.lastName, profile.stage || null, profile.stageOrderIndex || null, JSON.stringify(profile)]);
  replaceRows('households', state.households || [], (household) => [household.id, household.firmId, household.name, JSON.stringify(household)]);
  replaceRows('form_templates', state.formTemplates || [], (template) => [template.id, template.firmId, template.name, JSON.stringify(template)]);
  replaceRows('document_templates', state.documentTemplates || [], (template) => [template.id, template.firmId, template.name, template.status || 'draft', JSON.stringify(template)]);
  replaceRows('export_jobs', state.exportJobs || [], (job) => [job.id, job.firmId, job.clientId || null, job.type, job.status, JSON.stringify(job)]);
  replaceRows('notes', state.notes || [], (note) => [note.id, note.firmId, note.profileId, note.createdAt, JSON.stringify(note)]);
  replaceRows('audit_events', state.auditEvents || [], (event) => [event.id, event.firmId, event.action, event.occurredAt, JSON.stringify(event)]);
}

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
  syncQueryTables(state);
}

export function backupState(targetPath = resolve(process.cwd(), 'data', `backup-${Date.now()}.db`)) {
  copyFileSync(DB_PATH, targetPath);
  return { ok: true, targetPath };
}

export function readQuerySummary() {
  return {
    firms: db.prepare('SELECT COUNT(*) AS count FROM firms').get().count,
    users: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
    profiles: db.prepare('SELECT COUNT(*) AS count FROM profiles').get().count,
    households: db.prepare('SELECT COUNT(*) AS count FROM households').get().count,
    templates: db.prepare('SELECT COUNT(*) AS count FROM document_templates').get().count,
    exports: db.prepare('SELECT COUNT(*) AS count FROM export_jobs').get().count
  };
}

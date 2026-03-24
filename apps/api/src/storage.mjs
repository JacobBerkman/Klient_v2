import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
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

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    firm_id TEXT NOT NULL,
    expires_at TEXT,
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

  CREATE TABLE IF NOT EXISTS household_members (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    firm_id TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS stage_changes (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    changed_at TEXT,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS form_templates (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    name TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS form_submissions (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    client_id TEXT,
    template_id TEXT,
    status TEXT,
    updated_at TEXT,
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

  CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS portal_links (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    token TEXT NOT NULL,
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

const COLLECTIONS = {
  firms: { table: 'firms', map: (firm) => [firm.id, firm.name, firm.slug, JSON.stringify(firm)] },
  users: { table: 'users', map: (user) => [user.id, user.firmId, user.email, user.role, JSON.stringify(user)] },
  sessions: { table: 'sessions', map: (session) => [session.token, session.userId, session.firmId, session.expiresAt || null, JSON.stringify(session)] },
  profiles: { table: 'profiles', map: (profile) => [profile.id, profile.firmId, profile.kind, profile.firstName, profile.lastName, profile.stage || null, profile.stageOrderIndex || null, JSON.stringify(profile)] },
  households: { table: 'households', map: (household) => [household.id, household.firmId, household.name, JSON.stringify(household)] },
  householdMembers: { table: 'household_members', map: (member) => [`${member.householdId}:${member.clientId}:${member.createdAt || ''}`, member.householdId, member.clientId, member.firmId, JSON.stringify(member)] },
  stageChanges: { table: 'stage_changes', map: (entry) => [entry.id, entry.firmId, entry.clientId, entry.changedAt || null, JSON.stringify(entry)] },
  formTemplates: { table: 'form_templates', map: (template) => [template.id, template.firmId, template.name, JSON.stringify(template)] },
  formSubmissions: { table: 'form_submissions', map: (submission) => [submission.id, submission.firmId, submission.clientId || null, submission.templateId || null, submission.status || null, submission.updatedAt || null, JSON.stringify(submission)] },
  documentTemplates: { table: 'document_templates', map: (template) => [template.id, template.firmId, template.name, template.status || 'draft', JSON.stringify(template)] },
  exportJobs: { table: 'export_jobs', map: (job) => [job.id, job.firmId, job.clientId || null, job.type, job.status, JSON.stringify(job)] },
  notes: { table: 'notes', map: (note) => [note.id, note.firmId, note.profileId, note.createdAt, JSON.stringify(note)] },
  invites: { table: 'invites', map: (invite) => [invite.id, invite.firmId, invite.email, invite.role, JSON.stringify(invite)] },
  passwordResets: { table: 'password_resets', map: (reset) => [reset.id, reset.userId, JSON.stringify(reset)] },
  portalLinks: { table: 'portal_links', map: (link) => [link.id, link.firmId, link.profileId, link.token, JSON.stringify(link)] },
  auditEvents: { table: 'audit_events', map: (event) => [event.id, event.firmId, event.action, event.occurredAt, JSON.stringify(event)] }
};

function replaceRows(tableName, rows, mapper) {
  db.exec(`DELETE FROM ${tableName}`);
  for (const row of rows) {
    const mapped = mapper(row);
    const placeholders = mapped.map(() => '?').join(', ');
    db.prepare(`INSERT INTO ${tableName} VALUES (${placeholders})`).run(...mapped);
  }
}

function readCollection(name) {
  const config = COLLECTIONS[name];
  const rows = db.prepare(`SELECT payload FROM ${config.table}`).all();
  return rows.map((row) => JSON.parse(row.payload));
}

function writeCollection(name, rows) {
  const config = COLLECTIONS[name];
  replaceRows(config.table, rows || [], config.map);
}

function readStateFromCollections() {
  return Object.fromEntries(Object.keys(COLLECTIONS).map((key) => [key, readCollection(key)]));
}

function hasCollectionData() {
  return Object.values(COLLECTIONS).some((config) => db.prepare(`SELECT 1 FROM ${config.table} LIMIT 1`).get());
}

function migrateAppStateBlobIfNeeded() {
  if (hasCollectionData()) {
    return;
  }

  const row = db.prepare('SELECT payload FROM app_state WHERE id = 1').get();
  if (!row?.payload) {
    return;
  }

  const legacyState = JSON.parse(row.payload);
  writeCollections(legacyState);
}

function writeCollections(state, keys = Object.keys(COLLECTIONS)) {
  for (const key of keys) {
    writeCollection(key, state[key] || []);
  }
}

export function createStateRepository(seedFactory) {
  migrateAppStateBlobIfNeeded();

  return {
    load() {
      if (!hasCollectionData()) {
        const seeded = seedFactory();
        this.save(seeded);
        return seeded;
      }
      return readStateFromCollections();
    },
    save(state, keys = Object.keys(COLLECTIONS)) {
      writeCollections(state, keys);
      db.prepare(`
        INSERT INTO app_state (id, payload, updated_at)
        VALUES (1, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
      `).run(JSON.stringify(state));
    },
    list(collection) {
      return readCollection(collection);
    }
  };
}

export function ensureDatabaseReady() {
  db.prepare('SELECT 1').get();
  return {
    ok: true,
    dbPath: DB_PATH,
    exists: existsSync(DB_PATH)
  };
}

export function closeDatabase() {
  db.close();
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

export function completeQueuedExports() {
  const queuedRows = db.prepare('SELECT payload FROM export_jobs WHERE status = ?').all('queued');
  if (!queuedRows.length) return { processed: 0 };

  let processed = 0;
  const updateStmt = db.prepare('UPDATE export_jobs SET status = ?, payload = ? WHERE id = ?');

  for (const row of queuedRows) {
    const job = JSON.parse(row.payload);
    job.status = 'completed';
    job.output = { fileName: `${job.type}-${Date.now()}.json`, preview: { clientId: job.clientId, templateId: job.templateId } };
    job.updatedAt = new Date().toISOString();
    updateStmt.run(job.status, JSON.stringify(job), job.id);
    processed += 1;
  }

  return { processed };
}

import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const dbPath = resolve(process.cwd(), 'data', 'app.db')
const db = new DatabaseSync(dbPath)

function ensureOrderIndexColumn() {
  const columns = db.prepare('PRAGMA table_info(profiles)').all()
  if (!columns.some((column) => column.name === 'order_index')) {
    db.exec('ALTER TABLE profiles ADD COLUMN order_index INTEGER')
  }
}

function backfillProfileTable() {
  db.exec(`
    UPDATE profiles
    SET order_index = COALESCE(order_index, stage_order_index, json_extract(payload, '$.orderIndex'), json_extract(payload, '$.stageOrderIndex'))
  `)
}

function migrateAppStatePayload() {
  const row = db.prepare('SELECT payload FROM app_state WHERE id = 1').get()
  if (!row?.payload) return { migrated: 0 }
  const state = JSON.parse(row.payload)
  const profiles = Array.isArray(state.profiles) ? state.profiles : []

  const groups = new Map()
  for (const profile of profiles) {
    if (profile?.kind !== 'prospect') continue
    const key = `${profile.firmId}:${profile.stage || 'discovery'}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(profile)
  }

  let migrated = 0
  for (const cards of groups.values()) {
    cards.sort((a, b) => {
      const aIdx = Number(a.orderIndex ?? a.stageOrderIndex ?? Number.MAX_SAFE_INTEGER)
      const bIdx = Number(b.orderIndex ?? b.stageOrderIndex ?? Number.MAX_SAFE_INTEGER)
      if (aIdx !== bIdx) return aIdx - bIdx
      const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime()
      const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime()
      if (aTime !== bTime) return aTime - bTime
      return String(a.id || '').localeCompare(String(b.id || ''))
    })
    cards.forEach((card, index) => {
      const next = index + 1
      if (card.orderIndex !== next || card.stageOrderIndex !== next) {
        card.orderIndex = next
        card.stageOrderIndex = next
        migrated += 1
      }
    })
  }

  if (migrated > 0) {
    db.prepare(
      `
      UPDATE app_state
      SET payload = ?, updated_at = datetime('now')
      WHERE id = 1
    `
    ).run(JSON.stringify(state))
  }
  return { migrated }
}

try {
  ensureOrderIndexColumn()
  backfillProfileTable()
  const result = migrateAppStatePayload()
  console.log(JSON.stringify({ ok: true, dbPath, ...result }, null, 2))
} finally {
  db.close()
}

import { DatabaseSync } from 'node:sqlite'
import { DB_PATH } from '../storage.mjs'

const db = new DatabaseSync(DB_PATH)

function parsePayloadRows(rows) {
  return rows.map((row) => JSON.parse(row.payload))
}

export class SqliteReadRepository {
  listProfiles(firmId, { kind, search } = {}) {
    const conditions = ['firm_id = ?']
    const params = [firmId]
    if (kind) {
      conditions.push('kind = ?')
      params.push(kind)
    }
    if (search) {
      conditions.push(
        "(lower(first_name) LIKE ? OR lower(last_name) LIKE ? OR lower(json_extract(payload, '$.email')) LIKE ?)"
      )
      const q = `%${String(search).toLowerCase()}%`
      params.push(q, q, q)
    }

    const rows = db
      .prepare(
        `SELECT payload FROM profiles
         WHERE ${conditions.join(' AND ')}
         ORDER BY
           coalesce(stage, ''),
           coalesce(order_index, stage_order_index, 2147483647),
           coalesce(json_extract(payload, '$.updatedAt'), json_extract(payload, '$.createdAt'), ''),
           id`
      )
      .all(...params)
    return parsePayloadRows(rows)
  }

  getProfileDetail(firmId, profileId) {
    const row = db.prepare('SELECT payload FROM profiles WHERE id = ? AND firm_id = ?').get(profileId, firmId)
    return row ? JSON.parse(row.payload) : null
  }

  getAnalytics(firmId) {
    const stageRows = db
      .prepare(
        `SELECT coalesce(stage, 'unassigned') AS stage, COUNT(*) AS count FROM profiles WHERE firm_id = ? AND kind = 'prospect' GROUP BY coalesce(stage, 'unassigned')`
      )
      .all(firmId)
    return Object.fromEntries(stageRows.map((row) => [row.stage, row.count]))
  }

  getAnalyticsMaterialized(firmId) {
    const row = db.prepare('SELECT payload FROM analytics_materialized WHERE firm_id = ?').get(firmId)
    return row?.payload ? JSON.parse(row.payload) : null
  }

  getQueuedExports(firmId) {
    const rows = db.prepare('SELECT payload FROM export_jobs WHERE firm_id = ? AND status = ?').all(firmId, 'queued')
    return parsePayloadRows(rows)
  }
}

import { DatabaseSync } from 'node:sqlite'
import { DB_PATH } from '../storage.mjs'

const db = new DatabaseSync(DB_PATH)

function parsePayloadRows(rows) {
  return rows.map((row) => JSON.parse(row.payload))
}

function requireFirmId(firmId, method) {
  const value = String(firmId || '')
  if (!value) {
    throw new Error(`firmId is required for ${method}.`)
  }
  return value
}

export class SqliteReadRepository {
  listProfiles(firmId, { kind, search, status } = {}) {
    const conditions = ['firm_id = ?']
    const params = [requiredFirmId]
    if (kind) {
      conditions.push('kind = ?')
      params.push(kind)
    }
    if (status) {
      conditions.push('profile_status = ?')
      params.push(status)
    }
    if (search) {
      conditions.push('(lower(first_name) LIKE ? OR lower(last_name) LIKE ? OR lower(email) LIKE ?)')
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
    const requiredFirmId = requireFirmId(firmId, 'SqliteReadRepository.getProfileDetail')
    const row = db.prepare('SELECT payload FROM profiles WHERE id = ? AND firm_id = ?').get(profileId, requiredFirmId)
    return row ? JSON.parse(row.payload) : null
  }

  getAnalytics(firmId) {
    const requiredFirmId = requireFirmId(firmId, 'SqliteReadRepository.getAnalytics')
    const stageRows = db
      .prepare(
        `SELECT coalesce(stage, 'unassigned') AS stage, COUNT(*) AS count FROM profiles WHERE firm_id = ? AND kind = 'prospect' GROUP BY coalesce(stage, 'unassigned')`
      )
      .all(requiredFirmId)
    return Object.fromEntries(stageRows.map((row) => [row.stage, row.count]))
  }

  getAnalyticsMaterialized(firmId) {
    const requiredFirmId = requireFirmId(firmId, 'SqliteReadRepository.getAnalyticsMaterialized')
    const row = db.prepare('SELECT payload FROM analytics_materialized WHERE firm_id = ?').get(requiredFirmId)
    return row?.payload ? JSON.parse(row.payload) : null
  }

  getQueuedExports(firmId) {
    const requiredFirmId = requireFirmId(firmId, 'SqliteReadRepository.getQueuedExports')
    const rows = db
      .prepare('SELECT payload FROM export_jobs WHERE firm_id = ? AND status = ?')
      .all(requiredFirmId, 'queued')
    return parsePayloadRows(rows)
  }
}

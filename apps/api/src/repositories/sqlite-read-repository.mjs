import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '../storage.mjs';

const db = new DatabaseSync(DB_PATH);

function parsePayloadRows(rows) {
  return rows.map((row) => JSON.parse(row.payload));
}

export class SqliteReadRepository {
  listProfiles(firmId, filters = {}) {
    const { kind, search, location, venue, event, occurredFrom, occurredTo } = filters;
    const conditions = ['firm_id = ?'];
    const params = [firmId];
    if (kind) {
      conditions.push('kind = ?');
      params.push(kind);
    }
    if (search) {
      conditions.push("(lower(first_name) LIKE ? OR lower(last_name) LIKE ? OR lower(json_extract(payload, '$.email')) LIKE ?)");
      const q = `%${String(search).toLowerCase()}%`;
      params.push(q, q, q);
    }
    if (location) {
      conditions.push("lower(coalesce(json_extract(payload, '$.source.cityOrLocation'), '')) LIKE ?");
      params.push(`%${String(location).toLowerCase()}%`);
    }
    if (venue) {
      conditions.push("lower(coalesce(json_extract(payload, '$.source.venue'), '')) LIKE ?");
      params.push(`%${String(venue).toLowerCase()}%`);
    }
    if (event) {
      conditions.push("(lower(coalesce(json_extract(payload, '$.source.eventName'), '')) LIKE ? OR lower(coalesce(json_extract(payload, '$.source.venue'), '')) LIKE ?)");
      const eventQuery = `%${String(event).toLowerCase()}%`;
      params.push(eventQuery, eventQuery);
    }
    if (occurredFrom) {
      conditions.push("date(coalesce(json_extract(payload, '$.source.occurredOn'), '')) >= date(?)");
      params.push(String(occurredFrom));
    }
    if (occurredTo) {
      conditions.push("date(coalesce(json_extract(payload, '$.source.occurredOn'), '')) <= date(?)");
      params.push(String(occurredTo));
    }

    const rows = db.prepare(`SELECT payload FROM profiles WHERE ${conditions.join(' AND ')} ORDER BY coalesce(stage_order_index, 0), last_name, first_name`).all(...params);
    return parsePayloadRows(rows);
  }

  getProfileDetail(firmId, profileId) {
    const row = db.prepare('SELECT payload FROM profiles WHERE id = ? AND firm_id = ?').get(profileId, firmId);
    return row ? JSON.parse(row.payload) : null;
  }

  getAnalytics(firmId) {
    const stageRows = db.prepare(`SELECT coalesce(stage, 'unassigned') AS stage, COUNT(*) AS count FROM profiles WHERE firm_id = ? AND kind = 'prospect' GROUP BY coalesce(stage, 'unassigned')`).all(firmId);
    return Object.fromEntries(stageRows.map((row) => [row.stage, row.count]));
  }

  getSourceReport(firmId, filters = {}) {
    const { occurredFrom, occurredTo } = filters;
    const conditions = ['firm_id = ?', "json_extract(payload, '$.source.occurredOn') IS NOT NULL"];
    const params = [firmId];

    if (occurredFrom) {
      conditions.push("date(json_extract(payload, '$.source.occurredOn')) >= date(?)");
      params.push(String(occurredFrom));
    }
    if (occurredTo) {
      conditions.push("date(json_extract(payload, '$.source.occurredOn')) <= date(?)");
      params.push(String(occurredTo));
    }

    const whereClause = conditions.join(' AND ');
    const byDate = db.prepare(`SELECT date(json_extract(payload, '$.source.occurredOn')) AS occurredOn, COUNT(*) AS count
      FROM profiles WHERE ${whereClause} GROUP BY date(json_extract(payload, '$.source.occurredOn')) ORDER BY occurredOn DESC`).all(...params);
    const byLocation = db.prepare(`SELECT coalesce(nullif(json_extract(payload, '$.source.cityOrLocation'), ''), 'Unknown') AS key, COUNT(*) AS count
      FROM profiles WHERE ${whereClause} GROUP BY key ORDER BY count DESC, key ASC`).all(...params);
    const byVenue = db.prepare(`SELECT coalesce(nullif(json_extract(payload, '$.source.venue'), ''), 'Unknown') AS key, COUNT(*) AS count
      FROM profiles WHERE ${whereClause} GROUP BY key ORDER BY count DESC, key ASC`).all(...params);
    const byEvent = db.prepare(`SELECT coalesce(nullif(json_extract(payload, '$.source.eventName'), ''), nullif(json_extract(payload, '$.source.venue'), ''), 'Unknown') AS key, COUNT(*) AS count
      FROM profiles WHERE ${whereClause} GROUP BY key ORDER BY count DESC, key ASC`).all(...params);

    return {
      totals: {
        records: byDate.reduce((sum, row) => sum + row.count, 0),
        uniqueDates: byDate.length,
        uniqueLocations: byLocation.length,
        uniqueVenues: byVenue.length,
        uniqueEvents: byEvent.length
      },
      byDate,
      byLocation,
      byVenue,
      byEvent
    };
  }

  getQueuedExports(firmId) {
    const rows = db.prepare('SELECT payload FROM export_jobs WHERE firm_id = ? AND status = ?').all(firmId, 'queued');
    return parsePayloadRows(rows);
  }
}

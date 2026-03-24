# Deployment

## Environment contract
Copy `.env.example` to `.env` and set at least:

```bash
APP_SECRET=replace-with-a-long-random-secret
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
LOG_LEVEL=info
```

`APP_SECRET` is required in production and should be a long random value.

## Local Docker run
```bash
docker compose --env-file .env up --build -d
```

The app will be available at `http://localhost:3000`.

## Health and readiness
Use:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

`/ready` verifies SQLite connectivity and returns:
- table query counts
- storage diagnostics (file path, size, quick check, latency)
- export worker queue status
- audit event totals/latest record
- runtime config validation (issues/warnings)

For deeper runtime diagnostics per tenant, call:

```bash
curl -H "Authorization: Bearer <token>" http://localhost:3000/api/ops/diagnostics
```

This includes startup metadata (`bootedAt`, PID, uptime), config validation details, storage health, export status distribution, and firm audit summaries.

## Persistent data
The app stores seeded and runtime data in `data/app.db`.
Mount `./data` into the container to persist changes across restarts.

## Backup and restore
Create a backup:

```bash
node scripts/backup-db.mjs
```

Restore from a backup file:

```bash
node scripts/restore-db.mjs data/backup-<timestamp>.db
```

## Logs and shutdown
The API emits structured JSON logs to stdout/stderr.
Use your container/runtime log collector to ship them to your observability stack.
The server also handles `SIGTERM`/`SIGINT` for graceful shutdown.

On startup, the app emits a `server.started` log event with an embedded diagnostics snapshot. If configuration warnings exist, a `runtime.config.warnings` event is emitted; configuration errors produce `runtime.config.invalid`.

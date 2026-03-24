# Deployment

## Single deployable runtime
The repository now presents one deployable application:
- entrypoint: `node apps/api/src/server.mjs`
- UI assets: `apps/web/public`
- persistent data: `data/app.db`
- container image: `Dockerfile`

## Environment contract
Copy `.env.example` to `.env` and set at least:

```bash
APP_SECRET=replace-with-a-long-random-secret
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
LOG_LEVEL=info
SERVICE_NAME=kinetic-klient-api
INSTANCE_ID=prod-1
MAX_BODY_BYTES=1000000
REQUEST_TIMEOUT_MS=15000
HEADERS_TIMEOUT_MS=20000
KEEP_ALIVE_TIMEOUT_MS=5000
```

### Required
- `APP_SECRET`: required in production; use a long random value.

### Optional hardening/runtime knobs
- `MAX_BODY_BYTES`: rejects oversized JSON requests with HTTP 413.
- `REQUEST_TIMEOUT_MS`: total request timeout applied by the Node HTTP server.
- `HEADERS_TIMEOUT_MS`: header read timeout.
- `KEEP_ALIVE_TIMEOUT_MS`: idle keep-alive timeout.
- `SERVICE_NAME` / `INSTANCE_ID`: injected into structured logs.

## Local Docker run
```bash
docker compose --env-file .env up --build -d
```

The app is available at `http://localhost:3000`.

## Health and readiness
Use:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

- `/health` is the liveness endpoint.
- `/ready` verifies SQLite availability and returns a query summary.

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
- The API emits structured JSON logs to stdout/stderr.
- The server handles `SIGTERM` and `SIGINT` for graceful shutdown.
- Uncaught exceptions are logged before shutdown starts.

## CI coverage
GitHub Actions now checks:
- source syntax for the production runtime files
- end-to-end smoke coverage for key user workflows
- Docker image build plus container health probe

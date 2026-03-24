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

Object storage in production should use S3/MinIO-compatible configuration:

```bash
OBJECT_STORAGE_BACKEND=s3
OBJECT_STORAGE_BUCKET=klient-production
OBJECT_STORAGE_REGION=us-east-1
OBJECT_STORAGE_ENDPOINT=https://s3.amazonaws.com # or MinIO endpoint
OBJECT_STORAGE_ACCESS_KEY_ID=...
OBJECT_STORAGE_SECRET_ACCESS_KEY=...
OBJECT_STORAGE_FORCE_PATH_STYLE=false # true for many MinIO deployments
```

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

`/ready` verifies the SQLite database is reachable, returns a query summary for seeded/runtime records, and reports the active object storage backend.

## Persistent data
The app stores seeded and runtime data in `data/app.db`.
Mount `./data` into the container to persist changes across restarts.
When `OBJECT_STORAGE_BACKEND=local`, file objects are persisted under `OBJECT_STORAGE_LOCAL_PATH` (default `data/storage`) and should also be mounted.

When `OBJECT_STORAGE_BACKEND=s3`, uploaded templates, client-uploaded documents, and generated exports are stored in the configured bucket.

## Migration expectations
- Existing database records remain valid without migration.
- Historical document templates/exports created before object storage references may not have downloadable file payloads.
- If switching from local filesystem to S3/MinIO, copy files externally and update stored object references only if historical file download continuity is required.

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

# Kinetic Klient Rebuild

Kinetic Klient is a single-process advisory onboarding product that ships as one deployable Node 22 service with:
- a built-in web UI served from `apps/web/public`
- a JSON API for advisor and portal workflows
- persistent SQLite storage in `data/app.db`
- structured logs, health/readiness endpoints, and backup/restore scripts
- Docker and CI artifacts aligned to the same runtime entrypoint: `apps/api/src/server.mjs`

## Product surface
The deployable product includes these major workflows:
- admin firm bootstrap and sign-in
- dashboard, prospects, clients, and pipeline board
- households and spouse/member linking
- form template creation plus advisor/client submission flows
- client portal draft/save/submit flows
- document template management and export job processing
- audit trail, analytics, invites, and password reset flows

## Runtime requirements
- Node.js 22+
- no external database; SQLite is embedded
- set `APP_SECRET` before any production deployment

## Local run
```bash
cp .env.example .env
export $(grep -v '^#' .env | xargs)
node apps/api/src/server.mjs
```

Open `http://localhost:3000`.

## Demo credentials
- `admin@demo.test`
- `ChangeMe123!`

## Operations
### Health
```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

### Backup
```bash
node scripts/backup-db.mjs
```

### Restore
```bash
node scripts/restore-db.mjs data/backup-<timestamp>.db
```

### Export worker
```bash
node scripts/export-worker.mjs
```

## Testing
```bash
npm run test:syntax
npm run test:smoke
npm run test:all
```

## Docker deployment
```bash
docker compose --env-file .env up --build -d
```

## Production notes
- The service rejects startup in production if `APP_SECRET` is left at the default value.
- Static assets are served from an allowlisted path rooted at `apps/web/public`.
- API and static responses emit baseline hardening headers, and request/body timeouts are configurable through environment variables.
- CI validates syntax, smoke tests the end-to-end product, and performs a container health check.

See `DEPLOYMENT.md` for the full deployment contract.

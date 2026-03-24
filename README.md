# Kinetic Klient Rebuild

Kinetic Klient is now consolidated onto **one real runtime architecture**:

- a single Node.js HTTP server at `apps/api/src/server.mjs`
- SQLite-backed persistence in `data/app.db`
- the advisor web UI served directly from `apps/web/public`
- the client portal served from `/portal`

The older duplicate Fastify/TypeScript backend path and related workspace scaffolding have been removed so the repository now has one real startup path.

## Product capabilities
- firm admin registration and sign-in
- persistent session-backed advisory workspace
- dashboard with recent activity and operating stats
- prospect/client creation, search, detail, notes, and stage management
- household creation, member management, and spouse linking/creation
- masked sensitive data handling for SSNs and tax IDs
- form template creation plus advisor and portal submission flows
- document templates, auto-build mappings, export jobs, and worker processing
- invite and password reset flows
- readiness/health probes, backup/restore scripts, Docker packaging, and smoke coverage

## Runtime architecture kept
The repo now treats the plain Node runtime as canonical because it is the path that already:
- serves the API and static UI together,
- persists real state to SQLite,
- powers the smoke test and Docker startup path,
- and can be verified end-to-end without a second backend stack.

That eliminates the split-brain between competing backend implementations and keeps local, Docker, CI, and smoke verification on the same runtime.

## Local development
```bash
node apps/api/src/server.mjs
```

Open:
- `http://localhost:3000`
- `http://localhost:3000/portal?token=<token>`

## Demo credentials
- Email: `admin@demo.test`
- Password: `ChangeMe123!`

## Security notes
- In production, set `APP_SECRET` to a long random secret.
- New passwords must be at least 12 characters and include uppercase, lowercase, and numeric characters.
- Sessions expire after 8 hours.
- Repeated failed login attempts are rate limited.
- Sensitive identifiers are stored encrypted and only returned in masked form.

## Testing
Smoke test the full runtime:

```bash
node scripts/smoke-test.mjs
```

Run the full local validation bundle:

```bash
npm run test:all
```

## Health checks
```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
curl -I http://localhost:3000/health
```

## Data location
Runtime data is stored in:
- `data/app.db`

Delete the file to reseed the demo dataset.

## Backups
```bash
node scripts/backup-db.mjs
node scripts/restore-db.mjs data/backup-<timestamp>.db
```

## Export worker
```bash
node scripts/export-worker.mjs
```

## Docker
```bash
docker compose --env-file .env up --build -d
```

See `DEPLOYMENT.md` for deployment details.

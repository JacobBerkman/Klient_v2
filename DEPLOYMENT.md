# Deployment

## Local Docker run
```bash
docker compose up --build
```

The app will be available at `http://localhost:3000`.

## Persistent data
The app stores seeded and runtime data in `data/app.db`.
Mount `./data` into the container to persist changes across restarts.

## Health check
Use:
```bash
curl http://localhost:3000/health
```


## Backup
Use `node scripts/backup-db.mjs` to write a timestamped backup of the SQLite database.

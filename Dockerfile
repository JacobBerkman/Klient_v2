FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    LOG_LEVEL=info \
    MAX_BODY_BYTES=1000000 \
    REQUEST_TIMEOUT_MS=15000 \
    HEADERS_TIMEOUT_MS=20000 \
    KEEP_ALIVE_TIMEOUT_MS=5000

WORKDIR /app

COPY .dockerignore ./
COPY package.json README.md DEPLOYMENT.md ./
COPY apps ./apps
COPY scripts ./scripts
COPY docs ./docs
COPY data/.gitkeep ./data/.gitkeep
COPY .env.example ./

RUN addgroup -S klient \
  && adduser -S klient -G klient \
  && mkdir -p /app/data \
  && chown -R klient:klient /app

USER klient

VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1
CMD ["node", "apps/api/src/server.mjs"]

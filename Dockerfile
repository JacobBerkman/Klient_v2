# Keep runtime on current Node.js LTS major and pin the image by digest.
# Update NODE_IMAGE when the LTS line rolls forward or when refreshing the digest.
FROM node:22-alpine@sha256:8094c002d08262dba12645a3b4a15cd6cd627d30bc782f53229a2ec13ee22a00 AS web-builder

WORKDIR /app

COPY apps/web/package.json apps/web/package-lock.json ./apps/web/
RUN npm --prefix apps/web ci

COPY apps/web ./apps/web
RUN npm --prefix apps/web run build

FROM node:22-alpine@sha256:8094c002d08262dba12645a3b4a15cd6cd627d30bc782f53229a2ec13ee22a00

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    TMPDIR=/tmp

WORKDIR /app

# Copy only runtime files required by the production server.
COPY package.json package-lock.json ./
COPY apps ./apps
COPY scripts ./scripts
COPY docs ./docs
COPY DEPLOYMENT.md README.md ./
COPY --from=web-builder /app/apps/web/dist ./apps/web/dist

RUN addgroup -S klient && adduser -S klient -G klient \
  && mkdir -p /app/data /tmp /app/tmp \
  && chown -R klient:klient /app /tmp

USER klient

VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1
CMD ["node", "apps/api/src/server.mjs"]

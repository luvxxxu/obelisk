# Obelisk API (NestJS on Bun). Build context: repository root.

# Which commit this image is (for 서버 관리 → 업데이트 확인), read from the checkout's .git/HEAD and refs
# (.dockerignore lets only those through). Without a .git it records null; OBELISK_COMMIT overrides.
FROM oven/bun:1.3-alpine AS buildinfo
WORKDIR /src
ARG OBELISK_COMMIT=
COPY . .
RUN OBELISK_COMMIT="${OBELISK_COMMIT}" bun backend/scripts/build-info.ts /src > /build-info.json && cat /build-info.json

FROM oven/bun:1.3-alpine
WORKDIR /app

# Install only what the backend needs (workspace-aware, production deps).
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY backend/package.json backend/
COPY web/package.json web/
RUN bun install --frozen-lockfile --production --filter '@obelisk/backend'

COPY packages/core packages/core
COPY backend backend
COPY skills skills
COPY --from=buildinfo /build-info.json /app/build-info.json

ENV NODE_ENV=production \
    PORT=4000
USER bun
WORKDIR /app/backend
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
CMD ["bun", "src/main.ts"]

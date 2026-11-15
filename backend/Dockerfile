# Obelisk API (NestJS on Bun). Build context: repository root.
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

ENV NODE_ENV=production \
    PORT=4000
USER bun
WORKDIR /app/backend
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
CMD ["bun", "src/main.ts"]

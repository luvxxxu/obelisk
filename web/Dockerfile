# Obelisk web (Next.js, built and served with Bun). Build context: repository root.
FROM oven/bun:1.3 AS build
WORKDIR /app

COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY backend/package.json backend/
COPY web/package.json web/
RUN bun install --frozen-lockfile --filter '@obelisk/web'

COPY packages/core packages/core
COPY web web

# Where the web container reaches the API inside the compose network.
ARG BACKEND_URL=http://backend:4000
ENV BACKEND_URL=${BACKEND_URL} \
    NEXT_TELEMETRY_DISABLED=1
RUN cd web && bun run build

FROM oven/bun:1.3-alpine
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=bun:bun /app/web/.next/standalone ./
COPY --from=build --chown=bun:bun /app/web/.next/static ./web/.next/static
COPY --from=build --chown=bun:bun /app/web/public ./web/public
USER bun
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/login >/dev/null || exit 1
CMD ["bun", "web/server.js"]

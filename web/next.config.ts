import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * The web container is the single public entry point. API, MCP and OAuth
 * discovery are proxied to the backend container, so Dokploy only needs one
 * domain and cookies stay first-party.
 */
const backend = (process.env.BACKEND_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
const root = path.join(__dirname, '..');

/** Applied to every response (pages and proxied API). HSTS is ignored by browsers on plain http. */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
];

/**
 * The rewrite proxy's own limits (Next 16 `experimental.proxyClientMaxBodySize` / `proxyTimeout`):
 * an export file of up to 64 MiB (MIGRATION_MAX_BYTES in @obelisk/core, plus headroom) has to get
 * through to /api/migration/stage, and a big import or a pull from another server can take minutes
 * before the backend answers. The defaults (10 MB, 30 s) would cut both off.
 */
const PROXY_MAX_BODY = 65 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 10 * 60_000;

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: root,
  turbopack: { root },
  transpilePackages: ['@obelisk/core'],
  poweredByHeader: false,
  // `next dev` blocks dev assets for other origins; allow quick tunnels (cloudflared) so the
  // OAuth consent page works when Claude/ChatGPT connect to a local server. No effect in production.
  allowedDevOrigins: ['*.trycloudflare.com'],
  experimental: {
    proxyClientMaxBodySize: PROXY_MAX_BODY,
    proxyTimeout: PROXY_TIMEOUT_MS,
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  async rewrites() {
    return {
      beforeFiles: [
        { source: '/api/:path*', destination: `${backend}/api/:path*` },
        { source: '/mcp', destination: `${backend}/mcp` },
        { source: '/.well-known/:path*', destination: `${backend}/.well-known/:path*` },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;

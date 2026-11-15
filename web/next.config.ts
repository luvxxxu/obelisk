import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * The web container is the single public entry point. API, MCP and OAuth
 * discovery are proxied to the backend container, so Dokploy only needs one
 * domain and cookies stay first-party.
 */
const backend = (process.env.BACKEND_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
const root = path.join(__dirname, '..');

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: root,
  turbopack: { root },
  transpilePackages: ['@obelisk/core'],
  poweredByHeader: false,
  // `next dev` blocks dev assets for other origins; allow quick tunnels (cloudflared) so the
  // OAuth consent page works when Claude/ChatGPT connect to a local server. No effect in production.
  allowedDevOrigins: ['*.trycloudflare.com'],
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

import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { AiModule } from './ai/ai.module';
import { AuthModule } from './auth/auth.module';
import { config } from './config';
import { DbModule, runMigrations } from './db/db.module';
import { PlannerModule } from './planner/planner.module';
import { WorkspaceModule } from './workspace/workspace.module';

@Module({ imports: [DbModule, WorkspaceModule, AuthModule, PlannerModule, AiModule] })
class AppModule {}

/** Endpoints AI clients may call from a browser context (bearer-only, never cookies). */
const PUBLIC_CORS = [/^\/mcp$/, /^\/\.well-known\//, /^\/api\/oauth\/(token|register|revoke)$/];

const log = (m: string) => console.log(`[obelisk] ${m}`);

/** Postgres may still be starting (first boot, host reboot): retry for ~60 s before giving up. */
async function migrateWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      await runMigrations();
      return;
    } catch (err) {
      if (attempt >= 30) throw err;
      log(`database not ready (${(err as Error).message}); retrying in 2s`);
      await Bun.sleep(2000);
    }
  }
}

function warnAboutConfig() {
  if (process.env.NODE_ENV !== 'production') return;
  if (!process.env.PUBLIC_URL) log('WARNING: PUBLIC_URL is not set — OAuth/MCP links will point at localhost');
  else if (!config.publicUrl.startsWith('https://'))
    log('WARNING: PUBLIC_URL is not https — session cookies are not Secure and Claude/ChatGPT connectors will refuse it');
  if (config.publicUrl.includes('example.com')) log('WARNING: PUBLIC_URL still uses the example domain');
}

async function bootstrap() {
  warnAboutConfig();
  await migrateWithRetry();
  log('database migrations applied');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: process.env.NEST_VERBOSE ? ['error', 'warn', 'log'] : ['error', 'warn'],
  });
  app.disable('x-powered-by');
  // Exactly one trusted hop (the web container's proxy). req.ip is then the right-most
  // X-Forwarded-For entry, which Traefik writes; client-supplied entries to its left are ignored.
  app.set('trust proxy', 1);
  app.useBodyParser('json', { limit: '2mb' });
  app.useBodyParser('urlencoded', { extended: false, limit: '64kb' });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (PUBLIC_CORS.some((r) => r.test(req.path))) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
      );
      res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }
    next();
  });

  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
  log(`API listening on :${config.port} — public URL ${config.publicUrl}, MCP ${config.mcpUrl}`);
}

process.on('unhandledRejection', (err) => console.error('[obelisk] unhandled rejection', err));

bootstrap().catch((err) => {
  console.error('[obelisk] failed to start', err);
  process.exit(1);
});

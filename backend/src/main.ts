import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { AdminModule } from './admin/admin.module';
import { AiModule } from './ai/ai.module';
import { AuthModule } from './auth/auth.module';
import { AVATAR_MAX_BYTES, AVATAR_UPLOAD_TYPES } from './workspace/avatars.service';
import { config } from './config';
import { DbModule, runMigrations } from './db/db.module';
import { JevModule } from './jev/jev.module';
import { MigrationModule } from './migration/migration.module';
import { PlannerModule } from './planner/planner.module';
import { ServerModule } from './server/server.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { WorkspaceModule } from './workspace/workspace.module';

@Module({
  imports: [DbModule, ServerModule, WorkspaceModule, AuthModule, PlannerModule, JevModule, AiModule, WebhooksModule, MigrationModule, AdminModule],
})
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
  const secretKey = process.env.SECRET_KEY?.trim() ?? '';
  if (!secretKey)
    log(
      'WARNING: SECRET_KEY is not set — stored Jev keys are sealed with the database password, so that password alone opens them. ' +
        'Set SECRET_KEY to a random value (openssl rand -base64 32); existing keys move over on the next start.',
    );
  else if (secretKey.length < 32) log('WARNING: SECRET_KEY is short — use at least 32 random characters (openssl rand -base64 32)');
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
  // Incoming webhooks accept a plain-text line ("보고서 내일 !높음").
  app.useBodyParser('text', { limit: '64kb' });
  // Profile photos arrive as the image bytes themselves. The parser lets a bit more through so the
  // route can answer an oversized photo in words instead of the parser's bare 413.
  app.useBodyParser('raw', { type: AVATAR_UPLOAD_TYPES, limit: AVATAR_MAX_BYTES * 2 });
  // Export files (application/x-obelisk-export, gzip, octet-stream) up to 64 MiB are deliberately not
  // parsed here: POST /api/migration/stage reads its own body after the session check, with that cap,
  // so nobody can make the server buffer 64 MiB without signing in.

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

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

@Module({ imports: [DbModule, AuthModule, PlannerModule, AiModule] })
class AppModule {}

/** Endpoints AI clients may call from a browser context (bearer-only, never cookies). */
const PUBLIC_CORS = [/^\/mcp$/, /^\/\.well-known\//, /^\/api\/oauth\/(token|register|revoke)$/];

async function bootstrap() {
  const log = { log: (m: string) => console.log(`[obelisk] ${m}`) };
  await runMigrations();
  log.log('database migrations applied');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: process.env.NEST_VERBOSE ? ['error', 'warn', 'log'] : ['error', 'warn'],
  });
  app.disable('x-powered-by');
  app.set('trust proxy', true);
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
  log.log(`API listening on :${config.port} — public URL ${config.publicUrl}, MCP ${config.mcpUrl}`);
}

void bootstrap();

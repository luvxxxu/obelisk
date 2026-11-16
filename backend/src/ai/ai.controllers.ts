import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createTokenInput } from '@obelisk/core';
import { sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Auth, AuthGuard, SessionOnlyGuard, UserId } from '../auth/auth.guard';
import { AuthService, type AuthContext } from '../auth/auth.service';
import { bearerToken } from '../common/http';
import { rateLimiter } from '../common/rate-limit';
import { parse } from '../common/validation';
import { config } from '../config';
import { InjectDb, type Db } from '../db/db.module';
import { ImpactService } from '../planner/impact.service';
import { ProjectsService } from '../planner/projects.service';
import { TasksService } from '../planner/tasks.service';
import { AccessService } from '../workspace/access.service';
import { ActivityService } from '../workspace/activity.service';
import { WorkspacesService } from '../workspace/workspaces.service';
import { JevService } from '../jev/jev.service';
import { buildMcpServer } from './mcp.server';
import { OAuthService, type AuthorizeParams } from './oauth.service';
import { TokensService } from './tokens.service';
import { clientSupportsUi } from './widget';
import { zip } from './zip';

// ───────────────────────────────────────── MCP (Streamable HTTP, stateless)

@Controller('mcp')
export class McpController {
  constructor(
    private readonly auth: AuthService,
    private readonly tasks: TasksService,
    private readonly projects: ProjectsService,
    private readonly impact: ImpactService,
    private readonly access: AccessService,
    private readonly workspaces: WorkspacesService,
    private readonly activity: ActivityService,
    private readonly jev: JevService,
  ) {}

  /** RFC 6750 §3.1: no error code when the request carried no credentials at all. */
  private unauthorized(res: Response, description: string, invalidToken: boolean) {
    const params = [`resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource/mcp"`];
    if (invalidToken) params.push('error="invalid_token"', `error_description="${description}"`);
    res
      .status(401)
      .setHeader('WWW-Authenticate', `Bearer ${params.join(', ')}`)
      .json({ jsonrpc: '2.0', error: { code: -32001, message: description }, id: null });
  }

  @Post()
  async handle(@Req() req: Request, @Res() res: Response) {
    const token = bearerToken(req);
    if (!token) return this.unauthorized(res, 'Authentication required', false);
    const auth = await this.auth.authenticateBearer(token);
    if (!auth) return this.unauthorized(res, 'Invalid or expired token', true);

    // Stateless: only the initialize request says what the client can render, and it is also the
    // only response that carries the server instructions — so tailor them right here.
    const body = req.body as { method?: string; params?: { capabilities?: unknown } } | undefined;
    const ui = body?.method === 'initialize' && clientSupportsUi(body.params?.capabilities);
    const server = buildMcpServer(
      auth,
      {
        tasks: this.tasks,
        projects: this.projects,
        impact: this.impact,
        access: this.access,
        workspaces: this.workspaces,
        activity: this.activity,
        jev: this.jev,
      },
      { ui },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  @Get()
  get(@Res() res: Response) {
    this.methodNotAllowed(res);
  }

  @Delete()
  del(@Res() res: Response) {
    this.methodNotAllowed(res);
  }

  private methodNotAllowed(res: Response) {
    res
      .status(405)
      .setHeader('Allow', 'POST')
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This server is stateless: use POST.' }, id: null });
  }
}

// ───────────────────────────────────────── OAuth discovery

@Controller('.well-known')
export class WellKnownController {
  constructor(private readonly oauth: OAuthService) {}

  @Get('oauth-protected-resource')
  resource() {
    return this.oauth.protectedResourceMetadata();
  }

  @Get('oauth-protected-resource/mcp')
  resourceMcp() {
    return this.oauth.protectedResourceMetadata();
  }

  @Get('oauth-authorization-server')
  as() {
    return this.oauth.authorizationServerMetadata();
  }

  @Get('oauth-authorization-server/mcp')
  asMcp() {
    return this.oauth.authorizationServerMetadata();
  }

  @Get('openid-configuration')
  oidc() {
    return this.oauth.authorizationServerMetadata();
  }
}

// ───────────────────────────────────────── OAuth endpoints

const registerLimit = rateLimiter(30, 60 * 60_000);
const tokenLimit = rateLimiter(120, 60_000);

@Controller('api/oauth')
export class OAuthController {
  constructor(
    private readonly oauth: OAuthService,
    private readonly tokens: TokensService,
  ) {}

  @Post('register')
  @Header('Cache-Control', 'no-store')
  register(@Req() req: Request, @Body() body: Record<string, unknown>) {
    registerLimit(req.ip ?? 'unknown');
    return this.oauth.register(body ?? {});
  }

  @Post('token')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  token(@Req() req: Request, @Body() body: Record<string, string>, @Headers('authorization') authorization?: string) {
    tokenLimit(req.ip ?? 'unknown');
    return this.oauth.token(body ?? {}, authorization);
  }

  @Post('revoke')
  @HttpCode(200)
  async revoke(@Body() body: Record<string, string>) {
    await this.oauth.revoke(body?.token);
    return {};
  }

  /** Consent screen: who is asking? */
  @Get('request')
  @UseGuards(AuthGuard)
  describe(@Query() q: AuthorizeParams) {
    return this.oauth.describeRequest(q);
  }

  /** Consent screen: user clicked allow / deny. */
  @Post('authorize')
  @HttpCode(200)
  @UseGuards(AuthGuard, SessionOnlyGuard)
  authorize(@UserId() userId: string, @Body() body: AuthorizeParams & { approve?: boolean }) {
    return this.oauth.approve(userId, body, body.approve === true);
  }

  @Get('grants')
  @UseGuards(AuthGuard, SessionOnlyGuard)
  async grants(@UserId() userId: string) {
    return { grants: await this.tokens.listGrants(userId) };
  }

  @Delete('grants/:id')
  @UseGuards(AuthGuard, SessionOnlyGuard)
  revokeGrant(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tokens.revokeGrant(userId, id);
  }
}

// ───────────────────────────────────────── Personal API tokens

@Controller('api/tokens')
@UseGuards(AuthGuard, SessionOnlyGuard)
export class TokensController {
  constructor(private readonly tokens: TokensService) {}

  @Get()
  async list(@UserId() userId: string) {
    return { tokens: await this.tokens.list(userId) };
  }

  @Post()
  create(@UserId() userId: string, @Body() body: unknown) {
    return this.tokens.create(userId, parse(createTokenInput, body).name);
  }

  @Delete(':id')
  revoke(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tokens.revoke(userId, id);
  }
}

// ───────────────────────────────────────── Agent Skill download + integration info

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (!e.name.startsWith('.')) out.push(p);
  }
  return out.sort();
}

@Controller('api')
export class IntegrationController {
  constructor(@InjectDb() private readonly db: Db) {}

  /** The Obelisk Agent Skill (SKILL.md + references), with this server's URL baked in. */
  @Get('skill.zip')
  async skill(@Res() res: Response) {
    const root = join(config.skillsDir, 'obelisk');
    const files = await walk(root);
    const entries = await Promise.all(
      files.map(async (f) => {
        const raw = await readFile(f);
        const isText = /\.(md|txt|json|sh|ts|js|ya?ml)$/i.test(f);
        const data = isText
          ? new TextEncoder().encode(raw.toString('utf8').replaceAll('{{OBELISK_URL}}', config.publicUrl))
          : new Uint8Array(raw);
        return { path: `obelisk/${relative(root, f).split('\\').join('/')}`, data };
      }),
    );
    res
      .status(200)
      .setHeader('Content-Type', 'application/zip')
      .setHeader('Content-Disposition', 'attachment; filename="obelisk-skill.zip"')
      .send(Buffer.from(zip(entries)));
  }

  @Get('integrations')
  @UseGuards(AuthGuard)
  info(@Auth() _auth: AuthContext) {
    return { publicUrl: config.publicUrl, mcpUrl: config.mcpUrl, skillUrl: `${config.publicUrl}/api/skill.zip` };
  }

  /** Liveness + readiness for Docker/Dokploy health checks: 503 when Postgres is unreachable. */
  @Get('health')
  @Header('Cache-Control', 'no-store')
  async health() {
    try {
      // Fail fast: Docker's health check times out at 5 s, Postgres connects can hang for 30 s.
      await Promise.race([
        this.db.execute(sql`select 1`),
        Bun.sleep(3000).then(() => Promise.reject(new Error('timeout'))),
      ]);
    } catch {
      throw new ServiceUnavailableException({ ok: false, db: 'unreachable' });
    }
    return { ok: true };
  }
}

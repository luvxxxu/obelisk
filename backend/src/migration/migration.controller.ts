import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  MIGRATION_MAX_BYTES,
  migrationCodeInput,
  migrationExportInput,
  migrationImportInput,
  migrationStageRemoteInput,
  todayIn,
  type MigrationCode,
  type MigrationPreview,
  type MigrationResult,
  type MigrationStageStatus,
} from '@obelisk/core';
import type { Request, Response } from 'express';
import { Auth, AuthGuard, SessionOnlyGuard } from '../auth/auth.guard';
import type { AuthContext } from '../auth/auth.service';
import { bearerToken } from '../common/http';
import { rateLimiter } from '../common/rate-limit';
import { parse } from '../common/validation';
import { InjectDb, type Db } from '../db/db.module';
import type { WorkspaceRow } from '../db/schema';
import { ActivityService } from '../workspace/activity.service';
import { ExportService } from './export.service';
import { ImportService } from './import.service';
import { decodeBundle, readCapped, TransferService } from './transfer.service';

const codeLimit = rateLimiter(10, 15 * 60_000);
const pullLimit = rateLimiter(20, 15 * 60_000);
const remoteLimit = rateLimiter(20, 15 * 60_000);
const stageLimit = rateLimiter(30, 15 * 60_000);
const importLimit = rateLimiter(30, 15 * 60_000);
const exportLimit = rateLimiter(10, 15 * 60_000);

/**
 * Reading and checking a bundle holds up to 64 MiB (several times that once parsed): one at a time
 * per person, and only a couple on the whole server at once.
 */
const MAX_PARSING = 2;
const parsing = new Set<string>();
async function oneAtATime<T>(userId: string, work: () => Promise<T>): Promise<T> {
  if (parsing.has(userId)) throw new HttpException('이미 파일을 확인하고 있어요. 끝난 뒤 다시 시도하세요', 429);
  if (parsing.size >= MAX_PARSING) throw new HttpException('지금 다른 가져오기를 처리하고 있어요. 잠시 후 다시 시도하세요', 429);
  parsing.add(userId);
  try {
    return await work();
  } finally {
    parsing.delete(userId);
  }
}

/** "obelisk-acme-20261120.json", with the real (Korean) name in filename* for browsers that read it. */
export function exportFileName(ws: Pick<WorkspaceRow, 'name' | 'kind'>, timeZone: string): string {
  const ymd = todayIn(timeZone).replaceAll('-', '');
  const slug =
    ws.name
      .normalize('NFKD')
      .replace(/[^\x00-\x7f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || ws.kind;
  const full = `obelisk-${ws.name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim()}-${ymd}.json`;
  const encoded = encodeURIComponent(full).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="obelisk-${slug}-${ymd}.json"; filename*=UTF-8''${encoded}`;
}

function sendBundle(res: Response, json: string, disposition?: string) {
  res.status(200);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (disposition) res.setHeader('Content-Disposition', disposition);
  res.send(json);
}

/**
 * 데이터 이전: export a workspace (file or one-time link) and import one (file or link).
 * Web/iOS sessions only — API tokens and AI apps can't move data between servers.
 */
@Controller('api/migration')
@UseGuards(AuthGuard, SessionOnlyGuard)
export class MigrationController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly exporter: ExportService,
    private readonly importer: ImportService,
    private readonly transfer: TransferService,
    private readonly activity: ActivityService,
  ) {}

  @Post('export')
  @HttpCode(200)
  async export(@Auth() auth: AuthContext, @Body() body: unknown, @Res() res: Response) {
    const input = parse(migrationExportInput, body);
    exportLimit(auth.user.id);
    const passphrase = input.passphrase || null;
    const { json, ws } = await this.exporter.build(
      auth.user,
      input.workspaceId,
      passphrase ? { mode: 'locked', passphrase } : { mode: 'none' },
    );
    await this.activity.recordIn(this.db, { user: auth.user, via: auth.via, client: auth.client ?? null }, ws.id, {
      action: 'workspace.exported',
      subject: ws.name,
      data: { to: 'file', secrets: !!passphrase },
    });
    sendBundle(res, json, exportFileName(ws, auth.user.timezone));
  }

  @Post('codes')
  @HttpCode(200)
  async code(@Auth() auth: AuthContext, @Body() body: unknown): Promise<MigrationCode> {
    const { workspaceId } = parse(migrationCodeInput, body);
    codeLimit(auth.user.id);
    const ws = await this.exporter.exportable(auth.user.id, workspaceId);
    return this.transfer.createCode(auth.user.id, ws);
  }

  /** The file itself is the body (application/x-obelisk-export, gzip or octet-stream), up to 64 MiB. */
  @Post('stage')
  @HttpCode(200)
  async stage(@Auth() auth: AuthContext, @Req() req: Request): Promise<MigrationPreview> {
    stageLimit(auth.user.id);
    return oneAtATime(auth.user.id, async () => {
      let raw: unknown;
      let size = 0;
      if (Buffer.isBuffer(req.body)) {
        size = req.body.length;
        raw = decodeBundle(req.body);
      } else if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) raw = req.body;
      else {
        const declared = Number(req.headers['content-length'] ?? '') || null;
        let bytes: Buffer | null = await readCapped(req, MIGRATION_MAX_BYTES, declared);
        if (!bytes.length) throw new BadRequestException('가져올 파일을 보내 주세요');
        size = bytes.length;
        raw = decodeBundle(bytes);
        bytes = null; // not kept alive while the schema runs
      }
      return this.importer.stage(auth.user, raw, size);
    });
  }

  @Post('stage-remote')
  @HttpCode(200)
  async stageRemote(@Auth() auth: AuthContext, @Body() body: unknown): Promise<MigrationPreview> {
    const { link } = parse(migrationStageRemoteInput, body);
    remoteLimit(auth.user.id);
    return oneAtATime(auth.user.id, async () => this.importer.stage(auth.user, await this.transfer.pull(link)));
  }

  /** What became of a staged file: still waiting, being imported, done (with the import's answer) or gone. */
  @Get('stage/:stagingId')
  status(@Auth() auth: AuthContext, @Param('stagingId', ParseUUIDPipe) stagingId: string): MigrationStageStatus {
    return this.importer.status(auth.user, stagingId);
  }

  @Delete('stage/:stagingId')
  discard(@Auth() auth: AuthContext, @Param('stagingId', ParseUUIDPipe) stagingId: string) {
    return this.importer.discard(auth.user, stagingId);
  }

  @Post('import')
  @HttpCode(200)
  import(@Auth() auth: AuthContext, @Body() body: unknown): Promise<MigrationResult> {
    const input = parse(migrationImportInput, body);
    importLimit(auth.user.id);
    return this.importer.import(auth.user, input);
  }
}

/**
 * The other server's side of an 이전 링크: authenticated only by the one-time omg_ code, which is
 * used up by this call. The answer carries the secrets in plain text (TLS, single use).
 */
@Controller('api/migration')
export class MigrationPullController {
  constructor(
    private readonly exporter: ExportService,
    private readonly transfer: TransferService,
  ) {}

  @Post('pull')
  @HttpCode(200)
  async pull(@Req() req: Request, @Res() res: Response) {
    pullLimit(req.ip ?? 'unknown');
    const code = bearerToken(req);
    // A workspace that is plainly too big is refused before the code is used up.
    const live = code ? await this.transfer.peekCode(code) : null;
    if (!live) throw new UnauthorizedException('이전 링크가 만료됐거나 이미 쓰였어요');
    await this.exporter.assertFits(live.workspaceId);
    const used = await this.transfer.useCode(code!);
    if (!used) throw new UnauthorizedException('이전 링크가 만료됐거나 이미 쓰였어요');
    const header = req.headers['x-obelisk-target'];
    let target: string | null = null;
    try {
      const raw = (Array.isArray(header) ? header[0] : header)?.trim();
      if (raw && raw.length <= 500 && /^https?:\/\//i.test(raw)) target = new URL(raw).origin;
    } catch {}
    const { json, ws } = await this.exporter.build(used.user, used.workspaceId, { mode: 'plain' });
    await this.transfer.recordPulled(used.user, ws, target);
    sendBundle(res, json);
  }
}

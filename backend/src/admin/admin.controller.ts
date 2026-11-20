import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  adminLogQuery,
  adminMailInput,
  adminOrgQuery,
  adminUserQuery,
  announcementInput,
  claimAdminInput,
  confirmEmailInput,
  createServerInviteInput,
  recoverOrgInput,
  resetLinkInput,
  setAdminInput,
  suspendUserInput,
  updateServerSettingsInput,
} from '@obelisk/core';
import { AdminGuard, Auth, AuthGuard, SessionOnlyGuard } from '../auth/auth.guard';
import type { AuthContext } from '../auth/auth.service';
import { rateLimiter } from '../common/rate-limit';
import { parse } from '../common/validation';
import { ServerInvitesService } from '../server/invites.service';
import { AdminLogService } from '../server/log.service';
import { ServerSettingsService } from '../server/settings.service';
import { NoticeService } from './notice.service';
import { AdminOrgsService } from './orgs.service';
import { StatusService } from './status.service';
import { AdminUsersService } from './users.service';

const claimLimit = rateLimiter(10, 15 * 60_000);

/**
 * Becoming the first operator with the link the server logged at start. Any signed-in account
 * (web session) may try; the link is the proof that whoever runs the server sent them.
 */
@Controller('api/admin/claim')
@UseGuards(AuthGuard, SessionOnlyGuard)
export class AdminClaimController {
  constructor(private readonly settings: ServerSettingsService) {}

  @Post()
  @HttpCode(200)
  async claim(@Auth() auth: AuthContext, @Body() body: unknown) {
    claimLimit(auth.user.id);
    await this.settings.claim(auth.user, parse(claimAdminInput, body).token);
    return { ok: true };
  }
}

/** 서버 관리: operators only, from a signed-in web or iOS session. */
@Controller('api/admin')
@UseGuards(AuthGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly settings: ServerSettingsService,
    private readonly invites: ServerInvitesService,
    private readonly log: AdminLogService,
    private readonly status: StatusService,
    private readonly users: AdminUsersService,
    private readonly orgs: AdminOrgsService,
    private readonly notice: NoticeService,
  ) {}

  // ───────── overview

  @Get('status')
  getStatus() {
    return this.status.status();
  }

  @Post('status/update-check')
  @HttpCode(200)
  checkUpdate(@Auth() auth: AuthContext) {
    return this.status.checkNow(auth.user);
  }

  @Post('test-mail')
  @HttpCode(200)
  testMail(@Auth() auth: AuthContext) {
    return this.status.testMail(auth.user);
  }

  // ───────── settings

  @Get('settings')
  getSettings() {
    return this.settings.settings();
  }

  @Patch('settings')
  updateSettings(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.settings.update(auth.user, parse(updateServerSettingsInput, body));
  }

  @Put('announcement')
  setAnnouncement(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.settings.setAnnouncement(auth.user, parse(announcementInput, body).text);
  }

  // ───────── people

  @Get('users')
  listUsers(@Query() query: Record<string, string>) {
    return this.users.list(parse(adminUserQuery, query));
  }

  @Get('users/:id')
  async getUser(@Param('id', ParseUUIDPipe) id: string) {
    return { user: await this.users.one(id) };
  }

  @Post('users/:id/approve')
  @HttpCode(200)
  async approve(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return { user: await this.users.approve(auth.user, id) };
  }

  @Post('users/:id/reject')
  @HttpCode(200)
  async reject(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.users.reject(auth.user, id);
    return { ok: true };
  }

  @Post('users/:id/suspend')
  @HttpCode(200)
  async suspend(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return { user: await this.users.suspend(auth.user, id, parse(suspendUserInput, body ?? {}).note) };
  }

  @Post('users/:id/unsuspend')
  @HttpCode(200)
  async unsuspend(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return { user: await this.users.unsuspend(auth.user, id) };
  }

  @Post('users/:id/admin')
  @HttpCode(200)
  async setAdmin(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return { user: await this.users.setAdmin(auth.user, id, parse(setAdminInput, body).admin) };
  }

  @Post('users/:id/reset-link')
  @HttpCode(200)
  resetLink(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.users.resetLink(auth.user, id, !!parse(resetLinkInput, body ?? {}).mail);
  }

  @Post('users/:id/skip-verification')
  @HttpCode(200)
  async skipVerification(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return { user: await this.users.skipVerification(auth.user, id) };
  }

  @Get('users/:id/deletion')
  deletionPreview(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.deletionPreview(id);
  }

  @Delete('users/:id')
  async deleteUser(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    await this.users.remove(auth.user, id, parse(confirmEmailInput, body).confirm);
    return { ok: true };
  }

  // ───────── organizations

  @Get('orgs')
  listOrgs(@Query() query: Record<string, string>) {
    return this.orgs.list(parse(adminOrgQuery, query));
  }

  @Get('orgs/:id/members')
  async orgMembers(@Param('id', ParseUUIDPipe) id: string) {
    return { members: await this.orgs.members(id) };
  }

  @Post('orgs/:id/owner')
  @HttpCode(200)
  async setOwner(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    await this.orgs.setOwner(auth.user, id, parse(recoverOrgInput, body).userId);
    return { ok: true };
  }

  // ───────── server invites

  @Get('invites')
  async listInvites() {
    return { invites: await this.invites.list() };
  }

  @Post('invites')
  createInvite(@Auth() auth: AuthContext, @Body() body: unknown) {
    return this.invites.create(auth.user, parse(createServerInviteInput, body ?? {}));
  }

  @Delete('invites/:id')
  async revokeInvite(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.invites.revoke(auth.user, id);
    return { ok: true };
  }

  // ───────── operator log

  @Get('log')
  getLog(@Query() query: Record<string, string>) {
    const q = parse(adminLogQuery, query);
    return this.log.list(q.offset, q.limit);
  }

  // ───────── mail to everyone

  @Get('mail')
  async mailStatus(@Query('audience') audience?: string) {
    const a = audience === 'verified' ? 'verified' : 'all';
    return { job: this.notice.current(), recipients: await this.notice.count(a) };
  }

  @Post('mail')
  @HttpCode(200)
  async sendMail(@Auth() auth: AuthContext, @Body() body: unknown) {
    return { job: await this.notice.start(auth.user, parse(adminMailInput, body)) };
  }

  @Post('mail/stop')
  @HttpCode(200)
  stopMail() {
    return { job: this.notice.stop() };
  }
}

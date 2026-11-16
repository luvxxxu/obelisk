import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  activityQuery,
  createInviteInput,
  createTeamInput,
  createWorkspaceInput,
  updateMemberInput,
  updateTeamInput,
  updateWorkspaceInput,
} from '@obelisk/core';
import type { Request } from 'express';
import { z } from 'zod';
import { Auth, AuthGuard, SessionOnlyGuard } from '../auth/auth.guard';
import { AuthService, type AuthContext } from '../auth/auth.service';
import { rateLimiter } from '../common/rate-limit';
import { parse } from '../common/validation';
import { config } from '../config';
import { AccessService } from './access.service';
import { ActivityService } from './activity.service';
import { WorkspacesService } from './workspaces.service';

const inviteLimit = rateLimiter(60, 10 * 60_000);

/**
 * Organizations: settings, members, invite links, teams and the activity log.
 * Managing an organization (members, invites, teams, deletion) is web-only — API tokens
 * and AI apps can read but never change who has access.
 */
@Controller('api/workspaces')
@UseGuards(AuthGuard)
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly access: AccessService,
    private readonly activity: ActivityService,
  ) {}

  @Get()
  async list(@Auth() auth: AuthContext) {
    return { workspaces: await this.workspaces.listFor(auth.user.id) };
  }

  @Post()
  @UseGuards(SessionOnlyGuard)
  async create(@Auth() auth: AuthContext, @Body() body: unknown) {
    const { name } = parse(createWorkspaceInput, body);
    return { workspace: await this.workspaces.create(auth, name) };
  }

  @Get(':id')
  async get(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const a = await this.access.forWorkspace(auth, id);
    const [workspace, members, teams] = await Promise.all([
      this.workspaces.detail(a),
      this.workspaces.members(id),
      this.workspaces.teams(id),
    ]);
    return { workspace, members, teams };
  }

  @Patch(':id')
  @UseGuards(SessionOnlyGuard)
  async update(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const a = await this.access.forWorkspace(auth, id);
    await this.workspaces.update(a, parse(updateWorkspaceInput, body));
    return { workspace: await this.workspaces.detail(await this.access.forWorkspace(auth, id)) };
  }

  @Delete(':id')
  @UseGuards(SessionOnlyGuard)
  async remove(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { confirm } = parse(z.object({ confirm: z.string() }), body);
    return this.workspaces.remove(await this.access.forWorkspace(auth, id), confirm);
  }

  // ── members

  @Get(':id/members')
  async members(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.access.forWorkspace(auth, id);
    return { members: await this.workspaces.members(id) };
  }

  @Patch(':id/members/:userId')
  @UseGuards(SessionOnlyGuard)
  async updateMember(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: unknown,
  ) {
    const { role } = parse(updateMemberInput, body);
    await this.workspaces.updateMember(await this.access.forWorkspace(auth, id), userId, role);
    return { members: await this.workspaces.members(id) };
  }

  /** Remove a member, or leave when it is yourself. */
  @Delete(':id/members/:userId')
  @UseGuards(SessionOnlyGuard)
  async removeMember(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.workspaces.removeMember(await this.access.forWorkspace(auth, id), userId);
  }

  // ── invites

  @Get(':id/invites')
  @UseGuards(SessionOnlyGuard)
  async invites(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return { invites: await this.workspaces.listInvites(await this.access.forWorkspace(auth, id)) };
  }

  @Post(':id/invites')
  @UseGuards(SessionOnlyGuard)
  async createInvite(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(createInviteInput, body);
    const { token, invite } = await this.workspaces.createInvite(await this.access.forWorkspace(auth, id), input);
    return { invite, url: `${config.publicUrl}/invite/${token}` };
  }

  @Delete(':id/invites/:inviteId')
  @UseGuards(SessionOnlyGuard)
  async revokeInvite(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
  ) {
    return this.workspaces.revokeInvite(await this.access.forWorkspace(auth, id), inviteId);
  }

  // ── teams

  @Get(':id/teams')
  async teams(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.access.forWorkspace(auth, id);
    return { teams: await this.workspaces.teams(id) };
  }

  @Post(':id/teams')
  @UseGuards(SessionOnlyGuard)
  async createTeam(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(createTeamInput, body);
    return { team: await this.workspaces.createTeam(await this.access.forWorkspace(auth, id), input) };
  }

  @Patch(':id/teams/:teamId')
  @UseGuards(SessionOnlyGuard)
  async updateTeam(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Body() body: unknown,
  ) {
    const input = parse(updateTeamInput, body);
    return { team: await this.workspaces.updateTeam(await this.access.forWorkspace(auth, id), teamId, input) };
  }

  @Delete(':id/teams/:teamId')
  @UseGuards(SessionOnlyGuard)
  async removeTeam(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
  ) {
    return this.workspaces.removeTeam(await this.access.forWorkspace(auth, id), teamId);
  }

  // ── activity

  @Get(':id/activity')
  async activityLog(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() query: unknown) {
    const q = parse(activityQuery, query);
    return { activity: await this.activity.list(await this.access.forWorkspace(auth, id), q) };
  }
}

/** Invite links: preview works signed out (the page shows who invites you); joining needs an account. */
@Controller('api/invites')
export class InvitesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly auth: AuthService,
  ) {}

  @Get(':token')
  async preview(@Req() req: Request, @Param('token') token: string) {
    inviteLimit(req.ip ?? 'unknown');
    const me = await this.auth.authenticate(req).catch(() => null);
    return { invite: await this.workspaces.previewInvite(token, me?.user.id) };
  }

  @Post(':token/accept')
  @HttpCode(200)
  @UseGuards(AuthGuard, SessionOnlyGuard)
  async accept(@Req() req: Request, @Auth() auth: AuthContext, @Param('token') token: string) {
    inviteLimit(req.ip ?? 'unknown');
    return { workspaceId: await this.workspaces.acceptInvite(auth, token) };
  }
}

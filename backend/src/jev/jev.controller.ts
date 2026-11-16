import { Body, Controller, Get, Post, Put, Req, UseGuards } from '@nestjs/common';
import {
  jevDependenciesInput,
  jevPostponeInput,
  jevPrioritiesInput,
  jevSettingsInput,
  jevTriageInput,
} from '@obelisk/core';
import type { Request } from 'express';
import { Auth, AuthGuard, SessionOnlyGuard } from '../auth/auth.guard';
import { toUser, type AuthContext } from '../auth/auth.service';
import { parse } from '../common/validation';
import { AccessService } from '../workspace/access.service';
import { JevService } from './jev.service';
import { jevStatus } from './status';

/**
 * Jev hints for the web app. Every route uses the caller's own TypeSafe key and only
 * describes tasks the caller can see. Nothing here writes tasks: the client applies a
 * suggestion through the ordinary task and postpone endpoints (permissions, activity log).
 */
@Controller('api/jev')
@UseGuards(AuthGuard)
export class JevController {
  constructor(
    private readonly jev: JevService,
    private readonly access: AccessService,
  ) {}

  @Get('settings')
  settings(@Auth() auth: AuthContext) {
    return { jev: jevStatus(auth.user) };
  }

  /** Keys are entered in the web app only: an API token or AI app can't swap them. */
  @Put('settings')
  @UseGuards(SessionOnlyGuard)
  async updateSettings(@Auth() auth: AuthContext, @Body() body: unknown) {
    const { user, jev } = await this.jev.updateSettings(auth.user, parse(jevSettingsInput, body));
    return { jev, user: toUser(user) };
  }

  @Post('priorities')
  async priorities(@Auth() auth: AuthContext, @Req() req: Request, @Body() body: unknown) {
    const input = parse(jevPrioritiesInput, body);
    return this.jev.priorities(await this.access.fromRequest(auth, req), input);
  }

  @Post('postpone')
  async postpone(@Auth() auth: AuthContext, @Req() req: Request, @Body() body: unknown) {
    const input = parse(jevPostponeInput, body);
    return { plan: await this.jev.postpone(await this.access.fromRequest(auth, req), input) };
  }

  @Post('triage')
  async triage(@Auth() auth: AuthContext, @Req() req: Request, @Body() body: unknown) {
    const input = parse(jevTriageInput, body);
    return { suggestion: await this.jev.triage(await this.access.fromRequest(auth, req), input) };
  }

  @Post('dependencies')
  async dependencies(@Auth() auth: AuthContext, @Body() body: unknown) {
    const { taskId } = parse(jevDependenciesInput, body);
    return this.jev.dependencies(await this.access.forTask(auth, taskId), taskId);
  }
}

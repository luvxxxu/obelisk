import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import {
  actualInput,
  autoPlanInput,
  commitInput,
  createBlockInput,
  isoDate,
  manualEntryInput,
  timerInput,
  todayIn,
  updateBlockInput,
  type ISODate,
} from '@obelisk/core';
import type { Request } from 'express';
import { z } from 'zod';
import { Auth, AuthGuard } from '../auth/auth.guard';
import type { AuthContext } from '../auth/auth.service';
import { parse } from '../common/validation';
import { AccessService } from '../workspace/access.service';
import { OddsService } from './odds.service';
import { PlanService } from './plan.service';
import { TasksService } from './tasks.service';
import { TimeService } from './time.service';

const rangeQuery = z.object({ from: isoDate, to: isoDate });

/**
 * Time tracking, day plans and finish-date odds.
 *  - /api/time/*    the caller's clock and entries (one clock per person, across spaces)
 *  - /api/plan/*    the caller's own day plans (nobody else sees them)
 *  - /api/odds/*    finish-date odds and promise dates for the open space
 */
@Controller('api')
@UseGuards(AuthGuard)
export class TimeController {
  constructor(
    private readonly time: TimeService,
    private readonly plan: PlanService,
    private readonly odds: OddsService,
    private readonly tasks: TasksService,
    private readonly access: AccessService,
  ) {}

  private date(auth: AuthContext, raw: string): ISODate {
    if (raw === 'today') return todayIn(auth.user.timezone);
    const r = isoDate.safeParse(raw);
    if (!r.success) throw new BadRequestException('날짜는 YYYY-MM-DD 또는 today로 적어 주세요');
    return r.data;
  }

  private async task(auth: AuthContext, id: string) {
    return this.tasks.get(await this.access.forTask(auth, id), id);
  }

  // ── time

  @Get('time/running')
  async running(@Auth() auth: AuthContext) {
    return { running: await this.time.running(auth) };
  }

  @Post('time/timer')
  async timer(@Auth() auth: AuthContext, @Body() body: unknown) {
    const { taskId, action } = parse(timerInput, body);
    const { a, startDoing } = await this.time.timer(auth, taskId, action);
    const task = startDoing ? await this.tasks.update(a, taskId, { status: 'doing' }) : await this.tasks.get(a, taskId);
    return { running: await this.time.running(auth), task };
  }

  @Get('tasks/:id/time')
  async entries(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return { entries: await this.time.forTask(await this.access.forTask(auth, id), id) };
  }

  @Post('time/entries')
  async addEntry(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(manualEntryInput, body);
    await this.time.addManual(auth, input.taskId, input.minutes, input.date);
    return { task: await this.task(auth, input.taskId) };
  }

  @Delete('time/entries/:id')
  async removeEntry(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const taskId = await this.time.remove(auth, id);
    return { task: await this.task(auth, taskId) };
  }

  @Put('tasks/:id/actual')
  async setActual(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { minutes } = parse(actualInput, body);
    await this.time.setActual(auth, id, minutes);
    return { task: await this.task(auth, id), running: await this.time.running(auth) };
  }

  // ── day plans

  @Get('plan/day/:date')
  day(@Auth() auth: AuthContext, @Param('date') date: string) {
    return this.plan.day(auth, this.date(auth, date));
  }

  @Post('plan/day/:date/auto')
  auto(@Auth() auth: AuthContext, @Param('date') date: string, @Body() body: unknown) {
    return this.plan.auto(auth, this.date(auth, date), parse(autoPlanInput, body ?? {}));
  }

  @Delete('plan/day/:date')
  clear(@Auth() auth: AuthContext, @Param('date') date: string, @Query('unlocked') unlocked?: string) {
    return this.plan.clear(auth, this.date(auth, date), unlocked === 'true');
  }

  @Get('plan/blocks')
  async blocks(@Auth() auth: AuthContext, @Query() query: unknown) {
    const { from, to } = parse(rangeQuery, query);
    return { blocks: await this.plan.range(auth, from, to) };
  }

  @Post('plan/blocks')
  async createBlock(@Auth() auth: AuthContext, @Body() body: unknown) {
    return { block: await this.plan.create(auth, parse(createBlockInput, body)) };
  }

  @Patch('plan/blocks/:id')
  async updateBlock(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return { block: await this.plan.update(auth, id, parse(updateBlockInput, body)) };
  }

  @Delete('plan/blocks/:id')
  removeBlock(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.plan.remove(auth, id);
  }

  // ── odds

  @Get('odds')
  async forecast(@Auth() auth: AuthContext, @Req() req: Request) {
    return this.odds.forecast(auth, await this.access.fromRequest(auth, req));
  }

  @Post('odds/commit')
  async commit(@Auth() auth: AuthContext, @Req() req: Request, @Body() body: unknown) {
    const input = parse(commitInput, body);
    const a = input.taskId
      ? await this.access.forTask(auth, input.taskId)
      : input.projectId
        ? await this.access.forProject(auth, input.projectId)
        : await this.access.fromRequest(auth, req);
    return this.odds.commit(auth, a, input);
  }

  @Get('odds/calibration')
  async calibration(@Auth() auth: AuthContext) {
    return { calibration: await this.odds.calibration(auth) };
  }
}

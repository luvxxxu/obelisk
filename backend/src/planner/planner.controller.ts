import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import {
  bulkCreateTasksInput,
  createProjectInput,
  createTaskInput,
  delayInput,
  dependencyInput,
  isoDate,
  moveProjectInput,
  postponeInput,
  reorderTasksInput,
  rescheduleInput,
  taskStatus,
  todayIn,
  updateProjectAccessInput,
  updateProjectInput,
  updateTaskInput,
  VIEW_NAMES,
  type Bootstrap,
} from '@obelisk/core';
import type { Request } from 'express';
import { z } from 'zod';
import { Auth, AuthGuard, SessionOnlyGuard } from '../auth/auth.guard';
import { toUser, type AuthContext } from '../auth/auth.service';
import { parse } from '../common/validation';
import { AccessService, type Access } from '../workspace/access.service';
import { ActivityService } from '../workspace/activity.service';
import { WorkspacesService } from '../workspace/workspaces.service';
import { ImpactService } from './impact.service';
import { ProjectsService } from './projects.service';
import { TasksService } from './tasks.service';

const listQuery = z.object({
  view: z.enum(VIEW_NAMES).optional(),
  projectId: z.union([z.uuid(), z.literal('inbox')]).optional(),
  status: taskStatus.optional(),
  q: z.string().max(200).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  /** a user id, "me", or "none" */
  assignee: z.union([z.uuid(), z.literal('me'), z.literal('none')]).optional(),
});

/**
 * The workspace comes from the `x-obelisk-workspace` header (or ?workspace=), else the
 * user's default. Routes addressing one task or project by id use that thing's own
 * workspace, so links keep working whichever workspace a client has open.
 */
@Controller('api')
@UseGuards(AuthGuard)
export class PlannerController {
  constructor(
    private readonly tasks: TasksService,
    private readonly projects: ProjectsService,
    private readonly impact: ImpactService,
    private readonly access: AccessService,
    private readonly activity: ActivityService,
    private readonly workspaces: WorkspacesService,
  ) {}

  private ws(auth: AuthContext, req: Request): Promise<Access> {
    return this.access.fromRequest(auth, req);
  }

  /** Everything the web app needs for one workspace in one round trip. */
  @Get('bootstrap')
  async bootstrap(@Auth() auth: AuthContext, @Req() req: Request): Promise<Bootstrap> {
    const a = await this.ws(auth, req);
    const [workspace, workspaces, members, teams, projects, tasks, deps] = await Promise.all([
      this.workspaces.detail(a),
      this.workspaces.listFor(auth.user.id),
      this.workspaces.members(a.workspaceId),
      this.workspaces.teams(a.workspaceId),
      this.projects.list(a, { includeArchived: true }),
      this.tasks.listForClient(a),
      this.tasks.dependencies(a),
    ]);
    const ids = new Set(tasks.map((t) => t.id));
    return {
      user: toUser(auth.user),
      today: todayIn(auth.user.timezone),
      workspace,
      workspaces,
      members,
      teams,
      projects,
      tasks,
      dependencies: deps.filter((d) => ids.has(d.taskId) && ids.has(d.dependsOnId)),
    };
  }

  // ── tasks

  @Get('tasks')
  async listTasks(@Auth() auth: AuthContext, @Req() req: Request, @Query() query: unknown) {
    const q = parse(listQuery, query);
    const a = await this.ws(auth, req);
    const tasks = await this.tasks.list(
      a,
      {
        view: q.view,
        projectId: q.projectId === 'inbox' ? null : q.projectId,
        status: q.status,
        query: q.q,
        from: q.from,
        to: q.to,
        limit: q.limit,
        assigneeId: q.assignee === 'me' ? a.userId : q.assignee === 'none' ? null : q.assignee,
      },
      todayIn(auth.user.timezone),
    );
    return { tasks };
  }

  @Post('tasks')
  async createTask(@Auth() auth: AuthContext, @Req() req: Request, @Body() body: unknown) {
    const input = parse(createTaskInput, body);
    const a = input.projectId ? await this.access.forProject(auth, input.projectId) : await this.ws(auth, req);
    return { task: await this.tasks.create(a, input) };
  }

  @Post('tasks/bulk')
  async bulkCreate(@Auth() auth: AuthContext, @Req() req: Request, @Body() body: unknown) {
    const input = parse(bulkCreateTasksInput, body);
    const a = input.projectId ? await this.access.forProject(auth, input.projectId) : await this.ws(auth, req);
    return this.tasks.createMany(a, input);
  }

  @Post('tasks/reschedule')
  async reschedule(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(rescheduleInput, body);
    return { tasks: await this.tasks.reschedule(await this.access.forTask(auth, input.changes[0]!.taskId), input) };
  }

  @Post('tasks/reorder')
  async reorder(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(reorderTasksInput, body);
    return { tasks: await this.tasks.reorder(await this.access.forTask(auth, input.changes[0]!.taskId), input) };
  }

  @Get('tasks/:ref')
  async getTask(@Auth() auth: AuthContext, @Req() req: Request, @Param('ref') ref: string) {
    const a = z.uuid().safeParse(ref).success ? await this.access.forTask(auth, ref) : await this.ws(auth, req);
    return { task: await this.tasks.resolve(a, ref) };
  }

  @Get('tasks/:id/activity')
  async taskActivity(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const a = await this.access.forTask(auth, id);
    await this.tasks.get(a, id);
    return { activity: await this.activity.forTask(a, id) };
  }

  @Patch('tasks/:id')
  async updateTask(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(updateTaskInput, body);
    return { task: await this.tasks.update(await this.access.forTask(auth, id), id, input) };
  }

  @Delete('tasks/:id')
  async deleteTask(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.remove(await this.access.forTask(auth, id), id);
  }

  @Post('tasks/:id/dependencies')
  async addDependency(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { dependsOnId } = parse(dependencyInput, body);
    return { dependency: await this.tasks.addDependency(await this.access.forTask(auth, id), id, dependsOnId) };
  }

  @Delete('tasks/:id/dependencies/:dependsOnId')
  async removeDependency(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('dependsOnId', ParseUUIDPipe) dependsOnId: string,
  ) {
    return this.tasks.removeDependency(await this.access.forTask(auth, id), id, dependsOnId);
  }

  // ── impact

  @Post('impact/simulate')
  async simulate(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(delayInput, body);
    return this.impact.simulate(await this.access.forTask(auth, input.taskId), input);
  }

  @Post('impact/postpone')
  async postpone(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(postponeInput, body);
    return this.impact.postpone(await this.access.forTask(auth, input.taskId), input);
  }

  @Get('impact/forecast')
  async forecast(@Auth() auth: AuthContext, @Req() req: Request) {
    return this.impact.forecast(await this.ws(auth, req));
  }

  @Get('impact/leverage')
  async leverage(@Auth() auth: AuthContext, @Req() req: Request) {
    return { leverage: await this.impact.leverage(await this.ws(auth, req)) };
  }

  // ── projects

  @Get('projects')
  async listProjects(@Auth() auth: AuthContext, @Req() req: Request, @Query('archived') archived?: string) {
    return { projects: await this.projects.list(await this.ws(auth, req), { includeArchived: archived === 'true' }) };
  }

  @Post('projects')
  async createProject(@Auth() auth: AuthContext, @Req() req: Request, @Body() body: unknown) {
    const input = parse(createProjectInput, body);
    return { project: (await this.projects.create(await this.ws(auth, req), input)).project };
  }

  @Patch('projects/:id')
  async updateProject(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(updateProjectInput, body);
    return { project: await this.projects.update(await this.access.forProject(auth, id), id, input) };
  }

  @Delete('projects/:id')
  async deleteProject(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('deleteTasks') deleteTasks?: string,
  ) {
    return this.projects.remove(await this.access.forProject(auth, id), id, { deleteTasks: deleteTasks === 'true' });
  }

  @Get('projects/:id/access')
  async projectAccess(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return { access: await this.projects.getAccess(await this.access.forProject(auth, id), id) };
  }

  /** Who can reach what is decided in the web app only: tokens and AI apps can't widen access. */
  @Put('projects/:id/access')
  @UseGuards(SessionOnlyGuard)
  async updateProjectAccess(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(updateProjectAccessInput, body);
    return { access: await this.projects.updateAccess(await this.access.forProject(auth, id), id, input) };
  }

  @Post('projects/:id/move')
  @UseGuards(SessionOnlyGuard)
  async moveProject(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { workspaceId } = parse(moveProjectInput, body);
    return this.projects.move(await this.access.forProject(auth, id), auth, id, workspaceId);
  }
}

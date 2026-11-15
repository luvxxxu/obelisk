import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  bulkCreateTasksInput,
  createProjectInput,
  createTaskInput,
  delayInput,
  dependencyInput,
  postponeInput,
  rescheduleInput,
  todayIn,
  updateProjectInput,
  updateTaskInput,
  VIEW_NAMES,
  taskStatus,
  isoDate,
  type Bootstrap,
} from '@obelisk/core';
import { z } from 'zod';
import { Auth, AuthGuard, UserId } from '../auth/auth.guard';
import { toUser, type AuthContext } from '../auth/auth.service';
import { parse } from '../common/validation';
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
});

@Controller('api')
@UseGuards(AuthGuard)
export class PlannerController {
  constructor(
    private readonly tasks: TasksService,
    private readonly projects: ProjectsService,
    private readonly impact: ImpactService,
  ) {}

  /** Everything the web app needs in one round trip. */
  @Get('bootstrap')
  async bootstrap(@Auth() auth: AuthContext): Promise<Bootstrap> {
    const userId = auth.user.id;
    const [projects, tasks, deps] = await Promise.all([
      this.projects.list(userId, { includeArchived: true }),
      this.tasks.listForClient(userId),
      this.tasks.dependencies(userId),
    ]);
    const ids = new Set(tasks.map((t) => t.id));
    return {
      user: toUser(auth.user),
      today: todayIn(auth.user.timezone),
      projects,
      tasks,
      dependencies: deps.filter((d) => ids.has(d.taskId) && ids.has(d.dependsOnId)),
    };
  }

  // ── tasks

  @Get('tasks')
  async listTasks(@Auth() auth: AuthContext, @Query() query: unknown) {
    const q = parse(listQuery, query);
    const tasks = await this.tasks.list(
      auth.user.id,
      {
        view: q.view,
        projectId: q.projectId === 'inbox' ? null : q.projectId,
        status: q.status,
        query: q.q,
        from: q.from,
        to: q.to,
        limit: q.limit,
      },
      todayIn(auth.user.timezone),
    );
    return { tasks };
  }

  @Post('tasks')
  async createTask(@UserId() userId: string, @Body() body: unknown) {
    return { task: await this.tasks.create(userId, parse(createTaskInput, body)) };
  }

  @Post('tasks/bulk')
  async bulkCreate(@UserId() userId: string, @Body() body: unknown) {
    return this.tasks.createMany(userId, parse(bulkCreateTasksInput, body));
  }

  @Post('tasks/reschedule')
  async reschedule(@UserId() userId: string, @Body() body: unknown) {
    return { tasks: await this.tasks.reschedule(userId, parse(rescheduleInput, body)) };
  }

  @Get('tasks/:ref')
  async getTask(@UserId() userId: string, @Param('ref') ref: string) {
    return { task: await this.tasks.resolve(userId, ref) };
  }

  @Patch('tasks/:id')
  async updateTask(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return { task: await this.tasks.update(userId, id, parse(updateTaskInput, body)) };
  }

  @Delete('tasks/:id')
  async deleteTask(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.remove(userId, id);
  }

  @Post('tasks/:id/dependencies')
  async addDependency(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { dependsOnId } = parse(dependencyInput, body);
    return { dependency: await this.tasks.addDependency(userId, id, dependsOnId) };
  }

  @Delete('tasks/:id/dependencies/:dependsOnId')
  async removeDependency(
    @UserId() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('dependsOnId', ParseUUIDPipe) dependsOnId: string,
  ) {
    return this.tasks.removeDependency(userId, id, dependsOnId);
  }

  // ── impact

  @Post('impact/simulate')
  async simulate(@UserId() userId: string, @Body() body: unknown) {
    return this.impact.simulate(userId, parse(delayInput, body));
  }

  @Post('impact/postpone')
  async postpone(@UserId() userId: string, @Body() body: unknown) {
    return this.impact.postpone(userId, parse(postponeInput, body));
  }

  @Get('impact/forecast')
  async forecast(@Auth() auth: AuthContext) {
    return this.impact.forecast(auth.user.id, auth.user.timezone);
  }

  @Get('impact/leverage')
  async leverage(@UserId() userId: string) {
    return { leverage: await this.impact.leverage(userId) };
  }

  // ── projects

  @Get('projects')
  async listProjects(@UserId() userId: string, @Query('archived') archived?: string) {
    return { projects: await this.projects.list(userId, { includeArchived: archived === 'true' }) };
  }

  @Post('projects')
  async createProject(@UserId() userId: string, @Body() body: unknown) {
    return { project: await this.projects.create(userId, parse(createProjectInput, body)) };
  }

  @Patch('projects/:id')
  async updateProject(@UserId() userId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return { project: await this.projects.update(userId, id, parse(updateProjectInput, body)) };
  }

  @Delete('projects/:id')
  async deleteProject(
    @UserId() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('deleteTasks') deleteTasks?: string,
  ) {
    return this.projects.remove(userId, id, { deleteTasks: deleteTasks === 'true' });
  }
}

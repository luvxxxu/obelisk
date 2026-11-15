import { Module } from '@nestjs/common';
import { ImpactService } from './impact.service';
import { PlannerController } from './planner.controller';
import { ProjectsService } from './projects.service';
import { TasksService } from './tasks.service';

@Module({
  controllers: [PlannerController],
  providers: [TasksService, ProjectsService, ImpactService],
  exports: [TasksService, ProjectsService, ImpactService],
})
export class PlannerModule {}

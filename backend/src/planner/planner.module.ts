import { Module } from '@nestjs/common';
import { ImpactService } from './impact.service';
import { PlannerController } from './planner.controller';
import { ProjectsService } from './projects.service';
import { OddsService } from './odds.service';
import { PlanService } from './plan.service';
import { TasksService } from './tasks.service';
import { TimeController } from './time.controller';
import { TimeService } from './time.service';
import { WorkService } from './work.service';

@Module({
  controllers: [PlannerController, TimeController],
  providers: [TasksService, ProjectsService, ImpactService, TimeService, WorkService, PlanService, OddsService],
  exports: [TasksService, ProjectsService, ImpactService, TimeService, WorkService, PlanService, OddsService],
})
export class PlannerModule {}

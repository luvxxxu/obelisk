import { Module } from '@nestjs/common';
import { PlannerModule } from '../planner/planner.module';
import { JevController } from './jev.controller';
import { JevService } from './jev.service';

@Module({
  imports: [PlannerModule],
  controllers: [JevController],
  providers: [JevService],
  exports: [JevService],
})
export class JevModule {}

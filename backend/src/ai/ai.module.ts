import { Module } from '@nestjs/common';
import { PlannerModule } from '../planner/planner.module';
import {
  IntegrationController,
  McpController,
  OAuthController,
  TokensController,
  WellKnownController,
} from './ai.controllers';
import { OAuthService } from './oauth.service';
import { TokensService } from './tokens.service';

@Module({
  imports: [PlannerModule],
  controllers: [McpController, WellKnownController, OAuthController, TokensController, IntegrationController],
  providers: [OAuthService, TokensService],
})
export class AiModule {}

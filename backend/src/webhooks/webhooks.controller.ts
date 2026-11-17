import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  createIncomingWebhookInput,
  createWebhookInput,
  updateIncomingWebhookInput,
  updateWebhookInput,
  type WebhooksOverview,
} from '@obelisk/core';
import type { Request } from 'express';
import { Auth, AuthGuard, SessionOnlyGuard } from '../auth/auth.guard';
import type { AuthContext } from '../auth/auth.service';
import { rateLimiter } from '../common/rate-limit';
import { parse } from '../common/validation';
import { AccessService, type Access } from '../workspace/access.service';
import { incomingBody } from './body';
import { IncomingService } from './incoming.service';
import { WebhooksService } from './webhooks.service';

/**
 * Webhook management for the open workspace: its owner in a personal space, owners and admins in
 * an organization. Web sessions only: an API token or AI app must not be able to point the
 * workspace's events at a URL of its choosing.
 */
@Controller('api/webhooks')
@UseGuards(AuthGuard, SessionOnlyGuard)
export class WebhooksController {
  constructor(
    private readonly hooks: WebhooksService,
    private readonly incoming: IncomingService,
    private readonly access: AccessService,
  ) {}

  private async admin(auth: AuthContext, req: Request): Promise<Access> {
    const a = await this.access.fromRequest(auth, req);
    a.assertAdmin('웹훅 관리');
    return a;
  }

  @Get()
  async overview(@Auth() auth: AuthContext, @Req() req: Request): Promise<WebhooksOverview> {
    const a = await this.access.fromRequest(auth, req);
    if (!a.admin) return { canManage: false, webhooks: [], incoming: [] };
    const [webhooks, incoming] = await Promise.all([this.hooks.list(a), this.incoming.list(a)]);
    return { canManage: true, webhooks, incoming };
  }

  @Post()
  async create(@Auth() auth: AuthContext, @Req() req: Request, @Body() body: unknown) {
    return this.hooks.create(await this.admin(auth, req), parse(createWebhookInput, body));
  }

  @Patch(':id')
  async update(@Auth() auth: AuthContext, @Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return { webhook: await this.hooks.update(await this.admin(auth, req), id, parse(updateWebhookInput, body)) };
  }

  @Delete(':id')
  async remove(@Auth() auth: AuthContext, @Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.hooks.remove(await this.admin(auth, req), id);
  }

  @Post(':id/secret')
  async rotateSecret(@Auth() auth: AuthContext, @Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.hooks.rotateSecret(await this.admin(auth, req), id);
  }

  @Post(':id/test')
  async test(@Auth() auth: AuthContext, @Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return { delivery: await this.hooks.test(await this.admin(auth, req), id) };
  }

  @Get(':id/deliveries')
  async deliveries(@Auth() auth: AuthContext, @Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return { deliveries: await this.hooks.deliveries(await this.admin(auth, req), id) };
  }

  @Post(':id/deliveries/:deliveryId/redeliver')
  async redeliver(
    @Auth() auth: AuthContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
  ) {
    return { delivery: await this.hooks.redeliver(await this.admin(auth, req), id, deliveryId) };
  }
}

@Controller('api/incoming-webhooks')
@UseGuards(AuthGuard, SessionOnlyGuard)
export class IncomingWebhooksController {
  constructor(
    private readonly incoming: IncomingService,
    private readonly access: AccessService,
  ) {}

  private async admin(auth: AuthContext, req: Request): Promise<Access> {
    const a = await this.access.fromRequest(auth, req);
    a.assertAdmin('웹훅 관리');
    return a;
  }

  @Post()
  async create(@Auth() auth: AuthContext, @Req() req: Request, @Body() body: unknown) {
    return this.incoming.create(await this.admin(auth, req), parse(createIncomingWebhookInput, body));
  }

  @Patch(':id')
  async update(@Auth() auth: AuthContext, @Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return { incoming: await this.incoming.update(await this.admin(auth, req), id, parse(updateIncomingWebhookInput, body)) };
  }

  @Delete(':id')
  async remove(@Auth() auth: AuthContext, @Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.incoming.remove(await this.admin(auth, req), id);
  }

  @Post(':id/rotate')
  async rotate(@Auth() auth: AuthContext, @Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.incoming.rotate(await this.admin(auth, req), id);
  }
}

/** The secret URL itself is the credential; no session, token or CORS. */
@Controller('api/hooks')
export class IncomingHooksController {
  private readonly limit = rateLimiter(120, 60_000);

  constructor(private readonly incoming: IncomingService) {}

  @Post(':token')
  @HttpCode(200)
  async receive(@Param('token') token: string, @Req() req: Request, @Body() body: unknown) {
    // An outgoing Obelisk webhook pointed at an incoming one would feed itself forever.
    if (req.headers['x-obelisk-event'] || req.headers['x-obelisk-signature']) {
      throw new BadRequestException('Obelisk가 보낸 웹훅은 받는 웹훅으로 다시 받을 수 없습니다 (순환 방지)');
    }
    this.limit(`hook:${token.slice(0, 64)}`);
    return this.incoming.handle(token, incomingBody(req.headers['content-type'], body));
  }
}

import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Auth, AuthGuard, SessionOnlyGuard } from '../auth/auth.guard';
import type { AuthContext } from '../auth/auth.service';
import { AccessService } from '../workspace/access.service';
import { ReservationsService } from './reservations.service';

/**
 * 조직 설정 → 멤버 → 가입 대기: people of an imported organization who haven't joined yet. Owners and
 * admins. There is no "approve": only the person holding the claim link can take a place.
 */
@Controller('api/workspaces/:id/reservations')
@UseGuards(AuthGuard, SessionOnlyGuard)
export class ReservationsController {
  constructor(
    private readonly access: AccessService,
    private readonly reservations: ReservationsService,
  ) {}

  @Get()
  async list(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.reservations.list(await this.access.forWorkspace(auth, id));
  }

  /** Mail a fresh claim link to everyone waiting (owner places only for owners). 400 without SMTP. */
  @Post('mail-all')
  @HttpCode(200)
  async mailAll(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.reservations.mailAll(await this.access.forWorkspace(auth, id));
  }

  /** A new claim link (the previous one stops working). */
  @Post(':rid/link')
  @HttpCode(200)
  async link(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('rid', ParseUUIDPipe) rid: string) {
    const { link } = await this.reservations.rotateLink(await this.access.forWorkspace(auth, id), rid);
    return { link };
  }

  @Post(':rid/mail')
  @HttpCode(200)
  async mail(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('rid', ParseUUIDPipe) rid: string) {
    return this.reservations.mail(await this.access.forWorkspace(auth, id), rid);
  }

  @Delete(':rid')
  async remove(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('rid', ParseUUIDPipe) rid: string) {
    return this.reservations.remove(await this.access.forWorkspace(auth, id), rid);
  }
}

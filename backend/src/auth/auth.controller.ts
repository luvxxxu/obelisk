import { Body, Controller, Delete, Get, HttpCode, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import {
  deleteAccountInput,
  loginInput,
  passwordResetCheckInput,
  passwordResetInput,
  passwordResetRequestInput,
  signupInput,
  updateMeInput,
} from '@obelisk/core';
import type { Request, Response } from 'express';
import { config, SESSION_COOKIE } from '../config';
import { cookieHeader } from '../common/http';
import { parse } from '../common/validation';
import { AvatarsService } from '../workspace/avatars.service';
import { AccountService } from './account.service';
import { Auth, AuthGuard, SessionOnlyGuard } from './auth.guard';
import { AuthService, toUser, type AuthContext } from './auth.service';

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly account: AccountService,
    private readonly avatars: AvatarsService,
  ) {}

  private setSession(res: Response, token: string | null) {
    res.setHeader(
      'Set-Cookie',
      cookieHeader(SESSION_COOKIE, token ?? '', {
        maxAgeSeconds: token ? config.sessionDays * 86_400 : 0,
        secure: config.secureCookies,
      }),
    );
  }

  /** With ?invite=<token>, says whether that invite opens sign-up on a closed server. */
  @Get('signup-status')
  async signupStatus(@Query('invite') invite?: string) {
    return { allowed: await this.auth.signupAllowed(typeof invite === 'string' ? invite : undefined) };
  }

  @Post('signup')
  async signup(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { user, token, joinedWorkspaceId } = await this.auth.signup(parse(signupInput, body));
    this.setSession(res, token);
    return { user: toUser(user), joinedWorkspaceId };
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parse(loginInput, body);
    const { user, token } = await this.auth.login(input.email, input.password);
    this.setSession(res, token);
    return { user: toUser(user) };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = this.auth.sessionTokenFrom(req);
    if (token) await this.auth.destroySession(token);
    this.setSession(res, null);
    return { ok: true };
  }

  // ───────── password reset by mail (signed out)

  /** Whether "비밀번호 찾기" can work here (the server can send mail). */
  @Get('password-reset')
  passwordResetStatus() {
    return { available: this.account.passwordResetAvailable() };
  }

  /** Always answers the same, whether or not the address has an account. */
  @Post('password-reset')
  @HttpCode(200)
  async requestPasswordReset(@Body() body: unknown, @Req() req: Request) {
    await this.account.requestPasswordReset(parse(passwordResetRequestInput, body).email, req.ip ?? 'unknown');
    return { ok: true };
  }

  /** The token travels in the body (it lives in the link's #fragment) so it never lands in a URL log. */
  @Post('password-reset/check')
  @HttpCode(200)
  checkPasswordReset(@Body() body: unknown, @Req() req: Request) {
    return this.account.checkPasswordReset(parse(passwordResetCheckInput, body).token, req.ip ?? 'unknown');
  }

  @Post('password-reset/confirm')
  @HttpCode(200)
  async confirmPasswordReset(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = parse(passwordResetInput, body);
    const { user, session } = await this.account.resetPassword(input.token, input.password, req.ip ?? 'unknown');
    this.setSession(res, session);
    return { user: toUser(user) };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Auth() auth: AuthContext) {
    return { user: toUser(auth.user), via: auth.via };
  }

  @Patch('me')
  @UseGuards(AuthGuard)
  async updateMe(@Auth() auth: AuthContext, @Body() body: unknown) {
    const row = await this.auth.updateMe(auth.user.id, parse(updateMeInput, body));
    return { user: toUser(row) };
  }

  /** Profile photo: the body is the image itself (WebP, PNG or JPEG), already cut square by the client. */
  @Put('me/avatar')
  @UseGuards(AuthGuard, SessionOnlyGuard)
  async setAvatar(@Auth() auth: AuthContext, @Body() body: unknown) {
    return { user: toUser(await this.avatars.setForUser(auth.user.id, body)) };
  }

  @Delete('me/avatar')
  @UseGuards(AuthGuard, SessionOnlyGuard)
  async clearAvatar(@Auth() auth: AuthContext) {
    return { user: toUser(await this.avatars.clearForUser(auth.user.id)) };
  }

  // ───────── account deletion (signed-in web or iOS session only, never an API token or AI app)

  @Get('me/deletion')
  @UseGuards(AuthGuard, SessionOnlyGuard)
  deletionPreview(@Auth() auth: AuthContext) {
    return this.account.deletionPreview(auth.user.id);
  }

  @Delete('me')
  @UseGuards(AuthGuard, SessionOnlyGuard)
  async deleteMe(@Auth() auth: AuthContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    await this.account.deleteAccount(auth, parse(deleteAccountInput, body).password);
    this.setSession(res, null);
    return { ok: true };
  }
}

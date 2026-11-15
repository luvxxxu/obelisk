import { Body, Controller, Get, HttpCode, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { loginInput, signupInput, updateMeInput } from '@obelisk/core';
import type { Request, Response } from 'express';
import { config, SESSION_COOKIE } from '../config';
import { cookieHeader } from '../common/http';
import { parse } from '../common/validation';
import { Auth, AuthGuard } from './auth.guard';
import { AuthService, toUser, type AuthContext } from './auth.service';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private setSession(res: Response, token: string | null) {
    res.setHeader(
      'Set-Cookie',
      cookieHeader(SESSION_COOKIE, token ?? '', {
        maxAgeSeconds: token ? config.sessionDays * 86_400 : 0,
        secure: config.secureCookies,
      }),
    );
  }

  @Get('signup-status')
  async signupStatus() {
    return { allowed: await this.auth.signupAllowed() };
  }

  @Post('signup')
  async signup(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { user, token } = await this.auth.signup(parse(signupInput, body));
    this.setSession(res, token);
    return { user: toUser(user) };
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
}

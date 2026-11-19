import {
  createParamDecorator,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService, type AuthContext } from './auth.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** First-party clients that sign in with a session cookie: the web app and the iOS app. */
const SESSION_CLIENTS = new Set(['web', 'ios']);

export type AuthedRequest = Request & { auth: AuthContext };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const auth = await this.auth.authenticate(req);
    if (!auth) throw new UnauthorizedException('로그인이 필요합니다');
    // Cookie-authenticated writes must carry a header browsers won't send cross-site without CORS.
    const client = req.headers['x-obelisk-client'];
    if (auth.via === 'session' && !SAFE_METHODS.has(req.method) && !(typeof client === 'string' && SESSION_CLIENTS.has(client))) {
      throw new ForbiddenException('Missing x-obelisk-client header');
    }
    req.auth = auth;
    return true;
  }
}

/** Only allow browser sessions (e.g. for minting API tokens). */
@Injectable()
export class SessionOnlyGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (req.auth?.via !== 'session') throw new ForbiddenException('웹 로그인 세션에서만 가능한 작업입니다');
    return true;
  }
}

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().auth;
});

export const UserId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().auth.user.id;
});

import {
  createParamDecorator,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService, gateOf, type AuthContext } from './auth.service';

const ALLOW_GATED = 'obelisk:allowGated';
/**
 * Lets an account that is signed in but not let in yet (address not confirmed, sign-up not approved)
 * reach this route: reading itself, confirming or fixing its address, deleting itself.
 */
export const AllowGated = () => SetMetadata(ALLOW_GATED, true);

const GATE_MESSAGE = {
  email_unverified: '메일 주소를 확인하면 Obelisk를 쓸 수 있어요',
  pending_approval: '서버 운영자가 가입을 승인하면 Obelisk를 쓸 수 있어요',
} as const;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** First-party clients that sign in with a session cookie: the web app and the iOS app. */
const SESSION_CLIENTS = new Set(['web', 'ios']);

export type AuthedRequest = Request & { auth: AuthContext };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const auth = await this.auth.authenticate(req);
    if (!auth) throw new UnauthorizedException('로그인이 필요합니다');
    // Cookie-authenticated writes must carry a header browsers won't send cross-site without CORS.
    const client = req.headers['x-obelisk-client'];
    if (auth.via === 'session' && !SAFE_METHODS.has(req.method) && !(typeof client === 'string' && SESSION_CLIENTS.has(client))) {
      throw new ForbiddenException('Missing x-obelisk-client header');
    }
    const gate = gateOf(auth.user);
    if (gate && !this.reflector.getAllAndOverride<boolean>(ALLOW_GATED, [ctx.getHandler(), ctx.getClass()])) {
      // `code` lets the apps show the right screen (confirm your address / waiting for approval).
      throw new ForbiddenException({ statusCode: 403, error: 'Forbidden', code: gate, message: GATE_MESSAGE[gate] });
    }
    req.auth = auth;
    return true;
  }
}

/** 서버 관리: operators only, from a signed-in web or iOS session (never an API token or AI app). */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (req.auth?.via !== 'session') throw new ForbiddenException('웹 로그인 세션에서만 가능한 작업입니다');
    if (!req.auth.user.admin) throw new ForbiddenException('서버 운영자만 할 수 있어요');
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

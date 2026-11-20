import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { emailDomainAllowed } from '@obelisk/core';
import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import { randomToken, sha256 } from '../common/crypto';
import { actionMail, mailAvailable, sendMail } from '../common/mail';
import { rateLimiter } from '../common/rate-limit';
import { config } from '../config';
import { InjectDb, type Db } from '../db/db.module';
import { emailTokens, passwordResets, users, type UserRow } from '../db/schema';
import { ReservationsService } from '../migration/reservations.service';
import { ServerSettingsService } from '../server/settings.service';

/** Per account: one mail a minute, a handful an hour (each one goes to an address someone typed). */
const minuteLimit = rateLimiter(1, 60_000);
const hourLimit = rateLimiter(6, 60 * 60_000);
const confirmIpLimit = rateLimiter(30, 15 * 60_000);

function limited(key: string) {
  try {
    minuteLimit(key);
    hourLimit(key);
  } catch {
    throw new HttpException('메일을 너무 자주 보냈어요. 잠시 후 다시 시도하세요.', 429);
  }
}

export interface EmailConfirmResult {
  purpose: 'verify' | 'change';
  email: string;
  userId: string;
  /** Organizations the account joined because a reserved place had this (now confirmed) address. */
  joined: number;
}

/**
 * Confirming an address: a one-time link mailed to it. A confirmed address is what lets an account
 * past "메일 확인" on servers that require it, fills reserved places of imported organizations with
 * the same address, and is the only way to change the address an account signs in with.
 */
@Injectable()
export class EmailService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly reservations: ReservationsService,
    private readonly settings: ServerSettingsService,
  ) {}

  private async issue(user: UserRow, purpose: 'verify' | 'change', email: string): Promise<string> {
    const token = randomToken('oev', 24);
    await this.db.transaction(async (tx) => {
      // One live link per purpose: a new mail makes the previous link stop working.
      await tx
        .update(emailTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(emailTokens.userId, user.id), eq(emailTokens.purpose, purpose), isNull(emailTokens.usedAt)));
      await tx.insert(emailTokens).values({
        id: sha256(token),
        userId: user.id,
        purpose,
        email,
        expiresAt: new Date(Date.now() + config.emailTokenHours * 3_600_000),
      });
    });
    return `${config.publicUrl}/verify-email#${token}`;
  }

  /** Right after sign-up, and whenever the account asks again. */
  async sendVerification(user: UserRow): Promise<void> {
    const url = await this.issue(user, 'verify', user.email);
    await sendMail(
      actionMail({
        to: user.email,
        subject: 'Obelisk 메일 주소 확인',
        heading: '메일 주소를 확인해 주세요',
        lines: [
          `${user.name}님, Obelisk 계정(${user.email})의 메일 주소가 맞는지 확인할게요.`,
          `아래 버튼을 누르면 확인이 끝나요. 링크는 ${config.emailTokenHours}시간 동안 한 번만 쓸 수 있어요.`,
        ],
        action: '메일 주소 확인',
        url,
        footer: '가입한 적이 없다면 이 메일은 무시하세요. 확인하지 않은 계정은 쓸 수 없어요.',
      }),
    );
  }

  async requestVerification(user: UserRow): Promise<void> {
    if (!mailAvailable()) throw new BadRequestException('이 서버는 메일을 보낼 수 없어요');
    if (user.emailVerifiedAt) throw new BadRequestException('이미 확인된 주소예요');
    limited(user.id);
    await this.sendVerification(user).catch((err) => {
      console.error(`[mail] verification mail failed: ${(err as Error).message}`);
      throw new BadRequestException('메일을 보내지 못했어요. 잠시 후 다시 시도하세요.');
    });
  }

  /**
   * A link to the new address; the account switches only when it is opened. Needs the password, and
   * the new address must fit the server's domain list (when there is one) unless an operator asks.
   */
  async requestChange(user: UserRow, email: string, password: string): Promise<void> {
    if (!mailAvailable()) throw new BadRequestException('이 서버는 메일을 보낼 수 없어서 주소를 바꿀 수 없어요');
    if (!(await Bun.password.verify(password, user.passwordHash))) throw new UnauthorizedException('비밀번호가 올바르지 않아요');
    if (email === user.email) throw new BadRequestException('지금 쓰는 주소와 같아요');
    const r = await this.settings.row();
    if (!user.admin && !emailDomainAllowed(email, r.allowedEmailDomains)) {
      throw new ForbiddenException(`이 서버는 ${r.allowedEmailDomains.map((d) => `@${d}`).join(', ')} 주소만 쓸 수 있어요`);
    }
    const taken = await this.db.query.users.findFirst({ where: eq(users.email, email) });
    if (taken) throw new ConflictException('이미 다른 계정이 쓰는 주소예요');
    limited(user.id);
    const url = await this.issue(user, 'change', email);
    await sendMail(
      actionMail({
        to: email,
        subject: 'Obelisk 새 메일 주소 확인',
        heading: '이 주소로 바꿀까요?',
        lines: [
          `${user.name}님의 Obelisk 계정 주소를 ${user.email}에서 ${email}(으)로 바꾸려고 해요.`,
          `아래 버튼을 누르면 바뀌고, 그다음부터 이 주소로 로그인해요. 링크는 ${config.emailTokenHours}시간 동안 한 번만 쓸 수 있어요.`,
        ],
        action: '이 주소로 바꾸기',
        url,
        footer: '요청한 적이 없다면 이 메일은 무시하세요. 주소는 바뀌지 않아요.',
      }),
    ).catch((err) => {
      console.error(`[mail] email change mail failed: ${(err as Error).message}`);
      throw new BadRequestException('메일을 보내지 못했어요. 주소를 확인하고 다시 시도하세요.');
    });
  }

  /** Opening the link: no session needed, the link is the proof. */
  async confirm(token: string, ip: string): Promise<EmailConfirmResult> {
    try {
      confirmIpLimit(ip);
    } catch {
      throw new HttpException('요청이 너무 많아요. 잠시 후 다시 시도하세요.', 429);
    }
    const gone = () => new BadRequestException('링크가 만료됐거나 이미 쓰였어요. 확인 메일을 다시 보내 주세요.');
    const out = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(emailTokens)
        .where(and(eq(emailTokens.id, sha256(token.trim())), isNull(emailTokens.usedAt), gt(emailTokens.expiresAt, new Date())))
        .for('update');
      if (!row) throw gone();
      const [user] = await tx.select().from(users).where(eq(users.id, row.userId)).for('update');
      if (!user) throw gone();
      await tx.update(emailTokens).set({ usedAt: new Date() }).where(eq(emailTokens.id, row.id));

      let updated: UserRow;
      if (row.purpose === 'verify') {
        // The address changed since this link went out: it proves nothing about the current one.
        if (row.email !== user.email) throw gone();
        [updated] = (await tx.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id)).returning()) as [UserRow];
      } else {
        const taken = await tx.query.users.findFirst({ where: and(eq(users.email, row.email), ne(users.id, user.id)) });
        if (taken) throw new ConflictException('그사이 다른 계정이 이 주소로 가입했어요');
        [updated] = (await tx
          .update(users)
          .set({ email: row.email, emailVerifiedAt: new Date() })
          .where(eq(users.id, user.id))
          .returning()) as [UserRow];
        // Links mailed to the old address mean nothing now.
        await tx
          .update(emailTokens)
          .set({ usedAt: new Date() })
          .where(and(eq(emailTokens.userId, user.id), isNull(emailTokens.usedAt)));
        await tx
          .update(passwordResets)
          .set({ usedAt: new Date() })
          .where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt)));
      }
      const joined = await this.reservations.claimVerified(tx, updated);
      return { row, before: user, user: updated, joined };
    });

    if (out.row.purpose === 'change') {
      // The old address hears about it, in case it wasn't them.
      void sendMail(
        actionMail({
          to: out.before.email,
          subject: 'Obelisk 메일 주소가 바뀌었어요',
          heading: '로그인 주소가 바뀌었어요',
          lines: [
            `${out.user.name}님의 Obelisk 계정 주소가 ${out.before.email}에서 ${out.user.email}(으)로 바뀌었어요.`,
            '직접 바꾼 게 아니라면 서버 운영자에게 바로 알려 주세요.',
          ],
          action: 'Obelisk 열기',
          url: config.publicUrl,
          footer: '이전 주소로 보내는 마지막 안내예요.',
        }),
      ).catch((err) => console.error(`[mail] email changed notice failed: ${(err as Error).message}`));
    } else if (out.user.pendingApprovalAt && !out.before.emailVerifiedAt) {
      // Operators hear about an application once its address is real.
      void this.settings.notifyPending(out.user).catch(() => {});
    }
    return { purpose: out.row.purpose, email: out.user.email, userId: out.user.id, joined: out.joined };
  }
}

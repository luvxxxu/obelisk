import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { AdminMailJob } from '@obelisk/core';
import { randomUUID } from 'node:crypto';
import { and, isNotNull, isNull, or, eq } from 'drizzle-orm';
import { mailAvailable, sendMail, type Mail } from '../common/mail';
import { config } from '../config';
import { InjectDb, type Db } from '../db/db.module';
import { users, type UserRow } from '../db/schema';
import { AdminLogService } from '../server/log.service';

/** Mailbox SMTP (Gmail, Naver…) throttles bursts; one mail every this many ms stays well under. */
const GAP_MS = Number(process.env.ADMIN_MAIL_GAP_MS ?? 1500);

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A plain notice in the app's look: heading, paragraphs, a footer saying who sent it. No button. */
export function noticeMail(to: string, subject: string, body: string): Mail {
  const host = (() => {
    try {
      return new URL(config.publicUrl).host;
    } catch {
      return config.publicUrl;
    }
  })();
  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const footer = `${host}의 Obelisk 운영자가 이 서버의 모든 사용자에게 보낸 공지예요.`;
  const html = `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
<tr><td align="center" style="padding:48px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Pretendard','Segoe UI',sans-serif;">
<tr><td style="padding:0 0 32px;font-size:15px;font-weight:600;color:#000000;">Obelisk</td></tr>
<tr><td><h1 style="margin:0 0 16px;font-size:22px;line-height:1.35;font-weight:600;color:#000000;">${escapeHtml(subject)}</h1>
${paragraphs.map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#000000;white-space:pre-line;">${escapeHtml(p)}</p>`).join('\n')}
<hr style="border:0;border-top:1px solid #e5e5e5;margin:24px 0 16px;">
<p style="margin:0;font-size:12px;line-height:1.6;color:#8f8f8f;">${escapeHtml(footer)}</p>
</td></tr></table>
</td></tr></table>
</body></html>`;
  return { to, subject, text: `${subject}\n\n${paragraphs.join('\n\n')}\n\n${footer}`, html };
}

/**
 * 서버 관리 → 공지 → 전체 메일. One job at a time, sent one by one with a gap so a mailbox's SMTP
 * doesn't refuse the burst. Progress lives in memory (a restart stops the job; the log keeps what went).
 */
@Injectable()
export class NoticeService {
  private job: (AdminMailJob & { cancel?: boolean }) | null = null;

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly log: AdminLogService,
  ) {}

  current(): AdminMailJob | null {
    if (!this.job) return null;
    const { cancel: _c, ...job } = this.job;
    return job;
  }

  /** Who gets it: accounts that are in (not suspended, approved, confirmed if they had to), optionally only confirmed addresses. */
  private async recipients(audience: 'all' | 'verified') {
    return this.db
      .select({ email: users.email })
      .from(users)
      .where(
        and(
          isNull(users.suspendedAt),
          isNull(users.pendingApprovalAt),
          or(eq(users.mustVerifyEmail, false), isNotNull(users.emailVerifiedAt)),
          audience === 'verified' ? isNotNull(users.emailVerifiedAt) : undefined,
        ),
      );
  }

  async count(audience: 'all' | 'verified'): Promise<number> {
    return (await this.recipients(audience)).length;
  }

  async start(actor: UserRow, input: { subject: string; body: string; audience: 'all' | 'verified' }): Promise<AdminMailJob> {
    if (!mailAvailable()) throw new BadRequestException('SMTP_URL이 설정되지 않아 메일을 보낼 수 없어요');
    if (this.job && !this.job.done) throw new ConflictException('보내는 중인 메일이 있어요. 끝난 뒤 다시 보내세요.');
    const list = await this.recipients(input.audience);
    if (!list.length) throw new BadRequestException('받을 사람이 없어요');
    const job: AdminMailJob & { cancel?: boolean } = {
      id: randomUUID(),
      subject: input.subject,
      audience: input.audience,
      total: list.length,
      sent: 0,
      failed: 0,
      done: false,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      startedBy: actor.name,
    };
    this.job = job;
    void (async () => {
      for (const [i, r] of list.entries()) {
        if (job.cancel) break;
        try {
          await sendMail(noticeMail(r.email, input.subject, input.body));
          job.sent++;
        } catch (err) {
          job.failed++;
          console.error(`[mail] notice to one recipient failed: ${(err as Error).message}`);
        }
        if (i < list.length - 1) await Bun.sleep(GAP_MS);
      }
      job.done = true;
      job.finishedAt = new Date().toISOString();
      await this.log
        .record(this.db, actor, 'mail.sent', null, {
          subject: input.subject,
          audience: input.audience,
          sent: job.sent,
          failed: job.failed,
          total: job.total,
          stopped: !!job.cancel,
        })
        .catch(() => {});
    })();
    return this.current()!;
  }

  stop(): AdminMailJob | null {
    if (this.job && !this.job.done) this.job.cancel = true;
    return this.current();
  }
}

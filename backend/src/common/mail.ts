import { createTransport } from 'nodemailer';
import { config } from '../config';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

type Transport = ReturnType<typeof createTransport>;
let transport: Transport | null = null;

/** Mail goes out through SMTP_URL; without it only development servers "send" (to the log). */
export function mailAvailable(): boolean {
  return !!config.smtpUrl || !config.production;
}

export async function sendMail(mail: Mail): Promise<void> {
  if (!config.smtpUrl) {
    if (config.production) throw new Error('SMTP_URL is not set');
    console.log(`[mail] SMTP_URL is not set, printing instead of sending\n  to: ${mail.to}\n  subject: ${mail.subject}\n${mail.text.replace(/^/gm, '  | ')}`);
    return;
  }
  transport ??= createTransport(
    { url: config.smtpUrl, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 },
    { from: config.mailFrom },
  );
  await transport.sendMail(mail);
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * A plain one-action mail in the app's look: white page, black ink, one pill button.
 * `lines` are paragraphs of plain text; the link is also printed in full for clients that strip buttons.
 */
export function actionMail(input: { to: string; subject: string; heading: string; lines: string[]; action: string; url: string; footer: string }): Mail {
  const p = (t: string, style = '') =>
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#000000;${style}">${escapeHtml(t)}</p>`;
  const html = `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${escapeHtml(input.subject)}</title></head>
<body style="margin:0;padding:0;background:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
<tr><td align="center" style="padding:48px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Pretendard','Segoe UI',sans-serif;">
<tr><td style="padding:0 0 32px;font-size:15px;font-weight:600;color:#000000;">Obelisk</td></tr>
<tr><td><h1 style="margin:0 0 16px;font-size:22px;line-height:1.35;font-weight:600;color:#000000;">${escapeHtml(input.heading)}</h1>
${input.lines.map((l) => p(l)).join('\n')}
<p style="margin:24px 0 32px;"><a href="${escapeHtml(input.url)}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:#000000;color:#ffffff;font-size:15px;font-weight:500;text-decoration:none;">${escapeHtml(input.action)}</a></p>
${p('버튼이 열리지 않으면 아래 주소를 브라우저에 붙여 넣으세요.', 'color:#5d5d5d;font-size:13px;margin-bottom:6px;')}
<p style="margin:0 0 32px;font-size:13px;line-height:1.5;word-break:break-all;"><a href="${escapeHtml(input.url)}" style="color:#5d5d5d;">${escapeHtml(input.url)}</a></p>
<hr style="border:0;border-top:1px solid #e5e5e5;margin:0 0 16px;">
${p(input.footer, 'color:#8f8f8f;font-size:12px;')}
</td></tr></table>
</td></tr></table>
</body></html>`;
  const text = [input.heading, '', ...input.lines.flatMap((l) => [l, '']), `${input.action}: ${input.url}`, '', input.footer].join('\n');
  return { to: input.to, subject: input.subject, text, html };
}

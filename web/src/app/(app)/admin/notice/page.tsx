'use client';

import type { AdminMailJob, ServerSettings } from '@obelisk/core';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Modal, Progress, Skeleton, ui } from '@/components/primitives';
import { api } from '@/lib/api';
import { cx } from '@/lib/format';
import { refresh } from '@/lib/store';
import { toast } from '@/lib/toast';
import { SettingsSection } from '../../settings/SettingsNav';
import { AdminPage, dateTime, num, useAdmin } from '../shared';
import s from '../admin.module.css';

/** 서버 관리 → 공지: a banner over everyone's app, and a mail to everyone. */
export default function AdminNoticePage() {
  const settings = useAdmin<ServerSettings>('/api/admin/settings');
  return (
    <AdminPage lead="점검이나 변경 사항을 이 서버의 모든 사용자에게 알려요.">
      {!settings.data ? (
        <Skeleton height={200} />
      ) : (
        <>
          <Banner settings={settings.data} onSaved={(st) => settings.setData(st)} />
          <MailAll settings={settings.data} />
        </>
      )}
    </AdminPage>
  );
}

function Banner({ settings, onSaved }: { settings: ServerSettings; onSaved: (s: ServerSettings) => void }) {
  const current = settings.announcement?.text ?? '';
  const [text, setText] = useState(current);
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(current), [current]);

  const put = async (value: string) => {
    setBusy(true);
    try {
      onSaved(await api<ServerSettings>('PUT', '/api/admin/announcement', { text: value }));
      await refresh();
      toast.success(value ? '공지를 올렸어요' : '공지를 내렸어요');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title="공지 배너"
      lead={
        settings.announcement
          ? `${dateTime(settings.announcement.at)}부터 모든 화면 위에 보이고 있어요. 사용자가 닫으면 그 브라우저에서는 다시 보이지 않고, 내용을 바꾸면 다시 보여요.`
          : '모든 사용자의 화면 맨 위에 한 줄로 보여요. 사용자는 닫을 수 있어요.'
      }
    >
      <div className={s.formStack}>
        <textarea
          className={cx(ui.input, ui.textarea, s.textarea)}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={300}
          placeholder="예: 11월 21일(금) 밤 11시부터 10분 동안 점검해요."
          aria-label="공지 내용"
        />
        {text.trim() && (
          <div className={s.preview} aria-label="미리보기">
            <Icon name="info" size={15} />
            {text.trim()}
          </div>
        )}
        <div className={s.formFoot}>
          <span className={s.formNote}>{text.length} / 300</span>
          <span style={{ display: 'inline-flex', gap: 8 }}>
            {settings.announcement && (
              <button className={cx(ui.btn, ui.outline)} onClick={() => void put('')} disabled={busy}>
                내리기
              </button>
            )}
            <button className={cx(ui.btn, ui.primary)} onClick={() => void put(text)} disabled={busy || !text.trim() || text.trim() === current}>
              {settings.announcement ? '바꿔 올리기' : '올리기'}
            </button>
          </span>
        </div>
      </div>
    </SettingsSection>
  );
}

function MailAll({ settings }: { settings: ServerSettings }) {
  const [audience, setAudience] = useState<'all' | 'verified'>('all');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [job, setJob] = useState<AdminMailJob | null>(null);
  const [recipients, setRecipients] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const poll = async () => {
    try {
      const r = await api<{ job: AdminMailJob | null; recipients: number }>('GET', `/api/admin/mail?audience=${audience}`);
      setJob(r.job);
      setRecipients(r.recipients);
      return r.job;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    void poll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audience]);

  // While a job runs, follow it.
  useEffect(() => {
    if (!job || job.done) return;
    const t = window.setInterval(() => void poll(), 1500);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.done]);

  const send = async () => {
    setBusy(true);
    try {
      const r = await api<{ job: AdminMailJob }>('POST', '/api/admin/mail', { subject: subject.trim(), body: body.trim(), audience });
      setJob(r.job);
      setSubject('');
      setBody('');
      toast.success(`${num(r.job.total)}명에게 보내기 시작했어요`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    try {
      const r = await api<{ job: AdminMailJob | null }>('POST', '/api/admin/mail/stop');
      setJob(r.job);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const running = !!job && !job.done;
  const disabled = !settings.mailAvailable;

  return (
    <SettingsSection
      title="전체 메일"
      lead={
        disabled
          ? 'SMTP_URL이 설정되지 않아 메일을 보낼 수 없어요.'
          : `정지되지 않고 가입이 끝난 계정에 한 통씩 보내요. 메일함 SMTP는 하루 보내기 한도가 있으니 사용자가 많으면 나눠 보내세요.${
              settings.mailToLog ? ' 개발 모드라 메일은 백엔드 로그에 찍혀요.' : ''
            }`
      }
    >
      {job && (
        <div className={s.job} aria-live="polite">
          <div className={s.jobHead}>
            <span className={s.jobTitle}>{job.subject}</span>
            {running ? (
              <button className={cx(ui.btn, ui.outline, ui.sm)} onClick={() => void stop()}>
                멈추기
              </button>
            ) : (
              <span>{job.finishedAt ? dateTime(job.finishedAt) : ''}</span>
            )}
          </div>
          <Progress value={job.sent + job.failed} max={job.total} label="보낸 메일" size="sm" />
          <span>
            {running ? '보내는 중 · ' : '끝 · '}
            {num(job.sent)} / {num(job.total)}명{job.failed ? ` · 실패 ${num(job.failed)}` : ''} · {job.startedBy}
          </span>
        </div>
      )}

      <div className={s.formStack}>
        <div className={ui.segmented} data-size="sm" role="group" aria-label="받는 사람">
          <button type="button" className={ui.segment} aria-pressed={audience === 'all'} onClick={() => setAudience('all')}>
            모든 사용자
          </button>
          <button type="button" className={ui.segment} aria-pressed={audience === 'verified'} onClick={() => setAudience('verified')}>
            메일 확인된 주소만
          </button>
        </div>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="mail-subject">
            제목
          </label>
          <input id="mail-subject" className={ui.input} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={120} disabled={disabled} />
        </div>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="mail-body">
            내용
          </label>
          <textarea
            id="mail-body"
            className={cx(ui.input, ui.textarea, s.textarea)}
            style={{ minHeight: 160 }}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={5000}
            disabled={disabled}
            placeholder="빈 줄로 문단을 나눠요."
          />
        </div>
        <div className={s.formFoot}>
          <span className={s.formNote}>{recipients !== null ? `받는 사람 ${num(recipients)}명` : ''}</span>
          <button
            className={cx(ui.btn, ui.primary)}
            disabled={disabled || running || busy || !subject.trim() || !body.trim() || !recipients}
            onClick={() => setConfirm(true)}
          >
            보내기
          </button>
        </div>
      </div>

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`${num(recipients ?? 0)}명에게 보낼까요?`}
        width={440}
        footer={
          <>
            <button className={cx(ui.btn, ui.outline)} onClick={() => setConfirm(false)}>
              취소
            </button>
            <button
              className={cx(ui.btn, ui.primary)}
              autoFocus
              onClick={() => {
                setConfirm(false);
                void send();
              }}
            >
              보내기
            </button>
          </>
        }
      >
        <p className={s.dialogText}>
          <strong>{subject.trim()}</strong> 메일을 {audience === 'verified' ? '메일을 확인한 ' : ''}사용자에게 한 통씩 보내요. 보낸 메일은 되돌릴 수 없어요.
        </p>
      </Modal>
    </SettingsSection>
  );
}

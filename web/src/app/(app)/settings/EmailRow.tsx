'use client';

import type { User } from '@obelisk/core';
import { useEffect, useState } from 'react';
import { Badge, Modal, ui } from '@/components/primitives';
import { api } from '@/lib/api';
import { cx } from '@/lib/format';
import { toast } from '@/lib/toast';
import { SettingsRow } from './SettingsNav';
import s from './settings.module.css';

/**
 * 설정 → 프로필 → 이메일: the sign-in address, whether it is confirmed, and changing it (a link goes to
 * the new address; the account moves only when that link is opened).
 */
export function EmailRow({ user }: { user: User | null }) {
  const [mail, setMail] = useState<boolean | null>(null);
  const [sending, setSending] = useState(false);
  const [changing, setChanging] = useState(false);

  useEffect(() => {
    api<{ available: boolean }>('GET', '/api/auth/password-reset')
      .then((r) => setMail(r.available))
      .catch(() => setMail(false));
  }, []);

  const verify = async () => {
    setSending(true);
    try {
      await api('POST', '/api/auth/email/verify');
      toast.success(`${user?.email}(으)로 확인 메일을 보냈어요`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const verified = !!user?.emailVerified;
  return (
    <>
      <SettingsRow
        label="이메일"
        description={
          mail === false
            ? '로그인에 쓰는 주소예요. 이 서버는 메일을 보낼 수 없어서 확인하거나 바꿀 수 없어요.'
            : verified
              ? '로그인에 쓰는 주소예요. 바꾸면 새 주소로 보낸 링크를 열어야 바뀌어요.'
              : '로그인에 쓰는 주소예요. 확인해 두면 다른 서버에서 옮겨 온 조직의 자리에 링크 없이 들어갈 수 있어요.'
        }
      >
        <div className={s.emailControl}>
          <span className={s.value}>{user?.email ?? ''}</span>
          <Badge tone={verified ? 'ok' : 'secondary'}>{verified ? '확인됨' : '확인 전'}</Badge>
          {mail && !verified && (
            <button className={cx(ui.btn, ui.outline, ui.sm)} onClick={() => void verify()} disabled={sending}>
              {sending ? '보내는 중…' : '확인 메일 보내기'}
            </button>
          )}
          {mail && (
            <button className={cx(ui.btn, ui.outline, ui.sm)} onClick={() => setChanging(true)}>
              바꾸기
            </button>
          )}
        </div>
      </SettingsRow>
      <ChangeEmailDialog open={changing} onClose={() => setChanging(false)} current={user?.email ?? ''} />
    </>
  );
}

function ChangeEmailDialog({ open, onClose, current }: { open: boolean; onClose: () => void; current: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setEmail('');
      setPassword('');
      setError(null);
      setSent(null);
    }
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/email/change', { email: email.trim(), password });
      setSent(email.trim().toLowerCase());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="이메일 바꾸기"
      description={sent ? undefined : `지금 주소는 ${current}이에요. 새 주소로 보낸 링크를 열면 바뀌고, 지금 주소로도 알림이 가요.`}
      width={440}
      footer={
        sent ? (
          <button className={cx(ui.btn, ui.primary)} onClick={onClose}>
            확인
          </button>
        ) : (
          <>
            <button className={cx(ui.btn, ui.outline)} onClick={onClose}>
              취소
            </button>
            <button className={cx(ui.btn, ui.primary)} type="submit" form="change-email" disabled={busy || !email.trim() || !password}>
              {busy ? '보내는 중…' : '확인 메일 보내기'}
            </button>
          </>
        )
      }
    >
      {sent ? (
        <p className={s.dialogText}>
          <strong>{sent}</strong>(으)로 확인 메일을 보냈어요. 24시간 안에 메일의 버튼을 누르면 주소가 바뀌어요.
        </p>
      ) : (
        <form id="change-email" className={s.dialogForm} onSubmit={submit}>
          {error && (
            <div className={ui.alert} data-tone="danger" role="alert">
              <div className={ui.alertDescription}>{error}</div>
            </div>
          )}
          <div className={ui.field}>
            <label className={ui.label} htmlFor="change-email-address">
              새 이메일
            </label>
            <input
              id="change-email-address"
              type="email"
              className={ui.input}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              autoFocus
              required
            />
          </div>
          <div className={ui.field}>
            <label className={ui.label} htmlFor="change-email-password">
              비밀번호
            </label>
            <input
              id="change-email-password"
              type="password"
              className={ui.input}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
        </form>
      )}
    </Modal>
  );
}

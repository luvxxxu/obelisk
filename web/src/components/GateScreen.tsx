'use client';

import type { AccountGate, User } from '@obelisk/core';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PasswordField } from '@/app/AuthForm';
import s from '@/app/auth.module.css';
import { api } from '@/lib/api';
import { load, reset } from '@/lib/store';
import { toast } from '@/lib/toast';
import { Icon, Logo } from './Icon';
import { buttonClass, Spinner, ui } from './primitives';

/**
 * Signed in, but not let in yet: the address isn't confirmed, or an operator hasn't approved the
 * sign-up. Shown instead of the app; checks again whenever the tab comes back to the front.
 */
export function GateScreen({ gate }: { gate: AccountGate }) {
  const router = useRouter();
  const [me, setMe] = useState<{ user: User; mailAvailable: boolean } | null>(null);
  const [busy, setBusy] = useState<'send' | 'check' | null>(null);
  const [changing, setChanging] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  useEffect(() => {
    api<{ user: User; mailAvailable: boolean }>('GET', '/api/auth/me')
      .then(setMe)
      .catch(() => {});
    // Confirmed in another tab, or approved meanwhile: coming back is enough.
    const again = () => {
      if (document.visibilityState === 'visible') void load(true);
    };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    const timer = window.setInterval(again, 30_000);
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
      window.clearInterval(timer);
    };
  }, []);

  const logout = async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    reset();
    router.replace('/login');
  };

  const resend = async () => {
    setBusy('send');
    setError(null);
    try {
      await api('POST', '/api/auth/email/verify');
      setSentTo(me?.user.email ?? null);
      toast.success('확인 메일을 다시 보냈어요');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    setBusy('check');
    await load(true);
    setBusy(null);
  };

  const change = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('send');
    setError(null);
    try {
      await api('POST', '/api/auth/email/change', { email: newEmail.trim(), password });
      setSentTo(newEmail.trim().toLowerCase());
      setChanging(false);
      setPassword('');
      toast.success('새 주소로 확인 메일을 보냈어요');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const email = me?.user.email;
  const unverified = gate === 'email_unverified';

  return (
    <div className={s.page}>
      <main className={s.card}>
        <header className={s.header}>
          <span className={s.logo}>
            <Logo size={28} />
          </span>
          <h1 className={s.title}>{unverified ? '메일 주소를 확인해 주세요' : '가입 승인을 기다리고 있어요'}</h1>
          <p className={s.description}>
            {unverified ? (
              <>
                {email ? <span className={s.address}>{sentTo ?? email}</span> : '가입한'} 주소로 보낸 메일의 버튼을 누르면 바로 시작할 수 있어요.
                링크는 24시간 동안 쓸 수 있어요.
              </>
            ) : (
              <>
                이 서버는 운영자가 가입을 승인해야 쓸 수 있어요.
                {email && me?.mailAvailable && (
                  <>
                    {' '}
                    승인되면 <span className={s.address}>{email}</span> 주소로 알려 드려요.
                  </>
                )}
              </>
            )}
          </p>
        </header>

        {!me ? (
          <div className={s.pending}>
            <Spinner label="불러오는 중" />
          </div>
        ) : (
          <div className={s.stack}>
            {error && (
              <div className={ui.alert} data-tone="danger" role="alert">
                <Icon name="alertCircle" size={16} />
                <div className={ui.alertTitle}>요청을 처리하지 못했어요</div>
                <div className={ui.alertDescription}>{error}</div>
              </div>
            )}

            {unverified && changing ? (
              <form className={s.form} onSubmit={change} aria-busy={busy === 'send'}>
                <div className={ui.field}>
                  <label className={ui.label} htmlFor="new-email">
                    새 메일 주소
                  </label>
                  <input
                    id="new-email"
                    type="email"
                    className={`${ui.input} ${s.pillInput}`}
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    required
                    autoFocus
                    autoComplete="email"
                    placeholder="name@example.com"
                  />
                </div>
                <PasswordField value={password} onChange={setPassword} autoComplete="current-password" help="본인 확인을 위해 비밀번호를 입력해 주세요." />
                <div className={s.buttons}>
                  <button type="submit" className={buttonClass({ variant: 'primary', size: 'lg', block: true })} disabled={busy === 'send'}>
                    {busy === 'send' ? '보내는 중…' : '이 주소로 확인 메일 받기'}
                  </button>
                  <button type="button" className={buttonClass({ variant: 'ghost', size: 'lg', block: true })} onClick={() => setChanging(false)}>
                    취소
                  </button>
                </div>
              </form>
            ) : (
              <div className={s.buttons}>
                <button className={buttonClass({ variant: 'primary', size: 'lg', block: true })} onClick={() => void check()} disabled={busy === 'check'}>
                  {busy === 'check' ? '확인하는 중…' : unverified ? '확인했어요' : '다시 확인하기'}
                </button>
                {unverified && (
                  <>
                    <button
                      className={buttonClass({ variant: 'outline', size: 'lg', block: true })}
                      onClick={() => void resend()}
                      disabled={busy === 'send' || !me.mailAvailable}
                    >
                      {busy === 'send' ? '보내는 중…' : '확인 메일 다시 받기'}
                    </button>
                    <button className={buttonClass({ variant: 'ghost', size: 'lg', block: true })} onClick={() => setChanging(true)}>
                      주소를 잘못 적었어요
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        <p className={s.footer}>
          <button type="button" className={s.footerLink} onClick={() => void logout()}>
            다른 계정으로 로그인
          </button>
        </p>
      </main>
    </div>
  );
}

'use client';

import type { User } from '@obelisk/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon, Logo } from '@/components/Icon';
import { buttonClass, Spinner, ui } from '@/components/primitives';
import { api } from '@/lib/api';
import { load } from '@/lib/store';
import { toast } from '@/lib/toast';
import { PasswordField } from '../AuthForm';
import s from '../auth.module.css';

type State = { kind: 'checking' } | { kind: 'invalid' } | { kind: 'ready'; token: string; email: string };

/** The token arrives in the #fragment, so browsers never send it to a server or put it in a Referer. */
function tokenFromHash(): string {
  if (typeof window === 'undefined') return '';
  return decodeURIComponent(location.hash.replace(/^#/, '')).trim();
}

/** Opened from the reset mail: check the link, then take a new password and sign in. */
export function ResetPassword() {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'checking' });
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const token = tokenFromHash();
    if (token.length < 8) {
      setState({ kind: 'invalid' });
      return;
    }
    api<{ valid: boolean; email: string | null }>('POST', '/api/auth/password-reset/check', { token })
      .then((r) => setState(r.valid && r.email ? { kind: 'ready', token, email: r.email } : { kind: 'invalid' }))
      .catch(() => setState({ kind: 'invalid' }));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (state.kind !== 'ready') return;
    setBusy(true);
    setError(null);
    try {
      await api<{ user: User }>('POST', '/api/auth/password-reset/confirm', { token: state.token, password });
      // Drop the spent token from the address bar and history.
      history.replaceState(null, '', location.pathname);
      await load();
      toast.success('비밀번호를 바꿨어요');
      router.replace('/');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const title = state.kind === 'invalid' ? '링크를 쓸 수 없어요' : '새 비밀번호 정하기';

  return (
    <div className={s.page}>
      <main className={s.card}>
        <header className={s.header}>
          <span className={s.logo}>
            <Logo size={28} />
          </span>
          <h1 className={s.title}>{title}</h1>
          {state.kind === 'invalid' && (
            <p className={s.description}>링크가 만료되었거나 이미 사용되었어요. 재설정 링크는 60분 동안 한 번만 쓸 수 있어요.</p>
          )}
          {state.kind === 'ready' && (
            <p className={s.description}>
              <span className={s.address}>{state.email}</span> 계정의 새 비밀번호를 정하세요. 다른 기기에서는 모두 로그아웃돼요.
            </p>
          )}
        </header>

        {state.kind === 'checking' && (
          <div className={s.pending}>
            <Spinner label="링크 확인 중" />
          </div>
        )}

        {state.kind === 'invalid' && (
          <Link href="/forgot-password" className={buttonClass({ variant: 'primary', size: 'lg', block: true, className: s.action })}>
            새 링크 받기
          </Link>
        )}

        {state.kind === 'ready' && (
          <form className={s.form} onSubmit={submit} aria-busy={busy}>
            {error && (
              <div className={ui.alert} data-tone="danger" role="alert">
                <Icon name="alertCircle" size={16} />
                <div className={ui.alertTitle}>비밀번호를 바꾸지 못했어요</div>
                <div className={ui.alertDescription}>{error}</div>
              </div>
            )}
            {/* Lets password managers file the new password under the right account. */}
            <input type="email" name="username" autoComplete="username" value={state.email} readOnly hidden />
            <PasswordField
              label="새 비밀번호"
              value={password}
              onChange={setPassword}
              minLength={8}
              autoComplete="new-password"
              help="8자 이상으로 만들어 주세요."
              autoFocus
            />
            <button type="submit" className={buttonClass({ variant: 'primary', size: 'lg', block: true, className: `${s.action} ${s.submit}` })} disabled={busy}>
              {busy ? (
                <>
                  <span className={ui.spinner} aria-hidden="true" />
                  바꾸는 중…
                </>
              ) : (
                '비밀번호 바꾸고 로그인'
              )}
            </button>
          </form>
        )}

        <p className={s.footer}>
          <Link className={s.footerLink} href="/login">
            로그인으로 돌아가기
          </Link>
        </p>
      </main>
    </div>
  );
}

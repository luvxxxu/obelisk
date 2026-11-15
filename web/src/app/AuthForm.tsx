'use client';

import type { User } from '@obelisk/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon, Logo } from '@/components/Icon';
import { buttonClass, ui } from '@/components/primitives';
import { api } from '@/lib/api';
import { load } from '@/lib/store';
import s from './auth.module.css';

function safeNext(): string {
  if (typeof window === 'undefined') return '/';
  const n = new URLSearchParams(location.search).get('next');
  return n && n.startsWith('/') && !n.startsWith('//') ? n : '/';
}

/** Eye / eye-off glyphs for the password reveal toggle (not in the shared icon set). */
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {off ? (
        <>
          <path d="M10.73 5.08A10.74 10.74 0 0 1 21.94 11.65a1 1 0 0 1 0 .7 10.75 10.75 0 0 1-1.44 2.49" />
          <path d="M14.08 14.16a3 3 0 0 1-4.24-4.24" />
          <path d="M17.48 17.5a10.75 10.75 0 0 1-15.42-5.15 1 1 0 0 1 0-.7 10.75 10.75 0 0 1 4.45-5.14" />
          <path d="m2 2 20 20" />
        </>
      ) : (
        <>
          <path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}

export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signupAllowed, setSignupAllowed] = useState<boolean | null>(null);
  const [nextQuery, setNextQuery] = useState('');
  // UI-only: password visibility + Caps Lock hint.
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);

  useEffect(() => {
    setNextQuery(location.search);
    api<{ user: User }>('GET', '/api/auth/me')
      .then(() => router.replace(safeNext()))
      .catch(() => {});
    api<{ allowed: boolean }>('GET', '/api/auth/signup-status')
      .then((r) => setSignupAllowed(r.allowed))
      .catch(() => setSignupAllowed(false));
  }, [router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signup') {
        await api('POST', '/api/auth/signup', {
          email,
          password,
          name,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
      } else {
        await api('POST', '/api/auth/login', { email, password });
      }
      const next = safeNext();
      if (next.startsWith('/oauth/')) {
        window.location.href = next;
        return;
      }
      await load();
      router.replace(next);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const trackCaps = (e: React.KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(typeof e.getModifierState === 'function' && e.getModifierState('CapsLock'));
  };

  const isLogin = mode === 'login';
  const signupClosed = mode === 'signup' && signupAllowed === false;
  const showFooter = isLogin ? !!signupAllowed : true;

  return (
    <div className={s.page}>
      <main className={s.card}>
        <header className={s.header}>
          <div className={s.logoTile}>
            <Logo size={22} />
          </div>
          <h1 className={s.title}>{isLogin ? 'Obelisk에 로그인' : 'Obelisk 시작하기'}</h1>
          <p className={s.description}>
            {isLogin ? '단순하게 적고, 미루기 전에 미리 확인해요.' : '할 일을 적고, 미루면 무엇이 밀리는지 미리 확인하세요.'}
          </p>
        </header>

        {signupClosed ? (
          <div className={ui.alert}>
            <Icon name="lock" size={16} />
            <div className={ui.alertTitle}>지금은 가입할 수 없어요</div>
            <div className={ui.alertDescription}>이 서버는 새 계정 가입을 받지 않아요. 관리자에게 문의하세요.</div>
          </div>
        ) : (
          <form className={s.form} onSubmit={submit} aria-busy={busy}>
            {error && (
              <div className={ui.alert} data-tone="danger" role="alert">
                <Icon name="alertCircle" size={16} />
                <div className={ui.alertTitle}>{isLogin ? '로그인하지 못했어요' : '계정을 만들지 못했어요'}</div>
                <div className={ui.alertDescription}>{error}</div>
              </div>
            )}
            {mode === 'signup' && (
              <div className={ui.field}>
                <label className={ui.label} htmlFor="name">
                  이름
                </label>
                <input id="name" className={ui.input} value={name} onChange={(e) => setName(e.target.value)} required autoFocus autoComplete="name" />
              </div>
            )}
            <div className={ui.field}>
              <label className={ui.label} htmlFor="email">
                이메일
              </label>
              <input
                id="email"
                type="email"
                className={ui.input}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus={isLogin}
                autoComplete="email"
                placeholder="name@example.com"
              />
            </div>
            <div className={ui.field}>
              <label className={ui.label} htmlFor="password">
                비밀번호
              </label>
              <div className={s.inputWrap}>
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  className={ui.input}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={trackCaps}
                  onKeyUp={trackCaps}
                  onBlur={() => setCapsLock(false)}
                  required
                  minLength={mode === 'signup' ? 8 : 1}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  aria-describedby={mode === 'signup' || capsLock ? 'password-help' : undefined}
                />
                <button
                  type="button"
                  className={`${ui.iconBtn} ${s.reveal}`}
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label="비밀번호 표시"
                  aria-pressed={showPassword}
                  aria-controls="password"
                >
                  <EyeIcon off={showPassword} />
                </button>
              </div>
              {(mode === 'signup' || capsLock) && (
                <p id="password-help" className={`${ui.help} ${s.help}`} data-warn={capsLock || undefined}>
                  {capsLock ? (
                    <>
                      <Icon name="alert" size={13} />
                      Caps Lock이 켜져 있어요
                    </>
                  ) : (
                    '8자 이상으로 만들어 주세요.'
                  )}
                </p>
              )}
            </div>
            <button type="submit" className={buttonClass({ variant: 'primary', size: 'lg', block: true, className: s.submit })} disabled={busy}>
              {busy ? (
                <>
                  <span className={ui.spinner} aria-hidden="true" />
                  잠시만요…
                </>
              ) : isLogin ? (
                '로그인'
              ) : (
                '계정 만들기'
              )}
            </button>
          </form>
        )}

        {showFooter && (
          <p className={s.footer}>
            {isLogin ? (
              <>
                처음이신가요?{' '}
                <Link className={s.footerLink} href={`/signup${nextQuery}`}>
                  계정 만들기
                </Link>
              </>
            ) : (
              <>
                이미 계정이 있나요?{' '}
                <Link className={s.footerLink} href={`/login${nextQuery}`}>
                  로그인
                </Link>
              </>
            )}
          </p>
        )}
      </main>
    </div>
  );
}

'use client';

import type { InvitePreview, SignupStatus, User } from '@obelisk/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon, Logo } from '@/components/Icon';
import { buttonClass, ui } from '@/components/primitives';
import { api } from '@/lib/api';
import { load } from '@/lib/store';
import s from './auth.module.css';

function inviteParam(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(location.search).get('invite');
}

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

/** The pill password input with a reveal toggle and Caps Lock hint (login, sign-up, reset). */
export function PasswordField({
  id = 'password',
  label = '비밀번호',
  value,
  onChange,
  autoComplete,
  minLength,
  help,
  autoFocus,
  labelAside,
}: {
  id?: string;
  label?: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: 'current-password' | 'new-password';
  minLength?: number;
  /** Muted line under the field (replaced by the Caps Lock warning while it is on). */
  help?: string;
  autoFocus?: boolean;
  /** Something on the label's line, right-aligned (the "비밀번호 찾기" link). */
  labelAside?: React.ReactNode;
}) {
  // UI-only: password visibility + Caps Lock hint.
  const [show, setShow] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const trackCaps = (e: React.KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(typeof e.getModifierState === 'function' && e.getModifierState('CapsLock'));
  };
  const helpId = `${id}-help`;
  return (
    <div className={ui.field}>
      <div className={s.labelRow}>
        <label className={ui.label} htmlFor={id}>
          {label}
        </label>
        {labelAside}
      </div>
      <div className={s.inputWrap}>
        <input
          id={id}
          type={show ? 'text' : 'password'}
          className={`${ui.input} ${s.pillInput}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={trackCaps}
          onKeyUp={trackCaps}
          onBlur={() => setCapsLock(false)}
          required
          minLength={minLength}
          autoFocus={autoFocus}
          autoComplete={autoComplete}
          aria-describedby={help || capsLock ? helpId : undefined}
        />
        <button
          type="button"
          className={`${ui.iconBtn} ${s.reveal}`}
          onClick={() => setShow((v) => !v)}
          aria-label="비밀번호 표시"
          aria-pressed={show}
          aria-controls={id}
        >
          <EyeIcon off={show} />
        </button>
      </div>
      {(help || capsLock) && (
        <p id={helpId} className={`${ui.help} ${s.help}`} data-warn={capsLock || undefined}>
          {capsLock ? (
            <>
              <Icon name="alert" size={13} />
              Caps Lock이 켜져 있어요
            </>
          ) : (
            help
          )}
        </p>
      )}
    </div>
  );
}

/** Carries the typed address from the login form to "비밀번호 찾기" without putting it in the URL. */
export const FORGOT_EMAIL_KEY = 'obelisk-forgot-email';

export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<SignupStatus | null>(null);
  const signupAllowed = status ? status.allowed : null;
  const [nextQuery, setNextQuery] = useState('');
  const [resetAvailable, setResetAvailable] = useState(false);
  const [invite, setInvite] = useState<{ token: string; org: string | null } | null>(null);

  useEffect(() => {
    setNextQuery(location.search);
    const token = inviteParam();
    // A server invite (osi_…) only opens sign-up; it names no organization.
    if (token && token.startsWith('osi_')) setInvite({ token, org: null });
    else if (token) {
      setInvite({ token, org: null });
      api<{ invite: InvitePreview }>('GET', `/api/invites/${encodeURIComponent(token)}`)
        .then((r) => {
          setInvite({ token, org: r.invite.valid ? r.invite.workspace.name : null });
          // A reserved place from an imported organization: start from the address and name it was kept for.
          const kept = r.invite.valid ? r.invite.reservation : null;
          if (kept) {
            setEmail((v) => v || kept.email);
            if (mode === 'signup') setName((v) => v || kept.name);
          }
        })
        .catch(() => {});
    }
    api<{ user: User }>('GET', '/api/auth/me')
      .then(() => router.replace(safeNext()))
      .catch(() => {});
    api<SignupStatus>('GET', `/api/auth/signup-status${token ? `?invite=${encodeURIComponent(token)}` : ''}`)
      .then(setStatus)
      .catch(() => setStatus({ allowed: false, first: false, mode: 'closed', invited: false, approval: false, verifyEmail: false, domains: [] }));
    if (mode === 'login') {
      api<{ available: boolean }>('GET', '/api/auth/password-reset')
        .then((r) => setResetAvailable(r.available))
        .catch(() => {});
    }
  }, [router, mode]);

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
          ...(invite ? { inviteToken: invite.token } : {}),
        });
      } else {
        await api('POST', '/api/auth/login', { email, password });
      }
      // Signing up through an invite already joined the org (it opens there); no need to go back to the link.
      const next = mode === 'signup' && invite && safeNext().startsWith('/invite/') ? '/' : safeNext();
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

  const isLogin = mode === 'login';
  const signupClosed = mode === 'signup' && signupAllowed === false;
  const showFooter = isLogin ? !!signupAllowed : true;
  const serverInvite = !!invite && invite.token.startsWith('osi_');
  // What happens after "계정 만들기", said before it is pressed.
  const notes: string[] =
    mode === 'signup' && status?.allowed
      ? [
          ...(status.first ? ['첫 계정이라 이 서버의 운영자가 돼요.'] : []),
          ...(status.domains.length ? [`${status.domains.map((d) => `@${d}`).join(', ')} 주소로만 가입할 수 있어요.`] : []),
          ...(status.verifyEmail ? ['가입하면 메일로 주소를 확인해요.'] : []),
          ...(status.approval ? ['운영자가 가입을 승인하면 쓸 수 있어요.'] : []),
        ]
      : [];

  return (
    <div className={s.page}>
      <main className={s.card}>
        <header className={s.header}>
          <span className={s.logo}>
            <Logo size={28} />
          </span>
          <h1 className={s.title}>{isLogin ? 'Obelisk에 로그인' : 'Obelisk 시작하기'}</h1>
          {(invite || !isLogin) && (
            <p className={s.description}>
              {serverInvite
                ? isLogin
                  ? '이미 계정이 있다면 그대로 로그인하세요.'
                  : '초대 링크로 이 서버에 가입해요.'
                : invite
                  ? isLogin
                    ? `로그인하면 ${invite.org ? `‘${invite.org}’ ` : ''}초대를 수락할 수 있어요.`
                    : `계정을 만들면 ${invite.org ? `‘${invite.org}’에 ` : '초대받은 조직에 '}바로 참여해요.`
                  : '할 일을 적고, 미루면 무엇이 밀리는지 미리 확인하세요.'}
            </p>
          )}
        </header>

        {signupClosed ? (
          <div className={ui.alert}>
            <Icon name="lock" size={16} />
            <div className={ui.alertTitle}>지금은 가입할 수 없어요</div>
            <div className={ui.alertDescription}>
              {invite
                ? '초대 링크가 만료됐거나 더 이상 쓸 수 없어요. 링크를 준 사람에게 새 링크를 받으세요.'
                : status?.mode === 'invite'
                  ? '이 서버는 초대 링크로만 가입할 수 있어요. 서버 운영자나 조직 관리자에게 초대 링크를 받으세요.'
                  : '이 서버는 새 계정 가입을 받지 않아요. 서버 운영자에게 문의하세요.'}
            </div>
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
                <input id="name" className={`${ui.input} ${s.pillInput}`} value={name} onChange={(e) => setName(e.target.value)} required autoFocus autoComplete="name" />
              </div>
            )}
            <div className={ui.field}>
              <label className={ui.label} htmlFor="email">
                이메일
              </label>
              <input
                id="email"
                type="email"
                className={`${ui.input} ${s.pillInput}`}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus={isLogin}
                autoComplete="email"
                placeholder="name@example.com"
              />
            </div>
            <PasswordField
              value={password}
              onChange={setPassword}
              minLength={mode === 'signup' ? 8 : 1}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              help={mode === 'signup' ? '8자 이상으로 만들어 주세요.' : undefined}
              labelAside={
                isLogin && resetAvailable ? (
                  <Link
                    className={s.forgotLink}
                    href="/forgot-password"
                    onClick={() => {
                      try {
                        sessionStorage.setItem(FORGOT_EMAIL_KEY, email.trim());
                      } catch {}
                    }}
                  >
                    비밀번호를 잊으셨나요?
                  </Link>
                ) : undefined
              }
            />
            <button type="submit" className={buttonClass({ variant: 'primary', size: 'lg', block: true, className: `${s.action} ${s.submit}` })} disabled={busy}>
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
            {notes.length > 0 && (
              <ul className={s.notes}>
                {notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
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

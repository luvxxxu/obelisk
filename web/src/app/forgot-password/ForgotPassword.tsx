'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon, Logo } from '@/components/Icon';
import { buttonClass, Spinner, ui } from '@/components/primitives';
import { api } from '@/lib/api';
import { FORGOT_EMAIL_KEY } from '../AuthForm';
import s from '../auth.module.css';

/** "비밀번호 찾기": ask for the address, then say a link is on its way (the same answer for any address). */
export function ForgotPassword() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      const typed = sessionStorage.getItem(FORGOT_EMAIL_KEY);
      if (typed) setEmail(typed);
      sessionStorage.removeItem(FORGOT_EMAIL_KEY);
    } catch {}
    api<{ available: boolean }>('GET', '/api/auth/password-reset')
      .then((r) => setAvailable(r.available))
      .catch(() => setAvailable(false));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const address = email.trim();
      await api('POST', '/api/auth/password-reset', { email: address });
      setSentTo(address);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.page}>
      <main className={s.card}>
        <header className={s.header}>
          <span className={s.logo}>
            <Logo size={28} />
          </span>
          <h1 className={s.title}>{sentTo ? '메일을 확인하세요' : '비밀번호 찾기'}</h1>
          <p className={s.description}>
            {sentTo ? (
              <>
                <span className={s.address}>{sentTo}</span>(으)로 가입한 계정이 있다면 새 비밀번호를 정하는 링크를 보냈어요. 링크는 60분 동안 쓸 수 있어요.
              </>
            ) : (
              '가입한 이메일을 적으면 새 비밀번호를 정하는 링크를 보내 드려요.'
            )}
          </p>
        </header>

        {available === null ? (
          <div className={s.pending}>
            <Spinner />
          </div>
        ) : !available ? (
          <div className={ui.alert}>
            <Icon name="lock" size={16} />
            <div className={ui.alertTitle}>이 서버는 메일을 보낼 수 없어요</div>
            <div className={ui.alertDescription}>서버 관리자에게 비밀번호 초기화를 요청하세요.</div>
          </div>
        ) : sentTo ? (
          <div className={s.buttons}>
            <p className={`${ui.help} ${s.help}`}>메일이 오지 않으면 스팸함을 확인하거나 몇 분 뒤에 다시 보내 보세요.</p>
            <button
              type="button"
              className={buttonClass({ variant: 'outline', size: 'lg', block: true, className: s.action })}
              onClick={() => setSentTo(null)}
            >
              다시 보내기
            </button>
          </div>
        ) : (
          <form className={s.form} onSubmit={submit} aria-busy={busy}>
            {error && (
              <div className={ui.alert} data-tone="danger" role="alert">
                <Icon name="alertCircle" size={16} />
                <div className={ui.alertTitle}>링크를 보내지 못했어요</div>
                <div className={ui.alertDescription}>{error}</div>
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
                autoFocus
                autoComplete="email"
                placeholder="name@example.com"
              />
            </div>
            <button type="submit" className={buttonClass({ variant: 'primary', size: 'lg', block: true, className: `${s.action} ${s.submit}` })} disabled={busy}>
              {busy ? (
                <>
                  <span className={ui.spinner} aria-hidden="true" />
                  보내는 중…
                </>
              ) : (
                '링크 보내기'
              )}
            </button>
          </form>
        )}

        <p className={s.footer}>
          비밀번호가 생각났나요?{' '}
          <Link className={s.footerLink} href="/login">
            로그인
          </Link>
        </p>
      </main>
    </div>
  );
}

'use client';

import type { User } from '@obelisk/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon, Logo } from '@/components/Icon';
import { buttonClass, Spinner, ui } from '@/components/primitives';
import { api, ApiError } from '@/lib/api';
import { load } from '@/lib/store';
import { toast } from '@/lib/toast';
import s from '../auth.module.css';

/** The logged link survives the trip through the login page here (the #fragment would not). */
const KEY = 'obelisk-admin-claim';

type State =
  | { kind: 'checking' }
  | { kind: 'signedOut' }
  | { kind: 'noLink' }
  | { kind: 'ready'; token: string; user: User }
  | { kind: 'already'; user: User };

/**
 * The one-time link the backend logs at start while the server has no operator. Opened signed in,
 * it makes that account an operator. Signed out, it keeps the link for after logging in.
 */
export function ClaimAdmin() {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'checking' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fromHash = decodeURIComponent(location.hash.replace(/^#/, '')).trim();
    if (fromHash) {
      try {
        sessionStorage.setItem(KEY, fromHash);
      } catch {}
      history.replaceState(null, '', location.pathname);
    }
    let token = fromHash;
    if (!token) {
      try {
        token = sessionStorage.getItem(KEY) ?? '';
      } catch {}
    }
    api<{ user: User }>('GET', '/api/auth/me')
      .then(({ user }) => {
        if (user.admin) setState({ kind: 'already', user });
        else if (!token) setState({ kind: 'noLink' });
        else setState({ kind: 'ready', token, user });
      })
      .catch((e) => setState(e instanceof ApiError && e.status === 401 ? { kind: 'signedOut' } : { kind: 'noLink' }));
  }, []);

  const claim = async () => {
    if (state.kind !== 'ready') return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/admin/claim', { token: state.token });
      try {
        sessionStorage.removeItem(KEY);
      } catch {}
      await load();
      toast.success('이제 이 서버의 운영자예요');
      router.replace('/admin');
    } catch (e) {
      setError((e as Error).message);
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
          <h1 className={s.title}>{state.kind === 'already' ? '이미 운영자예요' : '서버 운영자 되기'}</h1>
          <p className={s.description}>
            {state.kind === 'ready' ? (
              <>
                <span className={s.address}>{state.user.email}</span> 계정이 이 서버의 운영자가 돼요. 가입, 사용자, 서버 설정을
                관리할 수 있지만 다른 사람의 작업 내용은 볼 수 없어요.
              </>
            ) : state.kind === 'signedOut' ? (
              '운영자가 될 계정으로 먼저 로그인하세요. 로그인하면 이 화면으로 돌아와요.'
            ) : state.kind === 'noLink' ? (
              '서버 로그에 찍힌 링크를 그대로 열어 주세요. 링크는 백엔드가 시작할 때마다 새로 만들어져요.'
            ) : state.kind === 'already' ? (
              <>
                <span className={s.address}>{state.user.email}</span> 계정은 이미 이 서버의 운영자예요.
              </>
            ) : null}
          </p>
        </header>

        {state.kind === 'checking' && (
          <div className={s.pending}>
            <Spinner label="확인 중" />
          </div>
        )}

        {error && (
          <div className={ui.alert} data-tone="danger" role="alert">
            <Icon name="alertCircle" size={16} />
            <div className={ui.alertTitle}>운영자가 되지 못했어요</div>
            <div className={ui.alertDescription}>{error}</div>
          </div>
        )}

        {state.kind === 'ready' && (
          <button className={buttonClass({ variant: 'primary', size: 'lg', block: true, className: s.action })} onClick={() => void claim()} disabled={busy}>
            {busy ? '처리하는 중…' : '운영자 되기'}
          </button>
        )}
        {state.kind === 'signedOut' && (
          <Link href={`/login?next=${encodeURIComponent('/claim-admin')}`} className={buttonClass({ variant: 'primary', size: 'lg', block: true, className: s.action })}>
            로그인
          </Link>
        )}
        {state.kind === 'already' && (
          <Link href="/admin" className={buttonClass({ variant: 'primary', size: 'lg', block: true, className: s.action })}>
            서버 관리 열기
          </Link>
        )}
      </main>
    </div>
  );
}

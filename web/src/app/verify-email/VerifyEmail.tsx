'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Icon, Logo } from '@/components/Icon';
import { buttonClass, Spinner, ui } from '@/components/primitives';
import { api } from '@/lib/api';
import s from '../auth.module.css';

type State =
  | { kind: 'checking' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; purpose: 'verify' | 'change'; email: string; joined: number };

/** Opened from a confirmation mail (sign-up or a new address). Works signed in or not: the link is the proof. */
export function VerifyEmail() {
  const [state, setState] = useState<State>({ kind: 'checking' });
  const started = useRef(false);

  useEffect(() => {
    // Strict Mode mounts twice in development; the link works once.
    if (started.current) return;
    started.current = true;
    const token = decodeURIComponent(location.hash.replace(/^#/, '')).trim();
    if (token.length < 8) {
      setState({ kind: 'error', message: '링크가 잘렸어요. 메일의 버튼을 다시 눌러 주세요.' });
      return;
    }
    api<{ purpose: 'verify' | 'change'; email: string; joined: number }>('POST', '/api/auth/email/confirm', { token })
      .then((r) => {
        // Drop the spent token from the address bar and history.
        history.replaceState(null, '', location.pathname);
        setState({ kind: 'done', ...r });
      })
      .catch((e) => setState({ kind: 'error', message: (e as Error).message }));
  }, []);

  return (
    <div className={s.page}>
      <main className={s.card}>
        <header className={s.header}>
          <span className={s.logo}>
            <Logo size={28} />
          </span>
          <h1 className={s.title}>
            {state.kind === 'checking'
              ? '확인하는 중이에요'
              : state.kind === 'error'
                ? '링크를 쓸 수 없어요'
                : state.purpose === 'change'
                  ? '메일 주소를 바꿨어요'
                  : '메일 주소를 확인했어요'}
          </h1>
          {state.kind === 'done' && (
            <p className={s.description}>
              {state.purpose === 'change' ? (
                <>
                  이제 <span className={s.address}>{state.email}</span>(으)로 로그인해요.
                </>
              ) : (
                <>
                  <span className={s.address}>{state.email}</span> 주소가 확인됐어요.
                </>
              )}
              {state.joined > 0 && ` 이 주소로 자리가 예약돼 있던 조직 ${state.joined}곳에도 들어갔어요.`}
            </p>
          )}
        </header>

        {state.kind === 'checking' && (
          <div className={s.pending}>
            <Spinner label="링크 확인 중" />
          </div>
        )}

        {state.kind === 'error' && (
          <div className={ui.alert} data-tone="danger" role="alert">
            <Icon name="alertCircle" size={16} />
            <div className={ui.alertTitle}>확인하지 못했어요</div>
            <div className={ui.alertDescription}>{state.message}</div>
          </div>
        )}

        {state.kind !== 'checking' && (
          <Link href="/" className={buttonClass({ variant: 'primary', size: 'lg', block: true, className: s.action })}>
            Obelisk 열기
          </Link>
        )}
      </main>
    </div>
  );
}

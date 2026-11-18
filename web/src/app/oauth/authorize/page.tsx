'use client';

import type { User } from '@obelisk/core';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon, Logo, type IconName } from '@/components/Icon';
import { buttonClass, Skeleton, ui } from '@/components/primitives';
import { api, ApiError } from '@/lib/api';
import s from '../../auth.module.css';

interface RequestInfo {
  clientName: string;
  clientId: string;
  redirectHost: string;
  scope: string;
}

/** What a connected AI app may do — shown on the consent screen (presentation only). */
const PERMISSIONS: { icon: IconName; title: string; detail: string; tone?: 'danger' }[] = [
  { icon: 'listChecks', title: '작업과 프로젝트 관리', detail: '작업과 프로젝트를 보고, 만들고, 수정하고, 완료할 수 있어요' },
  { icon: 'ripple', title: '일정 예측과 조정', detail: '일정 지연 예측을 실행하고 일정을 옮길 수 있어요' },
  {
    icon: 'building',
    title: '개인 공간과 참여한 조직',
    detail: '조직에서는 내 권한(보기·쓰기·관리)만큼만 일하고, 공유·멤버 설정은 바꿀 수 없어요',
  },
  { icon: 'trash', title: '작업과 프로젝트 삭제', detail: 'AI는 삭제하기 전에 꼭 확인을 받아요', tone: 'danger' },
];

/** OAuth consent screen shown to the user when Claude / ChatGPT / … connect. */
export default function AuthorizePage() {
  const [user, setUser] = useState<User | null>(null);
  const [info, setInfo] = useState<RequestInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [params, setParams] = useState<Record<string, string>>({});
  // UI-only: which button was pressed, so its spinner shows.
  const [choice, setChoice] = useState<boolean | null>(null);

  useEffect(() => {
    const p = Object.fromEntries(new URLSearchParams(location.search));
    setParams(p);
    (async () => {
      try {
        const me = await api<{ user: User }>('GET', '/api/auth/me');
        setUser(me.user);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
          return;
        }
        setError((e as Error).message);
        return;
      }
      try {
        setInfo(await api<RequestInfo>('GET', `/api/oauth/request?${new URLSearchParams(p)}`));
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, []);

  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      const r = await api<{ redirectTo: string }>('POST', '/api/oauth/authorize', { ...params, approve });
      location.href = r.redirectTo;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const loading = !info && !error;
  const spinner = <span className={ui.spinner} aria-hidden="true" />;

  return (
    <div className={s.page}>
      <main className={s.card} data-size="wide" aria-busy={loading || busy}>
        <header className={s.header}>
          <span className={s.logo}>
            <Logo size={28} />
          </span>
          {error ? (
            <>
              <h1 className={s.title}>연결할 수 없어요</h1>
              <p className={s.description}>연결 요청을 처리하지 못했어요.</p>
            </>
          ) : (
            <>
              <h1 className={s.title}>{info ? `${info.clientName}에서 Obelisk에 접근하려고 해요` : '확인하는 중…'}</h1>
              {user && (
                <p className={s.description}>
                  <b className={s.strong}>{user.email}</b> 계정으로 연결돼요
                </p>
              )}
            </>
          )}
        </header>

        {error && (
          <div className={s.stack}>
            <div className={ui.alert} data-tone="danger" role="alert">
              <Icon name="alertCircle" size={16} />
              <div className={ui.alertTitle}>{error}</div>
              <div className={ui.alertDescription}>연결하려던 앱에서 처음부터 다시 시도해 주세요.</div>
            </div>
            <Link href="/" className={buttonClass({ variant: 'outline', size: 'lg', block: true, className: s.action })}>
              Obelisk로 이동
            </Link>
          </div>
        )}

        {loading && (
          <div className={s.scopes} aria-hidden="true">
            {PERMISSIONS.map((p) => (
              <div key={p.icon} className={s.scope}>
                <Skeleton width={16} height={16} style={{ borderRadius: 'var(--radius-xs)' }} />
                <div className={s.scopeText}>
                  <Skeleton width="45%" height={12} />
                  <Skeleton width="80%" height={10} />
                </div>
              </div>
            ))}
          </div>
        )}

        {info && !error && (
          <div className={s.stack}>
            <section aria-labelledby="scope-heading">
              <h2 id="scope-heading" className={s.sectionLabel}>
                요청한 권한
              </h2>
              <ul className={s.scopes}>
                {PERMISSIONS.map((p) => (
                  <li key={p.icon} className={s.scope}>
                    <span className={s.scopeIcon} data-tone={p.tone} aria-hidden="true">
                      <Icon name={p.icon} size={16} />
                    </span>
                    <div className={s.scopeText}>
                      <span className={s.scopeTitle}>{p.title}</span>
                      <span className={s.scopeDetail}>{p.detail}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <div className={s.buttons}>
              <button
                type="button"
                className={buttonClass({ variant: 'primary', size: 'lg', block: true, className: s.action })}
                disabled={busy}
                onClick={() => {
                  setChoice(true);
                  void decide(true);
                }}
                autoFocus
              >
                {busy && choice === true && spinner}
                허용
              </button>
              <button
                type="button"
                className={buttonClass({ variant: 'outline', size: 'lg', block: true, className: s.action })}
                disabled={busy}
                onClick={() => {
                  setChoice(false);
                  void decide(false);
                }}
              >
                {busy && choice === false && spinner}
                거부
              </button>
            </div>

            <ul className={s.notes}>
              <li>
                허용하면 <b className={s.strong}>{info.redirectHost}</b>(으)로 돌아가요.
              </li>
              <li>설정 › AI 연결에서 언제든 연결을 끊을 수 있어요.</li>
            </ul>
          </div>
        )}
      </main>
    </div>
  );
}

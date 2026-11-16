'use client';

import { ROLE_LABEL_KO, type InvitePreview } from '@obelisk/core';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { buttonClass, Spinner, ui } from '@/components/primitives';
import { WorkspaceMark } from '@/components/WorkspaceSwitcher';
import { api } from '@/lib/api';
import { switchWorkspace } from '@/lib/store';
import s from '../../auth.module.css';
import i from './invite.module.css';

const REASON: Record<NonNullable<InvitePreview['reason']>, string> = {
  expired: '기한이 지난 초대 링크예요.',
  revoked: '관리자가 취소한 초대 링크예요.',
  used_up: '사용 횟수가 모두 끝난 초대 링크예요.',
};

/** An organization invite: who invites you where, then join (signing up or in first if needed). */
export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ invite: InvitePreview }>('GET', `/api/invites/${encodeURIComponent(token)}`)
      .then((r) => setInvite(r.invite))
      .catch((e) => setError((e as Error).message));
  }, [token]);

  const signedIn = invite?.alreadyMember !== undefined;
  const back = `next=${encodeURIComponent(`/invite/${token}`)}&invite=${encodeURIComponent(token)}`;

  const join = async () => {
    setBusy(true);
    try {
      const { workspaceId } = await api<{ workspaceId: string }>('POST', `/api/invites/${encodeURIComponent(token)}/accept`);
      router.replace('/');
      await switchWorkspace(workspaceId);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className={s.page}>
      <main className={s.card}>
        {!invite && !error ? (
          <div className={i.loading}>
            <Spinner />
          </div>
        ) : error && !invite ? (
          <>
            <header className={s.header}>
              <div className={s.logoTile}>
                <Icon name="link" size={20} />
              </div>
              <h1 className={s.title}>초대 링크를 열 수 없어요</h1>
              <p className={s.description}>{error}</p>
            </header>
            <Link href="/" className={buttonClass({ variant: 'outline', size: 'lg', block: true })}>
              Obelisk로 가기
            </Link>
          </>
        ) : (
          invite && (
            <>
              <header className={s.header}>
                <div className={i.mark}>
                  <WorkspaceMark ws={{ kind: 'org', name: invite.workspace.name }} size="lg" />
                </div>
                <p className={i.eyebrow}>{invite.invitedBy ? `${invite.invitedBy}님의 초대` : '조직 초대'}</p>
                <h1 className={s.title}>{invite.workspace.name}</h1>
                <p className={s.description}>
                  멤버 {invite.workspace.memberCount}명 · {ROLE_LABEL_KO[invite.role]}로 참여해요
                </p>
              </header>

              {error && (
                <div className={ui.alert} data-tone="danger" role="alert">
                  <Icon name="alertCircle" size={16} />
                  <div className={ui.alertTitle}>참여하지 못했어요</div>
                  <div className={ui.alertDescription}>{error}</div>
                </div>
              )}

              {invite.alreadyMember ? (
                <button
                  className={buttonClass({ variant: 'primary', size: 'lg', block: true })}
                  onClick={async () => {
                    router.replace('/');
                    await switchWorkspace(invite.workspace.id);
                  }}
                >
                  이미 멤버예요 · 열기
                  <Icon name="arrowRight" size={16} />
                </button>
              ) : !invite.valid ? (
                <div className={ui.alert} data-tone="warn">
                  <Icon name="lock" size={16} />
                  <div className={ui.alertTitle}>{REASON[invite.reason!]}</div>
                  <div className={ui.alertDescription}>조직 관리자에게 새 링크를 요청하세요.</div>
                </div>
              ) : signedIn ? (
                <button className={buttonClass({ variant: 'primary', size: 'lg', block: true })} disabled={busy} onClick={() => void join()}>
                  {busy ? (
                    <>
                      <span className={ui.spinner} aria-hidden="true" /> 참여하는 중…
                    </>
                  ) : (
                    <>
                      {invite.workspace.name}에 참여하기
                      <Icon name="arrowRight" size={16} />
                    </>
                  )}
                </button>
              ) : (
                <div className={i.actions}>
                  <Link href={`/signup?${back}`} className={buttonClass({ variant: 'primary', size: 'lg', block: true })}>
                    계정 만들고 참여하기
                  </Link>
                  <Link href={`/login?${back}`} className={buttonClass({ variant: 'outline', size: 'lg', block: true })}>
                    이미 계정이 있어요 · 로그인
                  </Link>
                </div>
              )}

              <ul className={i.facts}>
                <li>
                  <Icon name="lock" size={14} /> 공유받은 프로젝트만 볼 수 있어요. 내 개인 공간은 그대로 나만 봐요.
                </li>
                <li>
                  <Icon name="sparkle" size={14} /> 연결한 AI도 이 조직에서 내 권한만큼만 일해요.
                </li>
              </ul>
            </>
          )
        )}
      </main>
    </div>
  );
}

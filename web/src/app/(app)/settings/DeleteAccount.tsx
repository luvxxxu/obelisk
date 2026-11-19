'use client';

import type { AccountDeletionPreview } from '@obelisk/core';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Modal, Spinner, ui } from '@/components/primitives';
import { api } from '@/lib/api';
import { cx } from '@/lib/format';
import { reset, switchWorkspace } from '@/lib/store';
import s from './settings.module.css';

/**
 * "계정 삭제": first what goes with the account (or which organizations need another owner first),
 * then the password, then gone.
 */
export function DeleteAccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [preview, setPreview] = useState<AccountDeletionPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setLoadError(null);
    setPassword('');
    setError(null);
    setBusy(false);
    api<AccountDeletionPreview>('GET', '/api/auth/me/deletion')
      .then(setPreview)
      .catch((e) => setLoadError((e as Error).message));
  }, [open]);

  const blocked = !!preview?.blockers.length;

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api('DELETE', '/api/auth/me', { password });
      reset();
      router.replace('/login');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
      // The server re-checks ownership; refresh the list if that is what stopped it.
      api<AccountDeletionPreview>('GET', '/api/auth/me/deletion').then(setPreview).catch(() => {});
    }
  };

  const openOrg = async (id: string) => {
    onClose();
    await switchWorkspace(id);
    router.push('/settings/org');
  };

  const p = preview;
  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      width={460}
      title={blocked ? '먼저 소유자를 넘겨 주세요' : '계정을 삭제할까요?'}
      description={
        blocked
          ? '다른 멤버가 있는 조직의 마지막 소유자는 계정을 삭제할 수 없어요. 다른 멤버를 소유자로 지정하거나 조직을 삭제한 뒤 다시 시도하세요.'
          : '삭제하면 되돌릴 수 없어요. 아래 항목이 영구히 지워져요.'
      }
      footer={
        blocked ? (
          <button className={cx(ui.btn, ui.outline)} onClick={onClose}>
            닫기
          </button>
        ) : (
          <>
            <button className={cx(ui.btn, ui.outline)} onClick={onClose} disabled={busy}>
              취소
            </button>
            <button className={cx(ui.btn, ui.danger)} disabled={!p || !password || busy} onClick={() => void submit()}>
              {busy ? (
                <>
                  <span className={ui.spinner} aria-hidden="true" />
                  삭제하는 중…
                </>
              ) : (
                '계정 영구 삭제'
              )}
            </button>
          </>
        )
      }
    >
      {loadError ? (
        <div className={ui.alert} data-tone="danger" role="alert">
          <Icon name="alertCircle" size={16} />
          <div className={ui.alertTitle}>정보를 불러오지 못했어요</div>
          <div className={ui.alertDescription}>{loadError}</div>
        </div>
      ) : !p ? (
        <div className={s.deletePending}>
          <Spinner />
        </div>
      ) : blocked ? (
        <ul className={s.deleteList}>
          {p.blockers.map((o) => (
            <li key={o.id} className={s.deleteItem}>
              <Icon name="crown" size={15} className={s.deleteIcon} />
              <span className={s.deleteText}>
                <strong>{o.name}</strong>
                <span>멤버 {o.memberCount}명 · 소유자는 나 혼자</span>
              </span>
              <button type="button" className={cx(ui.btn, ui.outline, ui.sm)} onClick={() => void openOrg(o.id)}>
                조직 설정
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <form className={s.deleteForm} onSubmit={submit}>
          <ul className={s.deleteList}>
            <li className={s.deleteItem}>
              <Icon name="user" size={15} className={s.deleteIcon} />
              <span className={s.deleteText}>
                <strong>개인 공간</strong>
                <span>
                  {p.personal.projects || p.personal.tasks
                    ? `프로젝트 ${p.personal.projects}개, 작업 ${p.personal.tasks}개가 함께 삭제돼요`
                    : '비어 있어요'}
                </span>
              </span>
            </li>
            {p.soloOrgs.length > 0 && (
              <li className={s.deleteItem}>
                <Icon name="building" size={15} className={s.deleteIcon} />
                <span className={s.deleteText}>
                  <strong>혼자 쓰는 조직 {p.soloOrgs.length}곳</strong>
                  <span>{p.soloOrgs.map((o) => o.name).join(', ')}도 함께 삭제돼요</span>
                </span>
              </li>
            )}
            {p.sharedOrgs > 0 && (
              <li className={s.deleteItem}>
                <Icon name="users" size={15} className={s.deleteIcon} />
                <span className={s.deleteText}>
                  <strong>함께 쓰는 조직 {p.sharedOrgs}곳</strong>
                  <span>조직에서 나가요. 내가 만든 작업은 남고 담당자만 비워져요.</span>
                </span>
              </li>
            )}
            <li className={s.deleteItem}>
              <Icon name="plug" size={15} className={s.deleteIcon} />
              <span className={s.deleteText}>
                <strong>연결</strong>
                <span>AI 연결, API 토큰, 받는 웹훅, 모든 기기의 로그인이 끊겨요</span>
              </span>
            </li>
          </ul>
          {error && (
            <div className={ui.alert} data-tone="danger" role="alert">
              <Icon name="alertCircle" size={16} />
              <div className={ui.alertTitle}>삭제하지 못했어요</div>
              <div className={ui.alertDescription}>{error}</div>
            </div>
          )}
          <div className={ui.field}>
            <label className={ui.label} htmlFor="delete-password">
              확인을 위해 비밀번호를 입력하세요
            </label>
            <input
              id="delete-password"
              type="password"
              className={ui.input}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              autoFocus
            />
          </div>
        </form>
      )}
    </Modal>
  );
}

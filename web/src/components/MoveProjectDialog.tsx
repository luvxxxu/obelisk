'use client';

import { type Project } from '@obelisk/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { cx } from '@/lib/format';
import { moveProject, switchWorkspace, useApp } from '@/lib/store';
import { toast } from '@/lib/toast';
import { Icon } from './Icon';
import { Modal, ui } from './primitives';
import { workspaceLabel, WorkspaceMark } from './WorkspaceSwitcher';
import s from './MoveProjectDialog.module.css';

/**
 * Move a project (with its tasks) to another workspace — e.g. bring a personal project
 * into an organization. The server checks "manage" here and project creation there.
 */
export function MoveProjectDialog({
  project,
  taskCount,
  open,
  onClose,
}: {
  project: Project;
  taskCount: number;
  open: boolean;
  onClose: () => void;
}) {
  const app = useApp();
  const router = useRouter();
  const targets = app.workspaces.filter((w) => w.id !== app.workspace?.id);
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = targets.find((w) => w.id === target) ?? null;

  const submit = async () => {
    if (!chosen || busy) return;
    setBusy(true);
    const res = await moveProject(project.id, chosen.id);
    setBusy(false);
    if (!res) return;
    onClose();
    await switchWorkspace(res.workspace.id);
    router.push(`/projects/${project.id}`);
    toast.success(
      `‘${project.name}’을(를) ${workspaceLabel(chosen)}(으)로 옮겼어요${res.linksCut ? ` · 연결 ${res.linksCut}개를 끊었어요` : ''}`,
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={480}
      icon={<Icon name="arrowUpRight" size={18} />}
      title="다른 공간으로 옮기기"
      description={`‘${project.name}’과(와) 작업 ${taskCount}개를 함께 옮겨요.`}
      footer={
        <>
          <button className={cx(ui.btn, ui.outline)} onClick={onClose}>
            취소
          </button>
          <button className={cx(ui.btn, ui.primary)} disabled={!chosen || busy} onClick={() => void submit()}>
            {chosen ? `${workspaceLabel(chosen)}(으)로 옮기기` : '옮기기'}
          </button>
        </>
      }
    >
      {targets.length === 0 ? (
        <p className={s.empty}>옮길 수 있는 다른 공간이 없어요. 사이드바 왼쪽 위에서 조직을 먼저 만들어 보세요.</p>
      ) : (
        <div className={s.targets} role="radiogroup" aria-label="옮길 공간">
          {targets.map((w) => (
            <button
              key={w.id}
              role="radio"
              aria-checked={target === w.id}
              className={s.target}
              data-selected={target === w.id}
              onClick={() => setTarget(w.id)}
            >
              <WorkspaceMark ws={w} size="sm" />
              <span className={s.targetText}>
                <span className={s.targetName}>{workspaceLabel(w)}</span>
                <span className={s.targetMeta}>{w.kind === 'personal' ? '나만 보는 공간' : `멤버 ${w.memberCount}명`}</span>
              </span>
              <span className={s.radio} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
      <ul className={s.notes}>
        <li>작업 번호(#)는 옮긴 공간에서 새로 매겨져요.</li>
        <li>이 프로젝트 밖의 작업과 연결된 선행·후속 관계는 끊어져요.</li>
        <li>공유 설정은 초기화돼요 — 옮긴 곳에서는 나와 관리자만 볼 수 있어요.</li>
        <li>옮긴 공간의 멤버가 아닌 담당자는 해제돼요.</li>
      </ul>
    </Modal>
  );
}

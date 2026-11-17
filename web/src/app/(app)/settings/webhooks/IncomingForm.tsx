'use client';

import { atLeast, type IncomingWebhook, type Project } from '@obelisk/core';
import { useEffect, useState } from 'react';
import { isEnter, Modal, Switch, ui } from '@/components/primitives';
import { api } from '@/lib/api';
import { cx } from '@/lib/format';
import { toast } from '@/lib/toast';
import s from './webhooks.module.css';

export function IncomingForm({
  open,
  initial,
  projects,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: IncomingWebhook | null;
  projects: Project[];
  onClose: () => void;
  onSaved: (hook: IncomingWebhook, url?: string) => void;
}) {
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState<string>('');
  const [allowUpdates, setAllowUpdates] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? '');
    setProjectId(initial?.projectId ?? '');
    setAllowUpdates(initial?.allowUpdates ?? true);
    setSaving(false);
  }, [open, initial]);

  const writable = projects
    .filter((p) => (!p.archivedAt && atLeast(p.access, 'edit')) || p.id === initial?.projectId)
    .sort((a, b) => a.position - b.position);

  const save = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    const body = { name: name.trim(), projectId: projectId || null, allowUpdates };
    try {
      if (initial) {
        const r = await api<{ incoming: IncomingWebhook }>('PATCH', `/api/incoming-webhooks/${initial.id}`, body);
        onSaved(r.incoming);
      } else {
        const r = await api<{ incoming: IncomingWebhook; url: string }>('POST', '/api/incoming-webhooks', body);
        onSaved(r.incoming, r.url);
      }
    } catch (e) {
      toast.error((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={520}
      title={initial ? '받는 웹훅 수정' : '받는 웹훅 추가'}
      description="비밀 URL로 요청을 받으면 내 권한으로 작업을 만들거나 바꿔요."
      footer={
        <>
          <button type="button" className={cx(ui.btn, ui.outline)} onClick={onClose}>
            취소
          </button>
          <button type="button" className={cx(ui.btn, ui.primary)} disabled={!name.trim() || saving} onClick={() => void save()}>
            {saving ? '저장하는 중…' : initial ? '저장' : 'URL 만들기'}
          </button>
        </>
      }
    >
      <div className={s.form}>
        <label className={ui.field}>
          <span className={ui.label}>이름</span>
          <input
            className={ui.input}
            value={name}
            placeholder="예: GitHub Actions, 아이폰 단축어"
            maxLength={80}
            autoFocus={!initial}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => isEnter(e) && void save()}
          />
          <span className={ui.help}>활동 기록에 “웹훅 ‘{name.trim() || '이름'}’ 통해”로 남아요.</span>
        </label>

        <label className={ui.field}>
          <span className={ui.label}>새 작업을 넣을 곳</span>
          <select className={ui.input} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">인박스</option>
            {writable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <span className={ui.help}>요청에 project를 적으면 그 프로젝트로 들어가요 (쓰기 권한이 있는 곳만).</span>
        </label>

        <div className={s.switchRow}>
          <div className={s.switchText}>
            <span className={s.switchTitle}>기존 작업 바꾸기 허용</span>
            <span className={s.switchDesc}>
              “#12 완료”, 마감일·우선순위 변경 같은 요청도 받아요.
              {projectId ? ' 고른 프로젝트의 작업만 바꿀 수 있어요.' : ' 내가 쓰기 권한을 가진 작업이면 어디든 바꿀 수 있어요.'}
            </span>
          </div>
          <Switch checked={allowUpdates} onChange={setAllowUpdates} label="기존 작업 바꾸기 허용" />
        </div>
      </div>
    </Modal>
  );
}

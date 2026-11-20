'use client';

import { describeAdminAction, type AdminLogEntry } from '@obelisk/core';
import { useState } from 'react';
import { Skeleton, ui } from '@/components/primitives';
import { api } from '@/lib/api';
import { cx, relativeTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import { SettingsSection } from '../../settings/SettingsNav';
import { AdminPage, dateTime, num, useAdmin } from '../shared';
import s from '../admin.module.css';

const PAGE = 50;

/** 서버 관리 → 기록: what operators did, newest first. */
export default function AdminLogPage() {
  const first = useAdmin<{ entries: AdminLogEntry[]; total: number }>(`/api/admin/log?limit=${PAGE}`);
  const [extra, setExtra] = useState<AdminLogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const entries = [...(first.data?.entries ?? []), ...extra];
  const total = first.data?.total ?? 0;

  const more = async () => {
    setBusy(true);
    try {
      const r = await api<{ entries: AdminLogEntry[] }>('GET', `/api/admin/log?limit=${PAGE}&offset=${entries.length}`);
      setExtra((e) => [...e, ...r.entries]);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminPage lead="운영자가 한 일이 남아요. 운영자끼리만 볼 수 있어요.">
      <SettingsSection title={first.data ? `기록 ${num(total)}개` : '기록'}>
        {!first.data ? (
          <Skeleton height={120} />
        ) : entries.length === 0 ? (
          <p className={s.empty}>아직 기록이 없어요</p>
        ) : (
          <div>
            {entries.map((e) => (
              <div key={e.id} className={s.logRow}>
                <time className={s.logTime} dateTime={e.createdAt} title={dateTime(e.createdAt)}>
                  {relativeTime(e.createdAt)}
                </time>
                <div className={s.logBody}>
                  <span className={s.logActor}>{e.actorName}</span> · {describeAdminAction(e)}
                  {e.targetLabel && <div className={s.logTarget}>{e.targetLabel}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
        {first.data && entries.length < total && (
          <div className={s.more}>
            <button className={cx(ui.btn, ui.ghost, ui.sm)} onClick={() => void more()} disabled={busy}>
              {busy ? '불러오는 중…' : '더 보기'}
            </button>
          </div>
        )}
      </SettingsSection>
    </AdminPage>
  );
}

'use client';

import { ROLE_LABEL_KO, type AdminOrg, type AdminOrgList, type AdminOrgMember } from '@obelisk/core';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Avatar, Badge, Modal, Spinner, ui } from '@/components/primitives';
import { api } from '@/lib/api';
import { cx } from '@/lib/format';
import { toast } from '@/lib/toast';
import { SettingsSection } from '../../settings/SettingsNav';
import { AdminPage, dateOnly, num } from '../shared';
import s from '../admin.module.css';

const PAGE = 50;

export default function AdminOrgsPage() {
  return (
    <Suspense fallback={null}>
      <AdminOrgs />
    </Suspense>
  );
}

function AdminOrgs() {
  const params = useSearchParams();
  const router = useRouter();
  const [ownerless, setOwnerless] = useState(params.get('ownerless') === '1');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [data, setData] = useState<AdminOrgList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [recover, setRecover] = useState<AdminOrg | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const t = window.setTimeout(() => setQuery(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const url = (offset: number) =>
    `/api/admin/orgs?offset=${offset}&limit=${PAGE}${ownerless ? '&ownerless=true' : ''}${query ? `&q=${encodeURIComponent(query)}` : ''}`;

  const load = async () => {
    const mine = ++seq.current;
    try {
      const d = await api<AdminOrgList>('GET', url(0));
      if (mine === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message);
    }
  };

  useEffect(() => {
    void load();
    router.replace(ownerless ? '/admin/orgs?ownerless=1' : '/admin/orgs', { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerless, query]);

  const loadMore = async () => {
    if (!data) return;
    setMore(true);
    try {
      const d = await api<AdminOrgList>('GET', url(data.orgs.length));
      setData({ ...d, orgs: [...data.orgs, ...d.orgs] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setMore(false);
    }
  };

  return (
    <AdminPage lead="이 서버의 조직이에요. 이름과 규모만 보이고 프로젝트와 작업 내용은 운영자도 볼 수 없어요.">
      <SettingsSection
        title={data ? `조직 ${num(data.total)}곳` : '조직'}
        lead="소유자가 모두 정지되면 그 조직은 아무도 관리할 수 없어요. 그때만 운영자가 남은 멤버 중 한 명을 소유자로 정할 수 있어요."
      >
        <div className={s.toolbar}>
          <div className={s.search}>
            <Icon name="search" size={15} />
            <input placeholder="조직 이름으로 찾기" aria-label="조직 찾기" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className={ui.segmented} data-size="sm" role="group" aria-label="보기">
            <button type="button" className={ui.segment} aria-pressed={!ownerless} onClick={() => setOwnerless(false)}>
              전체
            </button>
            <button type="button" className={ui.segment} aria-pressed={ownerless} onClick={() => setOwnerless(true)}>
              소유자 없음
              {data && data.ownerless > 0 && <span className={s.count}>{data.ownerless}</span>}
            </button>
          </div>
        </div>

        {error && (
          <div className={ui.alert} data-tone="danger" role="alert">
            <Icon name="alertCircle" size={16} />
            <div className={ui.alertDescription}>{error}</div>
          </div>
        )}

        {!data ? (
          <div className={s.empty}>
            <Spinner />
          </div>
        ) : data.orgs.length === 0 ? (
          <p className={s.empty}>{ownerless ? '소유자가 없는 조직이 없어요' : query ? `‘${query}’에 맞는 조직이 없어요` : '아직 조직이 없어요'}</p>
        ) : (
          <ul className={s.people}>
            {data.orgs.map((o) => (
              <li key={o.id} className={s.person}>
                <Avatar name={o.name} src={o.avatarUrl} />
                <div className={s.personText}>
                  <span className={s.personName}>
                    <span>{o.name}</span>
                    {o.ownerless && <Badge tone="warn">소유자 없음</Badge>}
                  </span>
                  <span className={s.personMeta}>
                    멤버 {num(o.members)} · 프로젝트 {num(o.projects)} · 작업 {num(o.tasks)} · {dateOnly(o.createdAt)} 만듦
                  </span>
                  <span className={s.personMeta}>
                    소유자{' '}
                    {o.owners.length
                      ? o.owners.map((w) => `${w.name}${w.suspended ? ' (정지됨)' : ''}`).join(', ')
                      : '없음'}
                  </span>
                </div>
                {o.ownerless && (
                  <div className={s.personActions}>
                    <button className={cx(ui.btn, ui.outline, ui.sm)} onClick={() => setRecover(o)}>
                      소유자 지정
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {data && data.orgs.length < data.total && (
          <div className={s.more}>
            <button className={cx(ui.btn, ui.ghost, ui.sm)} onClick={() => void loadMore()} disabled={more}>
              {more ? '불러오는 중…' : `더 보기 (${num(data.total - data.orgs.length)}곳 더)`}
            </button>
          </div>
        )}
      </SettingsSection>

      <RecoverDialog
        org={recover}
        onClose={() => setRecover(null)}
        onDone={() => {
          toast.success('소유자를 지정했어요');
          void load();
        }}
      />
    </AdminPage>
  );
}

function RecoverDialog({ org, onClose, onDone }: { org: AdminOrg | null; onClose: () => void; onDone: () => void }) {
  const [members, setMembers] = useState<AdminOrgMember[] | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMembers(null);
    setPick(null);
    setError(null);
    if (!org) return;
    api<{ members: AdminOrgMember[] }>('GET', `/api/admin/orgs/${org.id}/members`)
      .then((r) => setMembers(r.members))
      .catch((e) => setError((e as Error).message));
  }, [org]);

  if (!org) return null;
  const submit = async () => {
    if (!pick) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', `/api/admin/orgs/${org.id}/owner`, { userId: pick });
      onDone();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const chosen = members?.find((m) => m.id === pick);

  return (
    <Modal
      open
      onClose={onClose}
      title={`‘${org.name}’의 소유자 지정`}
      description="고른 멤버가 소유자가 돼요. 조직의 활동 기록에도 서버 운영자가 지정했다고 남아요."
      width={480}
      footer={
        <>
          <button className={cx(ui.btn, ui.outline)} onClick={onClose}>
            취소
          </button>
          <button className={cx(ui.btn, ui.primary)} onClick={() => void submit()} disabled={!pick || busy}>
            {busy ? '지정하는 중…' : chosen ? `${chosen.name}님을 소유자로` : '소유자로 지정'}
          </button>
        </>
      }
    >
      <div className={s.dialogStack}>
        {error && (
          <div className={ui.alert} data-tone="danger" role="alert">
            <div className={ui.alertDescription}>{error}</div>
          </div>
        )}
        {!members ? (
          !error && <Spinner />
        ) : (
          <ul className={s.choices} role="radiogroup" aria-label="새 소유자">
            {members.map((m) => (
              <li key={m.id}>
                <label className={s.choice} data-disabled={m.suspended || undefined}>
                  <input type="radio" name="owner" value={m.id} checked={pick === m.id} disabled={m.suspended} onChange={() => setPick(m.id)} />
                  <span className={s.personText}>
                    <span className={s.personName}>
                      <span>{m.name}</span>
                      <Badge tone="secondary">{ROLE_LABEL_KO[m.role]}</Badge>
                      {m.suspended && <Badge tone="danger">정지됨</Badge>}
                    </span>
                    <span className={s.personMeta}>{m.email}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

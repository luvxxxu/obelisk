'use client';

import {
  SIGNUP_MODE_LABEL_KO,
  SIGNUP_MODES,
  type ServerInvite,
  type ServerSettings,
  type SignupMode,
  type UpdateServerSettingsInput,
} from '@obelisk/core';
import { useEffect, useState } from 'react';
import { CopyField } from '@/components/Copy';
import { Icon } from '@/components/Icon';
import { Badge, ConfirmModal, Modal, Skeleton, Switch, ui } from '@/components/primitives';
import { api } from '@/lib/api';
import { cx, relativeTime } from '@/lib/format';
import { refresh } from '@/lib/store';
import { toast } from '@/lib/toast';
import { SettingsRow, SettingsSection } from '../../settings/SettingsNav';
import { AdminPage, dateOnly, useAdmin } from '../shared';
import s from '../admin.module.css';

const MODE_HELP: Record<SignupMode, string> = {
  open: '주소를 아는 사람은 누구나 계정을 만들 수 있어요.',
  approval: '누구나 가입을 신청하고, 운영자가 승인하면 쓸 수 있어요. 초대 링크로 오면 승인 없이 바로 써요.',
  invite: '조직 초대 링크나 서버 초대 링크가 있어야 가입할 수 있어요.',
  closed: '새 계정을 받지 않아요. 초대 링크로도 가입할 수 없고, 이미 있는 계정만 조직 초대를 받을 수 있어요.',
};

/** 서버 관리 → 가입: who can make an account, what they must prove, and links to let one person in. */
export default function AdminSignupPage() {
  const settings = useAdmin<ServerSettings>('/api/admin/settings');
  const [saving, setSaving] = useState<string | null>(null);
  const st = settings.data;

  const save = async (patch: UpdateServerSettingsInput, key: string, done?: string) => {
    setSaving(key);
    try {
      settings.setData(await api<ServerSettings>('PATCH', '/api/admin/settings', patch));
      if (done) toast.success(done);
      if ('orgCreation' in patch) void refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <AdminPage lead="가입 방식은 바로 적용돼요. 환경 변수 SIGNUP_MODE는 처음 값으로만 쓰여요.">
      {!st ? (
        <Skeleton height={240} />
      ) : (
        <>
          <SettingsSection title="가입 방식">
            <div className={ui.segmented} role="group" aria-label="가입 방식" data-full="true">
              {SIGNUP_MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={ui.segment}
                  aria-pressed={st.signupMode === m}
                  disabled={saving === 'mode'}
                  onClick={() => st.signupMode !== m && void save({ signupMode: m }, 'mode', `가입 방식을 ‘${SIGNUP_MODE_LABEL_KO[m]}’으로 바꿨어요`)}
                >
                  {SIGNUP_MODE_LABEL_KO[m]}
                </button>
              ))}
            </div>
            <p className={s.modeHelp}>
              {MODE_HELP[st.signupMode]}
              {st.signupModeFromEnv && ` 지금은 환경 변수 값을 따르고 있어요.`}
            </p>
          </SettingsSection>

          <EmailRules st={st} saving={saving} save={save} />

          <SettingsSection title="조직">
            <SettingsRow
              label={<span id="org-creation">조직 만들기</span>}
              description="‘운영자만’이면 다른 사람은 새 조직을 만들거나 다른 서버의 조직 파일을 가져올 수 없어요. 이미 있는 조직은 그대로예요."
            >
              <div className={ui.segmented} data-size="sm" role="group" aria-labelledby="org-creation">
                {(['everyone', 'admins'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={ui.segment}
                    aria-pressed={st.orgCreation === v}
                    disabled={saving === 'org'}
                    onClick={() => st.orgCreation !== v && void save({ orgCreation: v }, 'org')}
                  >
                    {v === 'everyone' ? '누구나' : '운영자만'}
                  </button>
                ))}
              </div>
            </SettingsRow>
          </SettingsSection>

          <Invites mode={st.signupMode} />
        </>
      )}
    </AdminPage>
  );
}

function EmailRules({
  st,
  saving,
  save,
}: {
  st: ServerSettings;
  saving: string | null;
  save: (patch: UpdateServerSettingsInput, key: string, done?: string) => Promise<void>;
}) {
  const [domains, setDomains] = useState(st.allowedEmailDomains.join(', '));
  useEffect(() => setDomains(st.allowedEmailDomains.join(', ')), [st.allowedEmailDomains]);
  const parsed = domains
    .split(/[\s,]+/)
    .map((d) => d.trim().replace(/^@+/, '').toLowerCase())
    .filter(Boolean);
  const dirty = parsed.join(',') !== st.allowedEmailDomains.join(',');

  return (
    <SettingsSection
      title="메일 주소 확인"
      lead={
        st.mailAvailable
          ? st.mailToLog
            ? '개발 모드라 확인 메일은 백엔드 로그에 찍혀요.'
            : '확인 메일은 SMTP_URL로 보내요.'
          : 'SMTP_URL이 설정되지 않아 메일을 보낼 수 없어서 켤 수 없어요.'
      }
    >
      <SettingsRow
        label="새 계정은 메일 확인 필수"
        description="켜면 새로 가입한 계정은 메일로 받은 링크를 열어야 쓸 수 있어요. 지금 있는 계정은 그대로 쓰고, 설정에서 언제든 확인할 수 있어요."
      >
        <Switch
          checked={st.requireEmailVerification}
          onChange={(v) => {
            if (!st.mailAvailable && v) return toast.error('메일을 보낼 수 없는 서버예요. SMTP_URL을 먼저 설정하세요.');
            void save({ requireEmailVerification: v }, 'verify', v ? '새 계정은 메일을 확인해야 써요' : '메일 확인을 껐어요');
          }}
          label="새 계정은 메일 확인 필수"
        />
      </SettingsRow>
      <SettingsRow
        label="가입할 수 있는 도메인"
        htmlFor="domains"
        stack
        description="적으면 초대 링크 없이 가입하는 사람은 이 도메인 주소만 쓸 수 있고, 주소 확인도 함께 해요. 비우면 제한하지 않아요."
      >
        <div className={s.domainRow}>
          <input
            id="domains"
            className={ui.input}
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
            placeholder="company.com, example.org"
            disabled={!st.mailAvailable && !st.allowedEmailDomains.length}
            spellCheck={false}
            autoCapitalize="off"
          />
          <button
            className={cx(ui.btn, ui.primary)}
            disabled={!dirty || saving === 'domains'}
            onClick={() =>
              void save({ allowedEmailDomains: parsed }, 'domains', parsed.length ? `${parsed.map((d) => `@${d}`).join(', ')}만 가입할 수 있어요` : '도메인 제한을 없앴어요')
            }
          >
            저장
          </button>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

const USES = [
  { label: '1번', value: 1 },
  { label: '5번', value: 5 },
  { label: '25번', value: 25 },
  { label: '제한 없음', value: null },
] as const;

const EXPIRES = [
  { label: '1일', value: 1 },
  { label: '7일', value: 7 },
  { label: '30일', value: 30 },
  { label: '없음', value: null },
] as const;

function Invites({ mode }: { mode: SignupMode }) {
  const list = useAdmin<{ invites: ServerInvite[] }>('/api/admin/invites');
  const [creating, setCreating] = useState(false);
  const [revoke, setRevoke] = useState<ServerInvite | null>(null);
  const live = list.data?.invites.filter((i) => i.valid) ?? [];
  const done = list.data?.invites.filter((i) => !i.valid).slice(0, 10) ?? [];

  return (
    <SettingsSection
      title="서버 초대 링크"
      lead={
        mode === 'closed'
          ? '가입 방식이 ‘닫힘’이라 지금은 초대 링크로도 가입할 수 없어요.'
          : '조직에 넣지 않고 이 서버에 가입만 하게 하는 링크예요. 링크로 가입하면 승인과 도메인 제한을 건너뛰어요.'
      }
      action={
        <button className={cx(ui.btn, ui.primary, ui.sm)} onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} /> 초대 링크 만들기
        </button>
      }
    >
      {!list.data ? (
        <Skeleton height={60} />
      ) : live.length + done.length === 0 ? (
        <p className={s.empty}>아직 만든 링크가 없어요</p>
      ) : (
        <ul className={s.people}>
          {[...live, ...done].map((i) => (
            <li key={i.id} className={s.person}>
              <div className={s.personText}>
                <span className={s.personName}>
                  <span>
                    <code className={s.mono}>…{i.hint}</code>
                    {i.note && ` · ${i.note}`}
                  </span>
                  {!i.valid && <Badge tone="secondary">{i.revokedAt ? '취소됨' : i.maxUses !== null && i.uses >= i.maxUses ? '다 씀' : '만료됨'}</Badge>}
                </span>
                <span className={cx(s.personMeta, s.inviteMeta)}>
                  {i.uses}명 가입{i.maxUses !== null ? ` / ${i.maxUses}번` : ''} · {i.expiresAt ? `${dateOnly(i.expiresAt)} 만료` : '만료 없음'} ·{' '}
                  {i.createdBy ?? '알 수 없음'} · {relativeTime(i.createdAt)}
                </span>
              </div>
              {i.valid && (
                <div className={s.personActions}>
                  <button className={cx(ui.btn, ui.outline, ui.sm)} onClick={() => setRevoke(i)}>
                    취소
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <CreateInvite open={creating} onClose={() => setCreating(false)} onCreated={() => void list.reload()} />
      <ConfirmModal
        open={!!revoke}
        onClose={() => setRevoke(null)}
        title="이 초대 링크를 취소할까요?"
        confirmLabel="링크 취소"
        body="이 링크로는 더 이상 가입할 수 없어요. 이미 가입한 계정은 그대로예요."
        onConfirm={async () => {
          try {
            await api('DELETE', `/api/admin/invites/${revoke!.id}`);
            toast.success('초대 링크를 취소했어요');
            void list.reload();
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
      />
    </SettingsSection>
  );
}

function CreateInvite({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [note, setNote] = useState('');
  const [maxUses, setMaxUses] = useState<number | null>(1);
  const [days, setDays] = useState<number | null>(7);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setNote('');
      setMaxUses(1);
      setDays(7);
      setUrl(null);
    }
  }, [open]);

  const create = async () => {
    setBusy(true);
    try {
      const r = await api<{ url: string }>('POST', '/api/admin/invites', { note: note.trim() || undefined, maxUses, expiresInDays: days });
      setUrl(r.url);
      onCreated();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="서버 초대 링크"
      description={url ? '링크는 지금 한 번만 보여요. 복사해서 전해 주세요.' : '링크를 가진 사람은 정한 횟수만큼 이 서버에 가입할 수 있어요.'}
      width={480}
      footer={
        url ? (
          <button className={cx(ui.btn, ui.primary)} onClick={onClose}>
            완료
          </button>
        ) : (
          <>
            <button className={cx(ui.btn, ui.outline)} onClick={onClose}>
              취소
            </button>
            <button className={cx(ui.btn, ui.primary)} onClick={() => void create()} disabled={busy}>
              {busy ? '만드는 중…' : '링크 만들기'}
            </button>
          </>
        )
      }
    >
      {url ? (
        <CopyField value={url} label="초대 링크" done="초대 링크를 복사했어요" />
      ) : (
        <div className={s.dialogStack}>
          <div className={ui.field}>
            <label className={ui.label} htmlFor="invite-note">
              메모 <span className={s.muted}>(누구에게 줬는지, 목록에만 보여요)</span>
            </label>
            <input id="invite-note" className={ui.input} value={note} onChange={(e) => setNote(e.target.value)} maxLength={80} placeholder="예: 디자인팀 김민지" />
          </div>
          <div className={s.options}>
            <div className={ui.field}>
              <span className={ui.label} id="invite-uses">
                쓸 수 있는 횟수
              </span>
              <div className={ui.segmented} data-size="sm" data-full="true" role="group" aria-labelledby="invite-uses">
                {USES.map((o) => (
                  <button key={o.label} type="button" className={ui.segment} aria-pressed={maxUses === o.value} onClick={() => setMaxUses(o.value)}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <div className={ui.field}>
              <span className={ui.label} id="invite-expiry">
                만료
              </span>
              <div className={ui.segmented} data-size="sm" data-full="true" role="group" aria-labelledby="invite-expiry">
                {EXPIRES.map((o) => (
                  <button key={o.label} type="button" className={ui.segment} aria-pressed={days === o.value} onClick={() => setDays(o.value)}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

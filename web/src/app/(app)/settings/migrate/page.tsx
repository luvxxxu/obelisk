'use client';

import {
  MIGRATION_MAX_BYTES,
  MIGRATION_UPLOAD_TYPE,
  parseMigrationLink,
  ROLE_LABEL_KO,
  type MigrationCode,
  type MigrationCounts,
  type MigrationImportInput,
  type MigrationKind,
  type MigrationPerson,
  type MigrationPreview,
  type MigrationResult,
  type MigrationStageStatus,
  type User,
  type Workspace,
} from '@obelisk/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { CopyField } from '@/components/Copy';
import { Icon, type IconName } from '@/components/Icon';
import { Avatar, isEnter, Modal, Spinner, ui } from '@/components/primitives';
import { Page, ViewHeader } from '@/components/View';
import { workspaceLabel, WorkspaceMark } from '@/components/WorkspaceSwitcher';
import { api, ApiError, download, upload } from '@/lib/api';
import { cx } from '@/lib/format';
import { load, refresh, setUser, switchWorkspace, useApp } from '@/lib/store';
import { toast } from '@/lib/toast';
import { SettingsNav, SettingsRow, SettingsSection } from '../SettingsNav';
import base from '../settings.module.css';
import s from './migrate.module.css';

const MAX_MB = Math.round(MIGRATION_MAX_BYTES / 1024 / 1024);
const PASSPHRASE_MIN = 8;
/** How long the page keeps asking what became of an import whose answer got lost. */
const SETTLE_MS = 10 * 60_000;
const SETTLE_EVERY_MS = 2_000;

/**
 * The file as it goes up: gzipped in the browser when it can be (JSON shrinks a lot, the server
 * recognises gzip by its first bytes). A file that is already gzip, or a browser without
 * CompressionStream, sends the bytes as they are.
 */
async function uploadBody(file: File): Promise<Blob> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const gz = head[0] === 0x1f && head[1] === 0x8b;
  if (!gz && typeof CompressionStream !== 'undefined') {
    try {
      const packed = await new Response(file.stream().pipeThrough(new CompressionStream('gzip'))).blob();
      return new Blob([packed], { type: MIGRATION_UPLOAD_TYPE });
    } catch {
      // fall through to the plain file
    }
  }
  return new Blob([file], { type: MIGRATION_UPLOAD_TYPE });
}

const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/**
 * The import's answer can get lost on the way (a proxy giving up, a dropped connection) while the
 * server finishes. Ask the server what became of the staged file until it is clear: the result once
 * it is done, null when it isn't (nothing was imported, or the file is gone).
 */
async function settle(stagingId: string): Promise<MigrationResult | null> {
  const until = Date.now() + SETTLE_MS;
  while (Date.now() < until) {
    try {
      const st = await api<MigrationStageStatus>('GET', `/api/migration/stage/${stagingId}`);
      if (st.status === 'done' && st.result) return st.result;
      if (st.status !== 'importing') return null;
    } catch {
      // still unreachable: keep asking
    }
    await wait(SETTLE_EVERY_MS);
  }
  return null;
}

const COUNT_LABEL: { key: keyof MigrationCounts; label: string; unit: string }[] = [
  { key: 'projects', label: '프로젝트', unit: '개' },
  { key: 'tasks', label: '작업', unit: '개' },
  { key: 'dependencies', label: '의존 관계', unit: '개' },
  { key: 'activity', label: '활동 기록', unit: '개' },
  { key: 'teams', label: '팀', unit: '개' },
  { key: 'members', label: '멤버', unit: '명' },
  { key: 'webhooks', label: '보내는 웹훅', unit: '개' },
  { key: 'incomingWebhooks', label: '받는 웹훅', unit: '개' },
  { key: 'photos', label: '사진', unit: '장' },
];

function countList(c: MigrationCounts, kind: MigrationKind): { key: string; label: string; value: string }[] {
  // A personal space has one member, you; counting it only adds noise.
  return COUNT_LABEL.filter((x) => (c[x.key] ?? 0) > 0 && !(kind === 'personal' && x.key === 'members')).map((x) => ({
    key: x.key,
    label: x.label,
    value: `${c[x.key].toLocaleString('ko-KR')}${x.unit}`,
  }));
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
}

export default function MigrateSettingsPage() {
  const app = useApp();
  const ws = app.workspace;
  // One status line for screen readers: uploading, importing, done, failed.
  const [live, setLive] = useState('');

  return (
    <Page>
      <ViewHeader title="설정">
        <SettingsNav />
      </ViewHeader>

      <div className={base.stack}>
        <div className={base.intro}>
          <p>다른 Obelisk 서버로 공간을 옮기거나, 다른 서버에서 옮겨 온 공간을 이 서버로 가져와요.</p>
        </div>

        {ws && <ExportSection key={ws.id} ws={ws} otherSpaces={app.workspaces.length > 1} />}
        <ImportSection onStatus={setLive} />
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {live}
      </p>
    </Page>
  );
}

/* ───────────────────────────── export */

function ExportSection({ ws, otherSpaces }: { ws: Workspace; otherSpaces: boolean }) {
  const canExport = ws.kind === 'personal' || ws.role === 'owner';
  const [fileOpen, setFileOpen] = useState(false);
  const [code, setCode] = useState<MigrationCode | null>(null);
  const [expired, setExpired] = useState(false);
  const [making, setMaking] = useState(false);

  // The link stops working after 30 minutes; stop offering it then.
  useEffect(() => {
    if (!code) return;
    const left = new Date(code.expiresAt).getTime() - Date.now();
    if (!(left > 0)) {
      setExpired(true);
      return;
    }
    const t = window.setTimeout(() => setExpired(true), Math.min(left, 2 ** 31 - 1));
    return () => window.clearTimeout(t);
  }, [code]);

  const makeLink = async () => {
    setMaking(true);
    try {
      const c = await api<MigrationCode>('POST', '/api/migration/codes', { workspaceId: ws.id });
      setExpired(false);
      setCode(c);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setMaking(false);
    }
  };

  const label = workspaceLabel(ws);

  return (
    <SettingsSection title="내보내기" lead="지금 열려 있는 공간을 통째로 옮겨요. 이 서버의 데이터는 그대로 남아요.">
      <p className={s.scope}>
        <WorkspaceMark ws={ws} size="sm" />
        <span>
          <b>{label}</b> 전체를 내보내요.{otherSpaces ? ' 다른 공간은 맨 위의 공간 이름을 눌러 바꾼 뒤 내보내세요.' : ''}
        </span>
      </p>

      {!canExport ? (
        <div className={cx(ui.alert, s.lock)} role="note">
          <Icon name="lock" size={16} />
          <p className={ui.alertTitle}>조직 소유자만 내보낼 수 있어요</p>
          <p className={ui.alertDescription}>
            내보낸 데이터에는 모든 멤버의 작업과 웹훅 서명 키가 들어 있어서 소유자만 만들 수 있어요. 필요하면 소유자에게 요청하세요.
          </p>
        </div>
      ) : (
        <>
          <SettingsRow label="파일로 내려받기" description="공간 전체를 JSON 파일 하나로 받아요. 새 서버의 이 화면에서 올리면 돼요.">
            <button type="button" className={cx(ui.btn, ui.outline, ui.sm)} onClick={() => setFileOpen(true)}>
              <Icon name="download" size={14} /> 내려받기
            </button>
          </SettingsRow>

          <SettingsRow
            label="다른 서버로 바로 보내기"
            description="파일 없이 새 서버가 이 서버에서 직접 가져가요. 링크를 만들어 새 서버의 데이터 이전 화면에 붙여 넣으세요."
          >
            <button type="button" className={cx(ui.btn, ui.outline, ui.sm)} disabled={making} onClick={() => void makeLink()}>
              {making ? <Spinner label="링크 만드는 중" /> : <Icon name="link" size={14} />}
              {code && !expired ? '새 링크 만들기' : '이전 링크 만들기'}
            </button>
          </SettingsRow>

          {code && (
            <div className={cx(base.row, s.linkBlock)} data-stack="true">
              {expired ? (
                <p className={base.rowDesc}>이전 링크가 만료됐어요. 필요하면 새 링크를 만드세요.</p>
              ) : (
                <>
                  <CopyField value={code.link} label="이전 링크" done="이전 링크를 복사했어요" />
                  <p className={s.linkMeta}>
                    30분 동안 한 번만 쓸 수 있어요 · {clock(code.expiresAt)}까지. 이 링크를 아는 사람은 {label}의 모든 데이터를 가져갈 수 있으니 옮길
                    서버에만 붙여 넣으세요. 새 링크를 만들면 전에 만든 링크는 바로 막혀요.
                  </p>
                </>
              )}
            </div>
          )}
        </>
      )}

      <WhatMoves personal={ws.kind === 'personal'} />

      <ExportFileModal open={fileOpen} ws={ws} onClose={() => setFileOpen(false)} />
    </SettingsSection>
  );
}

function WhatMoves({ personal }: { personal: boolean }) {
  return (
    <ul className={s.facts}>
      <li className={s.fact}>
        <Icon name="check" size={15} className={s.factIcon} />
        <span className={s.factText}>
          <strong>함께 옮겨져요</strong>
          <span>
            프로젝트, 작업(번호·순서·미룬 횟수·완료 시각 포함), 의존 관계, 활동 기록, 보내는 웹훅(꺼진 채로)
            {personal ? ', 시간대·홈 구성·프로필 사진·Jev 설정' : ', 팀과 프로젝트 권한, 멤버 자리, 조직 사진'}
          </span>
        </span>
      </li>
      <li className={s.fact}>
        <Icon name="key" size={15} className={s.factIcon} />
        <span className={s.factText}>
          <strong>새로 만들어져요</strong>
          <span>받는 웹훅 주소. 가져온 직후 한 번 보여 드리니 요청을 보내는 곳의 주소를 바꿔 주세요.</span>
        </span>
      </li>
      <li className={s.fact}>
        <Icon name="x" size={15} className={s.factIcon} />
        <span className={s.factText}>
          <strong>옮겨지지 않아요</strong>
          <span>
            로그인 세션, API 토큰과 AI 앱 연결(새 서버에서 새로 만들기), 웹훅 전송 기록{personal ? '' : ', 초대 링크'}
          </span>
        </span>
      </li>
      {!personal && (
        <li className={s.fact}>
          <Icon name="users" size={15} className={s.factIcon} />
          <span className={s.factText}>
            <strong>멤버</strong>
            <span>
              가져오는 나를 빼고 모두 새 서버에서 가입 대기로 자리를 남겨요. 관리자가 보낸 합류 링크로 들어오면 맡던 작업과 권한을 그대로 이어받아요. 같은
              이메일의 계정이 있어도 링크 없이는 들어오지 않아요.
            </span>
          </span>
        </li>
      )}
    </ul>
  );
}

function ExportFileModal({ open, ws, onClose }: { open: boolean; ws: Workspace; onClose: () => void }) {
  const id = useId();
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPass('');
    setConfirm('');
    setTouched(false);
    setBusy(false);
    setError(null);
  }, [open]);

  const personal = ws.kind === 'personal';
  const secretsWhat = personal ? 'Jev 키와 웹훅 서명 키' : '웹훅 서명 키';
  const tooShort = pass.length > 0 && pass.length < PASSPHRASE_MIN;
  const mismatch = pass.length > 0 && confirm !== pass;
  const invalid = tooShort || mismatch;

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setTouched(true);
    if (busy || invalid) return;
    setBusy(true);
    setError(null);
    try {
      await download('POST', '/api/migration/export', { workspaceId: ws.id, passphrase: pass || null }, 'obelisk-export.json');
      toast.success(pass ? '비밀값을 잠가 파일로 내려받았어요' : '파일로 내려받았어요');
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      width={480}
      title="파일로 내려받기"
      description={`${workspaceLabel(ws)}의 모든 데이터를 JSON 파일 하나로 받아요. 작업 내용은 그대로 들어 있으니 안전한 곳에 보관하세요.`}
      footer={
        <>
          <button type="button" className={cx(ui.btn, ui.outline)} onClick={onClose} disabled={busy}>
            취소
          </button>
          <button type="submit" form={`${id}-form`} className={cx(ui.btn, ui.primary)} disabled={busy || (touched && invalid)}>
            {busy ? (
              <>
                <span className={ui.spinner} aria-hidden="true" />
                만드는 중…
              </>
            ) : (
              <>
                <Icon name="download" size={14} /> 내려받기
              </>
            )}
          </button>
        </>
      }
    >
      <form id={`${id}-form`} className={s.form} onSubmit={submit} aria-busy={busy}>
        <div>
          <p className={s.groupLabel}>비밀값도 담기</p>
          <p className={s.lead}>
            암호를 정하면 {secretsWhat}를 이 암호로 잠가 함께 담아요. 비워 두면 새 서버에서{' '}
            {personal ? 'Jev 키는 다시 입력하고 웹훅 서명 키는 새로 발급돼요.' : '웹훅 서명 키가 새로 발급돼요.'}
          </p>
        </div>
        <div className={ui.field}>
          <label className={ui.label} htmlFor={`${id}-pass`}>
            암호 (선택)
          </label>
          <input
            id={`${id}-pass`}
            type="password"
            className={ui.input}
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            onBlur={() => pass && setTouched(true)}
            autoComplete="new-password"
            maxLength={200}
            aria-invalid={(touched && tooShort) || undefined}
            aria-describedby={`${id}-pass-help`}
            autoFocus
          />
          <span id={`${id}-pass-help`} className={ui.help}>
            {touched && tooShort ? `암호는 ${PASSPHRASE_MIN}자 이상이어야 해요.` : `${PASSPHRASE_MIN}자 이상. 잊으면 비밀값은 꺼낼 수 없어요.`}
          </span>
        </div>
        {pass.length > 0 && (
          <div className={ui.field}>
            <label className={ui.label} htmlFor={`${id}-confirm`}>
              암호 확인
            </label>
            <input
              id={`${id}-confirm`}
              type="password"
              className={ui.input}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              maxLength={200}
              aria-invalid={(touched && mismatch) || undefined}
              aria-describedby={touched && mismatch ? `${id}-confirm-help` : undefined}
            />
            {touched && mismatch && (
              <span id={`${id}-confirm-help`} className={ui.help}>
                암호가 서로 달라요.
              </span>
            )}
          </div>
        )}
        {error && (
          <div className={ui.alert} data-tone="danger" role="alert">
            <Icon name="alertCircle" size={16} />
            <div className={ui.alertTitle}>내려받지 못했어요</div>
            <div className={ui.alertDescription}>{error}</div>
          </div>
        )}
      </form>
    </Modal>
  );
}

/* ───────────────────────────── import */

function ImportSection({ onStatus }: { onStatus: (msg: string) => void }) {
  const router = useRouter();
  const app = useApp();
  const input = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLButtonElement>(null);
  const [over, setOver] = useState(false);
  const [staging, setStaging] = useState<'file' | 'link' | null>(null);
  const [link, setLink] = useState('');
  const [linkHere, setLinkHere] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [result, setResult] = useState<MigrationResult | null>(null);
  const [opening, setOpening] = useState(false);

  // Opened with "#omg_…" (an 이전 링크 pasted into this address bar, or opened on the server that made it):
  // put the link in the field and take the code out of the address bar and history entry.
  // Also when the link is pasted into this tab's address bar while the page is open (a same-page jump).
  useEffect(() => {
    const check = () => {
      if (!window.location.hash.startsWith('#omg_')) return;
      const full = window.location.href;
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
      setLink(full);
      setLinkHere(parseMigrationLink(full)?.origin === window.location.origin);
    };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, []);

  // A file dropped next to the zone would make the browser open it and leave the page.
  useEffect(() => {
    const block = (e: DragEvent) => {
      if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);

  const staged = (p: MigrationPreview) => {
    setPreview(p);
    setResult(null);
    onStatus('내용을 확인했어요. 가져올 내용을 살펴보세요.');
  };

  const fail = (msg: string) => {
    setError(msg);
    onStatus(`가져오지 못했어요. ${msg}`);
  };

  const stageFile = async (file: File) => {
    if (staging) return;
    setError(null);
    if (file.size > MIGRATION_MAX_BYTES) return fail(`파일이 너무 커요. ${MAX_MB}MB까지 올릴 수 있어요.`);
    if (file.size === 0) return fail('빈 파일이에요.');
    setStaging('file');
    onStatus('파일을 확인하는 중이에요.');
    try {
      staged(await upload<MigrationPreview>('POST', '/api/migration/stage', await uploadBody(file)));
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setStaging(null);
    }
  };

  const stageLink = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (staging) return;
    const value = link.trim();
    setError(null);
    if (!value) return;
    if (!parseMigrationLink(value)) {
      return fail('이전 링크가 올바르지 않아요. 원래 서버의 데이터 이전 화면에서 만든 링크 전체를 붙여 넣으세요.');
    }
    setStaging('link');
    onStatus('원래 서버에서 불러오는 중이에요.');
    try {
      staged(await api<MigrationPreview>('POST', '/api/migration/stage-remote', { link: value }));
      setLink('');
      setLinkHere(false);
    } catch (err) {
      fail((err as Error).message);
    } finally {
      setStaging(null);
    }
  };

  const cancel = () => {
    if (preview) void api('DELETE', `/api/migration/stage/${preview.stagingId}`).catch(() => {});
    setPreview(null);
    onStatus('가져오기를 취소했어요.');
    dropRef.current?.focus();
  };

  const done = async (r: MigrationResult, applied: boolean) => {
    setPreview(null);
    setResult(r);
    const what = r.kind === 'org' ? `‘${r.workspaceName}’ 조직을 만들었어요` : '개인 공간으로 가져왔어요';
    toast.success(what);
    onStatus(`가져왔어요. ${what}.`);
    try {
      if (r.kind === 'org') await refresh();
      else {
        await load(true);
        if (applied) {
          const { user } = await api<{ user: User }>('GET', '/api/auth/me');
          setUser(user);
        }
      }
    } catch {
      // The next background sync catches up.
    }
  };

  const openResult = async (r: MigrationResult, to: string) => {
    setOpening(true);
    try {
      await switchWorkspace(r.workspaceId);
      router.push(to);
    } finally {
      setOpening(false);
    }
  };

  const busy = staging !== null;
  const r = result;
  const resultHere = r && app.workspace?.id === r.workspaceId;

  return (
    <SettingsSection
      title="가져오기"
      lead="다른 Obelisk 서버에서 내보낸 파일이나 이전 링크로 가져와요. 개인 공간은 내 개인 공간에 합쳐지고, 조직은 새 조직으로 만들어져요."
    >
      <SettingsRow label="파일로 가져오기" description="내보낸 JSON 파일을 올려요. 가져오기 전에 무엇이 들어오는지 먼저 보여 드려요." stack>
        <button
          ref={dropRef}
          type="button"
          className={s.drop}
          data-over={over || undefined}
          aria-disabled={busy || undefined}
          aria-busy={staging === 'file' || undefined}
          onClick={() => !busy && input.current?.click()}
          onDragOver={(e) => {
            if (![...e.dataTransfer.types].includes('Files')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = busy ? 'none' : 'copy';
            if (!busy) setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f && !busy) void stageFile(f);
          }}
        >
          {staging === 'file' ? (
            <>
              <span className={ui.spinner} aria-hidden="true" />
              <span className={s.dropTitle}>파일을 확인하는 중…</span>
              <span className={s.dropHint}>큰 파일은 잠시 걸려요</span>
            </>
          ) : (
            <>
              <Icon name="upload" size={20} className={s.dropIcon} />
              <span className={s.dropTitle}>{over ? '여기에 놓으세요' : '파일을 끌어다 놓거나 눌러서 고르세요'}</span>
              <span className={s.dropHint}>.json · .gz · 최대 {MAX_MB}MB</span>
            </>
          )}
        </button>
        <input
          ref={input}
          type="file"
          accept=".json,.gz,application/json,application/gzip"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = ''; // the same file can be picked again after cancelling
            if (f) void stageFile(f);
          }}
        />
      </SettingsRow>

      <SettingsRow
        label="이전 링크로 가져오기"
        htmlFor="migrate-link"
        description="원래 서버의 데이터 이전 → 다른 서버로 바로 보내기에서 만든 링크를 붙여 넣어요. 이 서버가 원래 서버에서 직접 받아 와요."
        stack
      >
        <form className={s.linkForm} onSubmit={stageLink} aria-busy={staging === 'link'}>
          <input
            id="migrate-link"
            className={ui.input}
            value={link}
            onChange={(e) => {
              setLink(e.target.value);
              setLinkHere(false);
            }}
            onKeyDown={(e) => {
              // Hangul IME: Enter that confirms a composition is not a submit.
              if (e.key === 'Enter' && !isEnter(e)) e.preventDefault();
            }}
            placeholder="https://…/settings/migrate#omg_…"
            spellCheck={false}
            autoComplete="off"
            inputMode="url"
            aria-describedby={linkHere ? 'migrate-link-here' : undefined}
          />
          <button type="submit" className={cx(ui.btn, ui.outline)} disabled={busy || !link.trim()}>
            {staging === 'link' ? (
              <>
                <span className={ui.spinner} aria-hidden="true" />
                불러오는 중…
              </>
            ) : (
              '불러오기'
            )}
          </button>
        </form>
        {linkHere && (
          <p id="migrate-link-here" className={base.rowDesc}>
            이 서버에서 만든 링크예요. 옮겨 갈 새 서버에 로그인해 설정 → 데이터 이전에 붙여 넣으세요.
          </p>
        )}
      </SettingsRow>

      {error && (
        <div className={cx(ui.alert, s.importError)} data-tone="danger" role="alert">
          <Icon name="alertCircle" size={16} />
          <div className={ui.alertTitle}>가져오지 못했어요</div>
          <div className={ui.alertDescription}>{error}</div>
        </div>
      )}

      {r && (
        <div className={s.result}>
          <div className={s.resultHead}>
            <Icon name="checkCircle" size={18} className={s.resultIcon} />
            <div className={s.resultText}>
              <p className={s.resultTitle}>
                {r.kind === 'org' ? `‘${r.workspaceName}’ 조직을 만들었어요` : '내 개인 공간으로 가져왔어요'}
              </p>
              <p className={s.resultDesc}>
                {countList(r.counts, r.kind)
                  .map((c) => `${c.label} ${c.value}`)
                  .join(' · ') || '옮길 내용이 없었어요'}
              </p>
              {r.renumbered && <p className={s.resultDesc}>이미 있던 작업과 겹치지 않게 작업 번호를 뒤에 이어 매겼어요.</p>}
              {r.tokensNotMoved.length > 0 && (
                <p className={s.resultDesc}>
                  API 토큰 {r.tokensNotMoved.length}개({r.tokensNotMoved.join(', ')})는 옮기지 않았어요. 필요하면{' '}
                  <Link href="/settings/ai" className={s.inlineLink}>
                    설정 → AI 연결
                  </Link>
                  에서 새로 만드세요.
                </p>
              )}
            </div>
          </div>
          {r.kind === 'org' && r.reserved > 0 && <ReservedNext result={r} onOpen={() => void openResult(r, '/settings/org')} opening={opening} />}
          {r.incoming.length > 0 && (
            <div className={s.secrets}>
              <p className={s.secretsLead}>
                받는 웹훅 {r.incoming.length}개의 주소가 새로 만들어졌어요. 요청을 보내는 곳에서 새 주소로 바꿔 주세요. 이 화면을 닫으면 다시 볼 수 없어요.
              </p>
              {r.incoming.map((h, i) => (
                <div key={`${i}-${h.name}`} className={s.secretItem}>
                  <span className={s.secretName}>{h.name}</span>
                  <CopyField value={h.url} label={`${h.name} 주소`} done="새 주소를 복사했어요" />
                </div>
              ))}
            </div>
          )}
          {r.warnings.length > 0 && <Notes items={r.warnings.map((w) => ({ text: w, warn: true }))} />}
          {!resultHere && (
            <div className={s.resultActions}>
              <button type="button" className={cx(ui.btn, ui.primary, ui.sm)} disabled={opening} onClick={() => void openResult(r, '/')}>
                {r.kind === 'org' ? '조직 열기' : '개인 공간 열기'}
              </button>
            </div>
          )}
        </div>
      )}

      <PreviewModal preview={preview} me={app.user} onCancel={cancel} onDone={(res, applied) => void done(res, applied)} onStatus={onStatus} />
    </SettingsSection>
  );
}

/**
 * After an organization import: everyone but the importer waits in 가입 대기 until they open their
 * claim link. Mail them all at once when this server can send mail; otherwise the links are copied
 * one by one in 조직 설정.
 */
function ReservedNext({ result: r, onOpen, opening }: { result: MigrationResult; onOpen: () => void; opening: boolean }) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<number | null>(null);

  const mailAll = async () => {
    setSending(true);
    try {
      const res = await api<{ sent: number }>('POST', `/api/workspaces/${r.workspaceId}/reservations/mail-all`);
      setSent(res.sent);
      toast.success(res.sent > 0 ? `${res.sent}명에게 합류 링크를 보냈어요` : '보낼 사람이 없었어요');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={s.secrets}>
      <p className={s.secretsLead}>
        {r.reserved}명이 가입 대기에 있어요. 합류 링크를 받은 사람만 들어올 수 있고, 들어오면 맡던 작업과 권한을 그대로 이어받아요.
        {r.mailEnabled
          ? sent === null
            ? ' 링크를 각자의 이메일로 보낼 수 있어요.'
            : ` ${sent}명에게 보냈어요. 링크는 한 번만 쓸 수 있어요.`
          : ' 이 서버는 메일을 보낼 수 없어요. 조직 설정 → 멤버 → 가입 대기에서 한 사람씩 링크를 복사해 전달하세요.'}
      </p>
      <div className={s.inlineActions}>
        {r.mailEnabled && sent === null && (
          <button type="button" className={cx(ui.btn, ui.primary, ui.sm)} disabled={sending} onClick={() => void mailAll()}>
            {sending ? <Spinner label="보내는 중" /> : <Icon name="mail" size={14} />}
            가입 대기 모두에게 메일 보내기
          </button>
        )}
        <button type="button" className={cx(ui.btn, ui.outline, ui.sm)} disabled={opening} onClick={onOpen}>
          가입 대기 보기
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────────── preview */

function personStatus(p: MigrationPerson): string {
  if (p.match === 'you') return '내 계정';
  if (p.former) return '예전 멤버';
  return '가입 대기';
}

function personNote(p: MigrationPerson): string | null {
  if (p.match === 'you') return null;
  if (p.former) return '떠난 멤버예요. 남긴 기록만 자리에 맡겨 둬요.';
  if (p.match === 'existing') return '이 서버에 같은 이메일 계정이 있어요. 합류 링크를 받으면 들어와요.';
  return null;
}

const PEOPLE_SHOWN = 8;

function PreviewModal({
  preview: p,
  me,
  onCancel,
  onDone,
  onStatus,
}: {
  preview: MigrationPreview | null;
  me: User | null;
  onCancel: () => void;
  onDone: (r: MigrationResult, applied: boolean) => void;
  onStatus: (msg: string) => void;
}) {
  const id = useId();
  const passRef = useRef<HTMLInputElement>(null);
  const [applySettings, setApplySettings] = useState(true);
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allPeople, setAllPeople] = useState(false);

  const stagingId = p?.stagingId;
  useEffect(() => {
    if (!stagingId) return;
    setApplySettings(true);
    setAllowDuplicate(false);
    setDuplicate(false);
    setPass('');
    setBusy(false);
    setChecking(false);
    setError(null);
    setAllPeople(false);
  }, [stagingId]);

  const run = useCallback(async () => {
    if (!p || busy) return;
    setBusy(true);
    setError(null);
    onStatus('가져오는 중이에요. 창을 닫지 마세요.');
    const applied = p.kind === 'personal' && !!p.account && applySettings;
    const body: MigrationImportInput = {
      stagingId: p.stagingId,
      passphrase: p.secrets === 'locked' && pass ? pass : null,
      applySettings: applied,
      allowDuplicate,
    };
    try {
      const r = await api<MigrationResult>('POST', '/api/migration/import', body);
      setBusy(false);
      onDone(r, applied);
      return;
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      const msg = (e as Error).message;
      // The answer got lost (proxy, connection) or another tab is importing it: ask what happened.
      if (status === 0 || status >= 500 || (status === 409 && msg.includes('가져오는 중'))) {
        setChecking(true);
        onStatus('응답이 끊겼어요. 가져오기가 끝났는지 확인하는 중이에요.');
        const settled = await settle(p.stagingId);
        setChecking(false);
        if (settled) {
          setBusy(false);
          onDone(settled, applied);
          return;
        }
      }
      setError(msg);
      onStatus(`가져오지 못했어요. ${msg}`);
      if (status === 409 && !msg.includes('가져오는 중')) setDuplicate(true);
      if (status === 400 && p.secrets === 'locked') {
        // The field is disabled while busy: enable it first, or focus() does nothing.
        flushSync(() => setBusy(false));
        passRef.current?.focus();
      }
    }
    setBusy(false);
  }, [p, busy, pass, applySettings, allowDuplicate, onDone, onStatus]);

  if (!p) return null;

  const isDup = !!p.alreadyImported || duplicate;
  const blocked = isDup && !allowDuplicate;
  const active = p.people.filter((x) => !x.former);
  const formerCount = p.people.length - active.length;
  const reservedCount = active.filter((x) => x.match !== 'you').length;
  const counts = countList(p.counts, p.kind);
  const people = allPeople ? p.people : p.people.slice(0, PEOPLE_SHOWN);
  const acc = p.account;
  const jevBit = acc?.jev ? `${acc.jevKey ? 'Jev 설정과 키' : 'Jev 설정'}${acc.jevHost ? `(${acc.jevHost})` : ''}` : null;
  const accountBits = acc
    ? [`시간대(${acc.timezone})`, acc.homeLayout && '홈 구성', acc.photo && '프로필 사진', jevBit].filter((x): x is string => !!x)
    : [];

  // What the server warns about comes as it is; only what follows from the counts is added here.
  const notes: { text: ReactNode; warn?: boolean; icon?: IconName }[] = [];
  if (p.counts.incomingWebhooks > 0) {
    notes.push({ icon: 'link', text: '받는 웹훅은 새 주소로 만들어져요. 가져온 뒤 한 번만 보여 드리니, 요청을 보내는 곳의 주소를 바꿔 주세요.' });
  }
  if (acc && acc.tokensNotMoved.length > 0) {
    notes.push({
      icon: 'key',
      text: `API 토큰 ${acc.tokensNotMoved.length}개(${acc.tokensNotMoved.join(', ')})는 옮기지 않아요. 가져온 뒤 설정 → AI 연결에서 새로 만드세요.`,
    });
  }
  for (const w of p.warnings) notes.push({ text: w, warn: true });

  const targetLine =
    p.target.kind === 'new-org'
      ? `‘${p.target.name}’ 조직을 새로 만들고 내가 소유자가 돼요.`
      : p.target.renumber
        ? `내 개인 공간에 합쳐져요. 이미 작업이 ${p.target.existingTasks.toLocaleString('ko-KR')}개 있어서 가져오는 작업은 뒤 번호로 이어 매겨요.`
        : '내 개인 공간에 합쳐져요. 작업 번호는 원래 서버와 같아요.';

  return (
    <Modal
      open
      onClose={busy ? () => {} : onCancel}
      width={560}
      title={p.kind === 'org' ? `‘${p.workspaceName}’ 가져오기` : '개인 공간 가져오기'}
      description={`${host(p.source.url)}에서 ${when(p.source.exportedAt)}에 내보냈어요.`}
      footer={
        <>
          <button type="button" className={cx(ui.btn, ui.outline)} onClick={onCancel} disabled={busy}>
            취소
          </button>
          <button type="submit" form={`${id}-form`} className={cx(ui.btn, ui.primary)} disabled={busy || blocked}>
            {busy ? (
              <>
                <span className={ui.spinner} aria-hidden="true" />
                {checking ? '확인하는 중…' : '가져오는 중…'}
              </>
            ) : (
              '가져오기'
            )}
          </button>
        </>
      }
    >
      <form
        id={`${id}-form`}
        className={s.preview}
        aria-busy={busy}
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <p className={s.target}>{targetLine}</p>

        {isDup && (
          <div className={ui.alert} data-tone="warn" role="alert">
            <Icon name="alert" size={16} />
            <div className={ui.alertTitle}>이미 가져온 파일이에요</div>
            <div className={ui.alertDescription}>
              {p.alreadyImported
                ? `${when(p.alreadyImported.at)}에 ‘${p.alreadyImported.workspaceName}’(으)로 가져왔어요. `
                : ''}
              한 번 더 가져오면 같은 내용이 하나 더 생겨요.
            </div>
          </div>
        )}

        <div>
          <p className={s.groupLabel}>가져올 내용</p>
          {counts.length ? (
            <dl className={s.counts}>
              {counts.map((c) => (
                <div key={c.key} className={s.count}>
                  <dt>{c.label}</dt>
                  <dd>{c.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className={ui.help}>비어 있는 공간이에요.</p>
          )}
        </div>

        {p.kind === 'org' && p.people.length > 0 && (
          <div>
            <p className={s.groupLabel}>
              멤버 {active.length}명{reservedCount > 0 ? ` · 가입 대기 ${reservedCount}명` : ''}
              {formerCount > 0 ? ` · 예전 멤버 ${formerCount}명` : ''}
            </p>
            <ul className={s.people}>
              {people.map((x, i) => {
                const note = personNote(x);
                return (
                  <li key={`${i}-${x.email}`} className={s.person}>
                    <Avatar name={x.match === 'you' ? (me?.name ?? x.name) : x.name} src={x.match === 'you' ? me?.avatarUrl : null} size="sm" />
                    <span className={s.personText}>
                      <span className={s.personName}>
                        {x.name}
                        {x.match === 'you' && me && me.name !== x.name ? ` → ${me.name}` : ''}
                      </span>
                      <span className={s.personMeta}>
                        {x.email}
                        {x.former ? '' : ` · ${ROLE_LABEL_KO[x.match === 'you' ? 'owner' : x.role]}`}
                      </span>
                      {note && <span className={s.personMeta}>{note}</span>}
                    </span>
                    <span className={s.personStatus} data-match={x.match}>
                      {personStatus(x)}
                    </span>
                  </li>
                );
              })}
            </ul>
            {p.people.length > PEOPLE_SHOWN && !allPeople && (
              <button type="button" className={cx(ui.btn, ui.ghost, ui.sm, s.more)} onClick={() => setAllPeople(true)}>
                {p.people.length - PEOPLE_SHOWN}명 더 보기
              </button>
            )}
            {reservedCount + formerCount > 0 && (
              <p className={cx(ui.help, s.after)}>
                나를 빼고는 아무도 바로 들어오지 않아요. 가져온 뒤 조직 설정 → 멤버 → 가입 대기에서 합류 링크를 보내면, 링크로 들어온 사람이 맡던 작업과 권한을
                그대로 이어받아요.
              </p>
            )}
          </div>
        )}

        {((p.kind === 'personal' && acc) || isDup) && (
          <div className={s.options}>
            {p.kind === 'personal' && acc && (
              <Pick checked={applySettings} onChange={setApplySettings} disabled={busy}>
                <span className={s.pickLabel}>내 설정도 가져오기</span>
                <span className={s.pickHint}>{accountBits.join(', ')}. 지금 설정을 덮어써요.</span>
              </Pick>
            )}
            {isDup && (
              <Pick checked={allowDuplicate} onChange={setAllowDuplicate} disabled={busy}>
                <span className={s.pickLabel}>한 번 더 가져오기</span>
                <span className={s.pickHint}>같은 내용이 또 생기는 걸 알고 가져와요.</span>
              </Pick>
            )}
          </div>
        )}

        {p.secrets === 'locked' && (
          <div className={ui.field}>
            <label className={ui.label} htmlFor={`${id}-pass`}>
              파일 암호
            </label>
            <input
              ref={passRef}
              id={`${id}-pass`}
              type="password"
              className={ui.input}
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              autoComplete="off"
              maxLength={200}
              disabled={busy}
              aria-describedby={`${id}-pass-help`}
            />
            <span id={`${id}-pass-help`} className={ui.help}>
              내보낼 때 정한 암호를 넣으면 {p.kind === 'personal' ? 'Jev 키와 웹훅 서명 키' : '웹훅 서명 키'}도 가져와요. 비워 두면 비밀값 없이 가져와요.
            </span>
          </div>
        )}

        {notes.length > 0 && <Notes items={notes} />}

        {error && (
          <div className={ui.alert} data-tone="danger" role="alert">
            <Icon name="alertCircle" size={16} />
            <div className={ui.alertTitle}>가져오지 못했어요</div>
            <div className={ui.alertDescription}>{error}</div>
          </div>
        )}
      </form>
    </Modal>
  );
}

function Notes({ items }: { items: { text: ReactNode; warn?: boolean; icon?: IconName }[] }) {
  return (
    <ul className={s.notes}>
      {items.map((n, i) => (
        <li key={i} data-tone={n.warn ? 'warn' : undefined}>
          <Icon name={n.icon ?? (n.warn ? 'alert' : 'info')} size={14} />
          <span>{n.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** Checkbox row: custom box, native input for keyboard and screen readers. */
function Pick({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={s.pick} data-on={checked}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className={s.pickBox} aria-hidden="true">
        <Icon name="check" size={12} strokeWidth={3} />
      </span>
      <span className={s.pickText}>{children}</span>
    </label>
  );
}

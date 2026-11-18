'use client';

import {
  addDays,
  isScheduleEvent,
  maskWebhookUrl,
  WEBHOOK_EVENT_LABEL,
  WEBHOOK_FORMAT_LABEL,
  type IncomingWebhook,
  type Webhook,
  type WebhookDelivery,
  type WebhooksOverview,
} from '@obelisk/core';
import { useCallback, useEffect, useState } from 'react';
import { Code, CopyField } from '@/components/Copy';
import { Icon } from '@/components/Icon';
import { ConfirmModal, Modal, Skeleton, Spinner, Switch, ui } from '@/components/primitives';
import { Page, ViewHeader } from '@/components/View';
import { workspaceLabel, WorkspaceMark } from '@/components/WorkspaceSwitcher';
import { api } from '@/lib/api';
import { cx, relativeTime } from '@/lib/format';
import { useApp } from '@/lib/store';
import { toast } from '@/lib/toast';
import { SettingsNav, SettingsRow, SettingsSection } from '../SettingsNav';
import base from '../settings.module.css';
import { Deliveries } from './Deliveries';
import { IncomingForm } from './IncomingForm';
import { hookStatus, hourLabel, RowMenu } from './shared';
import { WebhookForm } from './WebhookForm';
import s from './webhooks.module.css';

type Reveal =
  | { kind: 'secret'; hook: Webhook; secret: string; fresh: boolean }
  | { kind: 'url'; hook: IncomingWebhook; url: string; fresh: boolean };

type Confirm =
  | { kind: 'delete-out'; hook: Webhook }
  | { kind: 'delete-in'; hook: IncomingWebhook }
  | { kind: 'rotate-secret'; hook: Webhook }
  | { kind: 'rotate-url'; hook: IncomingWebhook };

const VERIFY_SNIPPET = `// Node.js: 요청이 Obelisk에서 왔는지 확인 (rawBody = 받은 본문 그대로)
import { createHmac, timingSafeEqual } from 'node:crypto';

function fromObelisk(rawBody, headers, secret) {
  const ts = headers['x-obelisk-timestamp'];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // 5분 지난 요청은 거절
  const expected = 'sha256=' + createHmac('sha256', secret).update(\`\${ts}.\${rawBody}\`).digest('hex');
  const got = String(headers['x-obelisk-signature'] ?? '');
  return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}`;

function incomingExamples(url: string, allowUpdates: boolean, due: string): { title: string; code: string }[] {
  const out = [
    {
      title: '한 줄로 만들기 (빠른 추가와 같은 문법)',
      code: `curl -X POST "${url}" \\\n  -H "content-type: text/plain" \\\n  --data "보고서 초안 내일 !높음"`,
    },
    {
      title: 'JSON으로 만들기',
      code: `curl -X POST "${url}" \\\n  -H "content-type: application/json" \\\n  -d '{"title":"배포 확인","dueDate":"${due}","priority":"high","assignee":"me"}'`,
    },
  ];
  if (allowUpdates) {
    out.push({
      title: '기존 작업 바꾸기',
      code: `curl -X POST "${url}" \\\n  -H "content-type: application/json" \\\n  -d '{"action":"complete","task":"#12"}'`,
    });
  }
  return out;
}

function eventSummary(h: Webhook): string[] {
  return h.events.map((e) => WEBHOOK_EVENT_LABEL[e] ?? e);
}

export default function WebhooksSettingsPage() {
  const app = useApp();
  const ws = app.workspace;
  const [data, setData] = useState<WebhooksOverview | null>(null);
  const [editOut, setEditOut] = useState<Webhook | 'new' | null>(null);
  const [editIn, setEditIn] = useState<IncomingWebhook | 'new' | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [log, setLog] = useState<Webhook | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<WebhookDelivery | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<WebhooksOverview>('GET', '/api/webhooks'));
    } catch (e) {
      toast.error((e as Error).message);
      setData({ canManage: false, webhooks: [], incoming: [] });
    }
  }, []);

  useEffect(() => {
    setData(null);
    if (ws?.id) void load();
  }, [ws?.id, load]);

  const putOut = (hook: Webhook) =>
    setData((d) => d && { ...d, webhooks: d.webhooks.some((h) => h.id === hook.id) ? d.webhooks.map((h) => (h.id === hook.id ? hook : h)) : [...d.webhooks, hook] });
  const putIn = (hook: IncomingWebhook) =>
    setData((d) => d && { ...d, incoming: d.incoming.some((h) => h.id === hook.id) ? d.incoming.map((h) => (h.id === hook.id ? hook : h)) : [...d.incoming, hook] });

  const test = async (hook: Webhook, inline = false) => {
    setTesting(hook.id);
    if (inline) setTestResult(null);
    try {
      const { delivery } = await api<{ delivery: WebhookDelivery }>('POST', `/api/webhooks/${hook.id}/test`);
      if (inline) setTestResult(delivery);
      else if (delivery.status === 'success') toast.success(`테스트를 보냈어요 · HTTP ${delivery.responseStatus}`);
      else toast.error(`테스트 실패 · ${delivery.error ?? '응답 없음'}`);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTesting(null);
    }
  };

  const setEnabled = async (hook: Webhook, enabled: boolean) => {
    putOut({ ...hook, enabled });
    try {
      const { webhook } = await api<{ webhook: Webhook }>('PATCH', `/api/webhooks/${hook.id}`, { enabled });
      putOut(webhook);
      toast.show(enabled ? `“${hook.name}”을(를) 켰어요` : `“${hook.name}”을(를) 껐어요`);
    } catch (e) {
      putOut(hook);
      toast.error((e as Error).message);
    }
  };

  const runConfirm = async (c: Confirm) => {
    try {
      if (c.kind === 'delete-out') {
        await api('DELETE', `/api/webhooks/${c.hook.id}`);
        setData((d) => d && { ...d, webhooks: d.webhooks.filter((h) => h.id !== c.hook.id) });
        toast.show(`“${c.hook.name}”을(를) 삭제했어요`);
      } else if (c.kind === 'delete-in') {
        await api('DELETE', `/api/incoming-webhooks/${c.hook.id}`);
        setData((d) => d && { ...d, incoming: d.incoming.filter((h) => h.id !== c.hook.id) });
        toast.show(`“${c.hook.name}”을(를) 삭제했어요`);
      } else if (c.kind === 'rotate-secret') {
        const { secret } = await api<{ secret: string }>('POST', `/api/webhooks/${c.hook.id}/secret`);
        setReveal({ kind: 'secret', hook: c.hook, secret, fresh: false });
      } else {
        const { url } = await api<{ url: string }>('POST', `/api/incoming-webhooks/${c.hook.id}/rotate`);
        setReveal({ kind: 'url', hook: c.hook, url, fresh: false });
        void load();
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const projectName = (id: string | null) => (id ? (app.projects.find((p) => p.id === id)?.name ?? '삭제된 프로젝트') : null);
  const loading = !data;
  const canManage = data?.canManage ?? true;
  const timezone = app.user?.timezone ?? 'Asia/Seoul';

  return (
    <Page>
      <ViewHeader title="설정">
        <SettingsNav />
      </ViewHeader>

      <div className={base.stack}>
        <div className={base.intro}>
          <p>작업이 바뀌거나 마감이 다가오면 Slack·Discord·내 서버로 알리고, 다른 서비스에서 Obelisk로 작업을 만들거나 바꿔요.</p>
          {ws && (
            <p className={s.scope}>
              <WorkspaceMark ws={ws} size="sm" />
              <span>
                <b>{workspaceLabel(ws)}</b>의 웹훅이에요.{' '}
                {app.workspaces.length > 1 ? '다른 공간은 맨 위의 공간 이름을 눌러 바꾼 뒤 설정하세요.' : ''}
              </span>
            </p>
          )}
        </div>

        {!canManage ? (
          <div className={ui.alert} role="note">
            <Icon name="lock" size={16} />
            <p className={ui.alertTitle}>웹훅은 조직 소유자와 관리자만 설정할 수 있어요</p>
            <p className={ui.alertDescription}>
              웹훅은 이 조직의 변경 내용을 외부로 보내거나 외부 요청으로 작업을 바꾸기 때문에 관리자만 다룰 수 있어요. 필요하면 관리자에게 요청하세요.
            </p>
          </div>
        ) : (
          <>
            {/* ───────── outgoing */}
            <SettingsSection
              title="보내는 웹훅"
              lead="작업 변경과 일정 알림을 Slack, Discord, 또는 JSON을 받는 서버로 보내요."
              action={
                !loading && !!data!.webhooks.length ? (
                  <button type="button" className={cx(ui.btn, ui.sm, ui.outline)} onClick={() => setEditOut('new')}>
                    <Icon name="plus" size={14} /> 추가
                  </button>
                ) : undefined
              }
            >
              {loading ? (
                <ListSkeleton />
              ) : !data!.webhooks.length ? (
                <SettingsRow label="아직 보내는 웹훅이 없어요" description="팀 채널에서 완료, 기한 지남, 고정 일정 충돌 알림을 받아 보세요.">
                  <button type="button" className={cx(ui.btn, ui.sm, ui.outline)} onClick={() => setEditOut('new')}>
                    <Icon name="plus" size={14} /> 보내는 웹훅 추가
                  </button>
                </SettingsRow>
              ) : (
                <ul className={s.list}>
                  {data!.webhooks.map((h) => {
                    const st = hookStatus(h);
                    const labels = eventSummary(h);
                    const schedule = h.events.some(isScheduleEvent);
                    return (
                      <li key={h.id} className={s.row} data-off={!h.enabled || undefined}>
                        <div className={s.main}>
                          <div className={s.titleLine}>
                            <span className={s.name}>{h.name}</span>
                            <span className={s.formatTag}>{WEBHOOK_FORMAT_LABEL[h.format]}</span>
                          </div>
                          <code className={s.url} title={maskWebhookUrl(h.url)}>
                            {maskWebhookUrl(h.url)}
                          </code>
                          <p className={s.meta}>
                            {labels.slice(0, 5).join(' · ')}
                            {labels.length > 5 && ` 외 ${labels.length - 5}개`}
                          </p>
                          {(h.projectIds || schedule) && (
                            <p className={s.meta}>
                              {h.projectIds && (
                                <span className={s.metaItem}>
                                  <Icon name="folder" size={12} /> 프로젝트 {h.projectIds.length}개
                                </span>
                              )}
                              {schedule && (
                                <span className={s.metaItem}>
                                  <Icon name="clock" size={12} /> 매일 {hourLabel(h.alertHour)}
                                </span>
                              )}
                            </p>
                          )}
                          {h.disabledReason && !h.enabled && (
                            <p className={s.warnLine}>
                              <Icon name="alert" size={13} /> {h.disabledReason}. 주소를 확인하고 다시 켜세요.
                            </p>
                          )}
                        </div>
                        <div className={s.side}>
                          <span className={s.status} data-tone={st.tone}>
                            <span>{st.label}</span>
                            {st.detail && <span className={s.statusDetail}>{st.detail}</span>}
                          </span>
                          <Switch checked={h.enabled} onChange={(v) => void setEnabled(h, v)} label={`${h.name} 켜기`} />
                          {testing === h.id ? (
                            <span className={s.menuSpin}>
                              <Spinner label="테스트 보내는 중" />
                            </span>
                          ) : (
                            <RowMenu
                              label={`${h.name} 메뉴`}
                              actions={[
                                { label: '테스트 보내기', icon: 'play', onSelect: () => void test(h) },
                                { label: '전달 기록', icon: 'listChecks', onSelect: () => setLog(h) },
                                { label: '수정', icon: 'squarePen', onSelect: () => setEditOut(h) },
                                {
                                  label: '서명 키 다시 만들기',
                                  icon: 'key',
                                  hidden: h.format !== 'json',
                                  onSelect: () => setConfirm({ kind: 'rotate-secret', hook: h }),
                                },
                                { label: '삭제', icon: 'trash', danger: true, onSelect: () => setConfirm({ kind: 'delete-out', hook: h }) },
                              ]}
                            />
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </SettingsSection>

            {/* ───────── incoming */}
            <SettingsSection
              title="받는 웹훅"
              lead="비밀 URL로 POST하면 작업이 만들어지거나 바뀌어요. 만든 사람의 권한으로 실행되고 활동 기록에 남아요."
              action={
                !loading && !!data!.incoming.length ? (
                  <button type="button" className={cx(ui.btn, ui.sm, ui.outline)} onClick={() => setEditIn('new')}>
                    <Icon name="plus" size={14} /> 추가
                  </button>
                ) : undefined
              }
            >
              {loading ? (
                <ListSkeleton />
              ) : !data!.incoming.length ? (
                <SettingsRow
                  label="아직 받는 웹훅이 없어요"
                  description="GitHub Actions, 아이폰 단축어, Zapier, Slack 슬래시 명령에서 작업을 만들거나 완료해 보세요."
                >
                  <button type="button" className={cx(ui.btn, ui.sm, ui.outline)} onClick={() => setEditIn('new')}>
                    <Icon name="plus" size={14} /> 받는 웹훅 추가
                  </button>
                </SettingsRow>
              ) : (
                <ul className={s.list}>
                  {data!.incoming.map((h) => {
                    const target = projectName(h.projectId);
                    return (
                      <li key={h.id} className={s.row}>
                        <div className={s.main}>
                          <div className={s.titleLine}>
                            <span className={s.name}>{h.name}</span>
                            <code className={s.hint}>obh_…{h.hint}</code>
                          </div>
                          <p className={s.meta}>
                            <span className={s.metaItem}>
                              <Icon name={target ? 'folder' : 'inbox'} size={12} /> {target ?? '인박스'}
                            </span>
                            <span className={s.metaItem}>{h.allowUpdates ? '만들기 · 바꾸기' : '만들기만'}</span>
                            {h.createdBy && <span className={s.metaItem}>{h.createdBy.name} 권한</span>}
                          </p>
                          {h.lastError && (
                            <p className={s.errorLine}>
                              <Icon name="alertCircle" size={13} /> 마지막 요청 실패 · {h.lastError}
                            </p>
                          )}
                        </div>
                        <div className={s.side}>
                          <span className={s.status}>
                            <span>{h.useCount ? `${h.useCount.toLocaleString('ko-KR')}번 받음` : '아직 받은 적 없음'}</span>
                            {h.lastUsedAt && <span className={s.statusDetail}>{relativeTime(h.lastUsedAt)}</span>}
                          </span>
                          <RowMenu
                            label={`${h.name} 메뉴`}
                            actions={[
                              { label: '수정', icon: 'squarePen', onSelect: () => setEditIn(h) },
                              { label: 'URL 다시 만들기', icon: 'key', onSelect: () => setConfirm({ kind: 'rotate-url', hook: h }) },
                              { label: '삭제', icon: 'trash', danger: true, onSelect: () => setConfirm({ kind: 'delete-in', hook: h }) },
                            ]}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {!loading && <IncomingHelp due={addDays(app.today, 3)} />}
            </SettingsSection>
          </>
        )}
      </div>

      <WebhookForm
        open={editOut !== null}
        initial={editOut === 'new' ? null : editOut}
        kind={ws?.kind ?? 'personal'}
        projects={app.projects}
        timezone={timezone}
        onClose={() => setEditOut(null)}
        onSaved={(hook, secret) => {
          putOut(hook);
          setEditOut(null);
          if (secret) {
            setTestResult(null);
            setReveal({ kind: 'secret', hook, secret, fresh: true });
          } else toast.success('저장했어요');
        }}
      />

      <IncomingForm
        open={editIn !== null}
        initial={editIn === 'new' ? null : editIn}
        projects={app.projects}
        onClose={() => setEditIn(null)}
        onSaved={(hook, url) => {
          putIn(hook);
          setEditIn(null);
          if (url) setReveal({ kind: 'url', hook, url, fresh: true });
          else toast.success('저장했어요');
        }}
      />

      <Deliveries hook={log} onClose={() => setLog(null)} onChanged={() => void load()} />

      <RevealModal
        reveal={reveal}
        testing={!!testing}
        testResult={testResult}
        due={addDays(app.today, 3)}
        onTest={(h) => void test(h, true)}
        onClose={() => {
          setReveal(null);
          setTestResult(null);
        }}
      />

      <ConfirmModal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={
          confirm?.kind === 'rotate-secret'
            ? '서명 키를 다시 만들까요?'
            : confirm?.kind === 'rotate-url'
              ? 'URL을 다시 만들까요?'
              : '웹훅을 삭제할까요?'
        }
        confirmLabel={confirm?.kind.startsWith('rotate') ? '다시 만들기' : '삭제'}
        body={
          confirm?.kind === 'rotate-secret'
            ? '지금 쓰는 서명 키는 바로 무효가 돼요. 받는 서버의 키도 새 값으로 바꿔야 해요.'
            : confirm?.kind === 'rotate-url'
              ? `“${confirm.hook.name}”의 지금 URL은 바로 작동을 멈춰요. 이 URL을 쓰던 곳을 모두 새 주소로 바꿔야 해요.`
              : confirm?.kind === 'delete-out'
                ? `“${confirm.hook.name}”으로 더 이상 보내지 않고, 전달 기록도 함께 지워져요.`
                : `“${confirm?.hook.name}” URL로 오는 요청은 더 이상 처리되지 않아요.`
        }
        onConfirm={() => confirm && void runConfirm(confirm)}
      />
    </Page>
  );
}

function ListSkeleton() {
  return (
    <ul className={s.list} aria-hidden="true">
      {[0, 1].map((i) => (
        <li key={i} className={s.row}>
          <div className={s.main}>
            <Skeleton width={140 + i * 30} height={14} />
            <Skeleton width={220} height={11} style={{ marginTop: 6 }} />
          </div>
          <Skeleton width={90} height={14} />
        </li>
      ))}
    </ul>
  );
}

/** Request formats for incoming webhooks, collapsed by default. */
function IncomingHelp({ due }: { due: string }) {
  return (
    <details className={s.help}>
      <summary>
        <Icon name="chevronRight" size={14} className={s.helpChev} /> 보낼 수 있는 내용
      </summary>
      <div className={s.helpBody}>
        <dl className={s.formats}>
          <div>
            <dt>텍스트</dt>
            <dd>
              <code>보고서 초안 내일 !높음 #런칭</code>처럼 빠른 추가와 같은 문법으로 써요. 둘째 줄부터는 메모가 돼요.
              <br />
              <code>#12 완료</code> · <code>#12 시작</code> · <code>#12 취소</code> · <code>#12 다시 열기</code> · <code>#12 금요일까지</code> ·{' '}
              <code>#12 !높음</code>
            </dd>
          </div>
          <div>
            <dt>JSON 만들기</dt>
            <dd>
              <code>title</code>(필수), <code>notes</code>, <code>dueDate</code>·<code>startDate</code>(<code>{due}</code> 또는 “내일”),{' '}
              <code>priority</code>(none·low·medium·high), <code>project</code>(이름), <code>assignee</code>(이메일·이름·me), <code>fixed</code>,{' '}
              <code>status</code>
            </dd>
          </div>
          <div>
            <dt>JSON 바꾸기</dt>
            <dd>
              <code>action</code>(complete·start·cancel·reopen·update) + <code>task</code>(<code>&quot;#12&quot;</code>) + 바꿀 필드
            </dd>
          </div>
          <div>
            <dt>응답</dt>
            <dd>
              <code>{'{ ok, action, task: { ref, title, url, … }, text }'}</code> · 실패하면 4xx와 <code>message</code>
            </dd>
          </div>
          <div>
            <dt>Slack</dt>
            <dd>
              슬래시 명령의 Request URL로 쓰면 <code>/할일 보고서 내일</code>처럼 채널에서 바로 작업을 만들 수 있어요.
            </dd>
          </div>
        </dl>
      </div>
    </details>
  );
}

function RevealModal({
  reveal,
  testing,
  testResult,
  due,
  onTest,
  onClose,
}: {
  reveal: Reveal | null;
  testing: boolean;
  testResult: WebhookDelivery | null;
  due: string;
  onTest: (h: Webhook) => void;
  onClose: () => void;
}) {
  const title = !reveal
    ? ''
    : reveal.kind === 'secret'
      ? reveal.fresh
        ? '보내는 웹훅을 만들었어요'
        : '새 서명 키를 만들었어요'
      : reveal.fresh
        ? '받는 웹훅 URL을 만들었어요'
        : '새 URL을 만들었어요';
  return (
    <Modal
      open={!!reveal}
      onClose={onClose}
      width={600}
      title={title}
      footer={
        <button type="button" className={cx(ui.btn, ui.primary)} onClick={onClose}>
          완료
        </button>
      }
    >
      {reveal?.kind === 'secret' && (
        <div className={s.form}>
          {reveal.hook.format === 'json' ? (
            <>
              <div className={ui.field}>
                <span className={ui.label}>서명 키</span>
                <CopyField value={reveal.secret} label="서명 키" done="서명 키를 복사했어요" />
                <span className={ui.help}>지금 복사해 두세요. 다시 볼 수 없어요. 모든 요청에 X-Obelisk-Signature 헤더로 서명이 붙어요.</span>
              </div>
              <div>
                <p className={s.bodyLabel}>받는 쪽에서 서명 확인하기</p>
                <Code>{VERIFY_SNIPPET}</Code>
              </div>
            </>
          ) : (
            <p className={s.lead}>
              이제 고른 이벤트가 {WEBHOOK_FORMAT_LABEL[reveal.hook.format]} 채널로 가요. 테스트 메시지로 연결을 확인해 보세요.
            </p>
          )}
          {reveal.fresh && (
            <div className={s.testBox}>
              <button type="button" className={cx(ui.btn, ui.outline)} disabled={testing} onClick={() => onTest(reveal.hook)}>
                {testing ? <Spinner /> : <Icon name="play" size={14} />} 테스트 보내기
              </button>
              {testResult && (
                <span className={s.testResult} data-tone={testResult.status === 'success' ? 'ok' : 'danger'}>
                  <Icon name={testResult.status === 'success' ? 'checkCircle' : 'xCircle'} size={15} />
                  {testResult.status === 'success' ? `받았어요 · HTTP ${testResult.responseStatus}` : (testResult.error ?? '실패')}
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {reveal?.kind === 'url' && (
        <div className={s.form}>
          <div className={ui.field}>
            <span className={ui.label}>URL</span>
            <CopyField value={reveal.url} label="받는 웹훅 URL" done="URL을 복사했어요" />
            <span className={ui.help}>이 URL을 아는 누구나 내 권한으로 작업을 만들 수 있어요. 지금 복사해 두세요. 다시 볼 수 없어요.</span>
          </div>
          {incomingExamples(reveal.url, reveal.hook.allowUpdates, due).map((ex) => (
            <div key={ex.title}>
              <p className={s.bodyLabel}>{ex.title}</p>
              <Code>{ex.code}</Code>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

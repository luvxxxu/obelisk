'use client';

import { cloudflareJevUrl, JEV_PRESETS, jevEndpoint, jevPresetOf, type JevPresetId, type JevStatus } from '@obelisk/core';
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '@/components/Icon';
import { Badge, ConfirmModal, Switch, ui, useDisclosure } from '@/components/primitives';
import { Page, ViewHeader } from '@/components/View';
import { cx } from '@/lib/format';
import { saveJevSettings, useJev } from '@/lib/jev';
import { toast } from '@/lib/toast';
import { setUi } from '@/lib/ui-state';
import { SettingsNav, SettingsRow, SettingsSection } from '../SettingsNav';
import s from '../settings.module.css';
import j from './jev.module.css';

const FEATURES: { title: string; body: string; where: string }[] = [
  {
    title: '우선순위 자동 판단',
    body: 'Jev가 작업마다 놓치면 무엇을 잃는지 판단하고, 마감까지 남은 날과 기다리는 작업 수를 더해 높음·보통·낮음을 제안해요.',
    where: '홈 · 명령 팔레트',
  },
  {
    title: '미룰 작업 고르기',
    body: '오늘이나 이번 주가 평소 페이스를 넘으면 미뤄도 괜찮은 일을 고르고, 고정 일정과 부딪히지 않는 여유 있는 날로 옮겨요.',
    where: '홈 · 오늘',
  },
  {
    title: '새 작업 자동 분류',
    body: '빠른 입력에 적은 내용을 보고 프로젝트, 우선순위, 고정 일정 여부를 추천해요. Tab 한 번이면 모두 적용돼요.',
    where: '빠른 입력',
  },
  {
    title: '선후 관계 찾기',
    body: '먼저 끝나야 할 작업과 이 작업을 기다릴 작업을 찾아 연결을 제안해요. 연결할수록 지연 예측이 정확해져요.',
    where: '작업 상세',
  },
];

type ServiceId = JevPresetId | 'custom';

const SERVICES: { id: ServiceId; label: string }[] = [
  { id: 'typesafe', label: 'TypeSafe' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'cloudflare', label: 'Cloudflare' },
  { id: 'custom', label: '직접 입력' },
];

const presetOf = (id: JevPresetId) => JEV_PRESETS.find((p) => p.id === id)!;

const MODEL_NOTE: Record<string, string> = {
  '~typesafe/jev-latest': '항상 최신 Jev',
  clef: '27B · 더 정확해요',
  'clef-flash': '9B · 더 빠르고, 같은 무료 한도로 약 6배 더 써요',
};

const KEY_LABEL: Record<ServiceId, { label: string; placeholder: string }> = {
  typesafe: { label: 'TypeSafe API 키', placeholder: 'apikey_…' },
  openrouter: { label: 'OpenRouter API 키', placeholder: 'sk-or-v1-…' },
  cloudflare: { label: 'Cloudflare API 토큰', placeholder: 'Workers AI 권한이 있는 토큰' },
  custom: { label: 'API 키', placeholder: 'Authorization: Bearer 로 보낼 키' },
};

/** "…로 전송돼요" */
const SENT_TO: Record<ServiceId, string> = { typesafe: 'TypeSafe로', openrouter: 'OpenRouter로', cloudflare: 'Cloudflare로', custom: '설정한 서버로' };

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={j.link}>
      {children}
      <Icon name="external" size={12} />
    </a>
  );
}

/** Where the key comes from and who bills it. */
function ServiceHelp({ id }: { id: ServiceId }) {
  switch (id) {
    case 'typesafe':
      return (
        <>
          키는 <ExternalLink href="https://docs.typesafe.ai/introduction/quickstart">TypeSafe 콘솔</ExternalLink>에서 만들 수 있어요. 요금은 보낸 글자 수(입력
          토큰)만큼 TypeSafe에 청구돼요.
        </>
      );
    case 'openrouter':
      return (
        <>
          TypeSafe 계정 없이 OpenRouter 키 하나로 Jev를 써요. 키는 <ExternalLink href="https://openrouter.ai/settings/keys">OpenRouter 설정</ExternalLink>에서
          만들고, 요금은 OpenRouter 크레딧에서 빠져요.
        </>
      );
    case 'cloudflare':
      return (
        <>
          Cloudflare가 만든 Jev 호환 판단 모델(Clef)을 Workers AI에서 써요. 하루 10,000 뉴런까지 무료이고, 무료 플랜은 한도를 넘으면 다음 날 오전 9시까지
          멈춰요. 계정 ID와 Workers AI 권한이 있는 토큰은{' '}
          <ExternalLink href="https://developers.cloudflare.com/workers-ai/get-started/rest-api/">이 안내</ExternalLink>대로 만들 수 있어요.
        </>
      );
    case 'custom':
      return (
        <>
          System One API(<code>state</code>·<code>questions</code> → <code>answers</code>)를 그대로 받는 서버면 어디든 돼요. 주소 끝에 <code>/systemone</code>이
          없으면 자동으로 붙여요.
        </>
      );
  }
}

const serviceOf = (jev: JevStatus): ServiceId => jevPresetOf(jev.baseUrl) ?? 'custom';
const accountOf = (url: string | null) => /\/accounts\/([0-9a-f]{32})(\/|$)/i.exec(url ?? '')?.[1] ?? '';
const defaultModel = (id: ServiceId) => (id === 'typesafe' || id === 'custom' ? '' : presetOf(id).models[0]);
const originOf = (baseUrl: string | null) => {
  try {
    return new URL(baseUrl ?? presetOf('typesafe').baseUrl).origin;
  } catch {
    return baseUrl ?? '';
  }
};

const hostOf = (url: string | null) => {
  try {
    return new URL(url ?? '').host;
  } catch {
    return '직접 입력';
  }
};

export default function JevSettingsPage() {
  const jev = useJev();
  const stored = serviceOf(jev);
  const [service, setService] = useState<ServiceId>(stored);
  const [model, setModel] = useState(jev.model ?? defaultModel(stored));
  const [accountId, setAccountId] = useState(accountOf(jev.baseUrl));
  const [customUrl, setCustomUrl] = useState(stored === 'custom' ? (jev.baseUrl ?? '') : '');
  const [key, setKey] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const disconnect = useDisclosure();

  // The stored connection changed (loaded, saved, disconnected): show it.
  useEffect(() => {
    const id = jevPresetOf(jev.baseUrl) ?? 'custom';
    setService(id);
    setModel(jev.model ?? defaultModel(id));
    setAccountId(accountOf(jev.baseUrl));
    setCustomUrl(id === 'custom' ? (jev.baseUrl ?? '') : '');
  }, [jev.baseUrl, jev.model]);

  const pick = (id: ServiceId) => {
    setService(id);
    setModel(id === stored ? (jev.model ?? defaultModel(id)) : defaultModel(id));
  };

  // What would be saved: the service's base URL (null = TypeSafe) and model (null = default).
  const m = model.trim();
  const account = accountId.trim();
  const accountOk = /^[0-9a-f]{32}$/i.test(account);
  const url = customUrl.trim().replace(/\/+$/, '');
  const draft: { baseUrl: string | null; model: string | null; ready: boolean } =
    service === 'typesafe'
      ? { baseUrl: null, model: m || null, ready: true }
      : service === 'openrouter'
        ? { baseUrl: presetOf('openrouter').baseUrl, model: m || null, ready: !!m }
        : service === 'cloudflare'
          ? { baseUrl: accountOk && m ? cloudflareJevUrl(account, m) : null, model: m || null, ready: accountOk && !!m }
          : { baseUrl: url || null, model: m || null, ready: /^https?:\/\/\S+$/i.test(url) && !!m };

  const k = key.trim();
  const changed = draft.baseUrl !== jev.baseUrl || draft.model !== jev.model;
  const sameHost = originOf(draft.baseUrl) === originOf(jev.baseUrl);
  // Without a new key only the model (or path) on the same host can change: a stored key never moves hosts.
  const canSave = draft.ready && !busy && (!!k || (jev.connected && changed && sameHost));
  const needsKey = jev.connected && changed && !sameHost && !k;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    const res = await saveJevSettings({ ...(k ? { apiKey: k } : {}), baseUrl: draft.baseUrl, model: draft.model });
    setBusy(false);
    if (res) {
      setKey('');
      toast.success(!k ? '모델을 바꿨어요' : jev.connected ? `${SERVICES.find((x) => x.id === service)!.label}로 바꿨어요` : 'Jev를 연결했어요');
    }
  };

  const connectedLabel = stored === 'custom' ? hostOf(jev.baseUrl) : presetOf(stored).label;
  const suggestions = service === 'typesafe' || service === 'custom' ? [] : presetOf(service).models;
  const endpoint = draft.baseUrl ? jevEndpoint(draft.baseUrl) : service === 'typesafe' ? jevEndpoint(presetOf('typesafe').baseUrl) : null;
  const enter = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) void save();
  };

  return (
    <Page>
      <ViewHeader title="설정">
        <SettingsNav />
      </ViewHeader>

      <div className={s.stack}>
        {/* ───────── connection */}
        <SettingsSection
          title={
            <>
              Jev 연결
              {jev.connected ? (
                <Badge tone="ok">연결됨</Badge>
              ) : jev.keyUnreadable ? (
                <Badge tone="danger">다시 입력 필요</Badge>
              ) : (
                <Badge tone="secondary">연결 안 됨</Badge>
              )}
            </>
          }
          lead="Jev는 TypeSafe의 판단 모델이에요. 같은 System One API를 쓰는 곳이면 어디든 연결할 수 있어요 — TypeSafe, OpenRouter, 무료 한도가 있는 Cloudflare, 직접 띄운 서버. 연결하면 작업마다 중요도와 미뤄도 되는지를 판단해 주고, 날짜와 파급 계산은 Obelisk의 지연 예측 엔진이 그대로 맡아요."
        >
          {jev.keyUnreadable && (
            <div className={cx(ui.alert, j.alert)} data-tone="danger" role="alert">
              <Icon name="alert" size={16} />
              <div className={ui.alertTitle}>저장된 키(…{jev.hint ?? ''})를 열 수 없어요</div>
              <div className={ui.alertDescription}>
                서버의 암호화 키(SECRET_KEY)가 바뀌었거나 다른 서버의 데이터를 옮겨 오면 이렇게 돼요. 아래에 키를 다시 입력하면 바로 다시 연결돼요.
              </div>
            </div>
          )}
          {(jev.connected || jev.keyUnreadable) && (
            <SettingsRow
              label="연결된 서비스"
              description={
                <>
                  {connectedLabel}
                  {' · '}
                  <span className={j.keyMask}>{jev.model ?? 'jev-latest'}</span>
                  {' · '}
                  <span className={j.keyMask}>•••• {jev.hint ?? ''}</span>
                  {jev.keyUnreadable ? ' · 열 수 없는 키' : ''}
                </>
              }
            >
              <button type="button" className={cx(ui.btn, ui.dangerGhost, ui.sm)} onClick={disconnect.toggle}>
                연결 해제
              </button>
            </SettingsRow>
          )}
          <SettingsRow stack label={jev.connected ? '서비스·모델 바꾸기' : '서비스'} description={<ServiceHelp id={service} />}>
            <div className={j.form}>
              <div className={cx(ui.segmented, j.seg)} role="radiogroup" aria-label="서비스">
                {SERVICES.map((x) => (
                  <button
                    key={x.id}
                    type="button"
                    role="radio"
                    aria-checked={service === x.id}
                    aria-pressed={service === x.id}
                    className={ui.segment}
                    onClick={() => pick(x.id)}
                  >
                    {x.label}
                  </button>
                ))}
              </div>

              {service === 'cloudflare' && (
                <label className={ui.field}>
                  <span className={ui.label}>계정 ID</span>
                  <input
                    className={cx(ui.input, j.mono)}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="32자리 영문·숫자"
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                    onKeyDown={enter}
                    aria-invalid={account !== '' && !accountOk}
                  />
                  {account !== '' && !accountOk && <span className={ui.help}>계정 ID는 32자리 영문·숫자예요.</span>}
                </label>
              )}

              {service === 'custom' && (
                <label className={ui.field}>
                  <span className={ui.label}>Base URL</span>
                  <input
                    className={cx(ui.input, j.mono)}
                    type="url"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="https://example.com/v1"
                    value={customUrl}
                    onChange={(e) => setCustomUrl(e.target.value)}
                    onKeyDown={enter}
                  />
                </label>
              )}

              <div className={ui.field}>
                <label className={ui.label} htmlFor="jev-model">
                  모델
                </label>
                <input
                  id="jev-model"
                  className={cx(ui.input, j.mono)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={service === 'typesafe' ? 'jev-latest (기본)' : '서비스에서 쓰는 모델 이름'}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  onKeyDown={enter}
                />
                {suggestions.length > 1 && (
                  <div className={cx(ui.segmented, j.seg)} data-size="sm" role="group" aria-label="추천 모델">
                    {suggestions.map((id) => (
                      <button key={id} type="button" className={cx(ui.segment, j.mono)} aria-pressed={m === id} onClick={() => setModel(id)}>
                        {id}
                      </button>
                    ))}
                  </div>
                )}
                {MODEL_NOTE[m] && <span className={ui.help}>{MODEL_NOTE[m]}</span>}
              </div>

              <div className={ui.field}>
                <label className={ui.label} htmlFor="jev-key">
                  {KEY_LABEL[service].label}
                  {jev.connected && sameHost && <span className={j.optional}> · 같은 서비스면 비워 둬도 돼요</span>}
                </label>
                <div className={j.inputRow}>
                  <input
                    id="jev-key"
                    className={ui.input}
                    type={show ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={KEY_LABEL[service].placeholder}
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    onKeyDown={enter}
                  />
                  <button type="button" className={cx(ui.btn, ui.ghost, ui.icon)} onClick={() => setShow((v) => !v)} aria-label={show ? '키 숨기기' : '키 보기'}>
                    <Icon name="eye" size={15} />
                  </button>
                  <button type="button" className={cx(ui.btn, ui.primary)} disabled={!canSave} onClick={() => void save()}>
                    {busy && <span className={ui.spinner} />}
                    {!k && jev.connected ? '저장' : jev.connected ? '바꾸기' : jev.keyUnreadable ? '다시 연결' : '연결'}
                  </button>
                </div>
                {needsKey ? (
                  <span className={ui.help}>다른 서비스로 바꾸려면 그 서비스의 키도 입력하세요. 저장된 키는 다른 주소로 보내지 않아요.</span>
                ) : (
                  <span className={ui.help}>저장하기 전에 키가 실제로 동작하는지 한 번 확인해요.</span>
                )}
              </div>

              {endpoint && (
                <p className={j.endpoint}>
                  <span>요청 주소</span>
                  <code>{endpoint}</code>
                </p>
              )}
            </div>
          </SettingsRow>
          <p className={s.note}>
            <Icon name="shield" size={15} />
            <span>
              Jev를 쓸 때마다 <strong>작업 제목, 메모 앞부분, 날짜, 프로젝트 이름, 연결된 작업 제목</strong>이 {SENT_TO[service]} 전송돼요. 이메일이나 멤버 이름은
              보내지 않고, 조직에서는 내가 볼 수 있는 작업만 보내요.
            </span>
          </p>
        </SettingsSection>

        {/* ───────── behaviour */}
        <SettingsSection title="판단 적용" lead="기본은 제안만 보여주고 내가 골라 적용해요.">
          <SettingsRow
            label="확신이 높으면 바로 적용"
            description="켜면 Jev가 80% 이상 확신하는 판단은 바로 반영해요(새 작업의 프로젝트·우선순위·고정 여부, 그리고 우선순위가 비어 있는 작업만). 미루기와 선후 관계 연결은 언제나 확인을 받아요."
          >
            <Switch
              checked={jev.autoApply}
              label="확신이 높으면 바로 적용"
              onChange={(v) => {
                if (!jev.connected) {
                  toast.error('먼저 Jev를 연결하세요');
                  return;
                }
                void saveJevSettings({ autoApply: v }).then((r) => r && toast.show(v ? '확신이 높은 판단은 바로 적용해요' : '이제 모든 판단을 제안으로만 보여줘요'));
              }}
            />
          </SettingsRow>
        </SettingsSection>

        {/* ───────── what it does */}
        <SettingsSection
          title="Jev가 하는 일"
          lead="Jev는 의미를 판단하고, 날짜·파급 계산은 지연 예측 엔진이 해요. 어떤 판단이든 이유와 확신도를 함께 보여줘요."
          action={
            jev.connected ? (
              <>
                <button type="button" className={cx(ui.btn, ui.outline, ui.sm)} onClick={() => setUi({ jev: { kind: 'priority' } })}>
                  우선순위 정리 열기
                </button>
                <button type="button" className={cx(ui.btn, ui.outline, ui.sm)} onClick={() => setUi({ jev: { kind: 'postpone', scope: 'today' } })}>
                  미룰 작업 고르기
                </button>
              </>
            ) : undefined
          }
        >
          <ul className={j.features}>
            {FEATURES.map((f) => (
              <li key={f.title} className={j.feature}>
                <p className={j.featureTitle}>
                  {f.title}
                  <span className={j.featureWhere}>{f.where}</span>
                </p>
                <p className={j.featureBody}>{f.body}</p>
              </li>
            ))}
          </ul>
        </SettingsSection>
      </div>

      <ConfirmModal
        open={disconnect.open}
        onClose={disconnect.close}
        title="Jev 연결을 해제할까요?"
        body="저장된 키와 서비스 설정을 지워요. 이미 적용한 우선순위나 일정은 그대로 남아요."
        confirmLabel="연결 해제"
        onConfirm={() => void saveJevSettings({ apiKey: null }).then((r) => r && toast.show('Jev 연결을 해제했어요'))}
      />
    </Page>
  );
}

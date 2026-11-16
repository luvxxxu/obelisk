'use client';

import { useState } from 'react';
import { Icon, type IconName } from '@/components/Icon';
import { JevMark } from '@/components/JevDialogs';
import { Badge, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, ConfirmModal, Switch, ui, useDisclosure } from '@/components/primitives';
import { Page, ViewHeader } from '@/components/View';
import { cx } from '@/lib/format';
import { saveJevSettings, useJev } from '@/lib/jev';
import { toast } from '@/lib/toast';
import { setUi } from '@/lib/ui-state';
import { SettingsNav } from '../SettingsNav';
import s from '../settings.module.css';
import j from './jev.module.css';

const FEATURES: { icon: IconName; title: string; body: string; where: string }[] = [
  {
    icon: 'flag',
    title: '우선순위 자동 판단',
    body: 'Jev가 작업마다 놓치면 무엇을 잃는지 판단하고, 마감까지 남은 날과 기다리는 작업 수를 더해 높음·보통·낮음을 제안해요.',
    where: '홈 · 명령 팔레트',
  },
  {
    icon: 'postpone',
    title: '미룰 작업 고르기',
    body: '오늘이나 이번 주가 평소 페이스를 넘으면 미뤄도 괜찮은 일을 고르고, 고정 일정과 부딪히지 않는 여유 있는 날로 옮겨요.',
    where: '홈 · 오늘',
  },
  {
    icon: 'sparkle',
    title: '새 작업 자동 분류',
    body: '빠른 입력에 적은 내용을 보고 프로젝트, 우선순위, 고정 일정 여부를 추천해요. Tab 한 번이면 모두 적용돼요.',
    where: '빠른 입력',
  },
  {
    icon: 'link',
    title: '선후 관계 찾기',
    body: '먼저 끝나야 할 작업과 이 작업을 기다릴 작업을 찾아 연결을 제안해요. 연결할수록 지연 예측이 정확해져요.',
    where: '작업 상세',
  },
];

export default function JevSettingsPage() {
  const jev = useJev();
  const [key, setKey] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const disconnect = useDisclosure();

  const connect = async () => {
    const k = key.trim();
    if (!k || busy) return;
    setBusy(true);
    const res = await saveJevSettings({ apiKey: k });
    setBusy(false);
    if (res) {
      setKey('');
      toast.success('Jev를 연결했어요');
    }
  };

  return (
    <Page>
      <ViewHeader icon="settings" title="설정" description="프로필과 화면, 계정을 관리해요.">
        <SettingsNav />
      </ViewHeader>

      <div className={s.stack}>
        <Card className={s.section}>
          <CardHeader>
            <div className={j.titleRow}>
              <JevMark />
              <CardTitle>Jev 연결</CardTitle>
              {jev.connected ? (
                <Badge tone="ok">
                  <Icon name="check" size={12} strokeWidth={2.6} /> 연결됨
                </Badge>
              ) : jev.keyUnreadable ? (
                <Badge tone="danger">
                  <Icon name="alert" size={12} strokeWidth={2.2} /> 다시 입력 필요
                </Badge>
              ) : (
                <Badge tone="outline">연결 안 됨</Badge>
              )}
            </div>
            <CardDescription>
              Jev는 TypeSafe의 판단 모델이에요. 내 TypeSafe API 키로 연결하면 작업마다 중요도와 미뤄도 되는지를 판단해 주고, 날짜와 파급 계산은 Obelisk의 지연 예측 엔진이 그대로 맡아요.
            </CardDescription>
          </CardHeader>
          <CardContent className={j.content}>
            {jev.keyUnreadable && (
              <div className={ui.alert} data-tone="danger" role="alert">
                <Icon name="alert" size={16} />
                <div className={ui.alertTitle}>저장된 키(…{jev.hint ?? ''})를 열 수 없어요</div>
                <div className={ui.alertDescription}>
                  서버의 암호화 키(SECRET_KEY)가 바뀌었거나 다른 서버의 데이터를 옮겨 오면 이렇게 돼요. 아래에 키를 다시 입력하면 바로 다시 연결돼요.
                </div>
              </div>
            )}
            {(jev.connected || jev.keyUnreadable) && (
              <div className={j.keyRow}>
                <Icon name="key" size={15} />
                <span className={j.keyMask}>•••• •••• {jev.hint ?? ''}</span>
                <span className={j.keyNote}>{jev.keyUnreadable ? '열 수 없는 키' : '서버에 암호화해서 저장돼 있어요'}</span>
                <button type="button" className={cx(ui.btn, ui.dangerGhost, ui.sm)} onClick={disconnect.toggle}>
                  연결 해제
                </button>
              </div>
            )}
            <div className={ui.field}>
              <label className={ui.label} htmlFor="jev-key">
                {jev.connected ? '다른 키로 바꾸기' : jev.keyUnreadable ? 'TypeSafe API 키 다시 입력' : 'TypeSafe API 키'}
              </label>
              <div className={j.inputRow}>
                <input
                  id="jev-key"
                  className={ui.input}
                  type={show ? 'text' : 'password'}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="apikey_…"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) void connect();
                  }}
                />
                <button type="button" className={cx(ui.btn, ui.ghost, ui.icon)} onClick={() => setShow((v) => !v)} aria-label={show ? '키 숨기기' : '키 보기'}>
                  <Icon name="eye" size={15} />
                </button>
                <button type="button" className={cx(ui.btn, ui.primary)} disabled={!key.trim() || busy} onClick={() => void connect()}>
                  {busy ? <span className={ui.spinner} /> : <Icon name="link" size={15} />}
                  {jev.connected ? '바꾸기' : jev.keyUnreadable ? '다시 연결' : '연결'}
                </button>
              </div>
              <p className={ui.help}>
                연결할 때 키가 실제로 동작하는지 한 번 확인해요. 키는{' '}
                <a href="https://docs.typesafe.ai/introduction/quickstart" target="_blank" rel="noreferrer" className={j.link}>
                  TypeSafe 콘솔
                  <Icon name="external" size={12} />
                </a>
                에서 만들 수 있어요. 요금은 보낸 글자 수(입력 토큰)만큼 TypeSafe에 청구돼요.
              </p>
            </div>
          </CardContent>
          <CardFooter className={j.privacy}>
            <Icon name="shield" size={15} />
            <p>
              Jev를 쓸 때마다 <strong>작업 제목, 메모 앞부분, 날짜, 프로젝트 이름, 연결된 작업 제목</strong>이 TypeSafe로 전송돼요. 이메일이나 멤버 이름은 보내지 않고, 조직에서는 내가 볼 수 있는 작업만 보내요.
            </p>
          </CardFooter>
        </Card>

        <Card className={s.section}>
          <CardContent>
            <div className={s.row}>
              <div className={s.rowText}>
                <p className={s.rowTitle}>확신이 높으면 바로 적용</p>
                <p className={s.rowDesc}>
                  기본은 제안만 보여주고 내가 골라 적용해요. 켜면 Jev가 80% 이상 확신하는 판단은 바로 반영해요 — 새 작업의 프로젝트·우선순위·고정 여부, 그리고 우선순위가 비어 있는 작업만요. 미루기와 선후 관계 연결은 언제나 확인을 받아요.
                </p>
              </div>
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
            </div>
          </CardContent>
        </Card>

        <Card className={s.section}>
          <CardHeader>
            <CardTitle>Jev가 하는 일</CardTitle>
            <CardDescription>Jev는 의미를 판단하고, 날짜·파급 계산은 지연 예측 엔진이 해요. 어떤 판단이든 이유와 확신도를 함께 보여줘요.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className={j.features}>
              {FEATURES.map((f) => (
                <li key={f.title} className={j.feature}>
                  <span className={j.featureIcon}>
                    <Icon name={f.icon} size={16} />
                  </span>
                  <div>
                    <p className={j.featureTitle}>
                      {f.title}
                      <span className={j.featureWhere}>{f.where}</span>
                    </p>
                    <p className={j.featureBody}>{f.body}</p>
                  </div>
                </li>
              ))}
            </ul>
            {jev.connected && (
              <div className={j.tryRow}>
                <button type="button" className={cx(ui.btn, ui.outline, ui.sm)} onClick={() => setUi({ jev: { kind: 'priority' } })}>
                  <Icon name="flag" size={14} /> 우선순위 정리 열기
                </button>
                <button type="button" className={cx(ui.btn, ui.outline, ui.sm)} onClick={() => setUi({ jev: { kind: 'postpone', scope: 'today' } })}>
                  <Icon name="postpone" size={14} /> 미룰 작업 고르기
                </button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <ConfirmModal
        open={disconnect.open}
        onClose={disconnect.close}
        title="Jev 연결을 해제할까요?"
        body="저장된 키를 지워요. 이미 적용한 우선순위나 일정은 그대로 남아요."
        confirmLabel="연결 해제"
        onConfirm={() => void saveJevSettings({ apiKey: null }).then((r) => r && toast.show('Jev 연결을 해제했어요'))}
      />
    </Page>
  );
}

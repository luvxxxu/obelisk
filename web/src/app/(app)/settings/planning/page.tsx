'use client';

import {
  DEFAULT_FOCUS,
  formatDurationKo,
  intervalMinutes,
  isISOTime,
  percentKo,
  workHoursInput,
  workIntervals,
  type CalibrationSummary,
  type WorkHours,
} from '@obelisk/core';
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Button, Switch, ui } from '@/components/primitives';
import { Page, ViewHeader } from '@/components/View';
import { api } from '@/lib/api';
import { cx } from '@/lib/format';
import { useApp } from '@/lib/store';
import { saveWorkHours } from '@/lib/timeplan';
import { SettingsNav, SettingsRow, SettingsSection } from '../SettingsNav';
import s from '../settings.module.css';
import p from './planning.module.css';

const DAYS = [
  { d: 1, label: '월' },
  { d: 2, label: '화' },
  { d: 3, label: '수' },
  { d: 4, label: '목' },
  { d: 5, label: '금' },
  { d: 6, label: '토' },
  { d: 0, label: '일' },
];

export default function PlanningSettingsPage() {
  const { user } = useApp();
  const [draft, setDraft] = useState<WorkHours | null>(user?.workHours ?? null);
  const [busy, setBusy] = useState(false);
  const [cal, setCal] = useState<CalibrationSummary | null>(null);
  useEffect(() => {
    if (user) setDraft(user.workHours);
  }, [user]);
  useEffect(() => {
    api<{ calibration: CalibrationSummary }>('GET', '/api/odds/calibration')
      .then((r) => setCal(r.calibration))
      .catch(() => {});
  }, [user?.workHours]);

  const check = useMemo(() => (draft ? workHoursInput.safeParse(draft) : null), [draft]);
  if (!draft || !user) return null;
  const set = (patch: Partial<WorkHours>) => setDraft({ ...draft, ...patch });
  const changed = JSON.stringify(draft) !== JSON.stringify(user.workHours);
  const error = check && !check.success ? check.error.issues[0]?.message : null;
  const perDay = check?.success ? intervalMinutes(workIntervals(check.data)) : 0;
  const focus = draft.focus ?? cal?.focus ?? DEFAULT_FOCUS;

  return (
    <Page>
      <ViewHeader title="설정">
        <SettingsNav />
      </ViewHeader>
      <div className={s.stack}>
        <p className={s.intro}>
          언제 일하고 하루에 얼마나 작업에 쓰는지 알려 주면 오늘 시간표와 완료 확률이 정확해져요. 비워 둔 값은 기록을 보고 스스로 맞춰요.
        </p>

        <SettingsSection title="근무 시간" lead={perDay ? `하루 ${formatDurationKo(perDay)} 일해요 (쉬는 시간 빼고).` : undefined}>
          <SettingsRow label="일하는 요일">
            <div className={p.days} role="group" aria-label="일하는 요일">
              {DAYS.map(({ d, label }) => {
                const on = draft.days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    className={p.day}
                    aria-pressed={on}
                    onClick={() => set({ days: on ? draft.days.filter((x) => x !== d) : [...draft.days, d].sort() })}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </SettingsRow>
          <SettingsRow label="출근 · 퇴근" description="이 사이에만 시간표를 짜요. 회의가 바깥에 있어도 그대로 보여요.">
            <div className={p.span}>
              <TimeInput value={draft.start} onChange={(v) => set({ start: v })} label="출근" />
              <span className={p.dash}>–</span>
              <TimeInput value={draft.end} onChange={(v) => set({ end: v })} label="퇴근" />
            </div>
          </SettingsRow>
          <SettingsRow label="쉬는 시간" description="점심처럼 매일 비워 두는 시간이에요." stack>
            <div className={p.breaks}>
              {draft.breaks.map((b, i) => (
                <div key={i} className={p.span}>
                  <TimeInput value={b.start} onChange={(v) => set({ breaks: draft.breaks.map((x, k) => (k === i ? { ...x, start: v } : x)) })} label="쉬는 시간 시작" />
                  <span className={p.dash}>–</span>
                  <TimeInput value={b.end} onChange={(v) => set({ breaks: draft.breaks.map((x, k) => (k === i ? { ...x, end: v } : x)) })} label="쉬는 시간 끝" />
                  <button type="button" className={ui.iconBtn} onClick={() => set({ breaks: draft.breaks.filter((_, k) => k !== i) })} aria-label="쉬는 시간 지우기">
                    <Icon name="x" size={14} />
                  </button>
                </div>
              ))}
              {draft.breaks.length < 4 && (
                <Button variant="ghost" size="sm" onClick={() => set({ breaks: [...draft.breaks, { start: '15:00', end: '15:15' }] })}>
                  <Icon name="plus" size={14} />
                  쉬는 시간 추가
                </Button>
              )}
            </div>
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title="얼마나 작업에 쓰나요" lead="메일, 메신저, 갑자기 생긴 일에 쓰는 시간을 빼고 실제로 작업에 쓰는 비율이에요.">
          <SettingsRow
            label="기록으로 맞추기"
            description={
              cal?.focusSource === 'history'
                ? `최근 ${cal.trackedDays}일 기록으로 하루 ${percentKo(cal.focus)}를 쓰고 있어요.`
                : '기록한 시간이 5일 이상 쌓이면 스스로 맞춰요. 그전까지는 70%로 봐요.'
            }
          >
            <Switch checked={draft.focus === null} onChange={(v) => set({ focus: v ? null : Math.round(focus * 20) / 20 })} label="집중 비율 자동" />
          </SettingsRow>
          {draft.focus !== null && (
            <SettingsRow label="집중 비율" description={perDay ? `하루 ${formatDurationKo(perDay * draft.focus)} 작업해요.` : undefined}>
              <div className={p.slider}>
                <input type="range" min={10} max={100} step={5} value={Math.round(draft.focus * 100)} onChange={(e) => set({ focus: Number(e.target.value) / 100 })} aria-label="집중 비율" />
                <span className={p.sliderValue}>{Math.round(draft.focus * 100)}%</span>
              </div>
            </SettingsRow>
          )}
          <SettingsRow
            label="예상 시간이 없는 작업"
            description={
              draft.defaultEstimate === null
                ? cal
                  ? `지금은 ${formatDurationKo(cal.defaultEstimate)}로 봐요 (${cal.defaultEstimateSource === 'history' ? '실제 걸린 시간의 중간값' : cal.defaultEstimateSource === 'pace' ? '하루에 끝내는 작업 수로 계산' : '기본값'}).`
                  : undefined
                : '이 길이로 시간표와 확률을 계산해요.'
            }
          >
            <select
              className={cx(ui.input, p.select)}
              value={draft.defaultEstimate ?? ''}
              onChange={(e) => set({ defaultEstimate: e.target.value ? Number(e.target.value) : null })}
              aria-label="예상 시간이 없는 작업의 길이"
            >
              <option value="">자동</option>
              {[15, 30, 45, 60, 90, 120, 180, 240].map((m) => (
                <option key={m} value={m}>
                  {formatDurationKo(m)}
                </option>
              ))}
            </select>
          </SettingsRow>
        </SettingsSection>

        {cal && (
          <SettingsSection title="지금까지 배운 것" lead="완료 확률과 약속 날짜는 이 숫자로 계산해요. 끝낸 작업이 쌓일수록 정확해져요.">
            <div className={p.learned}>
              <Learned
                label="예상 대비 실제"
                value={cal.ratioSamples ? `${cal.medianRatio!.toFixed(2)}배` : '기록 없음'}
                note={cal.ratioSamples ? `예상과 실제 시간이 모두 있는 작업 ${cal.ratioSamples}개` : '예상 시간을 적고 끝내면 쌓여요 (그전엔 1.25배)'}
              />
              <Learned
                label="첫 마감을 지킨 비율"
                value={cal.slipSamples ? percentKo(cal.onTimeRate!) : '기록 없음'}
                note={cal.slipSamples ? `마감이 있던 작업 ${cal.slipSamples}개${cal.meanLateDays ? ` · 늦으면 평균 ${cal.meanLateDays.toFixed(1)}일` : ''}` : '미뤄도 처음 마감일로 따져요'}
              />
              <Learned label="하루 집중" value={percentKo(cal.focus)} note={cal.focusSource === 'history' ? `기록 ${cal.trackedDays}일` : cal.focusSource === 'setting' ? '직접 정한 값' : '기본값'} />
            </div>
          </SettingsSection>
        )}

        <div className={s.footer}>
          <span className={cx(s.footerNote, error && p.error)} data-dirty={changed || undefined}>
            {error ?? (changed ? '저장하지 않은 변경이 있어요' : '오늘 시간표와 완료 확률에 바로 반영돼요')}
          </span>
          <div className={p.footerButtons}>
          <Button variant="ghost" disabled={!changed || busy} onClick={() => setDraft(user.workHours)}>
            되돌리기
          </Button>
          <Button
            disabled={!changed || busy || !check?.success}
            onClick={async () => {
              if (!check?.success) return;
              setBusy(true);
              await saveWorkHours(check.data);
              setBusy(false);
            }}
          >
            저장
          </Button>
          </div>
        </div>
      </div>
    </Page>
  );
}

function TimeInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      type="time"
      className={cx(ui.input, p.time)}
      value={text}
      step={900}
      aria-label={label}
      onChange={(e) => {
        setText(e.target.value);
        if (isISOTime(e.target.value)) onChange(e.target.value);
      }}
    />
  );
}

function Learned({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className={p.learnedItem}>
      <span className={p.learnedLabel}>{label}</span>
      <span className={p.learnedValue}>{value}</span>
      <span className={p.learnedNote}>{note}</span>
    </div>
  );
}

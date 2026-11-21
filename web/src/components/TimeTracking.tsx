'use client';

import {
  ESTIMATE_PRESETS,
  formatDurationKo,
  formatRelativeKo,
  parseDuration,
  percentKo,
  type Task,
  type TaskOdds,
} from '@obelisk/core';
import { useEffect, useRef, useState } from 'react';
import { cx } from '@/lib/format';
import { selectTask, updateTask, useApp } from '@/lib/store';
import {
  clockText,
  deleteEntry,
  logTime,
  setActual,
  startTimer,
  stopTimer,
  useElapsed,
  useEntries,
  useRunning,
} from '@/lib/timeplan';
import { setUi, useUi } from '@/lib/ui-state';
import { Icon } from './Icon';
import { Button, isEnter, Modal, Popover, tip, ui, useDisclosure } from './primitives';
import s from './TimeTracking.module.css';

const SOURCE_KO = { auto: '진행 중 자동', timer: '타이머', manual: '직접 입력' } as const;

/** "1시간 30분" from what was typed: a duration ("1h30m", "90분") or bare minutes. */
function readMinutes(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  if (/^\d{1,4}$/.test(t)) return Number(t);
  return parseDuration(t);
}

/* ───────── estimate */

export function EstimateField({ task }: { task: Task }) {
  const ref = useRef<HTMLButtonElement>(null);
  const d = useDisclosure();
  const [text, setText] = useState('');
  const pick = (m: number | null) => {
    d.close();
    if (m !== task.estimateMinutes) void updateTask(task.id, { estimateMinutes: m });
  };
  const typed = readMinutes(text);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={s.trigger}
        data-empty={!task.estimateMinutes}
        data-open={d.open}
        aria-haspopup="dialog"
        aria-expanded={d.open}
        aria-label={`예상 시간: ${task.estimateMinutes ? formatDurationKo(task.estimateMinutes) : '없음'}`}
        onClick={() => {
          setText('');
          d.toggle();
        }}
      >
        {task.estimateMinutes ? formatDurationKo(task.estimateMinutes) : '예상 시간 설정'}
      </button>
      <Popover anchor={ref} open={d.open} onClose={d.close} width={264}>
        <div className={s.estimatePanel}>
          <div className={s.chips} role="group" aria-label="자주 쓰는 시간">
            {ESTIMATE_PRESETS.map((m) => (
              <button key={m} type="button" className={s.chip} data-on={task.estimateMinutes === m} onClick={() => pick(m)}>
                {formatDurationKo(m)}
              </button>
            ))}
          </div>
          <form
            className={s.customRow}
            onSubmit={(e) => {
              e.preventDefault();
              if (typed && typed >= 1 && typed <= 1440) pick(typed);
            }}
          >
            <input
              className={ui.input}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="직접 입력 (예: 45분, 1h30m)"
              aria-label="예상 시간 직접 입력"
              autoFocus
            />
            <Button type="submit" size="sm" variant="outline" disabled={!typed || typed > 1440}>
              {typed && typed <= 1440 ? formatDurationKo(typed) : '적용'}
            </Button>
          </form>
          {task.estimateMinutes && (
            <button type="button" className={s.clear} onClick={() => pick(null)}>
              예상 시간 지우기
            </button>
          )}
        </div>
      </Popover>
    </>
  );
}

/* ───────── timer */

export function TimerButton({ task, compact = false }: { task: Task; compact?: boolean }) {
  const running = useRunning();
  const mine = running?.task.id === task.id;
  const elapsed = useElapsed(mine ? running!.entry.startedAt : null);
  const closed = task.status === 'done' || task.status === 'canceled';
  if (closed && !mine) return null;
  return mine ? (
    <button
      type="button"
      className={cx(s.timerBtn, compact && s.timerCompact)}
      data-on="true"
      onClick={() => void stopTimer(task.id)}
      aria-label={`타이머 멈추기 (${clockText(elapsed)})`}
      {...tip('타이머 멈추기', { side: 'top' })}
    >
      <Icon name="stop" size={12} strokeWidth={2.4} />
      <span className={s.clock}>{clockText(elapsed)}</span>
    </button>
  ) : (
    <button
      type="button"
      className={cx(s.timerBtn, compact && s.timerCompact)}
      onClick={() => void startTimer(task.id)}
      aria-label="타이머 시작"
      {...tip(task.status === 'todo' ? '타이머 시작 (진행 중으로 바뀌어요)' : '타이머 시작', { side: 'top' })}
    >
      <Icon name="play" size={12} strokeWidth={2.2} />
      {!compact && <span>시작</span>}
    </button>
  );
}

/** Time section of the task panel: estimate vs actual, the timer, and every entry. */
export function TimeSection({ task, readOnly }: { task: Task; readOnly: boolean }) {
  const entries = useEntries(task.id, task.actualMinutes);
  const running = useRunning();
  const runningHere = running?.task.id === task.id;
  const elapsedSec = useElapsed(runningHere ? running!.entry.startedAt : null);
  const live = task.actualMinutes + Math.floor(elapsedSec / 60);
  const est = task.estimateMinutes;
  const ratio = est ? live / est : 0;
  const add = useDisclosure();
  const addRef = useRef<HTMLButtonElement>(null);
  const [mins, setMins] = useState('');
  const typed = readMinutes(mins);
  const { today } = useApp();

  return (
    <section className={s.section} aria-label="시간">
      <div className={s.head}>
        <h3 className={s.title}>
          <Icon name="timer" size={14} />
          시간
        </h3>
        {!readOnly && <TimerButton task={task} />}
      </div>

      <div className={s.summary}>
        <div className={s.figure}>
          <span className={s.figureLabel}>실제</span>
          <span className={s.figureValue} data-over={est ? ratio > 1 : undefined}>
            {live ? formatDurationKo(live) : '0분'}
          </span>
        </div>
        <div className={s.figure}>
          <span className={s.figureLabel}>예상</span>
          <span className={s.figureValue} data-muted={!est}>
            {est ? formatDurationKo(est) : '없음'}
          </span>
        </div>
        {est ? (
          <div className={s.meter} role="img" aria-label={`예상의 ${Math.round(ratio * 100)}%`}>
            <span className={s.meterFill} data-over={ratio > 1} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
          </div>
        ) : null}
        {est && ratio > 1 && <span className={s.overNote}>예상보다 {formatDurationKo(live - est)} 더 걸렸어요</span>}
      </div>

      {!readOnly && (
        <div className={s.actions}>
          <button ref={addRef} type="button" className={s.textBtn} onClick={() => { setMins(''); add.toggle(); }} aria-expanded={add.open}>
            <Icon name="plus" size={13} />
            기록 추가
          </button>
          {(task.actualMinutes > 0 || runningHere) && (
            <button type="button" className={s.textBtn} onClick={() => setUi({ actual: { taskId: task.id } })}>
              실제 시간 고치기
            </button>
          )}
          <Popover anchor={addRef} open={add.open} onClose={add.close} width={240}>
            <form
              className={s.addForm}
              onSubmit={(e) => {
                e.preventDefault();
                if (!typed || typed > 1440) return;
                add.close();
                void logTime(task.id, typed);
              }}
            >
              <label className={s.addLabel} htmlFor={`log-${task.id}`}>
                오늘 한 시간
              </label>
              <div className={s.customRow}>
                <input
                  id={`log-${task.id}`}
                  className={ui.input}
                  value={mins}
                  onChange={(e) => setMins(e.target.value)}
                  placeholder="예: 30분, 1h"
                  autoFocus
                />
                <Button type="submit" size="sm" disabled={!typed || typed > 1440}>
                  추가
                </Button>
              </div>
            </form>
          </Popover>
        </div>
      )}

      {entries && entries.length > 0 && (
        <ul className={s.entries}>
          {entries.slice(0, 8).map((e) => (
            <li key={e.id} className={s.entry}>
              <span className={s.entryWhen}>{formatRelativeKo(localDay(e.startedAt), today)}</span>
              <span className={s.entryWho}>{e.userName ?? '예전 멤버'}</span>
              <span className={s.entrySource}>{SOURCE_KO[e.source]}</span>
              <span className={s.entryMinutes}>{e.endedAt ? formatDurationKo(e.minutes ?? 0) : '기록 중'}</span>
              {e.mine && e.endedAt && !readOnly && (
                <button type="button" className={s.entryRemove} onClick={() => void deleteEntry(e.id)} aria-label="기록 지우기" {...tip('지우기', { side: 'top' })}>
                  <Icon name="x" size={13} />
                </button>
              )}
            </li>
          ))}
          {entries.length > 8 && <li className={s.entryMore}>그 밖에 {entries.length - 8}개</li>}
        </ul>
      )}
    </section>
  );
}

function localDay(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ───────── running clock, always in view */

export function RunningPill() {
  const running = useRunning();
  const elapsed = useElapsed(running?.entry.startedAt ?? null);
  const app = useApp();
  if (!running) return null;
  const here = running.task.workspaceId === app.workspace?.id;
  return (
    <div className={s.pill} role="status" aria-label={`#${running.task.number} ${running.task.title} 기록 중`}>
      <button
        type="button"
        className={s.pillMain}
        onClick={() => here && selectTask(running.task.id)}
        disabled={!here}
        {...tip(here ? '작업 열기' : '다른 공간의 작업이에요', { side: 'bottom' })}
      >
        <span className={s.pillDot} aria-hidden="true" />
        <span className={s.pillTitle}>
          <span className={s.pillRef}>#{running.task.number}</span> {running.task.title}
        </span>
        <span className={s.clock}>{clockText(elapsed)}</span>
      </button>
      <button type="button" className={s.pillStop} onClick={() => void stopTimer(running.task.id)} aria-label="타이머 멈추기" {...tip('멈추기', { side: 'bottom' })}>
        <Icon name="stop" size={12} strokeWidth={2.4} />
      </button>
    </div>
  );
}

/* ───────── "실제로는 얼마나 걸렸나요" */

export function ActualDialog() {
  const { actual } = useUi();
  const app = useApp();
  const task = actual ? app.tasks[actual.taskId] : null;
  const [h, setH] = useState('0');
  const [m, setM] = useState('0');
  useEffect(() => {
    if (!task) return;
    setH(String(Math.floor(task.actualMinutes / 60)));
    setM(String(task.actualMinutes % 60));
  }, [task?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => setUi({ actual: null });
  const total = (Number(h) || 0) * 60 + (Number(m) || 0);
  const valid = Number.isFinite(total) && total >= 0 && total <= 6000;
  return (
    <Modal
      open={!!task}
      onClose={close}
      title="실제로 걸린 시간"
      description={task ? `#${task.number} ${task.title}` : undefined}
      width={380}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            취소
          </Button>
          <Button
            disabled={!valid}
            onClick={() => {
              if (!task) return;
              close();
              void setActual(task.id, total);
            }}
          >
            저장
          </Button>
        </>
      }
    >
      <form
        className={s.actualForm}
        onSubmit={(e) => {
          e.preventDefault();
          if (!task || !valid) return;
          close();
          void setActual(task.id, total);
        }}
      >
        <label className={s.actualField}>
          <input className={ui.input} inputMode="numeric" value={h} onChange={(e) => setH(e.target.value.replace(/\D/g, ''))} aria-label="시간" />
          <span>시간</span>
        </label>
        <label className={s.actualField}>
          <input className={ui.input} inputMode="numeric" value={m} onChange={(e) => setM(e.target.value.replace(/\D/g, ''))} aria-label="분" onKeyDown={(e) => isEnter(e) && e.currentTarget.form?.requestSubmit()} />
          <span>분</span>
        </label>
      </form>
      <p className={s.actualNote}>내 기록이 이 시간 하나로 바뀌어요. 다른 사람의 기록은 그대로예요. 이 기록이 예측을 더 정확하게 만들어요.</p>
    </Modal>
  );
}

/* ───────── on-time odds */

export function oddsTone(p: number | null | undefined): 'ok' | 'warn' | 'danger' | 'muted' {
  if (p == null) return 'muted';
  if (p >= 0.8) return 'ok';
  if (p >= 0.5) return 'warn';
  return 'danger';
}

/** "제때 72%" next to a due date, with what it rests on in the tooltip. */
export function OddsBadge({ odds, compact = false }: { odds: TaskOdds | undefined; compact?: boolean }) {
  if (!odds || odds.onTime == null) return null;
  const tone = oddsTone(odds.onTime);
  const label = compact ? percentKo(odds.onTime) : `제때 끝낼 확률 ${percentKo(odds.onTime)}`;
  const detail = odds.p85 ? `85% 확률로 ${odds.p85} 안에 끝나요` : '6개월 안에 끝나기 어려워요';
  return (
    <span className={s.odds} data-tone={tone} {...tip(detail, { side: 'top' })}>
      {label}
    </span>
  );
}

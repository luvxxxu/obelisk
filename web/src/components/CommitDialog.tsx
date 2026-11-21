'use client';

import {
  ESTIMATE_PRESETS,
  formatDurationKo,
  formatRelativeKo,
  formatShortKo,
  percentKo,
  weekday,
  type CommitOption,
  type CommitResponse,
  type ISODate,
} from '@obelisk/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '@/lib/format';
import { requestDateChange } from '@/lib/reschedule';
import { canWriteProject, createTask, selectTask, useApp } from '@/lib/store';
import { checkCommit } from '@/lib/timeplan';
import { setUi, useUi, type CommitDialogState } from '@/lib/ui-state';
import { Icon } from './Icon';
import { Button, Modal, Spinner, ui } from './primitives';
import s from './CommitDialog.module.css';

/**
 * "약속하기 전에": when could this be promised? The safe date (likely, and nothing else gets
 * riskier), the earliest date (and what it pushes), the natural finish, and any day to check.
 */
export function CommitDialog() {
  const { commit } = useUi();
  if (!commit) return null;
  return <CommitDialogInner key={JSON.stringify(commit)} init={commit} />;
}

function CommitDialogInner({ init }: { init: CommitDialogState }) {
  const app = useApp();
  const task = init.taskId ? app.tasks[init.taskId] : null;
  const [title, setTitle] = useState(init.title ?? '');
  const [estimate, setEstimate] = useState<number | null>(init.estimateMinutes ?? task?.estimateMinutes ?? null);
  const [projectId, setProjectId] = useState<string | null>(init.projectId ?? task?.projectId ?? null);
  const [picked, setPicked] = useState<ISODate | null>(init.date ?? null);
  const [res, setRes] = useState<CommitResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const close = () => setUi({ commit: null });

  // Recalculate (debounced) when what is being promised changes.
  const seq = useRef(0);
  useEffect(() => {
    if (!task && !title.trim() && estimate == null) {
      setRes(null);
      return;
    }
    const n = ++seq.current;
    setLoading(true);
    const id = window.setTimeout(async () => {
      const r = await checkCommit({
        ...(task ? { taskId: task.id } : { title: title.trim() || undefined, projectId }),
        estimateMinutes: estimate,
        ...(picked ? { date: picked } : {}),
      });
      if (n !== seq.current) return;
      setRes(r);
      setLoading(false);
    }, 350);
    return () => window.clearTimeout(id);
  }, [task?.id, title, estimate, projectId, picked]); // eslint-disable-line react-hooks/exhaustive-deps

  const report = res?.report;
  const choice: ISODate | null = picked ?? report?.safe?.date ?? report?.earliest?.date ?? null;
  const chosen: CommitOption | null = report
    ? choice === report.proposed?.date
      ? report.proposed
      : choice === report.safe?.date
        ? report.safe
        : choice === report.earliest?.date
          ? report.earliest
          : null
    : null;
  const projects = useMemo(() => app.projects.filter((p) => !p.archivedAt && canWriteProject(p.id, app)), [app]);

  const confirm = async () => {
    if (!choice) return;
    setBusy(true);
    if (task) {
      close();
      requestDateChange(task.id, { startDate: task.startDate && task.startDate > choice ? choice : task.startDate, dueDate: choice });
      return;
    }
    const t = await createTask({ title: title.trim() || '새 작업', dueDate: choice, estimateMinutes: estimate, projectId });
    setBusy(false);
    if (t) {
      close();
      selectTask(t.id);
    }
  };

  return (
    <Modal
      open
      onClose={close}
      width={600}
      title="약속하기 전에"
      description={task ? `#${task.number} ${task.title}` : '언제까지 된다고 말할 수 있을지, 지금 일정과 내 기록으로 계산해요.'}
      footer={
        <>
          <span className={s.footNote}>
            {res && (res.estimated ? `${formatDurationKo(res.minutes)} 걸리는 일로 계산했어요` : `예상 시간이 없어 평소처럼 ${formatDurationKo(res.minutes)}로 계산했어요`)}
          </span>
          <Button variant="ghost" onClick={close}>
            닫기
          </Button>
          <Button onClick={() => void confirm()} disabled={!choice || busy || (!task && !title.trim())}>
            {choice ? `${formatShortKo(choice)}${task ? '로 마감 정하기' : '까지로 추가'}` : '날짜 고르기'}
          </Button>
        </>
      }
    >
      <div className={s.body}>
        {!task && (
          <div className={s.inputs}>
            <input
              className={cx(ui.input, s.titleInput)}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="무엇을 약속하나요? (예: 견적서 보내기)"
              aria-label="할 일"
              autoFocus
            />
            <select className={cx(ui.input, s.project)} value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value || null)} aria-label="프로젝트">
              <option value="">인박스</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className={s.estimates} role="group" aria-label="예상 시간">
          <span className={s.estimateLabel}>예상 시간</span>
          {ESTIMATE_PRESETS.map((m) => (
            <button key={m} type="button" className={s.chip} data-on={estimate === m} onClick={() => setEstimate(estimate === m ? null : m)}>
              {formatDurationKo(m)}
            </button>
          ))}
        </div>

        {!report ? (
          <div className={s.placeholder}>{loading ? <Spinner label="계산하는 중" /> : '할 일을 적으면 가능한 날짜를 계산해요.'}</div>
        ) : (
          <>
            <div className={s.options} data-loading={loading || undefined}>
              <Option
                label="안전한 날"
                option={report.safe}
                today={res!.today}
                active={choice === report.safe?.date}
                onPick={() => setPicked(report.safe?.date ?? null)}
                note={report.safe ? '다른 일정에 영향 없음' : '6개월 안에서 찾지 못했어요'}
              />
              {report.earliest && report.earliest.date !== report.safe?.date && (
                <Option
                  label="가장 빠른 날"
                  option={report.earliest}
                  today={res!.today}
                  active={choice === report.earliest.date}
                  onPick={() => setPicked(report.earliest!.date)}
                  note={report.earliest.harmed.length ? `다른 작업 ${report.earliest.harmed.length}개가 위험해져요` : '다른 일정에 영향 없음'}
                  tone={report.earliest.harmed.length ? 'warn' : undefined}
                />
              )}
              <div className={s.natural}>
                <span className={s.optionLabel}>순서대로 하면</span>
                <span className={s.naturalLine}>50% {report.natural.p50 ? formatRelativeKo(report.natural.p50, res!.today) : '–'}</span>
                <span className={s.naturalLine}>85% {report.natural.p85 ? formatRelativeKo(report.natural.p85, res!.today) : '6개월 뒤 이후'}</span>
              </div>
            </div>

            <div className={s.strip} role="listbox" aria-label="날짜별 확률">
              {report.days.map((d) => (
                <button
                  key={d.date}
                  type="button"
                  role="option"
                  aria-selected={choice === d.date}
                  className={s.day}
                  data-on={choice === d.date}
                  data-weekend={weekday(d.date) === 0 || weekday(d.date) === 6 || undefined}
                  onClick={() => setPicked(d.date)}
                  aria-label={`${formatShortKo(d.date)} ${percentKo(d.probability)}${d.harmed ? `, 다른 작업 ${d.harmed}개 위험` : ''}`}
                >
                  <span className={s.bar}>
                    <span
                      className={s.barFill}
                      data-tone={d.probability >= report.confidence ? (d.harmed ? 'warn' : 'ok') : 'muted'}
                      style={{ height: `${Math.max(4, d.probability * 100)}%` }}
                    />
                  </span>
                  <span className={s.dayPct}>{Math.round(d.probability * 100)}</span>
                  <span className={s.dayLabel}>{formatShortKo(d.date).replace(/ \(.\)$/, '')}</span>
                  {d.harmed > 0 && <span className={s.harmDot} aria-hidden="true" />}
                </button>
              ))}
            </div>

            {chosen && (
              <div className={s.detail}>
                <div className={s.detailHead}>
                  <strong>{formatRelativeKo(chosen.date, res!.today)}</strong>
                  <span>까지 끝낼 확률 {percentKo(chosen.probability)}</span>
                </div>
                {chosen.harmed.length ? (
                  <ul className={s.harms}>
                    {chosen.harmed.slice(0, 6).map((h) => {
                      const t = app.tasks[h.taskId];
                      return (
                        <li key={h.taskId + h.kind} className={s.harm}>
                          <Icon name={h.kind === 'conflict' ? 'lock' : 'alert'} size={13} />
                          <span className={s.harmTitle}>
                            <span className={s.harmRef}>#{t?.number ?? '?'}</span> {t?.title ?? '볼 수 없는 작업'}
                          </span>
                          <span className={s.harmDelta}>
                            {h.kind === 'conflict' ? '충돌 위험' : '제때'} {percentKo(h.before)} → {percentKo(h.after)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className={s.detailNote}>이 날로 정해도 다른 작업이 더 위험해지지 않아요.</p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function Option({
  label,
  option,
  today,
  active,
  onPick,
  note,
  tone,
}: {
  label: string;
  option: CommitOption | null;
  today: ISODate;
  active: boolean;
  onPick: () => void;
  note: string;
  tone?: 'warn';
}) {
  return (
    <button type="button" className={s.option} data-on={active} disabled={!option} onClick={onPick}>
      <span className={s.optionLabel}>{label}</span>
      <span className={s.optionDate}>{option ? formatRelativeKo(option.date, today) : '없음'}</span>
      {option && <span className={s.optionPct}>{percentKo(option.probability)}</span>}
      <span className={s.optionNote} data-tone={tone}>
        {note}
      </span>
    </button>
  );
}

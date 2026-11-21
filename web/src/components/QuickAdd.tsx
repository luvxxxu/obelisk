'use client';

import {
  formatDurationKo,
  formatRelativeKo,
  formatShortKo,
  formatTimeKo,
  formatTimeRangeKo,
  matchProject,
  parseQuickAdd,
  PRIORITY_LABEL_KO,
  JEV_CONFIDENT,
  percentKo,
  type CommitResponse,
  type ISODate,
  type Priority,
  type QuickAddKind,
  type TriageSuggestion,
} from '@obelisk/core';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useClock } from '@/lib/clock';
import { cx } from '@/lib/format';
import { fetchTriage, useJev } from '@/lib/jev';
import { canWriteProject, createProject, createTask, useApp } from '@/lib/store';
import { peekCommit } from '@/lib/timeplan';
import { toast } from '@/lib/toast';
import { setUi } from '@/lib/ui-state';
import { Icon } from './Icon';
import { oddsTone } from './TimeTracking';
import { tip, ui, type BadgeTone } from './primitives';
import s from './QuickAdd.module.css';

type JevKind = 'project' | 'priority' | 'fixed';

export interface QuickAddHandle {
  focus: () => void;
}

/** Syntax cheat-sheet shared by the modal (always shown) and the inline "?" toggle. */
function SyntaxHelp({ onClose }: { onClose?: () => void }) {
  return (
    <div className={s.help}>
      {onClose && (
        <div className={s.helpHead}>
          <span>이렇게 적으면 알아서 정리돼요</span>
          <button
            type="button"
            className={ui.iconBtn}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClose}
            aria-label="도움말 닫기"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      <dl className={s.helpList}>
        <div className={s.helpRow}>
          <dt>
            <Icon name="calendar" size={13} /> 날짜
          </dt>
          <dd>
            <code>오늘</code> <code>내일</code> <code>금요일</code> <code>다음 주 수요일</code> <code>11/20</code> <code>3일 후</code>{' '}
            <code>11/20~11/22</code>
          </dd>
        </div>
        <div className={s.helpRow}>
          <dt>
            <Icon name="clock" size={13} /> 시각
          </dt>
          <dd>
            <code>오후 3시</code> <code>15:30</code> <code>3시 반</code> <code>10시~11시</code>{' '}
            <span className={s.helpNote}>날짜 없이 쓰면 다가오는 그 시각</span>
          </dd>
        </div>
        <div className={s.helpRow}>
          <dt>
            <Icon name="hash" size={13} /> 프로젝트
          </dt>
          <dd>
            <code>#업무</code> <span className={s.helpNote}>없는 이름이면 새로 만들어요</span>
          </dd>
        </div>
        <div className={s.helpRow}>
          <dt>
            <Icon name="flag" size={13} /> 우선순위
          </dt>
          <dd>
            <code>!높음</code> <code>!보통</code> <code>!낮음</code>
          </dd>
        </div>
        <div className={s.helpRow}>
          <dt>
            <Icon name="timer" size={13} /> 예상 시간
          </dt>
          <dd>
            <code>~30분</code> <code>~1h30m</code> <code>~2시간</code> <span className={s.helpNote}>하루 계획과 완료 확률에 써요</span>
          </dd>
        </div>
        <div className={s.helpRow}>
          <dt>
            <Icon name="pin" size={13} /> 고정 일정
          </dt>
          <dd>
            <code>@고정</code> <span className={s.helpNote}>움직이지 않는 약속·마감</span>
          </dd>
        </div>
      </dl>
      <div className={s.helpFoot}>
        예: <span className={s.helpExample}>기획서 초안 내일 오후 3시 #업무 !높음</span> · 입력창 아래에 뜬 항목을 누르면 인식을 취소해요
      </div>
    </div>
  );
}

/**
 * Natural-language task capture. Type "보고서 내일 #업무 !높음" and the chips
 * below show exactly what will be understood; click a chip to keep it as text.
 */
export const QuickAdd = forwardRef<
  QuickAddHandle,
  {
    projectId?: string | null;
    defaultDueDate?: ISODate | null;
    /** Assign new tasks to this member (e.g. yourself on 내 작업). */
    defaultAssigneeId?: string | null;
    placeholder?: string;
    autoFocus?: boolean;
    onCreated?: () => void;
    variant?: 'inline' | 'modal';
  }
>(function QuickAdd({ projectId, defaultDueDate, defaultAssigneeId, placeholder, autoFocus, onCreated, variant = 'inline' }, ref) {
  const { today, projects } = useApp();
  const [value, setValue] = useState('');
  const [disabled, setDisabled] = useState<QuickAddKind[]>([]);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }));

  // Read once per keystroke: "3시" alone means the next 3 o'clock, so it needs the time now.
  const clock = useClock(false);
  const nowMinutes = clock.date === today ? clock.minutes : null;
  const parsed = useMemo(() => parseQuickAdd(value, today, { disabled, nowMinutes }), [value, today, disabled, nowMinutes]);
  const activeProjects = projects.filter((p) => !p.archivedAt);
  const matched = parsed.projectName ? matchProject(activeProjects, parsed.projectName) : null;

  // ── Jev triage: suggest project / priority / fixed for what the text leaves open.
  const jev = useJev();
  const due = parsed.dueDate ?? (parsed.startDate ? null : (defaultDueDate ?? null));
  const projectChosen = projectId !== undefined || !!parsed.projectName;
  const triageKey = JSON.stringify([parsed.title.trim(), parsed.startDate, due, projectChosen]);
  const [triage, setTriage] = useState<{ key: string; s: TriageSuggestion } | null>(null);
  const [accepted, setAccepted] = useState<Set<JevKind>>(new Set());
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    const title = parsed.title.trim();
    if (!jev.connected || title.length < 2) {
      setAsking(false);
      return;
    }
    if (triage?.key === triageKey) return;
    const ctrl = new AbortController();
    const timer = window.setTimeout(async () => {
      setAsking(true);
      try {
        const sg = await fetchTriage(
          {
            title,
            startDate: parsed.startDate,
            dueDate: due,
            ...(projectChosen ? { projectId: projectId ?? matched?.id ?? null } : {}),
          },
          ctrl.signal,
        );
        if (!sg || ctrl.signal.aborted) return;
        setTriage({ key: triageKey, s: sg });
        // Auto-apply (opt-in) pre-accepts what Jev is sure about; otherwise the user picks.
        const pre = new Set<JevKind>();
        if (jev.autoApply) {
          if (sg.project?.id && sg.project.confidence >= JEV_CONFIDENT) pre.add('project');
          if (sg.priority.value > 0 && sg.priority.confidence >= JEV_CONFIDENT) pre.add('priority');
          if (sg.fixed.value && sg.fixed.probability >= 0.85) pre.add('fixed');
        }
        setAccepted(pre);
      } catch {
        // Triage is a hint: a failed call just shows nothing.
      } finally {
        if (!ctrl.signal.aborted) setAsking(false);
      }
    }, 450);
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triageKey, jev.connected, jev.autoApply]);

  const live = triage?.key === triageKey && parsed.title.trim().length >= 2 ? triage.s : null;
  // A coin-flip project guess is noise: only offer one Jev is at least fairly sure about.
  const jevProject =
    live?.project?.id && !projectChosen && live.project.confidence >= 0.5
      ? activeProjects.find((p) => p.id === live.project!.id && canWriteProject(p.id))
      : undefined;
  const offers: { kind: JevKind; text: string; confidence: number; color?: string }[] = [];
  if (live && jevProject) offers.push({ kind: 'project', text: jevProject.name, confidence: live.project!.confidence, color: `var(--c-${jevProject.color})` });
  if (live && parsed.priority === null && live.priority.value > 0)
    offers.push({ kind: 'priority', text: `우선순위 ${PRIORITY_LABEL_KO[live.priority.value]}`, confidence: live.priority.confidence });
  if (live && !parsed.fixed && live.fixed.value) offers.push({ kind: 'fixed', text: '고정 일정', confidence: live.fixed.probability });
  const toggleOffer = (k: JevKind) =>
    setAccepted((cur) => {
      const n = new Set(cur);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const take = (k: JevKind) => accepted.has(k) && offers.some((o) => o.kind === k);

  const submit = async () => {
    const title = parsed.title.trim();
    if (!title || busy) return;
    setBusy(true);
    let pid = projectId ?? null;
    if (matched && !canWriteProject(matched.id)) {
      toast.error(`‘${matched.name}’ 프로젝트는 보기 전용이라 작업을 추가할 수 없어요`);
      return;
    }
    if (parsed.projectName) {
      setBusy(true);
      pid = matched?.id ?? (await createProject({ name: parsed.projectName }))?.id ?? pid;
    }
    if (take('project') && jevProject) pid = jevProject.id;
    const priority = (parsed.priority ?? (take('priority') && live ? live.priority.value : 0)) as Priority;
    const fixed = parsed.fixed || take('fixed');
    const created = await createTask({
      title,
      projectId: pid,
      startDate: parsed.startDate,
      startTime: parsed.startTime,
      dueDate: due,
      dueTime: parsed.dueDate ? parsed.dueTime : null,
      priority,
      fixed: fixed || undefined,
      ...(parsed.estimateMinutes ? { estimateMinutes: parsed.estimateMinutes } : {}),
      ...(defaultAssigneeId ? { assigneeId: defaultAssigneeId } : {}),
    });
    setBusy(false);
    if (created) {
      setValue('');
      setDisabled([]);
      setTriage(null);
      setAccepted(new Set());
      onCreated?.();
    }
  };

  // "목요일" alone is ambiguous: always pair relative words with the actual date.
  const dateText = (d: ISODate) => {
    const rel = formatRelativeKo(d, today);
    return rel.includes('월') ? rel : `${rel} · ${formatShortKo(d).replace(/ \(.\)$/, '')}`;
  };
  const chips = parsed.tokens.map((t) => {
    if (t.kind === 'date') {
      const [a, b] = t.value.split('~');
      return {
        kind: t.kind,
        icon: 'calendar' as const,
        text: b ? `${dateText(a!)} → ${dateText(b)}` : dateText(a!),
        tone: 'info' as BadgeTone,
      };
    }
    if (t.kind === 'time') {
      const [a, b] = t.value.split('~');
      const time = b ? formatTimeRangeKo(a!, b) : formatTimeKo(a!);
      // A time typed without a date lands on today or tomorrow: say which.
      const day = !parsed.tokens.some((x) => x.kind === 'date') && parsed.dueDate ? `${formatRelativeKo(parsed.dueDate, today)} ` : '';
      return { kind: t.kind, icon: 'clock' as const, text: `${day}${time}`, tone: 'info' as BadgeTone };
    }
    if (t.kind === 'project')
      return {
        kind: t.kind,
        icon: 'hash' as const,
        text: matched ? matched.name : `새 프로젝트 “${t.value}”`,
        tone: 'outline' as BadgeTone,
      };
    if (t.kind === 'priority') {
      const p = Number(t.value) as Priority;
      return {
        kind: t.kind,
        icon: 'flag' as const,
        text: `우선순위 ${PRIORITY_LABEL_KO[p]}`,
        tone: (p === 3 ? 'danger' : p === 2 ? 'warn' : 'secondary') as BadgeTone,
      };
    }
    if (t.kind === 'estimate') return { kind: t.kind, icon: 'timer' as const, text: `${formatDurationKo(Number(t.value))} 걸림`, tone: 'secondary' as BadgeTone };
    return { kind: t.kind, icon: 'pin' as const, text: '고정 일정', tone: 'outline' as BadgeTone };
  });

  // ── Can this date be kept? Asked quietly once the line has a title and a due date.
  const oddsTarget = parsed.title.trim().length >= 2 && due && !parsed.fixed && !(parsed.startTime && parsed.dueTime) ? due : null;
  const oddsKey = oddsTarget ? JSON.stringify([parsed.title.trim(), parsed.estimateMinutes, oddsTarget, projectId ?? matched?.id ?? null]) : '';
  const [oddsHint, setOddsHint] = useState<{ key: string; r: CommitResponse } | null>(null);
  useEffect(() => {
    if (!oddsKey) return;
    if (oddsHint?.key === oddsKey) return;
    let live = true;
    const timer = window.setTimeout(async () => {
      const r = await peekCommit({ title: parsed.title.trim(), estimateMinutes: parsed.estimateMinutes, projectId: projectId ?? matched?.id ?? null, date: oddsTarget! });
      if (live && r) setOddsHint({ key: oddsKey, r });
    }, 650);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oddsKey]);
  const oddsNow = oddsHint?.key === oddsKey ? oddsHint.r : null;
  const proposedOdds = oddsNow?.report.proposed ?? null;
  const openCommit = () =>
    setUi({
      commit: { title: parsed.title.trim(), estimateMinutes: parsed.estimateMinutes, projectId: projectId ?? matched?.id ?? null, date: oddsTarget },
      quickAdd: false,
    });
  const showDefaultDate = !parsed.dueDate && !parsed.startDate && defaultDueDate && value.trim();
  const typing = !!value.trim();
  const isModal = variant === 'modal';

  return (
    <div className={cx(s.wrap, isModal && s.modal, (focused || value) && s.active)}>
      <div
        className={s.field}
        onMouseDown={(e) => {
          // Clicking the padding / icon area focuses the text field.
          if (!(e.target as HTMLElement).closest('button, input')) {
            e.preventDefault();
            input.current?.focus();
          }
        }}
      >
        <span className={s.plus} aria-hidden="true">
          {busy ? <span className={ui.spinner} /> : <Icon name="plus" size={16} strokeWidth={2} />}
        </span>
        <input
          ref={input}
          className={s.input}
          value={value}
          autoFocus={autoFocus}
          placeholder={placeholder ?? '할 일 추가 (예: 기획서 초안 내일 #업무 !높음)'}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
            if (e.key === 'Escape') {
              if (value) setValue('');
              else input.current?.blur();
            }
            // Tab takes every Jev suggestion at once (and stays in the field).
            if (e.key === 'Tab' && !e.shiftKey && offers.some((o) => !accepted.has(o.kind))) {
              e.preventDefault();
              setAccepted(new Set(offers.map((o) => o.kind)));
            }
          }}
          aria-label="새 작업"
        />
        {typing ? (
          <button
            type="button"
            className={s.submit}
            disabled={busy || !parsed.title.trim()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void submit()}
            aria-label="추가"
            {...tip(parsed.title.trim() ? '추가' : '제목을 함께 적어주세요', { side: 'top', kbd: parsed.title.trim() ? '↵' : undefined })}
          >
            <Icon name="arrowUp" size={16} strokeWidth={2.25} />
          </button>
        ) : (
          !isModal && (
            <button
              type="button"
              className={s.helpBtn}
              data-active={helpOpen}
              aria-expanded={helpOpen}
              aria-label="입력 도움말"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setHelpOpen((o) => !o);
                input.current?.focus();
              }}
              {...tip(helpOpen ? '도움말 닫기' : '날짜, #프로젝트, !우선순위를 한 줄에 적을 수 있어요', { side: 'top' })}
            >
              <span className={s.helpGlyph} aria-hidden="true">
                ?
              </span>
              <span className={s.helpLabel}>입력 도움말</span>
            </button>
          )
        )}
      </div>
      {(chips.length > 0 || showDefaultDate || proposedOdds) && (
        <div className={s.chips}>
          {chips.map((c, i) => (
            <button
              key={`${c.kind}-${i}`}
              type="button"
              className={cx(ui.badge, s.chip)}
              data-kind={c.kind}
              data-tone={c.tone}
              aria-label={`${c.text} 인식 취소`}
              {...tip('누르면 인식을 취소하고 제목에 그대로 둬요', { side: 'bottom' })}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setDisabled((d) => [...d, c.kind])}
            >
              {c.kind === 'project' && matched ? (
                <span className={ui.dot} style={{ background: `var(--c-${matched.color})` }} />
              ) : (
                <Icon name={c.icon} size={12} />
              )}
              {c.text}
              <Icon name="x" size={12} className={s.chipX} />
            </button>
          ))}
          {showDefaultDate && (
            <span className={cx(ui.badge, s.chip)} data-kind="default" data-tone="outline" {...tip('날짜를 적지 않으면 이 날짜로 들어가요', { side: 'bottom' })}>
              <Icon name="calendar" size={12} />
              {formatRelativeKo(defaultDueDate!, today)}
              <span className={s.chipNote}>기본</span>
            </span>
          )}
          {proposedOdds && (
            <button
              type="button"
              className={cx(ui.badge, s.chip, s.oddsChip)}
              data-odds={oddsTone(proposedOdds.probability)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={openCommit}
              {...tip(
                proposedOdds.harmed.length
                  ? `다른 작업 ${proposedOdds.harmed.length}개가 위험해져요 · 눌러서 가능한 날짜 보기`
                  : `${oddsNow!.estimated ? '' : '예상 시간이 없어 평소 길이로 계산 · '}눌러서 가능한 날짜 보기`,
                { side: 'bottom' },
              )}
            >
              <Icon name="target" size={12} />
              제때 {percentKo(proposedOdds.probability)}
              {proposedOdds.harmed.length > 0 && <span className={s.chipNote}>밀리는 일 {proposedOdds.harmed.length}</span>}
            </button>
          )}
        </div>
      )}
      {(offers.length > 0 || (asking && !live && jev.connected)) && typing && (
        <div className={s.jevRow} aria-live="polite">
          <span className={s.jevLabel} data-busy={asking || undefined}>
            {asking ? <span className={cx(ui.spinner, s.jevSpin)} aria-hidden="true" /> : <Icon name="scale" size={13} />}
            Jev
          </span>
          {offers.map((o) => {
            const on = accepted.has(o.kind);
            return (
              <button
                key={o.kind}
                type="button"
                className={cx(ui.badge, s.chip, s.jevChip)}
                data-on={on || undefined}
                aria-pressed={on}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => toggleOffer(o.kind)}
                {...tip(on ? '누르면 제안을 빼요' : `누르면 적용해요 · 확신 ${Math.round(o.confidence * 100)}%`, { side: 'bottom' })}
              >
                {o.color ? <span className={ui.dot} style={{ background: o.color }} /> : <Icon name={o.kind === 'fixed' ? 'pin' : 'flag'} size={12} />}
                {o.text}
                {on ? <Icon name="check" size={12} strokeWidth={2.6} /> : <Icon name="plus" size={12} />}
              </button>
            );
          })}
          {offers.some((o) => !accepted.has(o.kind)) && (
            <span className={s.jevHint}>
              <kbd>Tab</kbd> 모두 적용
            </span>
          )}
        </div>
      )}
      {(isModal || helpOpen) && <SyntaxHelp onClose={isModal ? undefined : () => setHelpOpen(false)} />}
    </div>
  );
});

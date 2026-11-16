'use client';

import {
  formatRelativeKo,
  formatShortKo,
  matchProject,
  parseQuickAdd,
  PRIORITY_LABEL_KO,
  type ISODate,
  type Priority,
  type QuickAddKind,
} from '@obelisk/core';
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { cx } from '@/lib/format';
import { canWriteProject, createProject, createTask, useApp } from '@/lib/store';
import { toast } from '@/lib/toast';
import { Icon } from './Icon';
import { tip, ui, type BadgeTone } from './primitives';
import s from './QuickAdd.module.css';

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
            <Icon name="pin" size={13} /> 고정 일정
          </dt>
          <dd>
            <code>@고정</code> <span className={s.helpNote}>움직이지 않는 약속·마감</span>
          </dd>
        </div>
      </dl>
      <div className={s.helpFoot}>
        예: <span className={s.helpExample}>기획서 초안 내일 #업무 !높음</span> · 입력창 아래에 뜬 항목을 누르면 인식을 취소해요
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

  const parsed = useMemo(() => parseQuickAdd(value, today, { disabled }), [value, today, disabled]);
  const activeProjects = projects.filter((p) => !p.archivedAt);
  const matched = parsed.projectName ? matchProject(activeProjects, parsed.projectName) : null;

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
    const due = parsed.dueDate ?? (parsed.startDate ? null : (defaultDueDate ?? null));
    const created = await createTask({
      title,
      projectId: pid,
      startDate: parsed.startDate,
      dueDate: due,
      priority: (parsed.priority ?? 0) as Priority,
      fixed: parsed.fixed || undefined,
      ...(defaultAssigneeId ? { assigneeId: defaultAssigneeId } : {}),
    });
    setBusy(false);
    if (created) {
      setValue('');
      setDisabled([]);
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
    return { kind: t.kind, icon: 'pin' as const, text: '고정 일정', tone: 'outline' as BadgeTone };
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
          placeholder={placeholder ?? '할 일 추가 — 예: 기획서 초안 내일 #업무 !높음'}
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
            {...tip(parsed.title.trim() ? null : '제목을 함께 적어주세요', { side: 'top' })}
          >
            <span className={s.submitLabel}>추가</span>
            <kbd aria-hidden="true">↵</kbd>
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
      {(chips.length > 0 || showDefaultDate) && (
        <div className={s.chips}>
          {chips.map((c, i) => (
            <button
              key={`${c.kind}-${i}`}
              type="button"
              className={cx(ui.badge, s.chip)}
              data-kind={c.kind}
              data-tone={c.tone}
              aria-label={`${c.text} — 인식 취소`}
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
        </div>
      )}
      {(isModal || helpOpen) && <SyntaxHelp onClose={isModal ? undefined : () => setHelpOpen(false)} />}
    </div>
  );
});

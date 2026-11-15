'use client';

import { addDays, compareTasks, formatRelativeKo, formatShortKo, selectView, type Task } from '@obelisk/core';
import { useMemo } from 'react';
import { Icon } from '@/components/Icon';
import { buttonClass, ui } from '@/components/primitives';
import { QuickAdd } from '@/components/QuickAdd';
import { TaskRow } from '@/components/TaskRow';
import { Timeline } from '@/components/Timeline';
import { EmptyState, Page, ViewHeader } from '@/components/View';
import { usePref, useTasks } from '@/lib/hooks';
import { useApp } from '@/lib/store';
import { setUi } from '@/lib/ui-state';
import s from '../views.module.css';

export default function UpcomingPage() {
  const { today } = useApp();
  const tasks = useTasks();
  const [mode, setMode] = usePref<'list' | 'timeline'>('upcoming-mode', 'list');

  const { days, later, timelineTasks } = useMemo(() => {
    const upcoming = selectView(tasks, 'upcoming', today);
    const byDay = new Map<string, Task[]>();
    const laterMap = new Map<string, Task[]>();
    const horizon = addDays(today, 14);
    for (const t of upcoming) {
      const d = (t.dueDate ?? t.startDate)!;
      if (d <= horizon) {
        const l = byDay.get(d) ?? [];
        l.push(t);
        byDay.set(d, l);
      } else {
        const key = d.slice(0, 7);
        const l = laterMap.get(key) ?? [];
        l.push(t);
        laterMap.set(key, l);
      }
    }
    const days = Array.from({ length: 14 }, (_, i) => addDays(today, i + 1)).map((d) => ({
      date: d,
      tasks: (byDay.get(d) ?? []).sort(compareTasks),
    }));
    const later = [...laterMap.entries()].sort().map(([m, l]) => ({ month: m, tasks: l.sort(compareTasks) }));
    const active = tasks.filter((t) => (t.status === 'todo' || t.status === 'doing') && (t.dueDate || t.startDate));
    return { days, later, timelineTasks: active };
  }, [tasks, today]);

  const toggle = (
    <div className={ui.segmented} data-size="sm" role="group" aria-label="보기 방식">
      <button className={ui.segment} aria-pressed={mode === 'list'} onClick={() => setMode('list')}>
        <Icon name="list" size={14} /> 리스트
      </button>
      <button className={ui.segment} aria-pressed={mode === 'timeline'} onClick={() => setMode('timeline')}>
        <Icon name="timeline" size={14} /> 타임라인
      </button>
    </div>
  );

  if (mode === 'timeline') {
    return (
      <Page wide>
        <ViewHeader
          icon="calendar"
          title="예정"
          description="막대를 끌어 일정을 옮겨보세요. 밀리는 작업이 실시간으로 표시돼요."
          actions={toggle}
        />
        <Timeline tasks={timelineTasks} />
      </Page>
    );
  }

  const nothing = days.every((d) => !d.tasks.length) && later.length === 0;
  return (
    <Page>
      <ViewHeader
        icon="calendar"
        title="예정"
        description="앞으로 2주는 날짜별로, 그 이후는 월별로 보여드려요."
        actions={toggle}
      />
      <QuickAdd defaultDueDate={addDays(today, 1)} placeholder="예정된 할 일 추가 — 예: 치과 예약 다음 주 화요일" />
      {nothing && (
        <EmptyState
          icon="calendar"
          title="예정된 작업이 없어요"
          body="날짜를 넣어 작업을 추가하면 여기에서 한눈에 볼 수 있어요. 예: “보고서 금요일”"
          action={
            <button type="button" className={buttonClass({ variant: 'outline', size: 'sm' })} onClick={() => setUi({ quickAdd: true })}>
              <Icon name="plus" size={15} />
              새 작업
              <kbd>N</kbd>
            </button>
          }
        />
      )}
      {!nothing && (
        <div className={s.agenda}>
          {days.map((d, i) => {
            if (!d.tasks.length && i >= 7) return null;
            const rel = formatRelativeKo(d.date, today).replace(/ \(.\)$/, '');
            const short = formatShortKo(d.date);
            // "내일 11/15 (토)" · "화요일 11/18" · "11월 22일 토요일" — never say the same thing twice.
            const sub = /\d월/.test(rel) ? `${short.slice(-2, -1)}요일` : rel.endsWith('요일') ? short.replace(/ \(.\)$/, '') : short;
            const empty = d.tasks.length === 0;
            return (
              <section key={d.date} className={s.day} data-empty={empty} aria-label={`${rel} ${short}`}>
                <div className={s.dayHeader}>
                  <span className={s.dayRel}>{rel}</span>
                  <span className={s.dayDate}>{sub}</span>
                  {empty ? <span className={s.dayNone}>일정 없음</span> : <span className={s.dayCount}>{d.tasks.length}</span>}
                </div>
                {!empty && (
                  <div className={s.dayRows}>
                    {d.tasks.map((t) => (
                      <TaskRow key={t.id} task={t} showDate={false} />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
          {later.length > 0 && <div className={s.laterLabel}>2주 이후</div>}
          {later.map((g) => {
            const label = `${g.month.slice(0, 4) !== today.slice(0, 4) ? `${g.month.slice(0, 4)}년 ` : ''}${Number(g.month.slice(5))}월`;
            return (
              <section key={g.month} className={s.day} aria-label={label}>
                <div className={s.dayHeader}>
                  <span className={s.dayRel}>{label}</span>
                  <span className={s.dayCount}>{g.tasks.length}</span>
                </div>
                <div className={s.dayRows}>
                  {g.tasks.map((t) => (
                    <TaskRow key={t.id} task={t} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </Page>
  );
}

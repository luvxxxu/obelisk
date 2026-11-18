'use client';

import { formatRelativeKo, OVERVIEW_DAYS, OVERVIEW_FIXED_DAYS, overviewSections, weekday, type ISODate, type WorkspaceSummary } from '@obelisk/core';
import { memo, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '@/components/Icon';
import { Spinner, tip, ui } from '@/components/primitives';
import { Checkbox } from '@/components/TaskRow';
import r from '@/components/TaskRow.module.css';
import { EmptyState, Page, ViewHeader } from '@/components/View';
import v from '@/components/View.module.css';
import { WorkspaceMark, workspaceLabel } from '@/components/WorkspaceSwitcher';
import { cx, longDateKo, overdueLabel, spanLabel } from '@/lib/format';
import { completeOverviewItem, openOverviewItem, spaceHues, useOverview, type OverviewItem, type SpaceHue } from '@/lib/overview';
import { useApp } from '@/lib/store';
import s from './overview.module.css';

const HIDDEN_KEY = 'obelisk:overview-hidden';
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
/** A day with at least this many tasks is called out under the week strip. */
const BUSY_DAY = 3;

const hueStyle = (hue: SpaceHue): CSSProperties => ({ '--space': `var(--c-${hue})`, '--space-text': `var(--c-${hue}-text)` }) as CSSProperties;

/** Spaces switched off on this page, remembered per browser. */
function useHiddenSpaces(): [Set<string>, (id: string) => void] {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const raw = localStorage.getItem(HIDDEN_KEY);
      if (raw) setHidden(new Set(JSON.parse(raw) as string[]));
    } catch {}
  }, []);
  const toggle = (id: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  return [hidden, toggle];
}

/**
 * 모아보기 — the user's own work in every space at once: all of the personal space and what is
 * assigned to them in each organization. Overdue · today · the next 7 days (with how the load spreads
 * across spaces) · fixed commitments within 30 days. Ticking works in place; opening a task of another
 * space switches to it with the task selected.
 */
export default function OverviewPage() {
  const { user, selectedTaskId } = useApp();
  const ov = useOverview();
  const { today, spaces, items } = ov;
  const [hidden, toggleSpace] = useHiddenSpaces();
  const hues = useMemo(() => spaceHues(spaces), [spaces]);
  const multi = spaces.length > 1;

  const shown = useMemo(() => items.filter((i) => !hidden.has(i.space.id)), [items, hidden]);
  const sections = useMemo(() => {
    const byTask = new Map(shown.map((i) => [i.task, i]));
    const sec = overviewSections([...byTask.keys()], today);
    const pick = (list: typeof sec.today) => list.map((t) => byTask.get(t)!);
    return {
      overdue: pick(sec.overdue),
      today: pick(sec.today),
      week: sec.week.map((d) => ({ date: d.date, items: pick(d.tasks) })),
      fixed: sec.fixed.map((f) => ({ item: byTask.get(f.task)!, date: f.date })),
    };
  }, [shown, today]);

  const perSpace = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) m.set(i.space.id, (m.get(i.space.id) ?? 0) + 1);
    return m;
  }, [items]);

  const listed = sections.overdue.length + sections.today.length + sections.week.reduce((n, d) => n + d.items.length, 0);
  const visibleSpaces = spaces.filter((w) => !hidden.has(w.id));
  const nothing = listed === 0 && sections.fixed.length === 0;

  const rowProps = { today, hues, multi, selectedTaskId };

  return (
    <Page>
      <ViewHeader
        title="모아보기"
        description={
          <>
            {longDateKo(today)} · {multi ? `${visibleSpaces.length}개 공간에서 ` : ''}
            {user?.name ? `${user.name}님이 ` : ''}할 일 {listed}개
            {sections.overdue.length > 0 && <span className={s.descDanger}> · 기한 지남 {sections.overdue.length}개</span>}
          </>
        }
      />

      {multi ? (
        <div className={s.spaces} role="group" aria-label="보일 공간">
          {spaces.map((w) => {
            const on = !hidden.has(w.id);
            return (
              <button
                key={w.id}
                className={s.spaceChip}
                aria-pressed={on}
                style={hueStyle(hues.get(w.id)!)}
                onClick={() => toggleSpace(w.id)}
                {...tip(on ? '이 공간 숨기기' : '이 공간 보이기', { side: 'bottom' })}
              >
                <span className={s.spaceSwatch} aria-hidden="true" />
                <WorkspaceMark ws={w} size="sm" />
                <span className={s.spaceName}>{workspaceLabel(w)}</span>
                <span className={s.spaceCount}>{perSpace.get(w.id) ?? 0}</span>
                {!on && <Icon name="eyeOff" size={13} className={s.spaceOff} />}
              </button>
            );
          })}
          {!ov.loaded && !ov.error && <Spinner label="다른 공간 불러오는 중" className={s.spacesSpinner} />}
        </div>
      ) : (
        ov.loaded && (
          <div className={cx(ui.alert, s.solo)}>
            <Icon name="building" size={16} />
            <div>지금은 개인 공간만 있어요. 조직에 참여하면 그곳에서 나에게 배정된 일도 여기에 함께 모여요.</div>
          </div>
        )
      )}

      {ov.error && (
        <div className={cx(ui.alert, s.solo)} data-tone="danger" role="alert">
          <Icon name="alert" size={16} />
          <div>다른 공간을 불러오지 못했어요 · {ov.error}</div>
        </div>
      )}

      {visibleSpaces.length > 0 && (
        <WeekLoad
          today={today}
          spaces={visibleSpaces}
          hues={hues}
          days={[{ date: today, items: [...sections.overdue, ...sections.today] }, ...sections.week]}
        />
      )}

      {visibleSpaces.length === 0 ? (
        <EmptyState icon="eyeOff" title="모든 공간을 숨겼어요" body="위에서 공간을 눌러 다시 켜 보세요." />
      ) : nothing && ov.loaded ? (
        <EmptyState
          icon="checkCircle"
          title="모든 공간이 조용해요"
          body={`기한 지난 일도, ${OVERVIEW_DAYS}일 안에 할 일도 없어요. ${multi ? '조직 작업은 나에게 배정된 것만 모여요.' : ''}`}
        />
      ) : (
        <>
          <Section id="ov-overdue" title="기한 지남" tone="danger" count={sections.overdue.length}>
            {sections.overdue.map((i) => (
              <Row key={i.task.id} item={i} {...rowProps} date="overdue" />
            ))}
          </Section>
          <Section
            id={`ov-day-${today}`}
            title="오늘"
            count={sections.today.length}
            hint="진행 중인 작업 포함"
            empty={sections.today.length === 0 ? '오늘 남은 일이 없어요.' : undefined}
          >
            {sections.today.map((i) => (
              <Row key={i.task.id} item={i} {...rowProps} date="span" />
            ))}
          </Section>
          {sections.week.some((d) => d.items.length) && (
            <section className={cx(v.group, s.section)}>
              <div className={v.groupHeader}>
                <span className={v.groupTitle}>앞으로 {OVERVIEW_DAYS}일</span>
                <span className={v.count}>{sections.week.reduce((m, d) => m + d.items.length, 0)}</span>
              </div>
              {sections.week
                .filter((d) => d.items.length)
                .map((d) => (
                  <div key={d.date} id={`ov-day-${d.date}`} className={s.day}>
                    <div className={s.dayHead}>
                      <span className={s.dayName}>{formatRelativeKo(d.date, today)}</span>
                      <span className={s.dayDate}>{dayLabel(d.date)}</span>
                      <span className={s.dayCount}>{d.items.length}</span>
                    </div>
                    <div className={v.rows}>
                      {d.items.map((i) => (
                        <Row key={i.task.id} item={i} {...rowProps} date="span-if-range" />
                      ))}
                    </div>
                  </div>
                ))}
            </section>
          )}
          <Section id="ov-fixed" title="고정 일정" count={sections.fixed.length} hint={`${OVERVIEW_FIXED_DAYS}일 안`}>
            {sections.fixed.map(({ item, date }) => (
              <Row key={item.task.id} item={item} {...rowProps} date="fixed" fixedDate={date} />
            ))}
          </Section>
        </>
      )}
    </Page>
  );
}

function dayLabel(date: ISODate) {
  const [, m, d] = date.split('-').map(Number);
  return `${m}/${d} ${WEEKDAYS[weekday(date)]}`;
}

/* ───────────────────────── sections */

function Section({
  id,
  title,
  tone,
  count,
  hint,
  empty,
  children,
}: {
  id: string;
  title: string;
  tone?: 'danger';
  count: number;
  hint?: string;
  empty?: string;
  children: ReactNode;
}) {
  if (!count && !empty) return null;
  return (
    <section id={id} className={cx(v.group, s.section)} data-tone={tone}>
      <div className={v.groupHeader} data-tone={tone}>
        <span className={v.groupTitle}>{title}</span>
        {count > 0 && <span className={v.count}>{count}</span>}
        {hint && <span className={s.hint}>{hint}</span>}
      </div>
      <div className={v.rows}>{count ? children : <div className={v.groupEmpty}>{empty}</div>}</div>
    </section>
  );
}

/* ───────────────────────── week load: how the next days fill up, per space */

function WeekLoad({
  today,
  spaces,
  hues,
  days,
}: {
  today: ISODate;
  spaces: WorkspaceSummary[];
  hues: Map<string, SpaceHue>;
  days: { date: ISODate; items: OverviewItem[] }[];
}) {
  const cols = days.map((d) => {
    const counts = spaces.map((w) => ({ space: w, n: d.items.filter((i) => i.space.id === w.id).length })).filter((c) => c.n > 0);
    return { date: d.date, total: d.items.length, counts };
  });
  const max = Math.max(1, ...cols.map((c) => c.total));
  // Today already has its own list; the note is about a day ahead where work piles up.
  const busy = cols.slice(1).reduce<(typeof cols)[number] | null>((best, c) => (c.total >= BUSY_DAY && c.total > (best?.total ?? 0) ? c : best), null);
  const busyWhen = busy ? formatRelativeKo(busy.date, today) : '';

  const jump = (date: ISODate) => {
    const el = document.getElementById(`ov-day-${date}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className={s.load} role="group" aria-label="날짜별 할 일 수">
      <div className={s.loadCols}>
        {cols.map((c) => {
          const isToday = c.date === today;
          const weekend = [0, 6].includes(weekday(c.date));
          const label = c.counts.map((x) => `${workspaceLabel(x.space)} ${x.n}`).join(' · ');
          return (
            <button
              key={c.date}
              className={s.loadCol}
              data-today={isToday || undefined}
              data-weekend={weekend || undefined}
              data-busy={busy?.date === c.date || undefined}
              disabled={!c.total}
              onClick={() => jump(c.date)}
              aria-label={`${isToday ? '오늘(기한 지남 포함)' : formatRelativeKo(c.date, today)} ${c.total}개${label ? `: ${label}` : ''}`}
              {...tip(c.total ? label : null, { side: 'top', meta: isToday ? '기한 지남 포함' : undefined })}
            >
              <span className={s.loadNum}>{c.total || ''}</span>
              <span className={s.loadBar}>
                {c.total > 0 && (
                  <span className={s.loadStack} style={{ '--h': c.total / max } as CSSProperties}>
                    {c.counts.map((x) => (
                      <span key={x.space.id} className={s.loadSeg} style={{ ...hueStyle(hues.get(x.space.id)!), flexGrow: x.n }} />
                    ))}
                  </span>
                )}
              </span>
              <span className={s.loadDay}>{isToday ? '오늘' : WEEKDAYS[weekday(c.date)]}</span>
              <span className={s.loadDate}>{Number(c.date.slice(8))}</span>
            </button>
          );
        })}
      </div>
      {busy && (
        <p className={s.loadNote}>
          <Icon name="bolt" size={14} />
          <span>
            <strong>{busyWhen}</strong>
            {/^(내일|모레)$/.test(busyWhen) ? ' ' : '에 '}
            {busy.total}개가 몰려 있어요
            {busy.counts.length > 1 && <> · {busy.counts.map((x) => `${workspaceLabel(x.space)} ${x.n}`).join(', ')}</>}
          </span>
        </p>
      )}
    </div>
  );
}

/* ───────────────────────── rows */

type DateMode = 'overdue' | 'span' | 'span-if-range' | 'fixed';

const Row = memo(function Row({
  item,
  today,
  hues,
  multi,
  selectedTaskId,
  date,
  fixedDate,
}: {
  item: OverviewItem;
  today: ISODate;
  hues: Map<string, SpaceHue>;
  multi: boolean;
  selectedTaskId: string | null;
  date: DateMode;
  fixedDate?: ISODate;
}) {
  const { task, editable, space, project } = item;
  const [completing, setCompleting] = useState(false);
  const spaceName = workspaceLabel(space);

  const complete = () => {
    if (!editable) return;
    setCompleting(true);
    window.setTimeout(() => {
      void Promise.resolve(completeOverviewItem(item)).finally(() => setCompleting(false));
    }, 380);
  };
  const open = () => void openOverviewItem(item, spaceName);

  // Same date language as the shared task row: overdue red, today bold, the rest muted.
  let label: string | null = null;
  let tone: 'overdue' | 'today' | undefined;
  if (date === 'overdue' && task.dueDate) {
    label = overdueLabel(task.dueDate, today);
    tone = 'overdue';
  } else if (date === 'span') {
    label = spanLabel(task, today);
    tone = 'today';
  } else if (date === 'span-if-range' && task.startDate && task.dueDate && task.startDate !== task.dueDate) {
    label = spanLabel(task, today);
  } else if (date === 'fixed' && fixedDate) {
    label = formatRelativeKo(fixedDate, today);
    tone = fixedDate === today ? 'today' : undefined;
  }

  return (
    <div
      className={cx(r.row, completing && r.completing, item.live && selectedTaskId === task.id && r.selected)}
      data-task-row={task.id}
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') open();
        if (e.key === 'x' || e.key === ' ') {
          e.preventDefault();
          complete();
        }
      }}
    >
      <Checkbox task={completing ? { ...task, status: 'done' } : task} onToggle={complete} animate={completing} disabled={!editable} />
      <div className={r.main}>
        <div className={r.content}>
          <div className={r.titleLine}>
            <span className={r.title}>{task.title}</span>
          </div>
          <div className={r.meta}>
            {label && (
              <span
                className={cx(r.item, r.date)}
                data-tone={tone}
                {...tip(task.fixed ? '고정 일정: 날짜가 움직이지 않아요' : null, { side: 'top' })}
              >
                {task.fixed && <Icon name="pin" size={13} />}
                {label}
              </span>
            )}
            {!label && task.fixed && date !== 'fixed' && (
              <span className={r.item} {...tip('날짜가 움직이지 않는 고정 일정', { side: 'top' })}>
                <Icon name="pin" size={13} /> 고정
              </span>
            )}
            {!editable && (
              <span className={r.item} {...tip('보기 전용: 쓰기 권한이 없어요', { side: 'top' })}>
                <Icon name="eye" size={13} /> 보기 전용
              </span>
            )}
            {project && (
              <span className={cx(r.item, r.project)}>
                <span className={r.swatch} style={{ background: `var(--c-${project.color})` }} aria-hidden="true" />
                <span className={r.projectName}>{project.name}</span>
              </span>
            )}
            {multi && (
              <span
                className={cx(r.item, s.spaceTag)}
                style={hueStyle(hues.get(space.id) ?? 'slate')}
                {...tip(item.live ? '지금 열린 공간' : `열면 ${spaceName}(으)로 전환해요`, { side: 'top' })}
              >
                <span className={s.spaceTagDot} aria-hidden="true" />
                <span className={s.spaceTagName}>{spaceName}</span>
              </span>
            )}
          </div>
        </div>
      </div>
      <div className={r.actions}>
        <button
          className={cx(ui.iconBtn, r.openBtn)}
          aria-label={item.live ? '열기' : `${spaceName}에서 열기`}
          tabIndex={-1}
          {...tip(item.live ? '열기' : `${spaceName}에서 열기`, { side: 'top', kbd: '↵' })}
          onClick={(e) => {
            e.stopPropagation();
            open();
          }}
        >
          <Icon name={item.live ? 'chevronRight' : 'arrowUpRight'} size={15} />
        </button>
      </div>
    </div>
  );
});

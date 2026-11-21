'use client';

import { formatDurationKo, formatRelativeKo, formatTimeRangeKo, percentKo, toMinutes } from '@obelisk/core';
import { useRouter } from 'next/navigation';
import { Spinner } from '@/components/primitives';
import { setPref } from '@/lib/hooks';
import { selectTask, useApp } from '@/lib/store';
import { useDay, useOdds } from '@/lib/timeplan';
import { setUi } from '@/lib/ui-state';
import { Database, ListRow, NewPageBox, Tag } from './blocks';
import s from '../home.module.css';

const CAP = 6;

/** Open 오늘 in its 시간표 view. */
function openPlan(router: ReturnType<typeof useRouter>) {
  setPref('today-mode', 'plan');
  router.push('/today');
}

/** 오늘 시간표: what's next in today's plan, and how the hours add up. */
export function DayPlanWidget() {
  const app = useApp();
  const router = useRouter();
  const { view } = useDay(app.today);
  if (!view) {
    return (
      <Database icon="clock" title="지금부터">
        <Spinner label="불러오는 중" />
      </Database>
    );
  }
  const now = view.now.date === view.date ? view.now.minutes : 0;
  const tasks = new Map(view.tasks.map((t) => [t.id, t]));
  const rows = [
    ...view.events.map((e) => ({ key: `e${e.taskId}`, taskId: e.taskId, start: e.start, end: e.end, event: true })),
    ...view.blocks.map((b) => ({ key: b.id, taskId: b.taskId, start: b.start, end: b.end, event: false })),
  ]
    .filter((r) => toMinutes(r.end) > now)
    .sort((a, b) => a.start.localeCompare(b.start));
  const over = view.needed - view.capacity;
  const colorOf = (projectId: string | null) => view.projects.find((p) => p.id === projectId)?.color;
  return (
    <Database
      icon="clock"
      title="지금부터"
      tools={
        <span className={s.rowDate} data-tone={over > 0 ? 'warn' : undefined}>
          {over > 0 ? `${formatDurationKo(over)} 넘침` : `남은 시간 ${formatDurationKo(Math.max(0, view.capacity - view.planned))}`}
        </span>
      }
      onNew={() => openPlan(router)}
      newLabel={view.blocks.length ? '시간표 열기' : '시간표 짜기'}
    >
      {rows.length ? (
        <div className={s.list}>
          {rows.slice(0, CAP).map((r) => {
            const t = tasks.get(r.taskId);
            const color = t ? colorOf(t.projectId) : undefined;
            return (
              <ListRow key={r.key} icon={r.event ? 'calendarClock' : 'timer'} title={t?.title ?? '볼 수 없는 작업'} onOpen={() => t && t.workspaceId === app.workspace?.id && selectTask(t.id)}>
                {color && t?.projectId && <Tag hue={color as never}>{view.projects.find((p) => p.id === t.projectId)?.name}</Tag>}
                <span className={s.rowDate}>{formatTimeRangeKo(r.start, r.end)}</span>
              </ListRow>
            );
          })}
          {rows.length > CAP && <ListRow title={`외 ${rows.length - CAP}개 · 시간표에서 보기`} onOpen={() => openPlan(router)} muted />}
        </div>
      ) : (
        <NewPageBox label={view.pending.length ? `할 일 ${view.pending.length}개를 시간표에 넣기` : '오늘 남은 계획이 없어요'} onClick={() => openPlan(router)} />
      )}
    </Database>
  );
}

/** 완료 확률: each project's 85% date and the tasks unlikely to make their due date. */
export function OddsWidget() {
  const app = useApp();
  const router = useRouter();
  const { data } = useOdds();
  if (!data) {
    return (
      <Database icon="target" title="내 기록으로 계산" href="/forecast" hrefLabel="파급 예측 보기">
        <Spinner label="계산하는 중" />
      </Database>
    );
  }
  const today = data.today;
  const risky = data.report.tasks.filter((t) => t.onTime !== null && t.onTime < 0.6 && app.tasks[t.taskId]).sort((a, b) => a.onTime! - b.onTime!);
  const projects = data.report.projects
    .filter((p) => p.projectId && app.projects.some((x) => x.id === p.projectId))
    .sort((a, b) => (a.p85 ?? '9999').localeCompare(b.p85 ?? '9999'));
  return (
    <Database
      icon="target"
      title="내 기록으로 계산"
      href="/forecast"
      hrefLabel="파급 예측 보기"
      tools={
        data.report.overall?.p85 ? <span className={s.rowDate}>전부 85% {formatRelativeKo(data.report.overall.p85, today)}</span> : undefined
      }
    >
      <div className={s.list}>
        {risky.slice(0, 3).map((o) => {
          const t = app.tasks[o.taskId]!;
          return (
            <ListRow key={o.taskId} icon="alert" iconColor="var(--warn)" title={t.title} onOpen={() => selectTask(t.id)}>
              <span className={s.rowDate}>제때 {percentKo(o.onTime!)}</span>
            </ListRow>
          );
        })}
        {projects.slice(0, CAP - Math.min(3, risky.length)).map((p) => {
          const project = app.projects.find((x) => x.id === p.projectId)!;
          return (
            <ListRow key={p.projectId} icon="folder" iconColor={`var(--c-${project.color})`} title={project.name} onOpen={() => router.push(`/projects/${project.id}`)}>
              <span className={s.rowDate}>
                85% {p.p85 ? formatRelativeKo(p.p85, today) : '6개월 뒤 이후'}
              </span>
            </ListRow>
          );
        })}
        {!risky.length && !projects.length && <NewPageBox label="약속하기 전에 가능한 날짜 보기" onClick={() => setUi({ commit: {} })} />}
      </div>
    </Database>
  );
}

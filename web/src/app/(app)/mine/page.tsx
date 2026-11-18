'use client';

import { compareTasks, isOverdue, isToday, type Task } from '@obelisk/core';
import { useClock } from '@/lib/clock';
import Link from 'next/link';
import { useMemo } from 'react';
import { Icon } from '@/components/Icon';
import { Avatar, buttonClass } from '@/components/primitives';
import { QuickAdd } from '@/components/QuickAdd';
import { EmptyState, Page, TaskGroup, ViewHeader } from '@/components/View';
import { useTasks } from '@/lib/hooks';
import { memberName, useApp } from '@/lib/store';
import s from '../views.module.css';

/** 내 작업: what is assigned to me in this organization, plus what I handed to others. */
export default function MinePage() {
  const app = useApp();
  const { today, user, workspace } = app;
  const tasks = useTasks();
  const me = user?.id;
  const clock = useClock();

  const groups = useMemo(() => {
    const active = (t: Task) => t.status === 'todo' || t.status === 'doing';
    const mine = tasks.filter((t) => active(t) && t.assigneeId === me).sort(compareTasks);
    const overdue = mine.filter((t) => isOverdue(t, today, clock));
    const now = mine.filter((t) => !isOverdue(t, today, clock) && isToday(t, today));
    const later = mine.filter((t) => !isToday(t, today) && (t.startDate || t.dueDate));
    const undated = mine.filter((t) => !t.startDate && !t.dueDate);
    const done = tasks
      .filter((t) => t.status === 'done' && t.assigneeId === me)
      .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
      .slice(0, 30);
    const delegated = tasks
      .filter((t) => active(t) && t.createdBy === me && t.assigneeId && t.assigneeId !== me)
      .sort(compareTasks);
    return { total: mine.length, overdue, now, later, undated, done, delegated };
  }, [tasks, me, today, clock]);

  const byAssignee = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of groups.delegated) map.set(t.assigneeId!, [...(map.get(t.assigneeId!) ?? []), t]);
    return [...map.entries()];
  }, [groups.delegated]);

  if (workspace?.kind !== 'org') {
    return (
      <Page>
        <EmptyState
          icon="user"
          title="내 작업은 조직에서 쓰는 보기예요"
          body="조직에서는 작업마다 담당자를 정할 수 있고, 여기에 내가 맡은 작업이 모여요."
          action={
            <Link href="/all" className={buttonClass({ variant: 'outline', size: 'sm' })}>
              <Icon name="layers" size={15} />
              전체 작업 보기
            </Link>
          }
        />
      </Page>
    );
  }

  return (
    <Page>
      <ViewHeader
        title="내 작업"
        description={`${workspace.name}에서 내가 맡은 작업 ${groups.total}개${groups.overdue.length ? ` · 기한 지남 ${groups.overdue.length}개` : ''}`}
      />
      <QuickAdd defaultAssigneeId={me} placeholder="내가 맡을 작업 추가 (예: 계약서 검토 금요일 #법무)" />

      <TaskGroup title="기한 지남" tone="danger" tasks={groups.overdue} />
      <TaskGroup title="오늘" tasks={groups.now} />
      <TaskGroup title="예정" tasks={groups.later} />
      <TaskGroup title="날짜 없음" tone="muted" tasks={groups.undated} />

      {groups.total === 0 && (
        <EmptyState
          icon="checkCircle"
          title="맡은 작업이 없어요"
          body="작업 상세에서 담당자를 나로 지정하거나, 위 입력창에서 바로 추가해 보세요."
        />
      )}

      {byAssignee.map(([id, list]) => (
        <TaskGroup
          key={id}
          title={
            <span className={s.groupTitle}>
              <Avatar name={memberName(id, app)} size="sm" />
              <span className={s.groupName}>{memberName(id, app) ?? '전 멤버'}에게 맡긴 작업</span>
            </span>
          }
          tasks={list}
          collapsible
          defaultCollapsed
        />
      ))}

      <TaskGroup title="최근 완료" tone="muted" tasks={groups.done} collapsible defaultCollapsed />
    </Page>
  );
}

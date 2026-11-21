'use client';

import { compareTasks, isOverdue, isToday, type Task } from '@obelisk/core';
import { useClock } from '@/lib/clock';
import Link from 'next/link';
import { useMemo } from 'react';
import { Icon } from '@/components/Icon';
import { Avatar, AvatarStack, buttonClass } from '@/components/primitives';
import { QuickAdd } from '@/components/QuickAdd';
import { EmptyState, Page, TaskGroup, ViewHeader } from '@/components/View';
import { useTasks } from '@/lib/hooks';
import { memberAvatar, memberName, useApp } from '@/lib/store';
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
    const mine = tasks.filter((t) => active(t) && !!me && t.assigneeIds.includes(me)).sort(compareTasks);
    const overdue = mine.filter((t) => isOverdue(t, today, clock));
    const now = mine.filter((t) => !isOverdue(t, today, clock) && isToday(t, today));
    const later = mine.filter((t) => !isToday(t, today) && (t.startDate || t.dueDate));
    const undated = mine.filter((t) => !t.startDate && !t.dueDate);
    const done = tasks
      .filter((t) => t.status === 'done' && !!me && t.assigneeIds.includes(me))
      .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
      .slice(0, 30);
    const delegated = tasks
      .filter((t) => active(t) && t.createdBy === me && t.assigneeIds.length > 0 && !t.assigneeIds.includes(me!))
      .sort(compareTasks);
    return { total: mine.length, overdue, now, later, undated, done, delegated };
  }, [tasks, me, today, clock]);

  // One group per set of people (a task handed to two people is one group, not two).
  const byAssignee = useMemo(() => {
    const map = new Map<string, { ids: string[]; tasks: Task[] }>();
    for (const t of groups.delegated) {
      const key = [...t.assigneeIds].sort().join(',');
      const g = map.get(key) ?? { ids: t.assigneeIds, tasks: [] };
      g.tasks.push(t);
      map.set(key, g);
    }
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

      {byAssignee.map(([key, { ids, tasks: list }]) => (
        <TaskGroup
          key={key}
          title={
            <span className={s.groupTitle}>
              {ids.length === 1 ? (
                <Avatar name={memberName(ids[0], app)} src={memberAvatar(ids[0], app)} size="sm" />
              ) : (
                <AvatarStack people={ids.map((id) => ({ id, name: memberName(id, app), src: memberAvatar(id, app) }))} size="sm" />
              )}
              <span className={s.groupName}>{ids.map((id) => memberName(id, app) ?? '전 멤버').join(', ')}에게 맡긴 작업</span>
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

'use client';

import { compareTasks, selectView, type Task } from '@obelisk/core';
import Link from 'next/link';
import { useMemo } from 'react';
import { Icon } from '@/components/Icon';
import { buttonClass, tip, ui } from '@/components/primitives';
import { QuickAdd } from '@/components/QuickAdd';
import { EmptyState, Page, TaskGroup, ViewHeader } from '@/components/View';
import { useTasks } from '@/lib/hooks';
import { useApp } from '@/lib/store';
import { setUi } from '@/lib/ui-state';
import s from '../views.module.css';

export default function AllPage() {
  const { today, projects } = useApp();
  const tasks = useTasks();
  const groups = useMemo(() => {
    const active = selectView(tasks, 'all', today);
    const byProject = new Map<string | null, Task[]>();
    for (const t of active) {
      const list = byProject.get(t.projectId) ?? [];
      list.push(t);
      byProject.set(t.projectId, list);
    }
    const ordered = [
      { id: null as string | null, name: '인박스', color: null as string | null },
      ...projects.filter((p) => !p.archivedAt).map((p) => ({ id: p.id, name: p.name, color: p.color })),
    ];
    return ordered
      .map((g) => ({ ...g, tasks: (byProject.get(g.id) ?? []).sort(compareTasks) }))
      .filter((g) => g.tasks.length);
  }, [tasks, today, projects]);
  const total = groups.reduce((n, g) => n + g.tasks.length, 0);

  return (
    <Page>
      <ViewHeader
        icon="layers"
        title="전체 작업"
        description={`진행 중인 작업 ${total}개를 프로젝트별로 모았어요. 머리글을 눌러 접거나 펼칠 수 있어요.`}
      />
      <QuickAdd />
      {groups.map((g) => {
        const href = g.id ? `/projects/${g.id}` : '/inbox';
        return (
          <TaskGroup
            key={g.id ?? 'inbox'}
            title={
              <span className={s.groupTitle}>
                {g.color ? (
                  <span className={ui.dot} style={{ background: `var(--c-${g.color})` }} />
                ) : (
                  <Icon name="inbox" size={14} className={s.groupIcon} />
                )}
                <span className={s.groupName}>{g.name}</span>
              </span>
            }
            aside={
              <Link href={href} className={s.groupLink} aria-label={`${g.name} 열기`} {...tip(g.id ? '프로젝트 페이지 열기' : '인박스 열기', { side: 'top' })}>
                <span className={s.groupLinkText}>열기</span>
                <Icon name="arrowUpRight" size={14} />
              </Link>
            }
            tasks={g.tasks}
            showProject={false}
            collapsible
          />
        );
      })}
      {groups.length === 0 && (
        <EmptyState
          icon="layers"
          title="진행 중인 작업이 없어요"
          body="새 작업을 추가해보세요. “#프로젝트”를 붙이면 프로젝트별로 정리돼요."
          action={
            <button type="button" className={buttonClass({ variant: 'outline', size: 'sm' })} onClick={() => setUi({ quickAdd: true })}>
              <Icon name="plus" size={15} />
              새 작업
              <kbd>N</kbd>
            </button>
          }
        />
      )}
    </Page>
  );
}

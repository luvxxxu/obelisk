'use client';

import { formatRelativeKo, formatShortKo, type Task } from '@obelisk/core';
import Link from 'next/link';
import { useMemo } from 'react';
import { Icon } from '@/components/Icon';
import { buttonClass } from '@/components/primitives';
import { TaskRow } from '@/components/TaskRow';
import { EmptyState, Page, ViewHeader } from '@/components/View';
import { completedOn, useTasks } from '@/lib/hooks';
import { useApp } from '@/lib/store';
import s from '../views.module.css';

export default function LogbookPage() {
  const { today, user } = useApp();
  const tasks = useTasks();
  const groups = useMemo(() => {
    const tz = user?.timezone ?? 'UTC';
    const map = new Map<string, Task[]>();
    for (const t of tasks) {
      if (t.status !== 'done') continue;
      const d = completedOn(t, tz);
      if (!d) continue;
      const list = map.get(d) ?? [];
      list.push(t);
      map.set(d, list);
    }
    return [...map.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, list]) => ({ date, list: list.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')) }));
  }, [tasks, user]);
  const total = groups.reduce((n, g) => n + g.list.length, 0);

  return (
    <Page>
      <ViewHeader
        icon="checkCircle"
        iconColor="var(--ok)"
        title="완료 기록"
        description={`최근 30일 동안 ${total}개를 끝냈어요. 동그라미를 다시 누르면 완료를 취소해요.`}
      />
      <div className={s.agenda}>
        {groups.map((g) => {
          const rel = formatRelativeKo(g.date, today);
          return (
            <section key={g.date} className={s.day} aria-label={rel}>
              <div className={s.dayHeader}>
                <span className={s.dayRel}>{rel}</span>
                {/* "오늘"/"어제" carry no date — show it next to them. */}
                {!/\d월/.test(rel) && <span className={s.dayDate}>{formatShortKo(g.date)}</span>}
                <span className={s.dayCount}>{g.list.length}</span>
              </div>
              <div className={s.dayRows}>
                {g.list.map((t) => (
                  <TaskRow key={t.id} task={t} showDate={false} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
      {total === 0 && (
        <EmptyState
          icon="checkCircle"
          title="아직 완료한 작업이 없어요"
          body="작업 왼쪽의 동그라미를 누르면 완료돼요. 키보드로는 J/K로 고르고 X를 누르세요."
          action={
            <Link href="/today" className={buttonClass({ variant: 'outline', size: 'sm' })}>
              <Icon name="sun" size={15} />
              오늘 할 일 보기
            </Link>
          }
        />
      )}
    </Page>
  );
}

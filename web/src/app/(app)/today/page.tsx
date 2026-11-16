'use client';

import { isOverdue, selectView } from '@obelisk/core';
import Link from 'next/link';
import { useMemo } from 'react';
import { Icon } from '@/components/Icon';
import { buttonClass, Progress, ui } from '@/components/primitives';
import { QuickAdd } from '@/components/QuickAdd';
import { EmptyState, Page, TaskGroup, ViewHeader } from '@/components/View';
import { cx, longDateKo } from '@/lib/format';
import { completedOn, useForecast, useTasks } from '@/lib/hooks';
import { useJev } from '@/lib/jev';
import { useApp } from '@/lib/store';
import { setUi } from '@/lib/ui-state';
import s from '../views.module.css';

export default function TodayPage() {
  const { today, user } = useApp();
  const tasks = useTasks();
  const fc = useForecast();
  const jev = useJev();

  const { overdue, todays, done } = useMemo(() => {
    const tz = user?.timezone ?? 'UTC';
    return {
      overdue: selectView(tasks, 'overdue', today),
      todays: selectView(tasks, 'today', today).filter((t) => !isOverdue(t, today)),
      done: tasks.filter((t) => t.status === 'done' && completedOn(t, tz) === today),
    };
  }, [tasks, today, user]);

  const risk = fc.summary.delayedCount + fc.summary.conflictCount;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? '좋은 아침이에요' : hour < 18 ? '좋은 오후예요' : '좋은 저녁이에요';

  // Read-only progress for the header: finished today vs. everything due today (incl. overdue).
  const planned = done.length + overdue.length + todays.length;
  const progress =
    planned > 0 ? (
      <div className={s.todayProgress}>
        <span className={s.todayProgressLabel}>오늘 진행</span>
        <Progress value={done.length} max={planned} size="sm" label="오늘 진행률" className={s.todayProgressBar} tone={done.length === planned ? 'ok' : undefined} />
        <span className={s.todayProgressCount}>
          {done.length}/{planned}
        </span>
      </div>
    ) : undefined;

  return (
    <Page>
      <ViewHeader
        icon="sun"
        iconColor="var(--accent)"
        title="오늘"
        description={`${longDateKo(today)} · ${greeting}, ${user?.name}님`}
        actions={
          progress || jev.connected ? (
            <div className={s.todayActions}>
              {progress}
              {jev.connected && overdue.length + todays.length > 0 && (
                <button
                  type="button"
                  className={buttonClass({ variant: 'outline', size: 'sm' })}
                  onClick={() => setUi({ jev: { kind: 'postpone', scope: 'today' } })}
                >
                  <Icon name="sparkle" size={14} />
                  미룰 작업 고르기
                </button>
              )}
            </div>
          ) : undefined
        }
      />

      {risk > 0 && (
        <Link href="/forecast" className={cx(ui.alert, s.riskAlert)} data-tone={fc.summary.conflictCount ? 'danger' : 'warn'}>
          <Icon name="alert" size={16} />
          <div className={s.riskText}>
            <div className={ui.alertTitle}>
              기한 지난 작업 {fc.rootIds.length}개 때문에{' '}
              {fc.summary.delayedCount > 0 && `${fc.summary.delayedCount}개 일정이 밀리고 있어요`}
              {fc.summary.delayedCount > 0 && fc.summary.conflictCount > 0 && ', '}
              {fc.summary.conflictCount > 0 && `고정 일정 ${fc.summary.conflictCount}개가 위험해요`}
            </div>
            <div className={ui.alertDescription}>파급 예측에서 한 번에 정리할 수 있어요</div>
          </div>
          <span className={s.riskCta}>
            <span className={s.riskCtaText}>해결하기</span>
            <Icon name="chevronRight" size={16} />
          </span>
        </Link>
      )}

      <QuickAdd defaultDueDate={today} placeholder="오늘 할 일 추가 — 예: 견적서 보내기 !높음" />

      <TaskGroup title="기한 지남" tone="danger" tasks={overdue} />
      <TaskGroup title={overdue.length ? '오늘' : undefined} tasks={todays} />

      {overdue.length + todays.length === 0 && (
        <EmptyState
          icon="sun"
          title={done.length ? '오늘 할 일을 모두 끝냈어요' : '오늘은 비어 있어요'}
          body={done.length ? `${done.length}개 완료. 푹 쉬어도 좋아요.` : '위 입력창에 할 일을 적어보세요. “내일”, “금요일”, “#프로젝트” 같은 표현을 알아들어요.'}
          action={
            done.length ? (
              <Link href="/upcoming" className={buttonClass({ variant: 'outline', size: 'sm' })}>
                <Icon name="calendar" size={15} />
                다가오는 일정 보기
              </Link>
            ) : (
              <button type="button" className={buttonClass({ variant: 'outline', size: 'sm' })} onClick={() => setUi({ quickAdd: true })}>
                <Icon name="plus" size={15} />
                새 작업
                <kbd>N</kbd>
              </button>
            )
          }
        />
      )}

      <TaskGroup title="오늘 완료" tone="muted" tasks={done} collapsible defaultCollapsed={done.length > 3} />
    </Page>
  );
}

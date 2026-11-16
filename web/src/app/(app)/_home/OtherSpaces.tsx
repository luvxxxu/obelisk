'use client';

import { formatRelativeKo, OVERVIEW_DAYS, overviewSections } from '@obelisk/core';
import Link from 'next/link';
import { useMemo, type CSSProperties } from 'react';
import { Icon } from '@/components/Icon';
import { Spinner } from '@/components/primitives';
import { WorkspaceMark, workspaceLabel } from '@/components/WorkspaceSwitcher';
import { spaceHues, useOverview } from '@/lib/overview';
import { stagger } from './motion';
import s from './spaces.module.css';

/**
 * Home widget "다른 공간": what waits for the user in every space other than the open one —
 * overdue, today and the next 7 days, plus the first thing up — each card leading to 모아보기.
 */
export function OtherSpaces() {
  const { spaces, items, today, openId, loaded, error } = useOverview();
  const hues = useMemo(() => spaceHues(spaces), [spaces]);

  const cards = useMemo(
    () =>
      spaces
        .filter((w) => w.id !== openId)
        .map((w) => {
          const sec = overviewSections(
            items.filter((i) => i.space.id === w.id).map((i) => i.task),
            today,
          );
          const week = sec.week.reduce((n, d) => n + d.tasks.length, 0);
          const nextDay = sec.week.find((d) => d.tasks.length);
          const next = sec.overdue[0] ?? sec.today[0] ?? nextDay?.tasks[0] ?? null;
          const when = sec.overdue[0] ? '기한 지남' : sec.today[0] ? '오늘' : nextDay ? formatRelativeKo(nextDay.date, today) : null;
          return { space: w, overdue: sec.overdue.length, today: sec.today.length, week, next, when };
        }),
    [spaces, items, today, openId],
  );

  if (!loaded) {
    return <div className={s.loading}>{error ? `다른 공간을 불러오지 못했어요 · ${error}` : <Spinner label="다른 공간 불러오는 중" />}</div>;
  }

  if (!cards.length) {
    return (
      <div className={s.empty}>
        <span className={s.emptyMark} aria-hidden="true">
          <Icon name="building" size={18} />
        </span>
        <div>
          <div className={s.emptyTitle}>다른 공간이 없어요</div>
          <div className={s.emptyBody}>조직에 참여하면 그곳에서 나에게 배정된 일이 여기 요약돼요.</div>
        </div>
      </div>
    );
  }

  return (
    <div className={s.wrap}>
      <div className={s.cards}>
        {cards.map((c, i) => {
          return (
            <Link
              key={c.space.id}
              href="/overview"
              className={s.card}
              data-tone={c.overdue ? 'danger' : undefined}
              style={{ ...stagger(i), '--space': `var(--c-${hues.get(c.space.id) ?? 'slate'})` } as CSSProperties}
            >
              <span className={s.head}>
                <WorkspaceMark ws={c.space} size="sm" />
                <span className={s.name}>{workspaceLabel(c.space)}</span>
                <span className={s.swatch} aria-hidden="true" />
              </span>
              <span className={s.stats}>
                <Stat label="기한 지남" n={c.overdue} tone="danger" />
                <Stat label="오늘" n={c.today} />
                <Stat label={`${OVERVIEW_DAYS}일 안`} n={c.week} />
              </span>
              <span className={s.next}>
                {c.next ? (
                  <>
                    <span className={s.nextWhen} data-tone={c.overdue ? 'danger' : undefined}>
                      {c.when}
                    </span>
                    <span className={s.nextTitle}>{c.next.title}</span>
                  </>
                ) : (
                  <span className={s.nextNone}>{OVERVIEW_DAYS}일 안에 맡은 일이 없어요</span>
                )}
              </span>
            </Link>
          );
        })}
      </div>
      <Link href="/overview" className={s.more}>
        모아보기에서 모든 공간 보기
        <Icon name="arrowRight" size={14} />
      </Link>
    </div>
  );
}

function Stat({ label, n, tone }: { label: string; n: number; tone?: 'danger' }) {
  return (
    <span className={s.stat} data-tone={n && tone ? tone : undefined} data-zero={!n || undefined}>
      <span className={s.statNum}>{n}</span>
      <span className={s.statLabel}>{label}</span>
    </span>
  );
}

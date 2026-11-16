'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { cx } from '@/lib/format';
import { refreshPriorities, useJev, usePriorities } from '@/lib/jev';
import { selectTask, useApp } from '@/lib/store';
import { setUi } from '@/lib/ui-state';
import { Icon } from './Icon';
import { JevMark } from './JevDialogs';
import { Skeleton, tip, ui } from './primitives';
import s from './Jev.module.css';

const DISMISS_KEY = 'obelisk:jev-invite-dismissed';

/**
 * Home: "지금 할 일 하나" from Jev plus the two Jev actions. Without a key it is a one-line,
 * dismissible invitation to connect one.
 */
export function JevStrip({ todayCount, onDismiss }: { todayCount: number; /** On the home dashboard the ✕ hides the widget instead. */ onDismiss?: () => void }) {
  const jev = useJev();
  const app = useApp();
  const p = usePriorities(jev.connected);
  const [dismissed, setDismissed] = useState(!onDismiss);

  useEffect(() => {
    if (onDismiss) return setDismissed(false);
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === '1');
    } catch {
      setDismissed(false);
    }
  }, [onDismiss]);

  if (!jev.connected) {
    if (dismissed) return null;
    return (
      <div className={cx(s.strip, s.invite)}>
        <JevMark />
        <p className={s.inviteText}>
          <strong>Jev</strong>를 연결하면 우선순위를 정해 주고, 일이 몰리는 날엔 미뤄도 되는 일을 골라 드려요.
        </p>
        <Link href="/settings/jev" className={cx(ui.btn, ui.outline, ui.sm)}>
          연결하기
          <Icon name="arrowRight" size={13} />
        </Link>
        <button
          type="button"
          className={ui.iconBtn}
          aria-label={onDismiss ? '홈에서 숨기기' : '다시 보지 않기'}
          {...tip(onDismiss ? '홈에서 숨기기' : '다시 보지 않기', { side: 'top' })}
          onClick={() => {
            if (onDismiss) return onDismiss();
            setDismissed(true);
            try {
              localStorage.setItem(DISMISS_KEY, '1');
            } catch {}
          }}
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    );
  }

  const focus = p.data?.focus ? app.tasks[p.data.focus.taskId] : undefined;
  const changes = (p.data?.suggestions ?? []).filter((sg) => app.tasks[sg.taskId] && sg.suggested !== app.tasks[sg.taskId]!.priority).length;
  const busy = todayCount > 5;

  return (
    <div className={s.strip} aria-label="Jev 추천" role="region">
      <JevMark />
      <div className={s.stripBody}>
        <span className={s.stripLabel}>Jev 추천 · 지금 할 일</span>
        {p.status === 'loading' && !p.data ? (
          <span className={s.stripLoading}>
            <Skeleton width={240} height={15} />
            <Skeleton width={180} height={11} />
          </span>
        ) : p.status === 'error' && !p.data ? (
          <span className={s.stripError}>
            {p.error}
            <button type="button" className={s.linkBtn} onClick={() => void refreshPriorities(true)}>
              다시 시도
            </button>
          </span>
        ) : focus ? (
          <span className={s.stripFocus}>
            <button type="button" className={s.taskName} onClick={() => selectTask(focus.id)}>
              <span className={s.num}>#{focus.number}</span>
              <span className={s.title}>{focus.title}</span>
            </button>
            <span className={s.reasons}>{p.data!.focus!.reasons.join(' · ')}</span>
          </span>
        ) : (
          <span className={s.stripEmpty}>지금 바로 시작할 일은 없어요. 다가오는 일정을 확인해 보세요.</span>
        )}
      </div>
      <div className={s.stripActions}>
        <button type="button" className={cx(ui.btn, ui.ghost, ui.sm)} onClick={() => setUi({ jev: { kind: 'priority' } })}>
          <Icon name="flag" size={14} />
          우선순위 정리
          {changes > 0 && <span className={s.count}>{changes}</span>}
        </button>
        <button
          type="button"
          className={cx(ui.btn, busy ? ui.outline : ui.ghost, ui.sm)}
          onClick={() => setUi({ jev: { kind: 'postpone', scope: 'today' } })}
          {...tip(busy ? `오늘 할 일이 ${todayCount}개예요` : null, { side: 'top' })}
        >
          {busy && <span className={ui.dot} data-tone="warn" />}
          <Icon name="postpone" size={14} />
          미룰 작업 고르기
        </button>
      </div>
    </div>
  );
}

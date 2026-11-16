'use client';

import {
  formatRelativeKo,
  formatShortKo,
  JEV_CONFIDENT,
  PRIORITY_LABEL_KO,
  type PostponeCandidate,
  type PostponePlan,
  type Priority,
  type PrioritySuggestion,
  type Task,
} from '@obelisk/core';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cx } from '@/lib/format';
import { applyPostpone, applyPriorities, fetchPostponePlan, jevMessage, refreshPriorities, useJev, usePriorities } from '@/lib/jev';
import { selectTask, useApp } from '@/lib/store';
import { setUi, useUi } from '@/lib/ui-state';
import { Icon } from './Icon';
import { Modal, Skeleton, tip, ui } from './primitives';
import s from './Jev.module.css';

export const PRIORITY_TONE: Record<Priority, string> = {
  0: 'var(--text-3)',
  1: 'var(--info)',
  2: 'var(--warn)',
  3: 'var(--danger)',
};

/** "Jev" mark: a small violet sparkle badge, the only colour Jev adds to a screen. */
export function JevMark({ size = 'md' }: { size?: 'sm' | 'md' }) {
  return (
    <span className={s.mark} data-size={size} aria-hidden="true">
      <Icon name="sparkle" size={size === 'sm' ? 12 : 15} strokeWidth={2} />
    </span>
  );
}

export function PriorityPill({ p, strong }: { p: Priority; strong?: boolean }) {
  return (
    <span className={s.pill} data-strong={strong || undefined} style={{ '--tone': PRIORITY_TONE[p] } as React.CSSProperties}>
      <span className={s.pillDot} />
      {p === 0 ? '없음' : PRIORITY_LABEL_KO[p]}
    </span>
  );
}

export function Confidence({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <span className={s.conf} data-sure={value >= JEV_CONFIDENT || undefined} {...tip(`Jev 확신도 ${pct}%`, { side: 'top' })}>
      <span className={s.confTrack} aria-hidden="true">
        <span className={s.confBar} style={{ width: `${pct}%` }} />
      </span>
      {pct}%
    </span>
  );
}

function Pick({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={label} className={s.pick} data-checked={checked || undefined} onClick={() => onChange(!checked)}>
      <Icon name="check" size={12} strokeWidth={3} />
    </button>
  );
}

function TaskName({ task }: { task: Task }) {
  return (
    <button
      type="button"
      className={s.taskName}
      onClick={() => {
        setUi({ jev: null });
        selectTask(task.id);
      }}
    >
      <span className={s.num}>#{task.number}</span>
      <span className={s.title}>{task.title}</span>
    </button>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className={s.loading} role="status" aria-live="polite">
      <div className={s.loadingHead}>
        <span className={s.pulse} aria-hidden="true" />
        {label}
      </div>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className={s.skelRow} style={{ animationDelay: `${i * 80}ms` }}>
          <Skeleton width={18} height={18} />
          <Skeleton width={`${46 - i * 6}%`} height={14} />
          <Skeleton width={64} height={20} style={{ marginLeft: 'auto' }} />
        </div>
      ))}
    </div>
  );
}

function Failure({ message, onRetry }: { message: string; onRetry: () => void }) {
  const notConnected = /연결되어 있지 않|다시 입력|올바르지 않/.test(message);
  return (
    <div className={ui.alert} data-tone="danger" role="alert">
      <Icon name="alertCircle" size={16} />
      <div className={ui.alertTitle}>{message}</div>
      <div className={s.failActions}>
        {notConnected ? (
          <Link href="/settings/jev" className={cx(ui.btn, ui.outline, ui.sm)} onClick={() => setUi({ jev: null })}>
            Jev 설정 열기
          </Link>
        ) : (
          <button type="button" className={cx(ui.btn, ui.outline, ui.sm)} onClick={onRetry}>
            다시 시도
          </button>
        )}
      </div>
    </div>
  );
}

function Group({ title, count, children, collapsible, hint }: { title: string; count: number; children: ReactNode; collapsible?: boolean; hint?: string }) {
  const [open, setOpen] = useState(!collapsible);
  return (
    <section className={s.group}>
      <button type="button" className={s.groupHead} onClick={() => collapsible && setOpen((o) => !o)} aria-expanded={collapsible ? open : undefined} disabled={!collapsible}>
        <span className={s.groupTitle}>{title}</span>
        <span className={s.groupCount}>{count}</span>
        {hint && <span className={s.groupHint}>{hint}</span>}
        {collapsible && <Icon name={open ? 'chevronUp' : 'chevronDown'} size={14} className={s.groupChevron} />}
      </button>
      {open && <ul className={s.rows}>{children}</ul>}
    </section>
  );
}

/* ───────────────────────────── A. priorities */

/** Preselect what Jev is reasonably sure about; leave close calls for the user. */
const PRESELECT = 0.6;

function PriorityDialog() {
  const app = useApp();
  const p = usePriorities(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const changes = useMemo(
    () => (p.data?.suggestions ?? []).filter((sg) => app.tasks[sg.taskId] && sg.suggested !== app.tasks[sg.taskId]!.priority),
    [p.data, app.tasks],
  );
  const same = useMemo(
    () => (p.data?.suggestions ?? []).filter((sg) => app.tasks[sg.taskId] && sg.suggested === app.tasks[sg.taskId]!.priority),
    [p.data, app.tasks],
  );
  const dataKey = p.data ? p.data.suggestions.map((x) => `${x.taskId}${x.suggested}`).join() : '';
  useEffect(() => {
    setPicked(new Set(changes.filter((c) => c.confidence >= PRESELECT).map((c) => c.taskId)));
    // Reset the selection only when a new result arrives, not on every task edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey]);

  const toggle = (id: string, v: boolean) =>
    setPicked((cur) => {
      const n = new Set(cur);
      if (v) n.add(id);
      else n.delete(id);
      return n;
    });

  const apply = async () => {
    setBusy(true);
    const list = changes.filter((c) => picked.has(c.taskId)).map((c) => ({ taskId: c.taskId, priority: c.suggested }));
    const n = await applyPriorities(list);
    setBusy(false);
    if (n) setUi({ jev: null });
  };

  const focus = p.data?.focus ? app.tasks[p.data.focus.taskId] : undefined;
  const loading = p.status === 'loading' || p.status === 'idle';

  return (
    <Modal
      open
      onClose={() => setUi({ jev: null })}
      width={680}
      icon={<JevMark />}
      title="Jev 우선순위 제안"
      description="Jev가 작업마다 놓치면 무엇을 잃는지 판단하고, 마감까지 남은 날과 기다리는 작업 수를 더해 우선순위를 골랐어요."
      footer={
        <div className={s.footer}>
          <span className={s.footNote}>{p.data?.model ? `${p.data.model} · ` : ''}바꾼 뒤에도 언제든 되돌릴 수 있어요</span>
          <button className={cx(ui.btn, ui.ghost)} onClick={() => setUi({ jev: null })}>
            닫기
          </button>
          <button className={cx(ui.btn, ui.primary)} disabled={busy || picked.size === 0 || loading} onClick={() => void apply()}>
            {busy ? <span className={ui.spinner} /> : <Icon name="check" size={15} />}
            {picked.size ? `${picked.size}개 적용` : '적용'}
          </button>
        </div>
      }
    >
      {loading && !p.data ? (
        <Loading label={`Jev가 작업 ${Object.values(app.tasks).filter((t) => t.status === 'todo' || t.status === 'doing').length}개를 살펴보는 중…`} />
      ) : p.status === 'error' && !p.data ? (
        <Failure message={p.error ?? 'Jev에 묻지 못했어요'} onRetry={() => void refreshPriorities(true)} />
      ) : (
        <div className={s.body}>
          {focus && (
            <div className={s.focus}>
              <span className={s.focusLabel}>
                <Icon name="target" size={14} />
                지금 할 일
              </span>
              <TaskName task={focus} />
              <span className={s.reasons}>{p.data!.focus!.reasons.join(' · ')}</span>
            </div>
          )}

          {changes.length === 0 ? (
            <div className={s.calm}>
              <Icon name="checkCircle" size={18} />
              지금 우선순위가 Jev 판단과 모두 같아요.
            </div>
          ) : (
            <Group title="바꿀 작업" count={changes.length} hint={changes.length > 1 ? '애매한 건 비워 뒀어요' : undefined}>
              {changes.map((c, i) => (
                <PriorityRow key={c.taskId} sg={c} task={app.tasks[c.taskId]!} checked={picked.has(c.taskId)} onChange={(v) => toggle(c.taskId, v)} index={i} />
              ))}
            </Group>
          )}

          {same.length > 0 && (
            <Group title="그대로 둘 작업" count={same.length} collapsible>
              {same.map((c, i) => (
                <PriorityRow key={c.taskId} sg={c} task={app.tasks[c.taskId]!} index={i} />
              ))}
            </Group>
          )}
        </div>
      )}
    </Modal>
  );
}

function PriorityRow({
  sg,
  task,
  checked,
  onChange,
  index,
}: {
  sg: PrioritySuggestion;
  task: Task;
  checked?: boolean;
  onChange?: (v: boolean) => void;
  index: number;
}) {
  const change = onChange !== undefined;
  return (
    <li className={s.row} style={{ animationDelay: `${Math.min(index, 12) * 28}ms` }} data-off={change && !checked ? true : undefined}>
      {change ? <Pick checked={!!checked} onChange={onChange!} label={`${task.title} 우선순위 바꾸기`} /> : <span className={s.pickSpacer} />}
      <div className={s.rowMain}>
        <TaskName task={task} />
        <span className={s.reasons}>{sg.reasons.join(' · ')}</span>
      </div>
      <div className={s.rowSide}>
        {change ? (
          <span className={s.change}>
            <PriorityPill p={task.priority} />
            <Icon name="arrowRight" size={12} className={s.changeArrow} />
            <PriorityPill p={sg.suggested} strong />
          </span>
        ) : (
          <PriorityPill p={sg.suggested} />
        )}
        <Confidence value={sg.confidence} />
      </div>
    </li>
  );
}

/* ───────────────────────────── B. postpone */

function PostponeDialog({ initialScope }: { initialScope: 'today' | 'week' }) {
  const app = useApp();
  const [scope, setScope] = useState(initialScope);
  const [capacity, setCapacity] = useState<number | undefined>(undefined);
  const [plan, setPlan] = useState<PostponePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const seq = useRef(0);
  const run = useCallback(async (sc: 'today' | 'week', cap?: number) => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const pl = await fetchPostponePlan(sc, cap);
      if (mine !== seq.current) return;
      setPlan(pl);
      setPicked(new Set(pl.candidates.filter((c) => c.verdict === 'postpone').map((c) => c.taskId)));
    } catch (e) {
      if (mine === seq.current) setError(jevMessage(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void run(scope, capacity);
  }, [run, scope, capacity]);

  const groups = useMemo(() => {
    const list = (plan?.candidates ?? []).filter((c) => app.tasks[c.taskId]);
    return {
      postpone: list.filter((c) => c.verdict === 'postpone'),
      could: list.filter((c) => c.verdict === 'could'),
      keep: list.filter((c) => c.verdict === 'keep' || c.verdict === 'fixed'),
    };
  }, [plan, app.tasks]);

  const toggle = (id: string, v: boolean) =>
    setPicked((cur) => {
      const n = new Set(cur);
      if (v) n.add(id);
      else n.delete(id);
      return n;
    });

  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    const n = await applyPostpone(plan.candidates.filter((c) => picked.has(c.taskId) && c.toDate));
    setBusy(false);
    if (n) setUi({ jev: null });
  };

  const cap = plan?.capacity ?? capacity ?? 5;
  const setCap = (n: number) => setCapacity(Math.max(1, Math.min(30, n)));

  // Live load after the picks the user actually kept.
  const loadAfter = useMemo(() => {
    const m = new Map((plan?.days ?? []).map((d) => [d.date, d.load]));
    for (const c of plan?.candidates ?? []) {
      if (!picked.has(c.taskId) || !c.toDate) continue;
      m.set(c.day, (m.get(c.day) ?? 0) - 1);
      if (m.has(c.toDate)) m.set(c.toDate, (m.get(c.toDate) ?? 0) + 1);
    }
    return m;
  }, [plan, picked]);

  return (
    <Modal
      open
      onClose={() => setUi({ jev: null })}
      width={700}
      icon={<JevMark />}
      title="무엇을 미룰까요?"
      description="Jev가 미뤄도 괜찮은 일을 고르고, 파급 엔진이 고정 일정과 부딪히지 않는 여유 있는 날을 찾았어요."
      footer={
        <div className={s.footer}>
          <span className={s.footNote}>뒤따르는 작업도 함께 옮기고, 한 번에 되돌릴 수 있어요</span>
          <button className={cx(ui.btn, ui.ghost)} onClick={() => setUi({ jev: null })}>
            닫기
          </button>
          <button className={cx(ui.btn, ui.primary)} disabled={busy || loading || picked.size === 0} onClick={() => void apply()}>
            {busy ? <span className={ui.spinner} /> : <Icon name="postpone" size={15} />}
            {picked.size ? `${picked.size}개 미루기` : '미루기'}
          </button>
        </div>
      }
    >
      <div className={s.body}>
        <div className={s.controls}>
          <div className={ui.segmented} role="group" aria-label="범위">
            {(['today', 'week'] as const).map((sc) => (
              <button key={sc} type="button" className={ui.segment} aria-pressed={scope === sc} onClick={() => setScope(sc)}>
                {sc === 'today' ? '오늘' : '이번 주'}
              </button>
            ))}
          </div>
          <div className={s.stepper} aria-label="하루에 할 수 있는 양">
            <span className={s.stepLabel}>하루</span>
            <button type="button" className={ui.iconBtn} onClick={() => setCap(cap - 1)} aria-label="줄이기" disabled={cap <= 1}>
              <Icon name="chevronLeft" size={14} />
            </button>
            <span className={s.stepValue}>{cap}개</span>
            <button type="button" className={ui.iconBtn} onClick={() => setCap(cap + 1)} aria-label="늘리기">
              <Icon name="chevronRight" size={14} />
            </button>
            {plan && capacity === undefined && (
              <span className={s.stepSource}>{plan.capacitySource === 'history' ? '최근 14일 페이스' : '기본값'}</span>
            )}
          </div>
        </div>

        {plan && <LoadBars plan={plan} after={loadAfter} />}

        {loading && !plan ? (
          <Loading label="Jev가 미뤄도 되는 일을 고르는 중…" />
        ) : error ? (
          <Failure message={error} onRetry={() => void run(scope, capacity)} />
        ) : plan ? (
          <div className={cx(s.lists, loading && s.stale)}>
            {groups.postpone.length === 0 && groups.could.length === 0 ? (
              <div className={s.calm}>
                <Icon name="checkCircle" size={18} />
                {plan.overloaded ? '미룰 만한 작업이 없어요. 하루 양을 늘리거나 직접 골라 주세요.' : `하루 ${plan.capacity}개 안에 들어와요. 미룰 필요가 없어요.`}
              </div>
            ) : null}
            {groups.postpone.length > 0 && (
              <Group title="미룰 작업" count={groups.postpone.length}>
                {groups.postpone.map((c, i) => (
                  <PostponeRow key={c.taskId} c={c} task={app.tasks[c.taskId]!} today={app.today} checked={picked.has(c.taskId)} onChange={(v) => toggle(c.taskId, v)} index={i} />
                ))}
              </Group>
            )}
            {groups.could.length > 0 && (
              <Group title="미뤄도 되는 작업" count={groups.could.length} hint="필요하면 골라서 함께 미루세요">
                {groups.could.map((c, i) => (
                  <PostponeRow key={c.taskId} c={c} task={app.tasks[c.taskId]!} today={app.today} checked={picked.has(c.taskId)} onChange={(v) => toggle(c.taskId, v)} index={i} />
                ))}
              </Group>
            )}
            {groups.keep.length > 0 && (
              <Group title="그대로 둘 작업" count={groups.keep.length} collapsible>
                {groups.keep.map((c, i) => (
                  <PostponeRow key={c.taskId} c={c} task={app.tasks[c.taskId]!} today={app.today} index={i} />
                ))}
              </Group>
            )}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function LoadBars({ plan, after }: { plan: PostponePlan; after: Map<string, number> }) {
  if (plan.scope === 'today') {
    const d = plan.days[0]!;
    const now = after.get(d.date) ?? d.after;
    const max = Math.max(plan.capacity + 2, d.load);
    return (
      <div className={s.meter} data-over={now > plan.capacity || undefined}>
        <div className={s.meterText}>
          <span className={s.meterLabel}>오늘</span>
          <span className={s.meterNum}>
            {d.load !== now ? (
              <>
                <span className={s.old}>{d.load}개</span>
                <Icon name="arrowRight" size={13} />
                {now}개
              </>
            ) : (
              `${now}개`
            )}
          </span>
          <span className={s.meterCap}>하루 {plan.capacity}개 기준{d.load > plan.capacity ? ` · ${d.load - plan.capacity}개 넘침` : ''}</span>
        </div>
        <div className={s.meterTrack} aria-hidden="true">
          <span className={s.meterBefore} style={{ width: `${(d.load / max) * 100}%` }} />
          <span className={s.meterAfter} style={{ width: `${(now / max) * 100}%` }} />
          <span className={s.meterCapLine} style={{ left: `${(plan.capacity / max) * 100}%` }} />
        </div>
      </div>
    );
  }
  const max = Math.max(plan.capacity + 1, ...plan.days.map((d) => d.load));
  return (
    <div className={s.loads}>
      {plan.days.map((d, i) => {
        const now = after.get(d.date) ?? d.after;
        return (
          <div key={d.date} className={s.load} style={{ animationDelay: `${i * 40}ms` }}>
            <div className={s.loadBarBox} aria-hidden="true">
              <span className={s.loadCap} style={{ bottom: `${(plan.capacity / max) * 100}%` }} />
              <span className={s.loadBefore} data-over={d.load > plan.capacity || undefined} style={{ height: `${(d.load / max) * 100}%` }} />
              <span className={s.loadAfter} data-over={now > plan.capacity || undefined} style={{ height: `${(now / max) * 100}%` }} />
            </div>
            <div className={s.loadText}>
              <span className={s.loadDay}>{i === 0 ? '오늘' : formatShortKo(d.date).replace(/^\d+월 /, '')}</span>
              <span className={s.loadNum} data-over={now > plan.capacity || undefined}>
                {d.load !== now ? (
                  <>
                    <span className={s.old}>{d.load}</span>→{now}
                  </>
                ) : (
                  now
                )}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PostponeRow({
  c,
  task,
  today,
  checked,
  onChange,
  index,
}: {
  c: PostponeCandidate;
  task: Task;
  today: string;
  checked?: boolean;
  onChange?: (v: boolean) => void;
  index: number;
}) {
  const movable = onChange !== undefined && !!c.toDate;
  return (
    <li className={s.row} style={{ animationDelay: `${Math.min(index, 12) * 28}ms` }} data-off={movable && !checked ? true : undefined}>
      {movable ? (
        <Pick checked={!!checked} onChange={onChange!} label={`${task.title} 미루기`} />
      ) : (
        <span className={s.keepIcon} aria-hidden="true">
          <Icon name={c.verdict === 'fixed' ? 'pin' : 'lock'} size={13} />
        </span>
      )}
      <div className={s.rowMain}>
        <TaskName task={task} />
        <span className={s.reasons}>{c.reasons.join(' · ')}</span>
      </div>
      <div className={s.rowSide}>
        {c.toDate ? (
          <>
            <span className={s.moveTo}>
              <Icon name="arrowRight" size={12} />
              {formatRelativeKo(c.toDate, today)}
              <span className={s.moveDate}>{formatShortKo(c.toDate)}</span>
            </span>
            {c.delayed > 0 ? (
              <span className={cx(ui.badge)} data-tone="warn">
                함께 {c.delayed}개
              </span>
            ) : (
              <span className={cx(ui.badge)} data-tone="secondary">
                영향 없음
              </span>
            )}
          </>
        ) : c.verdict === 'fixed' ? (
          <span className={ui.badge} data-tone="outline">
            고정
          </span>
        ) : null}
      </div>
    </li>
  );
}

/* ───────────────────────────── mount point */

export function JevDialogs() {
  const { jev } = useUi();
  const status = useJev();
  if (!jev || !status.connected) return null;
  return jev.kind === 'priority' ? <PriorityDialog /> : <PostponeDialog initialScope={jev.scope} />;
}

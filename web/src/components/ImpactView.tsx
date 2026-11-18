'use client';

import { formatShortKo, type DateSpan, type ImpactReport, type TaskImpact } from '@obelisk/core';
import { useMemo } from 'react';
import { daysLabel } from '@/lib/format';
import { selectTask, useApp } from '@/lib/store';
import { Icon } from './Icon';
import { ui, type BadgeTone } from './primitives';
import s from './ImpactView.module.css';

export function impactHeadline(report: ImpactReport): { tone: 'ok' | 'warn' | 'danger'; text: string } {
  const { delayedCount: d, conflictCount: c, maxShiftDays: m, absorbedCount: a } = report.summary;
  if (!d && !c) {
    return { tone: 'ok', text: a ? `여유 시간이 흡수해서 다른 일정은 그대로예요` : `다른 일정에는 영향이 없어요` };
  }
  const parts: string[] = [];
  if (d) parts.push(`작업 ${d}개가 최대 ${daysLabel(m)} 밀려요`);
  if (c) parts.push(`고정 일정 ${c}개와 충돌해요`);
  return { tone: c ? 'danger' : 'warn', text: parts.join(' · ') };
}

function spanText(span: DateSpan) {
  const { startDate: a, dueDate: b } = span;
  if (a && b && a !== b) return `${formatShortKo(a)}–${formatShortKo(b).replace(/^\d+\//, '')}`;
  const one = b ?? a;
  return one ? formatShortKo(one) : '날짜 없음';
}

/** Depth-first order so every task sits right under the task that pushed it. */
function treeOrder(impacts: TaskImpact[]): TaskImpact[] {
  const byVia = new Map<string | null, TaskImpact[]>();
  const ids = new Set(impacts.map((i) => i.taskId));
  for (const im of impacts) {
    const key = im.viaId && ids.has(im.viaId) ? im.viaId : null;
    const list = byVia.get(key) ?? [];
    list.push(im);
    byVia.set(key, list);
  }
  const out: TaskImpact[] = [];
  const seen = new Set<string>();
  const visit = (im: TaskImpact) => {
    if (seen.has(im.taskId)) return;
    seen.add(im.taskId);
    out.push(im);
    for (const child of byVia.get(im.taskId) ?? []) visit(child);
  };
  for (const root of byVia.get(null) ?? []) visit(root);
  for (const im of impacts) visit(im);
  return out;
}

/* ───────── presentation: kind badge (what happens) + amount badge (by how much) */

const KIND_TONE: Record<TaskImpact['kind'], BadgeTone> = {
  root: 'outline',
  shifted: 'warn',
  conflict: 'danger',
  absorbed: 'ok',
  unscheduled: 'secondary',
};

function kindLabel(im: TaskImpact): string {
  switch (im.kind) {
    case 'root':
      return im.shiftDays > 0 ? '미룸' : im.shiftDays < 0 ? '당김' : '변경';
    case 'shifted':
      return '밀림';
    case 'conflict':
      return '충돌';
    case 'absorbed':
      return '흡수';
    case 'unscheduled':
      return '미정';
  }
}

function amountText(im: TaskImpact): string {
  switch (im.kind) {
    case 'root':
      return im.shiftDays >= 0 ? `+${daysLabel(im.shiftDays)}` : `−${daysLabel(-im.shiftDays)}`;
    case 'shifted':
      return `+${daysLabel(im.shiftDays)}`;
    case 'conflict':
      return `${daysLabel(im.overrunDays)} 초과`;
    case 'absorbed':
      return `여유 ${im.slackDays ?? 0}일 남음`;
    case 'unscheduled':
      return im.shiftDays ? `+${daysLabel(im.shiftDays)} 대기` : '대기 늘어남';
  }
}

export function ImpactView({
  report,
  hideRoot = false,
  compact = false,
  linkTasks = true,
}: {
  report: ImpactReport;
  hideRoot?: boolean;
  compact?: boolean;
  linkTasks?: boolean;
}) {
  const app = useApp();
  const projects = useMemo(() => new Map(app.projects.map((p) => [p.id, p])), [app.projects]);
  const head = impactHeadline(report);
  const items = treeOrder(report.impacts).filter((i) => !(hideRoot && i.kind === 'root'));
  const minDepth = hideRoot ? 1 : 0;
  const { delayedCount, conflictCount, absorbedCount } = report.summary;

  return (
    <div className={s.wrap}>
      {!compact && (
        <div className={s.summary} data-tone={head.tone}>
          <Icon name={head.tone === 'ok' ? 'checkCircle' : 'alert'} size={16} className={s.summaryIcon} />
          <div className={s.summaryBody}>
            <div className={s.summaryTitle}>{head.text}</div>
            <div className={s.stats}>
              <span className={s.stat}>
                밀림 <b>{delayedCount}</b>
              </span>
              <span className={s.stat}>
                충돌 <b>{conflictCount}</b>
              </span>
              <span className={s.stat}>
                흡수 <b>{absorbedCount}</b>
              </span>
            </div>
          </div>
        </div>
      )}

      {report.summary.projectSlips.length > 0 && (
        <ul className={s.slips}>
          {report.summary.projectSlips.map((p) => {
            const proj = projects.get(p.projectId);
            return (
              <li key={p.projectId} className={s.slip}>
                <span className={s.dot} style={{ background: `var(--c-${proj?.color ?? 'slate'})` }} aria-hidden="true" />
                <span className={s.slipName}>{proj?.name ?? '프로젝트'}</span>
                <span className={s.slipDates}>
                  완료 {formatShortKo(p.from)} <Icon name="arrowRight" size={11} /> {formatShortKo(p.to)}
                </span>
                <span className={s.slipShift}>+{daysLabel(p.shiftDays)}</span>
              </li>
            );
          })}
        </ul>
      )}

      {items.length > 0 && (
        <ol className={s.tree}>
          {items.map((im) => {
            const depth = Math.max(0, im.depth - minDepth);
            return (
              <li
                key={im.taskId}
                className={s.item}
                data-kind={im.kind}
                data-nested={depth > 0 || undefined}
                style={{ ['--depth' as string]: depth }}
              >
                <span className={s.node} aria-hidden="true" />
                <div className={s.body}>
                  <button
                    className={s.title}
                    onClick={() => linkTasks && selectTask(im.taskId)}
                    disabled={!linkTasks}
                    title={im.title}
                  >
                    {im.number ? <span className={s.num}>#{im.number}</span> : null}
                    {im.title}
                  </button>
                  <span className={s.dates}>
                    {im.kind === 'shifted' || im.kind === 'root' ? (
                      <>
                        <span className={s.from}>{spanText(im.from)}</span>
                        <Icon name="arrowRight" size={11} />
                        <span>{spanText(im.to)}</span>
                      </>
                    ) : (
                      <span>{spanText(im.from)}</span>
                    )}
                  </span>
                </div>
                <span className={s.tags}>
                  <span className={ui.badge} data-tone={KIND_TONE[im.kind]}>
                    {kindLabel(im)}
                  </span>
                  <span className={s.amount} data-kind={im.kind}>
                    {amountText(im)}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

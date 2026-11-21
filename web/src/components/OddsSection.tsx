'use client';

import { diffDays, formatDurationKo, formatRelativeKo, percentKo, type DateOdds, type ISODate } from '@obelisk/core';
import Link from 'next/link';
import { cx } from '@/lib/format';
import { selectTask, useApp } from '@/lib/store';
import { useOdds } from '@/lib/timeplan';
import { setUi } from '@/lib/ui-state';
import { Icon } from './Icon';
import { Spinner, tip, ui } from './primitives';
import { oddsTone } from './TimeTracking';
import s from './OddsSection.module.css';

const when = (d: ISODate | null, today: ISODate) => (d ? formatRelativeKo(d, today) : '6개월 뒤 이후');

/** A bar from today: the solid part is the 50–85% range, the faint tail runs to 95%. */
function RangeBar({ odds, today, span }: { odds: DateOdds; today: ISODate; span: number }) {
  const at = (d: ISODate | null) => (d ? Math.min(1, Math.max(0, diffDays(d, today) / span)) : 1);
  const a = at(odds.p50);
  const b = at(odds.p85);
  const c = at(odds.p95);
  return (
    <span className={s.range} aria-hidden="true">
      <span className={s.rangeTail} style={{ left: `${b * 100}%`, width: `${Math.max(0, c - b) * 100}%` }} />
      <span className={s.rangeCore} style={{ left: `${a * 100}%`, width: `${Math.max(0.012, b - a) * 100}%` }} />
    </span>
  );
}

/**
 * 완료 확률: finish dates as odds, from the person's own record. Projects with their 50%/85% dates,
 * tasks unlikely to make their due date, fixed dates at risk, and what the numbers rest on.
 */
export function OddsSection() {
  const app = useApp();
  const { data } = useOdds();
  if (!data) {
    return (
      <section className={s.section} aria-label="완료 확률">
        <div className={s.loading}>
          <Spinner label="완료 확률을 계산하는 중" />
        </div>
      </section>
    );
  }
  const today = data.today;
  const projects = data.report.projects
    .map((p) => ({ ...p, project: p.projectId ? app.projects.find((x) => x.id === p.projectId) : null }))
    .filter((p) => !p.projectId || p.project)
    .sort((a, b) => (a.p85 ?? '9999').localeCompare(b.p85 ?? '9999'));
  const span = Math.max(7, ...projects.map((p) => (p.p95 ? diffDays(p.p95, today) : 30)));
  const risky = data.report.tasks
    .filter((t) => t.onTime !== null && t.onTime < 0.6 && app.tasks[t.taskId])
    .sort((a, b) => a.onTime! - b.onTime!)
    .slice(0, 8);
  const fixed = data.report.tasks.filter((t) => (t.conflict ?? 0) >= 0.15 && app.tasks[t.taskId]).sort((a, b) => b.conflict! - a.conflict!);
  const c = data.calibration;

  return (
    <section className={s.section} aria-labelledby="fc-odds">
      <div className={s.head}>
        <h2 className={cx(ui.pageSection, s.title)} id="fc-odds">
          완료 확률
        </h2>
        <p className={s.lead}>
          내 기록으로 남은 일정을 {data.report.runs}번 돌려 봤어요. 50%는 반반, 85%는 이 날이면 거의 끝나는 날이에요.
        </p>
      </div>

      {data.report.overall && (
        <div className={s.overall}>
          <div className={s.figure}>
            <span className={s.figureLabel}>전부 끝나는 날 · 85%</span>
            <span className={s.figureValue}>{when(data.report.overall.p85, today)}</span>
          </div>
          <div className={s.figure}>
            <span className={s.figureLabel}>50%</span>
            <span className={s.figureValueMuted}>{when(data.report.overall.p50, today)}</span>
          </div>
          <div className={s.figure}>
            <span className={s.figureLabel}>제때 끝내기 어려운 작업</span>
            <span className={s.figureValue} data-tone={risky.length ? 'warn' : undefined}>
              {risky.length}개
            </span>
          </div>
        </div>
      )}

      {projects.length > 0 && (
        <ul className={s.projects}>
          {projects.map((p) => (
            <li key={p.projectId ?? 'inbox'} className={s.project}>
              <span className={s.projectName}>
                <span className={ui.dot} style={{ background: p.project ? `var(--c-${p.project.color})` : 'var(--text-4)' }} />
                {p.project ? (
                  <Link href={`/projects/${p.project.id}`} className={s.projectLink}>
                    {p.project.name}
                  </Link>
                ) : (
                  '프로젝트 없음'
                )}
                <span className={s.projectCount}>{p.tasks}개</span>
              </span>
              <RangeBar odds={p} today={today} span={span} />
              <span className={s.projectDates} {...tip(`95%: ${when(p.p95, today)}`, { side: 'top' })}>
                <span className={s.dim}>50%</span> {when(p.p50, today)} <span className={s.dim}>· 85%</span> <strong>{when(p.p85, today)}</strong>
              </span>
            </li>
          ))}
        </ul>
      )}

      {(risky.length > 0 || fixed.length > 0) && (
        <div className={s.lists}>
          {risky.length > 0 && (
            <div>
              <h3 className={s.subTitle}>제때 끝내기 어려운 작업</h3>
              <ul className={s.rows}>
                {risky.map((o) => {
                  const t = app.tasks[o.taskId]!;
                  return (
                    <li key={o.taskId} className={s.row}>
                      <button type="button" className={s.rowMain} onClick={() => selectTask(t.id)}>
                        <span className={s.num}>#{t.number}</span>
                        <span className={s.rowTitle}>{t.title}</span>
                      </button>
                      <span className={s.rowMeta}>마감 {t.dueDate ? formatRelativeKo(t.dueDate, today) : '–'}</span>
                      <span className={s.pct} data-tone={oddsTone(o.onTime)}>
                        {percentKo(o.onTime!)}
                      </span>
                      <button type="button" className={s.rowAction} onClick={() => setUi({ commit: { taskId: t.id } })} {...tip(`85%면 ${when(o.p85, today)}`, { side: 'top' })}>
                        가능한 날짜
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {fixed.length > 0 && (
            <div>
              <h3 className={s.subTitle}>위험한 고정 일정</h3>
              <ul className={s.rows}>
                {fixed.map((o) => {
                  const t = app.tasks[o.taskId]!;
                  return (
                    <li key={o.taskId} className={s.row}>
                      <button type="button" className={s.rowMain} onClick={() => selectTask(t.id)}>
                        <Icon name="pin" size={13} />
                        <span className={s.num}>#{t.number}</span>
                        <span className={s.rowTitle}>{t.title}</span>
                      </button>
                      <span className={s.rowMeta}>{t.dueDate ? formatRelativeKo(t.dueDate, today) : ''}</span>
                      <span className={s.pct} data-tone="danger" {...tip('앞 작업이 그날까지 끝나지 않을 확률', { side: 'top' })}>
                        충돌 {percentKo(o.conflict!)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className={s.basis}>
        <span className={s.basisTitle}>근거</span>
        <span>{c.ratioSamples ? `예상보다 ${c.medianRatio!.toFixed(1)}배 걸려요 (${c.ratioSamples}개)` : '예상 대비 실제 기록이 아직 없어 1.25배로 봐요'}</span>
        <span>{c.slipSamples ? `첫 마감을 지킨 비율 ${percentKo(c.onTimeRate!)} (${c.slipSamples}개)` : '마감 기록이 아직 없어요'}</span>
        <span>
          하루 집중 {Math.round(c.focus * 100)}%{c.focusSource === 'history' ? ` (기록 ${c.trackedDays}일)` : c.focusSource === 'setting' ? ' (설정)' : ' (기본값)'}
        </span>
        <span>예상 없는 작업 {formatDurationKo(c.defaultEstimate)}</span>
        {data.external > 0 && <span>다른 공간 작업 {data.external}개 포함</span>}
        <Link href="/settings/planning" className={s.basisLink}>
          일정 계획 설정
          <Icon name="chevronRight" size={12} />
        </Link>
      </div>
    </section>
  );
}

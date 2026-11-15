'use client';

import {
  changesFromReport,
  diffDays,
  downstreamOf,
  formatRelativeKo,
  simulate,
  type ImpactReport,
} from '@obelisk/core';
import { useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { ImpactView } from '@/components/ImpactView';
import { Checkbox } from '@/components/TaskRow';
import { Badge, Card, Spinner, ui } from '@/components/primitives';
import { EmptyState, Page, ViewHeader } from '@/components/View';
import { cx, daysLabel } from '@/lib/format';
import { useForecast, useLeverage, useTasks } from '@/lib/hooks';
import { planItems, reschedule, selectTask, toggleDone, useApp } from '@/lib/store';
import { toast } from '@/lib/toast';
import s from './forecast.module.css';

type Tone = 'ok' | 'warn' | 'danger';

const STATUS_LABEL: Record<Tone, string> = { danger: '위험', warn: '주의', ok: '순조로움' };

export default function ForecastPage() {
  const app = useApp();
  const { today, deps, tasks: byId } = app;
  const tasks = useTasks();
  const fc = useForecast();
  const lev = useLeverage();
  const [busy, setBusy] = useState<string | null>(null);

  // One card per overdue root, with only the ripple that root causes.
  const roots = useMemo(() => {
    const items = planItems(app);
    return fc.rootIds
      .map((id) => {
        const t = byId[id]!;
        const days = diffDays(today, (t.dueDate ?? t.startDate)!);
        const report: ImpactReport = simulate(items, deps, { [id]: days });
        const downstream = new Set(downstreamOf(deps, id));
        return { task: t, days, report, downstream: downstream.size };
      })
      .sort((a, b) => b.report.summary.conflictCount - a.report.summary.conflictCount || b.report.summary.delayedCount - a.report.summary.delayedCount || b.days - a.days);
  }, [fc, app, byId, deps, today]);

  const bottlenecks = lev.filter((l) => l.delayedIfLate + l.conflictsIfLate > 0 || l.slackDays === 0).slice(0, 8);
  const chronic = tasks
    .filter((t) => (t.status === 'todo' || t.status === 'doing') && t.postponedCount >= 2)
    .sort((a, b) => b.postponedCount - a.postponedCount)
    .slice(0, 8);

  const applyAll = async () => {
    setBusy('all');
    const changes = changesFromReport(fc, true);
    if (await reschedule(changes)) toast.show(`${changes.length}개 작업을 오늘 기준으로 다시 맞췄어요`);
    setBusy(null);
  };

  const ok = fc.rootIds.length === 0;
  const tone: Tone = fc.summary.conflictCount ? 'danger' : ok ? 'ok' : 'warn';
  const canApplyAll = !ok && fc.summary.delayedCount > 0;

  return (
    <Page>
      <ViewHeader
        icon="ripple"
        iconColor={fc.summary.conflictCount ? 'var(--danger)' : ok ? 'var(--ok)' : 'var(--warn)'}
        title="파급 예측"
        description="기한 지난 작업 하나가 뒤에 이어진 일정을 얼마나 밀어내는지 미리 계산해 보여줘요."
      >
        <HowItWorks />
      </ViewHeader>

      {/* ── status */}
      <Card className={s.hero} data-tone={tone}>
        <div className={s.heroTop}>
          <div className={s.heroIcon} aria-hidden="true">
            <Icon name={ok ? 'checkCircle' : 'alert'} size={20} />
          </div>
          <div className={s.heroText}>
            <div className={s.heroEyebrow}>
              <Badge tone={tone}>
                <span className={s.statusDot} aria-hidden="true" />
                {STATUS_LABEL[tone]}
              </Badge>
              <span>오늘 기준 예측</span>
            </div>
            <h2 className={s.heroTitle}>
              {ok
                ? '모든 일정이 순조로워요'
                : fc.summary.delayedCount + fc.summary.conflictCount === 0
                  ? `기한 지난 작업 ${fc.rootIds.length}개 — 다행히 다른 일정엔 영향이 없어요`
                  : `기한 지난 작업 ${fc.rootIds.length}개가 일정 ${fc.summary.delayedCount + fc.summary.conflictCount}개를 밀고 있어요`}
            </h2>
            <p className={s.heroSub}>
              {ok
                ? '기한이 지난 작업이 없어요. 아래에서 일정이 가장 민감한 작업을 확인해보세요.'
                : fc.summary.finishFrom !== fc.summary.finishTo && fc.summary.finishTo
                  ? `전체 완료 예상일이 ${formatRelativeKo(fc.summary.finishFrom!, today)} → ${formatRelativeKo(fc.summary.finishTo, today)}로 늦어져요.`
                  : '각 작업을 오늘 끝내거나, 일정을 오늘 기준으로 다시 맞출 수 있어요.'}
            </p>
          </div>
        </div>

        <div className={s.stats}>
          <Stat n={fc.rootIds.length} label="기한 지남" tone="danger" icon="clock" hint="오늘 끝내도 이미 늦은 작업" />
          <Stat n={fc.summary.delayedCount} label="밀리는 작업" tone="warn" icon="ripple" hint="그 여파로 뒤로 밀리는 작업" />
          <Stat n={fc.summary.conflictCount} label="고정 일정 충돌" tone="danger" icon="pin" hint="못 지키게 되는 고정 일정" />
          <Stat n={fc.summary.maxShiftDays} label="최대 지연" unit="일" icon="hourglass" hint="가장 많이 밀리는 정도" />
        </div>

        {canApplyAll && (
          <div className={s.heroFooter}>
            <p className={s.heroNote}>
              기한 지난 작업은 오늘로, 밀리는 작업은 예측된 날짜로 한 번에 옮겨요.
            </p>
            <button className={cx(ui.btn, ui.primary, s.heroCta)} onClick={() => void applyAll()} disabled={busy === 'all'}>
              {busy === 'all' ? <Spinner label="재조정하는 중" /> : <Icon name="bolt" size={15} />} 전체 일정 오늘 기준으로 재조정
            </button>
          </div>
        )}
      </Card>

      {/* ── overdue roots */}
      {roots.length > 0 && (
        <section className={s.section} aria-labelledby="fc-roots">
          <div className={s.sectionHead}>
            <h2 className={cx(ui.sectionTitle, s.sectionTitle)} id="fc-roots">
              지금 밀리고 있는 일정
              <Badge tone="secondary">{roots.length}</Badge>
            </h2>
            <p className={s.lead}>기한 지난 작업마다 따라 밀리는 일정을 보여줘요. 이미 끝냈다면 완료로, 아니면 오늘로 옮겨보세요.</p>
          </div>
          <div className={s.cards}>
            {roots.map(({ task, days, report, downstream }) => {
              const hasImpact = report.summary.delayedCount + report.summary.conflictCount > 0;
              const head = rippleSummary(report);
              const due = task.dueDate ?? task.startDate;
              return (
                <article key={task.id} className={cx(ui.card, s.rootCard)} data-tone={head.tone}>
                  <header className={s.rootHead}>
                    <Checkbox task={task} onToggle={() => void toggleDone(task.id)} />
                    <div className={s.rootHeading}>
                      <button className={s.rootTitle} onClick={() => selectTask(task.id)}>
                        {task.title}
                      </button>
                      <div className={s.rootMeta}>
                        <span className={s.num}>#{task.number}</span>
                        {due && <span>마감 {formatRelativeKo(due, today)}</span>}
                        {downstream > 0 && <span>후속 {downstream}개</span>}
                      </div>
                    </div>
                    <Badge tone="danger" className={s.overdue}>
                      {days === 1 ? '어제 마감' : `${days}일 지남`}
                    </Badge>
                  </header>

                  <div className={s.rootBody}>
                    {hasImpact ? (
                      <>
                        <p className={s.rootHeadline} data-tone={head.tone}>
                          <Icon name="alert" size={14} />
                          {head.text}
                        </p>
                        <div className={s.impact}>
                          <ImpactView report={report} hideRoot compact />
                        </div>
                      </>
                    ) : (
                      <p className={s.noImpact}>
                        <Icon name="checkCircle" size={14} />
                        이 작업을 기다리는 일정은 없어요.
                      </p>
                    )}
                  </div>

                  <footer className={s.rootActions}>
                    <button className={cx(ui.btn, ui.sm, ui.ghost)} onClick={() => void toggleDone(task.id)}>
                      <Icon name="check" size={14} /> 완료했어요
                    </button>
                    <button
                      className={cx(ui.btn, ui.sm, ui.outline)}
                      disabled={busy === task.id}
                      onClick={async () => {
                        setBusy(task.id);
                        const changes = changesFromReport(report, true);
                        if (await reschedule(changes, task.id)) {
                          toast.show(changes.length > 1 ? `오늘로 옮기고 ${changes.length - 1}개 작업을 함께 조정했어요` : '오늘로 옮겼어요');
                        }
                        setBusy(null);
                      }}
                    >
                      {busy === task.id ? <Spinner label="옮기는 중" /> : <Icon name="postpone" size={14} />}
                      오늘로 옮기기{report.summary.delayedCount ? ` · ${report.summary.delayedCount}개 연쇄` : ''}
                    </button>
                  </footer>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {/* ── leverage */}
      <section className={s.section} aria-labelledby="fc-key">
        <div className={s.sectionHead}>
          <h2 className={cx(ui.sectionTitle, s.sectionTitle)} id="fc-key">
            핵심 작업
            {bottlenecks.length > 0 && <Badge tone="secondary">{bottlenecks.length}</Badge>}
          </h2>
          <p className={s.lead}>하루만 늦어도 다른 일정이 움직이는 작업이에요. 여기부터 지키면 전체 일정이 지켜져요.</p>
        </div>
        {bottlenecks.length === 0 ? (
          <Card className={s.emptyCard}>
            {lev.length === 0 ? (
              <EmptyState icon="link" title="아직 연결된 작업이 없어요" body="작업 상세에서 ‘먼저 끝나야 하는 작업’을 연결하면 무엇이 일정의 핵심인지 계산해 드려요." />
            ) : (
              <EmptyState icon="checkCircle" title="모든 연결 작업에 여유가 있어요" body="하루쯤 늦어져도 다른 일정은 움직이지 않아요." />
            )}
          </Card>
        ) : (
          <div className={cx(ui.tableWrap, s.tableWrap)}>
            <table className={cx(ui.table, s.table)}>
              <thead>
                <tr className={ui.tr}>
                  <th className={ui.th} scope="col">
                    작업
                  </th>
                  <th className={cx(ui.th, s.colDue)} scope="col">
                    마감
                  </th>
                  <th className={ui.th} scope="col">
                    여유
                  </th>
                  <th className={ui.th} scope="col">
                    1일 늦으면
                  </th>
                  <th className={cx(ui.th, s.colNum, s.colDown)} scope="col">
                    후속
                  </th>
                </tr>
              </thead>
              <tbody>
                {bottlenecks.map((l) => {
                  const t = byId[l.taskId]!;
                  const dueText = t.dueDate ? formatRelativeKo(t.dueDate, today) : '—';
                  return (
                    <tr key={l.taskId} className={cx(ui.tr, s.row)} onClick={() => selectTask(t.id)}>
                      <td className={cx(ui.td, s.cellTitle)}>
                        <button type="button" className={s.rowBtn}>
                          <span className={s.num}>#{t.number}</span>
                          <span className={s.titleText}>{t.title}</span>
                        </button>
                        <span className={s.mobileMeta}>마감 {dueText}</span>
                      </td>
                      <td className={cx(ui.td, s.cellMuted, s.colDue)}>{dueText}</td>
                      <td className={ui.td}>
                        {l.slackDays === null ? (
                          <span className={s.cellMuted}>—</span>
                        ) : l.slackDays === 0 ? (
                          <Badge tone="danger">여유 없음</Badge>
                        ) : (
                          <span className={s.cellText}>{daysLabel(l.slackDays)}</span>
                        )}
                      </td>
                      <td className={ui.td}>
                        <span className={s.badges}>
                          {l.delayedIfLate > 0 && <Badge tone="warn">{l.delayedIfLate}개 밀림</Badge>}
                          {l.conflictsIfLate > 0 && <Badge tone="danger">충돌 {l.conflictsIfLate}</Badge>}
                          {l.delayedIfLate + l.conflictsIfLate === 0 && <span className={s.cellMuted}>영향 없음</span>}
                        </span>
                      </td>
                      <td className={cx(ui.td, s.colNum, s.colDown, s.cellMuted)}>{l.downstreamCount}개</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── chronic postponement */}
      {chronic.length > 0 && (
        <section className={s.section} aria-labelledby="fc-chronic">
          <div className={s.sectionHead}>
            <h2 className={cx(ui.sectionTitle, s.sectionTitle)} id="fc-chronic">
              자꾸 미뤄지는 작업
              <Badge tone="secondary">{chronic.length}</Badge>
            </h2>
            <p className={s.lead}>두 번 이상 미룬 작업이에요. 더 작게 쪼개거나, 맡기거나, 과감히 지우는 것도 방법이에요.</p>
          </div>
          <div className={cx(ui.tableWrap, s.tableWrap)}>
            <table className={cx(ui.table, s.table)}>
              <thead>
                <tr className={ui.tr}>
                  <th className={ui.th} scope="col">
                    작업
                  </th>
                  <th className={cx(ui.th, s.colDue)} scope="col">
                    마감
                  </th>
                  <th className={cx(ui.th, s.colNum)} scope="col">
                    미룬 횟수
                  </th>
                </tr>
              </thead>
              <tbody>
                {chronic.map((t) => {
                  const dueText = t.dueDate ? formatRelativeKo(t.dueDate, today) : '—';
                  return (
                    <tr key={t.id} className={cx(ui.tr, s.row)} onClick={() => selectTask(t.id)}>
                      <td className={cx(ui.td, s.cellTitle)}>
                        <button type="button" className={s.rowBtn}>
                          <span className={s.num}>#{t.number}</span>
                          <span className={s.titleText}>{t.title}</span>
                        </button>
                        <span className={s.mobileMeta}>마감 {dueText}</span>
                      </td>
                      <td className={cx(ui.td, s.cellMuted, s.colDue)}>{dueText}</td>
                      <td className={cx(ui.td, s.colNum)}>
                        <Badge tone="warn">
                          <Icon name="postpone" size={12} />
                          {t.postponedCount}회 미룸
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </Page>
  );
}

/** One-line summary of a root's ripple (presentation only; shown when something is pushed). */
function rippleSummary(r: ImpactReport): { tone: Tone; text: string } {
  const { delayedCount: d, conflictCount: c, maxShiftDays: m } = r.summary;
  const parts: string[] = [];
  if (d) parts.push(`작업 ${d}개가 최대 ${daysLabel(m)} 밀려요`);
  if (c) parts.push(`고정 일정 ${c}개와 충돌해요`);
  return { tone: c ? 'danger' : d ? 'warn' : 'ok', text: parts.join(' · ') };
}

/** Small native disclosure that explains the model in plain words. */
function HowItWorks() {
  return (
    <details className={s.how}>
      <summary className={s.howSummary}>
        <Icon name="info" size={14} />
        어떻게 계산하나요?
        <Icon name="chevronDown" size={14} className={s.howChevron} />
      </summary>
      <ol className={s.howList}>
        <li>
          기한이 지난 작업은 <b>빨라도 오늘 끝난다</b>고 보고, 늦어진 날짜만큼을 지연으로 계산해요.
        </li>
        <li>
          그 작업을 기다리는 <b>후속 작업</b>(‘먼저 끝나야 하는 작업’으로 연결된 작업)을 같은 만큼 뒤로 밀어요.
        </li>
        <li>
          후속 작업에 <b>여유</b>가 있으면 지연을 흡수해요. 움직일 수 없는 <b>고정 일정</b>에 닿으면 <b>충돌</b>로 표시해요.
        </li>
        <li>여기서는 미리 보기만 해요. 버튼을 눌러야 실제 일정이 바뀌어요.</li>
      </ol>
    </details>
  );
}

function Stat({
  n,
  label,
  tone,
  hint,
  unit,
  icon,
}: {
  n: number;
  label: string;
  tone?: 'danger' | 'warn';
  hint?: string;
  unit?: string;
  icon?: 'clock' | 'ripple' | 'pin' | 'hourglass';
}) {
  return (
    <div className={cx(ui.stat, s.stat)} data-tone={n > 0 ? tone : undefined}>
      <span className={ui.statLabel}>
        {label}
        {icon && <Icon name={icon} size={14} />}
      </span>
      <span className={cx(ui.statValue, s.statValue)}>
        {n}
        {unit && <small className={s.statUnit}>{unit}</small>}
      </span>
      {hint && <span className={ui.statMeta}>{hint}</span>}
    </div>
  );
}

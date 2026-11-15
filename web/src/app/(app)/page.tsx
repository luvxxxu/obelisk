'use client';

import {
  changesFromReport,
  diffDays,
  formatRelativeKo,
  formatShortKo,
  PROJECT_COLORS,
  type ProjectColor,
  type Task,
  type TaskImpact,
} from '@obelisk/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '@/components/Icon';
import { Spinner, tip } from '@/components/primitives';
import { Page, ViewHeader } from '@/components/View';
import { cx, longDateKo } from '@/lib/format';
import { useTasks } from '@/lib/hooks';
import { createProject, reschedule, selectTask, toggleDone, useApp } from '@/lib/store';
import { toast } from '@/lib/toast';
import { setUi } from '@/lib/ui-state';
import {
  Board,
  BoardCard,
  CardMeta,
  CardProgress,
  CardProps,
  Column,
  ColumnAdd,
  Database,
  H2,
  ListRow,
  NewPageBox,
  Tag,
} from './_home/blocks';
import { stagger, useCountUp } from './_home/motion';
import { UrgentBoard } from './_home/UrgentBoard';
import { useHomeData, type HomeData, type ProjectRow, type RootRisk } from './_home/useHomeData';
import s from './home.module.css';

/** Rows in the 다가오는 일정 list. */
const LIST_CAP = 8;
/** Overdue roots and impacts per root shown in 지연 파급. */
const ROOT_CAP = 3;
const IMPACT_CAP = 4;

const isActive = (t: Task) => t.status === 'todo' || t.status === 'doing';

/**
 * Home — a Notion-style workspace page on pure black/white.
 * Status callout → 5 summary tiles → 지연 파급 (ripple of each overdue task) + 주의할 작업
 * → 급한 업무 board · 다가오는 일정 list → 진행 상황 (projects board).
 */
export default function HomePage() {
  const data = useHomeData();
  const app = useApp();
  const tasks = useTasks();
  const router = useRouter();
  const { today } = data;
  const newTask = () => setUi({ quickAdd: true });

  const hour = new Date().getHours();
  const greeting = hour < 12 ? '좋은 아침이에요' : hour < 18 ? '좋은 오후예요' : '좋은 저녁이에요';
  const name = data.user?.name;

  const chronic = useMemo(
    () =>
      tasks
        .filter((t) => isActive(t) && t.postponedCount >= 2)
        .sort((a, b) => b.postponedCount - a.postponedCount)
        .slice(0, 3),
    [tasks],
  );

  const upcoming = useMemo(() => data.week.days.flatMap((d) => d.tasks.map((t) => ({ task: t, date: d.date }))), [data.week]);

  const doingByProject = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) if (t.status === 'doing' && t.projectId) set.add(t.projectId);
    return set;
  }, [tasks]);

  const projectGroups = useMemo(() => {
    const started: ProjectRow[] = [];
    const notStarted: ProjectRow[] = [];
    const finished: ProjectRow[] = [];
    for (const r of data.projectRows) {
      if (r.total > 0 && r.done === r.total) finished.push(r);
      else if (r.done > 0 || doingByProject.has(r.project.id)) started.push(r);
      else notStarted.push(r);
    }
    return { started, notStarted, finished };
  }, [data.projectRows, doingByProject]);

  const projectOf = (id: string | null) => (id ? app.projects.find((p) => p.id === id) : undefined);

  return (
    <Page wide>
      <ViewHeader icon="home" title="홈" description={`${longDateKo(today)} · ${greeting}${name ? `, ${name}님` : ''}`} />

      <div className={s.home}>
        <div className={s.reveal} style={stagger(0)}>
          <StatusCallout data={data} />
        </div>

        <div className={s.reveal} style={stagger(1)}>
          <SummaryTiles data={data} />
        </div>

        <section className={cx(s.section, s.reveal)} style={stagger(2)} aria-labelledby="ripple-title">
          <div className={s.sectionHead}>
            <H2 id="ripple-title">지연 파급</H2>
            <p className={s.sectionLead}>기한 지난 작업이 뒤따르는 일정을 얼마나 밀어내는지 미리 계산했어요.</p>
          </div>
          <div className={s.rippleGrid}>
            <RippleBoard data={data} />
            <WatchList data={data} chronic={chronic} />
          </div>
        </section>

        <div className={cx(s.columns, s.reveal)} style={stagger(3)}>
          <section className={s.col}>
            <H2>급한 업무</H2>
            <UrgentBoard today={today} doneToday={data.doneToday} onNew={newTask} />
          </section>

          <section className={s.col}>
            <H2>다가오는 일정</H2>
            <Database icon="calendar" title="이번 주" href="/upcoming" hrefLabel="예정 보기" onNew={newTask} newLabel="새 일정">
              {upcoming.length ? (
                <div className={s.list}>
                  {upcoming.slice(0, LIST_CAP).map(({ task, date }) => {
                    const project = projectOf(task.projectId);
                    return (
                      <ListRow
                        key={task.id}
                        icon={task.fixed ? 'pin' : 'fileText'}
                        iconColor={task.fixed ? 'var(--c-red)' : undefined}
                        title={task.title}
                        onOpen={() => selectTask(task.id)}
                      >
                        {project && <Tag hue={project.color}>{project.name}</Tag>}
                        <span className={s.rowDate}>{formatRelativeKo(date, today)}</span>
                      </ListRow>
                    );
                  })}
                  {upcoming.length > LIST_CAP && (
                    <ListRow
                      icon="calendar"
                      title={`외 ${upcoming.length - LIST_CAP}개 · 예정에서 모두 보기`}
                      onOpen={() => router.push('/upcoming')}
                      muted
                    />
                  )}
                </div>
              ) : (
                <NewPageBox label="새 일정" onClick={newTask} />
              )}
            </Database>
          </section>
        </div>

        <section className={cx(s.section, s.reveal)} style={stagger(4)}>
          <H2>진행 상황</H2>
          <ProjectsBoard groups={projectGroups} today={today} />
        </section>
      </div>
    </Page>
  );
}

/** Largest shift among tasks pushed by overdue work (the overdue tasks themselves don't count). */
function maxDownstreamShift(data: HomeData): number {
  return data.fc.impacts.reduce((m, im) => (im.kind === 'shifted' ? Math.max(m, im.shiftDays) : m), 0);
}

/* ───────────────────────── status callout */

function StatusCallout({ data }: { data: HomeData }) {
  const { level, remaining, overdue, doneToday, roots, delayed, conflicts, fc, today, fixed } = data;
  const [busy, setBusy] = useState(false);
  const { finishFrom, finishTo } = fc.summary;
  const maxShiftDays = maxDownstreamShift(data);
  const rel = (d: string) => formatRelativeKo(d, today);
  const finishShift = finishFrom && finishTo && finishFrom !== finishTo ? diffDays(finishTo, finishFrom) : 0;

  let pill: string;
  let headline: string;
  const details: string[] = [];
  if (level === 'danger') {
    pill = '위험';
    headline = `고정 일정 ${conflicts}개가 지켜지지 않을 수 있어요`;
    details.push(`기한 지난 작업 ${roots.length}개가 일정 ${delayed + conflicts}개를 밀고 있어요`);
  } else if (level === 'warn' && delayed > 0) {
    pill = '주의';
    headline = `일정 ${delayed}개가 최대 ${maxShiftDays}일 밀리고 있어요`;
    details.push(`기한 지난 작업 ${roots.length}개 때문이에요`);
  } else if (level === 'warn') {
    pill = '주의';
    headline = `기한 지난 작업이 ${overdue.length}개 있어요`;
    details.push('다행히 다른 일정엔 영향이 없어요');
  } else {
    pill = '순조로움';
    headline = remaining === 0 && doneToday.length > 0 ? '오늘 할 일을 모두 끝냈어요' : '모든 일정이 순조로워요';
    if (finishTo) details.push(`지금 계획대로면 ${rel(finishTo)}에 모두 끝나요`);
    if (fixed[0]) details.push(`다음 고정 일정은 ${rel(fixed[0].date)} ‘${fixed[0].task.title}’`);
  }
  if (finishShift > 0 && finishFrom && finishTo) details.push(`전체 완료 ${rel(finishFrom)} → ${rel(finishTo)}`);

  const canApply = level !== 'ok' && delayed > 0;
  const applyAll = async () => {
    setBusy(true);
    const changes = changesFromReport(fc, true);
    if (await reschedule(changes)) toast.show(`${changes.length}개 작업을 오늘 기준으로 다시 맞췄어요`);
    setBusy(false);
  };

  return (
    <div className={s.status} data-level={level} role="region" aria-label="지금 상황">
      <span className={s.statusIcon} aria-hidden="true">
        <Icon name={level === 'ok' ? 'checkCircle' : level === 'danger' ? 'alertCircle' : 'alert'} size={20} />
      </span>
      <div className={s.statusBody}>
        <div className={s.statusTop}>
          <span className={s.statusPill}>
            <span className={s.statusDot} />
            {pill}
          </span>
          <span className={s.statusHeadline}>{headline}</span>
        </div>
        {details.length > 0 && (
          <p className={s.statusDetail}>
            {details.map((d) => (
              <span key={d}>{d}</span>
            ))}
          </p>
        )}
      </div>
      <div className={s.statusActions}>
        {canApply && (
          <button className={s.btnPrimary} onClick={() => void applyAll()} disabled={busy}>
            {busy ? <Spinner /> : <Icon name="bolt" size={15} />}
            오늘 기준으로 재조정
          </button>
        )}
        <Link href={level === 'ok' ? '/today' : '/forecast'} className={s.btnGhost}>
          {level === 'ok' ? '오늘 보기' : '파급 예측'}
          <Icon name="arrowRight" size={14} />
        </Link>
      </div>
    </div>
  );
}

/* ───────────────────────── summary tiles */

function SummaryTiles({ data }: { data: HomeData }) {
  const { remaining, doneToday, doing, overdue, oldestOverdue, delayed, conflicts, fc, today, fixed } = data;
  const { finishFrom, finishTo } = fc.summary;
  const maxShiftDays = maxDownstreamShift(data);
  const finishShift = finishFrom && finishTo && finishFrom !== finishTo ? diffDays(finishTo, finishFrom) : 0;
  const totalToday = remaining + doneToday.length;
  const pct = totalToday ? Math.round((doneToday.length / totalToday) * 100) : 0;
  const nextFixed = fixed.find((f) => f.conflict) ?? fixed[0];

  return (
    <div className={s.tiles}>
      <Tile href="/today" icon="sun" label="오늘 남은 작업" value={remaining} unit="개" index={0}>
        <span className={s.tileMeta}>
          완료 {doneToday.length}개{doing > 0 ? ` · 진행 중 ${doing}개` : ''}
        </span>
        <span className={s.tileTrack} aria-hidden="true">
          <span className={s.tileBar} style={{ width: `${pct}%` }} />
        </span>
      </Tile>
      <Tile href="/today" icon="alertCircle" label="기한 지남" value={overdue.length} unit="개" tone={overdue.length ? 'danger' : undefined} index={1}>
        <span className={s.tileMeta}>{overdue.length ? `가장 오래된 작업 ${oldestOverdue}일 지남` : '밀린 작업이 없어요'}</span>
      </Tile>
      <Tile href="/forecast" icon="ripple" label="밀리는 작업" value={delayed} unit="개" tone={delayed ? 'warn' : undefined} index={2}>
        <span className={s.tileMeta}>{delayed ? `최대 ${maxShiftDays}일 늦어져요` : '영향받는 일정 없음'}</span>
      </Tile>
      <Tile href="/forecast" icon="pin" label="고정 일정 충돌" value={conflicts} unit="개" tone={conflicts ? 'danger' : undefined} index={3}>
        <span className={s.tileMeta}>
          {nextFixed ? `${nextFixed.conflict ? '위험 ' : '다음 '}${formatRelativeKo(nextFixed.date, today)} · ${nextFixed.task.title}` : '30일 안에 고정 일정 없음'}
        </span>
      </Tile>
      <Tile
        href="/forecast"
        icon="flag"
        label="전체 완료 예상"
        text={finishTo ? formatShortKo(finishTo) : '—'}
        tone={finishShift > 0 ? 'warn' : undefined}
        index={4}
      >
        <span className={s.tileMeta}>
          {finishShift > 0 ? `원래보다 ${finishShift}일 늦어져요` : finishTo ? `${Math.max(0, diffDays(finishTo, today))}일 남음 · 계획대로` : '날짜 있는 작업이 없어요'}
        </span>
      </Tile>
    </div>
  );
}

function Tile({
  href,
  icon,
  label,
  value,
  text,
  unit,
  tone,
  index,
  children,
}: {
  href: string;
  icon: IconName;
  label: string;
  value?: number;
  text?: string;
  unit?: string;
  tone?: 'danger' | 'warn';
  index: number;
  children?: ReactNode;
}) {
  const n = useCountUp(value ?? 0);
  return (
    <Link href={href} className={s.tile} data-tone={tone} style={stagger(index)}>
      <span className={s.tileLabel}>
        <Icon name={icon} size={15} />
        {label}
      </span>
      <span className={s.tileValue}>
        {text ?? n}
        {text === undefined && unit && <span className={s.tileUnit}>{unit}</span>}
      </span>
      {children}
    </Link>
  );
}

/* ───────────────────────── 지연 파급 */

function RippleBoard({ data }: { data: HomeData }) {
  const { roots, fc, today } = data;
  const shown = roots.slice(0, ROOT_CAP);

  if (!roots.length) {
    const finish = fc.summary.finishTo ?? fc.summary.finishFrom;
    return (
      <div className={s.calm}>
        <span className={s.calmMark} aria-hidden="true">
          <Icon name="check" size={22} strokeWidth={2.4} />
        </span>
        <div>
          <div className={s.calmTitle}>밀리는 일정이 없어요</div>
          <div className={s.calmBody}>
            {finish ? `지금 계획대로면 ${formatRelativeKo(finish, today)}에 모두 끝나요.` : '날짜와 선행 작업을 넣으면 지연을 미리 계산해 드려요.'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={s.ripples}>
      {shown.map((r, i) => (
        <RippleCard key={r.task.id} root={r} today={today} index={i} />
      ))}
      {roots.length > shown.length && (
        <Link href="/forecast" className={s.rippleMore}>
          기한 지난 작업 {roots.length - shown.length}개 더 · 파급 예측에서 보기
          <Icon name="arrowRight" size={14} />
        </Link>
      )}
    </div>
  );
}

function impactDate(im: TaskImpact): string | null {
  return im.to.dueDate ?? im.to.startDate;
}

function RippleCard({ root, today, index }: { root: RootRisk; today: string; index: number }) {
  const { task, days, report } = root;
  const impacts = report.impacts
    .filter((im) => im.kind === 'shifted' || im.kind === 'conflict')
    .sort((a, b) => a.depth - b.depth || (b.kind === 'conflict' ? 1 : 0) - (a.kind === 'conflict' ? 1 : 0) || b.shiftDays - a.shiftDays);
  const shown = impacts.slice(0, IMPACT_CAP);
  const { delayedCount, conflictCount } = report.summary;

  return (
    <article className={s.ripple} style={stagger(index)} data-conflict={conflictCount > 0 || undefined}>
      <div className={s.rippleRoot}>
        <button
          className={s.rippleCheck}
          onClick={() => void toggleDone(task.id)}
          aria-label={`${task.title} 완료로 표시`}
          {...tip('완료하면 파급이 사라져요', { side: 'top', kbd: 'X' })}
        >
          <Icon name="check" size={12} strokeWidth={3} />
        </button>
        <button className={s.rippleRootMain} onClick={() => selectTask(task.id)}>
          <span className={s.rippleNum}>#{task.number}</span>
          <span className={s.rippleTitle}>{task.title}</span>
        </button>
        <span className={s.rippleBadge} data-tone="danger">
          {days === 1 ? '어제 마감' : `${days}일 지남`}
        </span>
      </div>

      {shown.length ? (
        <ol className={s.chain}>
          {shown.map((im, i) => {
            const conflict = im.kind === 'conflict';
            const d = impactDate(im);
            return (
              <li key={im.taskId} className={s.link} style={{ ...stagger(i), paddingLeft: `${Math.min(im.depth - 1, 2) * 18}px` }}>
                <button className={s.linkBtn} data-conflict={conflict || undefined} onClick={() => selectTask(im.taskId)}>
                  <span className={s.linkIcon}>
                    <Icon name={conflict ? 'pin' : 'arrowRight'} size={13} strokeWidth={2} />
                  </span>
                  <span className={s.linkTitle}>
                    {im.number !== undefined && <span className={s.rippleNum}>#{im.number}</span>}
                    {im.title}
                  </span>
                  <span className={s.linkMeta}>
                    {conflict ? (
                      <span className={s.rippleBadge} data-tone="danger">
                        고정 일정 충돌 · {im.overrunDays}일 초과
                      </span>
                    ) : (
                      <>
                        {d && <span className={s.linkDate}>→ {formatRelativeKo(d, today)}</span>}
                        <span className={s.rippleBadge} data-tone="warn">
                          +{im.shiftDays}일
                        </span>
                      </>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className={s.rippleNone}>뒤따르는 일정엔 영향이 없어요. 오늘 끝내면 그만이에요.</p>
      )}

      {(impacts.length > shown.length || delayedCount + conflictCount > 0) && (
        <div className={s.rippleFoot}>
          <span>
            {delayedCount > 0 && `작업 ${delayedCount}개 밀림`}
            {delayedCount > 0 && conflictCount > 0 && ' · '}
            {conflictCount > 0 && `고정 일정 ${conflictCount}개 충돌`}
            {impacts.length > shown.length && ` · 외 ${impacts.length - shown.length}개`}
          </span>
        </div>
      )}
    </article>
  );
}

function WatchList({ data, chronic }: { data: HomeData; chronic: Task[] }) {
  const { key } = data;
  return (
    <aside className={s.watch} aria-label="주의할 작업">
      <div className={s.watchHead}>
        <Icon name="target" size={16} />
        핵심 작업
        <span className={s.watchCount}>{key.total}</span>
      </div>
      {key.items.length ? (
        <ul className={s.watchList}>
          {key.items.map(({ task, lev }) => (
            <li key={task.id}>
              <button className={s.watchRow} onClick={() => selectTask(task.id)}>
                <span className={s.watchTitle}>
                  <span className={s.rippleNum}>#{task.number}</span>
                  {task.title}
                </span>
                <span className={s.watchMeta}>
                  하루 늦으면 {lev.delayedIfLate}개 밀림{lev.conflictsIfLate > 0 ? ` · 충돌 ${lev.conflictsIfLate}` : ''}
                </span>
                <span className={s.watchSlack} data-tight={lev.slackDays === 0 || undefined}>
                  {lev.slackDays === null ? '여유 —' : lev.slackDays === 0 ? '여유 없음' : `여유 ${lev.slackDays}일`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={s.watchEmpty}>
          {key.linked ? '하루 늦어도 다른 일정에 영향이 없어요.' : '선행 작업을 연결하면 일정 전체를 흔드는 작업을 찾아 드려요.'}
        </p>
      )}

      {chronic.length > 0 && (
        <>
          <div className={cx(s.watchHead, s.watchHeadSub)}>
            <Icon name="postpone" size={16} />
            자주 미룬 작업
          </div>
          <ul className={s.watchList}>
            {chronic.map((t) => (
              <li key={t.id}>
                <button className={s.watchRow} onClick={() => selectTask(t.id)}>
                  <span className={s.watchTitle}>
                    <span className={s.rippleNum}>#{t.number}</span>
                    {t.title}
                  </span>
                  <span className={s.watchSlack} data-tight="true">
                    {t.postponedCount}번 미룸
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}

/* ───────────────────────── projects board */

function ProjectsBoard({
  groups,
  today,
}: {
  groups: { started: ProjectRow[]; notStarted: ProjectRow[]; finished: ProjectRow[] };
  today: string;
}) {
  const router = useRouter();
  const app = useApp();
  const [adding, setAdding] = useState<null | 'started' | 'notStarted'>(null);
  const [name, setName] = useState('');

  const submit = async () => {
    const n = name.trim();
    setAdding(null);
    setName('');
    if (!n) return;
    const active = app.projects.filter((p) => !p.archivedAt).length;
    const color = PROJECT_COLORS[(active + 6) % PROJECT_COLORS.length] as ProjectColor;
    const p = await createProject({ name: n, color });
    if (p) router.push(`/projects/${p.id}`);
  };

  const footer = (key: 'started' | 'notStarted') =>
    adding === key ? (
      <div className={s.columnInput}>
        <Icon name="folder" size={16} />
        <input
          autoFocus
          placeholder="프로젝트 이름"
          aria-label="새 프로젝트 이름"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void submit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submit();
            if (e.key === 'Escape') {
              setAdding(null);
              setName('');
            }
          }}
        />
      </div>
    ) : (
      <ColumnAdd label="새 프로젝트" onClick={() => setAdding(key)} />
    );

  const card = (r: ProjectRow, i: number) => {
    const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
    const left = r.total - r.done;
    return (
      <BoardCard key={r.project.id} icon="folder" iconColor={`var(--c-${r.project.color})`} title={r.project.name} href={`/projects/${r.project.id}`} index={i}>
        {(r.slip || (r.finish && left > 0)) && (
          <CardProps>
            {r.slip ? <Tag hue="orange">지연 +{r.slip.shiftDays}일</Tag> : <Tag hue="green">순조</Tag>}
            {left > 0 && <Tag hue="slate">남은 작업 {left}</Tag>}
          </CardProps>
        )}
        {r.finish && left > 0 && <CardMeta icon="flag">{formatRelativeKo(r.slip?.to ?? r.finish, today)} 완료 예상</CardMeta>}
        {r.total > 0 ? <CardProgress pct={pct} label={`${r.project.name} 완료 비율`} /> : <CardMeta>아직 작업이 없어요</CardMeta>}
      </BoardCard>
    );
  };

  return (
    <Database icon="folder" title="프로젝트" href="/all" hrefLabel="전체 작업 보기" onNew={() => setAdding('notStarted')} newLabel="새 프로젝트">
      <Board label="프로젝트 보드">
        <Column hue="green" title="진행 중" count={groups.started.length} footer={footer('started')}>
          {groups.started.map(card)}
        </Column>
        <Column hue="amber" title="시작 전" count={groups.notStarted.length} footer={footer('notStarted')}>
          {groups.notStarted.map(card)}
        </Column>
        <Column hue="blue" title="완료" count={groups.finished.length}>
          {groups.finished.map(card)}
        </Column>
      </Board>
    </Database>
  );
}

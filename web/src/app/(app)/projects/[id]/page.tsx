'use client';

import { compareTasks, formatRelativeKo, PROJECT_COLORS, type ImpactReport, type TaskImpact } from '@obelisk/core';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { ImpactView } from '@/components/ImpactView';
import { Badge, buttonClass, ConfirmModal, isEnter, Popover, Progress, tip, ui, useDisclosure } from '@/components/primitives';
import { QuickAdd } from '@/components/QuickAdd';
import { Timeline } from '@/components/Timeline';
import { EmptyState, Page, TaskGroup, ViewHeader } from '@/components/View';
import { useForecast, usePref, useTasks } from '@/lib/hooks';
import { deleteProject, updateProject, useApp } from '@/lib/store';
import { setUi } from '@/lib/ui-state';
import s from '../../views.module.css';

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { projects, today } = useApp();
  const project = projects.find((p) => p.id === id);
  const tasks = useTasks();
  const fc = useForecast();
  const [mode, setMode] = usePref<'list' | 'timeline'>(`project-mode`, 'list');
  const [name, setName] = useState(project?.name ?? '');
  const menuRef = useRef<HTMLButtonElement>(null);
  const menu = useDisclosure();
  const del = useDisclosure();

  useEffect(() => setName(project?.name ?? ''), [project?.name]);

  const data = useMemo(() => {
    const mine = tasks.filter((t) => t.projectId === id);
    const active = mine.filter((t) => t.status === 'todo' || t.status === 'doing').sort(compareTasks);
    const done = mine.filter((t) => t.status === 'done').sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
    const finish = active.map((t) => t.dueDate ?? t.startDate).filter(Boolean).sort().at(-1) ?? null;
    return { mine, active, done, finish };
  }, [tasks, id]);

  // Only the part of the live forecast that actually reaches this project: its pushed or
  // conflicting tasks plus the upstream chain (possibly in other projects) that causes them.
  const risk = useMemo(() => {
    const touched = fc.impacts.filter((im) => im.projectId === id && (im.kind === 'shifted' || im.kind === 'conflict'));
    const byId = new Map(fc.impacts.map((im) => [im.taskId, im]));
    const keep = new Set<string>();
    for (const im of touched) {
      let cur: TaskImpact | undefined = im;
      while (cur && !keep.has(cur.taskId)) {
        keep.add(cur.taskId);
        cur = cur.viaId ? byId.get(cur.viaId) : undefined;
      }
    }
    const impacts = fc.impacts.filter((im) => keep.has(im.taskId));
    const slip = fc.summary.projectSlips.find((p) => p.projectId === id);
    const report: ImpactReport = {
      rootIds: fc.rootIds.filter((r) => keep.has(r)),
      impacts,
      summary: {
        ...fc.summary,
        delayedCount: impacts.filter((im) => im.kind === 'shifted').length,
        conflictCount: impacts.filter((im) => im.kind === 'conflict').length,
        absorbedCount: 0,
        unscheduledCount: 0,
        maxShiftDays: Math.max(0, ...impacts.map((im) => (im.kind === 'conflict' ? im.overrunDays : im.shiftDays))),
        projectSlips: slip ? [slip] : [],
      },
    };
    return { touched, slip, report };
  }, [fc, id]);

  if (!project) {
    return (
      <Page>
        <EmptyState
          icon="folder"
          title="프로젝트를 찾을 수 없어요"
          body="삭제되었거나 보관된 프로젝트일 수 있어요."
          action={
            <Link href="/all" className={buttonClass({ variant: 'outline', size: 'sm' })}>
              <Icon name="layers" size={15} />
              전체 작업 보기
            </Link>
          }
        />
      </Page>
    );
  }

  const total = data.active.length + data.done.length;
  const pct = total ? Math.round((data.done.length / total) * 100) : 0;

  return (
    <Page wide={mode === 'timeline'}>
      <ViewHeader
        icon="folder"
        iconColor={`var(--c-${project.color})`}
        title={
          <span className={s.projectTitle}>
            {/* The hidden mirror sizes the field to its text, so the name reads like a heading. */}
            <span className={s.nameField}>
              <span className={s.nameMirror} aria-hidden="true">
                {name || '프로젝트 이름'}
              </span>
              <input
                className={s.projectName}
                value={name}
                placeholder="프로젝트 이름"
                onChange={(e) => setName(e.target.value)}
                onBlur={() => name.trim() && name.trim() !== project.name ? void updateProject(project.id, { name: name.trim() }) : setName(project.name)}
                onKeyDown={(e) => isEnter(e) && (e.target as HTMLInputElement).blur()}
                aria-label="프로젝트 이름"
              />
            </span>
          </span>
        }
        actions={
          <>
            <div className={ui.segmented} data-size="sm" role="group" aria-label="보기 방식">
              <button className={ui.segment} aria-pressed={mode === 'list'} onClick={() => setMode('list')}>
                <Icon name="list" size={14} /> 리스트
              </button>
              <button className={ui.segment} aria-pressed={mode === 'timeline'} onClick={() => setMode('timeline')}>
                <Icon name="timeline" size={14} /> 타임라인
              </button>
            </div>
            <button
              ref={menuRef}
              className={buttonClass({ variant: 'outline', size: 'sm', icon: true })}
              onClick={menu.toggle}
              aria-label="프로젝트 메뉴"
              aria-haspopup="dialog"
              aria-expanded={menu.open}
              {...tip('색상 · 보관 · 삭제', { side: 'bottom' })}
            >
              <Icon name="more" size={18} />
            </button>
            <Popover anchor={menuRef} open={menu.open} onClose={menu.close} align="end" width={208}>
              <div className={ui.menuTitle}>색상</div>
              <div className={s.colorGrid}>
                {PROJECT_COLORS.map((c) => (
                  <button
                    key={c}
                    className={s.colorBtn}
                    data-selected={project.color === c}
                    style={{ background: `var(--c-${c})` }}
                    onClick={() => void updateProject(project.id, { color: c })}
                    aria-label={c}
                  >
                    {project.color === c && <Icon name="check" size={14} strokeWidth={3} />}
                  </button>
                ))}
              </div>
              <div className={ui.menuSep} />
              <button
                className={ui.menuItem}
                onClick={async () => {
                  menu.close();
                  await updateProject(project.id, { archived: true });
                  router.push('/all');
                }}
              >
                <Icon name="archive" size={15} /> 보관
              </button>
              <button className={ui.menuItem} data-tone="danger" onClick={() => (menu.close(), del.setOpen(true))}>
                <Icon name="trash" size={15} /> 삭제…
              </button>
            </Popover>
          </>
        }
      >
        <div className={s.stats}>
          <div className={s.statProgress}>
            <Progress value={pct} size="sm" label="완료 비율" className={s.statBar} tone={total > 0 && pct === 100 ? 'ok' : undefined} />
            <span>
              <strong className={s.statStrong}>
                {data.done.length}/{total}
              </strong>{' '}
              완료
            </span>
            {total > 0 && <span className={s.statMuted}>{pct}%</span>}
          </div>
          {data.finish && (
            <Badge tone="outline" className={s.statBadge}>
              <Icon name="flag" size={12} />
              예상 완료 {formatRelativeKo(data.finish, today)}
            </Badge>
          )}
          {risk.slip && (
            <Badge tone="warn" className={s.statBadge}>
              <Icon name="ripple" size={12} />
              지연 예측 +{risk.slip.shiftDays}일 ({formatRelativeKo(risk.slip.to, today)} 완료)
            </Badge>
          )}
        </div>
      </ViewHeader>

      {mode === 'timeline' ? (
        <Timeline tasks={[...data.active, ...data.done.slice(0, 20)]} />
      ) : (
        <>
          <QuickAdd projectId={project.id} placeholder={`${project.name}에 할 일 추가`} />
          {risk.touched.length > 0 && (
            <section className={s.impact} aria-label="이 프로젝트에 닿는 지연">
              <div className={s.impactHead}>
                <span className={s.impactTitle}>
                  <Icon name="ripple" size={14} />
                  이 프로젝트에 닿는 지연
                </span>
                <Link href="/forecast" className={s.impactLink}>
                  파급 예측 열기
                  <Icon name="chevronRight" size={14} />
                </Link>
              </div>
              <ImpactView report={risk.report} />
            </section>
          )}
          <TaskGroup tasks={data.active} showProject={false} />
          {data.active.length === 0 && (
            <EmptyState
              icon="folder"
              title="진행 중인 작업이 없어요"
              body="작업을 추가하고, 상세 패널에서 ‘먼저 끝나야 하는 작업’을 연결하면 지연 예측이 시작돼요."
              action={
                <button type="button" className={buttonClass({ variant: 'outline', size: 'sm' })} onClick={() => setUi({ quickAdd: true })}>
                  <Icon name="plus" size={15} />
                  새 작업
                  <kbd>N</kbd>
                </button>
              }
            />
          )}
          <TaskGroup title="완료" tone="muted" tasks={data.done} showProject={false} collapsible defaultCollapsed />
        </>
      )}

      <ConfirmModal
        open={del.open}
        onClose={del.close}
        title="프로젝트를 삭제할까요?"
        body={`“${project.name}” 프로젝트가 삭제되고, 안의 작업 ${data.mine.length}개는 인박스로 옮겨져요.`}
        onConfirm={async () => {
          if (await deleteProject(project.id)) router.push('/inbox');
        }}
      />
    </Page>
  );
}

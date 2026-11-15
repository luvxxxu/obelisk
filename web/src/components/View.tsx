'use client';

import type { Task } from '@obelisk/core';
import { useState, type ReactNode } from 'react';
import { Icon, Logo, type IconName } from './Icon';
import { TaskRow } from './TaskRow';
import s from './View.module.css';

/**
 * Notion-style page header: a large page icon, a 40px bold title, one muted description line.
 * `actions` sit at the right of the title row; `children` render under the description.
 * `subtitle` and `description` are aliases. `logo` shows the Obelisk mark instead of `icon`.
 */
export function ViewHeader({
  title,
  subtitle,
  description,
  icon,
  iconColor,
  logo = false,
  actions,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  description?: ReactNode;
  icon?: IconName;
  iconColor?: string;
  logo?: boolean;
  /** @deprecated the page icon is always shown now */
  showIcon?: boolean;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const desc = description ?? subtitle;
  return (
    <header className={s.header}>
      {(logo || icon) && (
        <div className={s.pageIcon} style={iconColor ? { color: iconColor } : undefined} aria-hidden="true">
          {logo ? <Logo size={60} /> : <Icon name={icon!} size={64} strokeWidth={1.35} />}
        </div>
      )}
      <div className={s.titleRow}>
        <h1 className={s.title}>
          <span className={s.titleText}>{title}</span>
        </h1>
        {actions && <div className={s.actions}>{actions}</div>}
      </div>
      {desc && <div className={s.subtitle}>{desc}</div>}
      {children}
    </header>
  );
}

export function TaskGroup({
  title,
  tasks,
  tone,
  showProject = true,
  showDate = true,
  collapsible = false,
  defaultCollapsed = false,
  aside,
  empty,
}: {
  title?: ReactNode;
  tasks: Task[];
  tone?: 'danger' | 'accent' | 'muted';
  showProject?: boolean;
  showDate?: boolean;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  aside?: ReactNode;
  empty?: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  if (!tasks.length && !empty) return null;
  return (
    <section className={s.group} data-tone={tone}>
      {title && (
        <div className={s.groupHeader} data-tone={tone}>
          {collapsible ? (
            <button className={s.groupToggle} onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>
              <span className={s.chevron} data-open={!collapsed}>
                <Icon name="chevronRight" size={14} strokeWidth={2} />
              </span>
              <span className={s.groupTitle}>{title}</span>
              {tasks.length > 0 && <span className={s.count}>{tasks.length}</span>}
            </button>
          ) : (
            <>
              <span className={s.groupTitle}>{title}</span>
              {tasks.length > 0 && <span className={s.count}>{tasks.length}</span>}
            </>
          )}
          {aside && <div className={s.groupAside}>{aside}</div>}
        </div>
      )}
      {!collapsed && (
        <div className={s.rows}>
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} showProject={showProject} showDate={showDate} />
          ))}
          {!tasks.length && empty && <div className={s.groupEmpty}>{empty}</div>}
        </div>
      )}
    </section>
  );
}

/** Friendly, centred empty block. Use `action` for a button (e.g. 새 작업) and `children` for extras. */
export function EmptyState({
  icon,
  title,
  body,
  action,
  children,
}: {
  icon: IconName;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={s.empty}>
      <div className={s.emptyIcon}>
        <Icon name={icon} size={20} strokeWidth={1.75} />
      </div>
      <div className={s.emptyTitle}>{title}</div>
      {body && <div className={s.emptyBody}>{body}</div>}
      {action && <div className={s.emptyAction}>{action}</div>}
      {children}
    </div>
  );
}

/** Page container: Notion default width (760px content), `wide` = full width. Both keep --page-pad gutters. */
export function Page({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <div className={wide ? s.pageWide : s.page}>{children}</div>;
}

'use client';

import Link from 'next/link';
import type { CSSProperties, KeyboardEventHandler, PointerEventHandler, ReactNode, Ref } from 'react';
import { Icon, type IconName } from '@/components/Icon';
import { tip, ui } from '@/components/primitives';
import { cx } from '@/lib/format';
import { setUi } from '@/lib/ui-state';
import s from '../home.module.css';

/**
 * Building blocks for the Home page: inline list header (title + toolbar), board columns/cards,
 * list rows, tags. Purely presentational: callers pass data and handlers.
 */

export type Hue = 'slate' | 'red' | 'orange' | 'amber' | 'green' | 'teal' | 'blue' | 'indigo' | 'violet' | 'pink';

export function hueVars(hue: Hue): CSSProperties {
  return {
    '--hue': `var(--c-${hue})`,
    '--hue-bg': `var(--c-${hue}-bg)`,
    '--hue-text': `var(--c-${hue}-text)`,
    '--hue-soft': `var(--c-${hue}-soft)`,
  } as CSSProperties;
}

export function Tag({ hue = 'slate', children, dot = false }: { hue?: Hue; children: ReactNode; dot?: boolean }) {
  return (
    <span className={s.tag} style={hueVars(hue)} data-dot={dot || undefined}>
      {dot && <span className={s.tagDot} aria-hidden="true" />}
      {children}
    </span>
  );
}

/** Inline list header: a small title on the left, a few quiet tools and "새로 만들기" on the right. */
export function Database({
  icon,
  title,
  href,
  hrefLabel,
  onNew,
  newLabel = '새로 만들기',
  tools,
  children,
}: {
  icon: IconName;
  title: string;
  href?: string;
  hrefLabel?: string;
  onNew?: () => void;
  newLabel?: string;
  /** Extra toolbar controls, left of search. */
  tools?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={s.db}>
      <div className={s.dbHead}>
        <div className={s.dbTitle}>
          <Icon name={icon} size={16} />
          {href ? (
            <Link href={href} className={s.dbTitleLink}>
              {title}
            </Link>
          ) : (
            <span>{title}</span>
          )}
        </div>
        <div className={s.dbTools}>
          {tools}
          <button className={ui.iconBtn} onClick={() => setUi({ palette: true })} aria-label="검색" {...tip('검색', { side: 'bottom' })}>
            <Icon name="search" size={16} />
          </button>
          {href && (
            <Link href={href} className={ui.iconBtn} aria-label={hrefLabel ?? '전체 보기'} {...tip(hrefLabel ?? '전체 보기', { side: 'bottom' })}>
              <Icon name="maximize" size={15} />
            </Link>
          )}
          {onNew && (
            <button className={cx(ui.btn, ui.outline, ui.sm, s.dbNew)} onClick={onNew}>
              {newLabel}
            </button>
          )}
        </div>
      </div>
      {children}
    </section>
  );
}

export function Board({
  children,
  label,
  ref,
  dragging,
}: {
  children: ReactNode;
  label: string;
  ref?: Ref<HTMLDivElement>;
  /** A card is lifted (drag in progress). */
  dragging?: boolean;
}) {
  return (
    <div className={s.board} role="list" aria-label={label} ref={ref} data-dragging={dragging || undefined}>
      {children}
    </div>
  );
}

export function Column({
  hue,
  title,
  count,
  children,
  footer,
  dropKey,
  dropTarget,
  ghost,
}: {
  hue: Hue;
  title: string;
  count: number;
  children?: ReactNode;
  footer?: ReactNode;
  /** Makes the column a drop target for useBoardDnd. */
  dropKey?: string;
  /** The lifted card would land here. */
  dropTarget?: boolean;
  /** Shown only while dragging (e.g. an empty 완료 column to drop into). */
  ghost?: boolean;
}) {
  return (
    <div
      className={s.column}
      style={hueVars(hue)}
      role="listitem"
      aria-label={`${title} ${count}개`}
      data-col={dropKey}
      data-drop-target={dropTarget || undefined}
      data-ghost={ghost || undefined}
    >
      <div className={s.columnHead}>
        <span className={s.columnTitle}>{title}</span>
        <span className={s.columnCount}>{count}</span>
      </div>
      <div className={s.columnCards} data-col-cards={dropKey ? '' : undefined}>
        {children}
      </div>
      {footer}
    </div>
  );
}

/** Where a lifted card will land. Carries the card's FLIP id so the real card takes over its box. */
export function CardSlot({ id, height }: { id: string; height: number }) {
  return <div className={s.cardSlot} style={{ height }} data-placeholder="" data-flip={id} data-flip-still="" aria-hidden="true" />;
}

/** Empty drop area, e.g. "여기에 놓으면 완료". */
export function DropHint({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <div className={s.dropHint}>
      <Icon name={icon} size={15} />
      {children}
    </div>
  );
}

export function ColumnAdd({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className={s.columnAdd} onClick={onClick}>
      <Icon name="plus" size={15} />
      {label}
    </button>
  );
}

export function ColumnMore({ href, n }: { href: string; n: number }) {
  return (
    <Link href={href} className={s.columnMore}>
      외 {n}개 더 보기
    </Link>
  );
}

/** Board card. Renders as a link when `href` is set, otherwise as a button. */
export function BoardCard({
  icon,
  iconColor,
  title,
  done,
  href,
  onOpen,
  aside,
  index = 0,
  dragId,
  onPointerDown,
  onKeyDown,
  keyShortcuts,
  actions,
  children,
}: {
  /** Optional leading glyph (e.g. a project's folder); plain task cards have none. */
  icon?: IconName;
  iconColor?: string;
  title: string;
  done?: boolean;
  index?: number;
  href?: string;
  onOpen?: () => void;
  aside?: ReactNode;
  /** Task id when the card can be dragged (useBoardDnd + FLIP). */
  dragId?: string;
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  /** aria-keyshortcuts on the card button. */
  keyShortcuts?: string;
  /** Number of hover buttons in `aside` (room is reserved on touch screens). */
  actions?: number;
  children?: ReactNode;
}) {
  const inner = (
    <>
      <span className={s.cardTitle} data-done={done || undefined}>
        {icon && (
          <span className={s.cardIcon} style={iconColor ? { color: iconColor } : undefined}>
            <Icon name={icon} size={16} />
          </span>
        )}
        <span className={s.cardTitleText}>{title}</span>
      </span>
      {children}
    </>
  );
  return (
    <div
      className={s.cardWrap}
      style={{ '--i': index } as CSSProperties}
      data-card={dragId}
      data-flip={dragId}
      data-actions={actions}
      onPointerDown={onPointerDown}
    >
      {href ? (
        <Link href={href} className={s.card}>
          {inner}
        </Link>
      ) : (
        <button type="button" className={s.card} onClick={onOpen} onKeyDown={onKeyDown} aria-keyshortcuts={keyShortcuts} data-card-main="">
          {inner}
        </button>
      )}
      {aside && (
        <div className={s.cardAside} data-no-drag="">
          {aside}
        </div>
      )}
    </div>
  );
}

export function CardProps({ children }: { children: ReactNode }) {
  return <span className={s.cardProps}>{children}</span>;
}

export function CardMeta({ icon, tone, children }: { icon?: IconName; tone?: 'danger' | 'warn'; children: ReactNode }) {
  return (
    <span className={s.cardMeta} data-tone={tone}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </span>
  );
}

export function CardProgress({ pct, label }: { pct: number; label: string }) {
  return (
    <span className={s.cardProgress}>
      <span className={s.cardPct}>{pct}%</span>
      <span className={s.cardTrack} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <span className={s.cardBar} style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

export function ListRow({
  icon,
  iconColor,
  title,
  onOpen,
  children,
  muted,
}: {
  icon?: IconName;
  iconColor?: string;
  title: string;
  onOpen: () => void;
  children?: ReactNode;
  muted?: boolean;
}) {
  return (
    <button type="button" className={cx(s.row, muted && s.rowMuted)} onClick={onOpen}>
      {icon && (
        <span className={s.rowIcon} style={iconColor ? { color: iconColor } : undefined}>
          <Icon name={icon} size={16} />
        </span>
      )}
      <span className={s.rowTitle}>{title}</span>
      <span className={s.rowProps}>{children}</span>
    </button>
  );
}

export function NewPageBox({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className={s.newBox} onClick={onClick}>
      <Icon name="plus" size={15} />
      {label}
    </button>
  );
}

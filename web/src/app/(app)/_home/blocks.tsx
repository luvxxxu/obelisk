'use client';

import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { Icon, type IconName } from '@/components/Icon';
import { tip } from '@/components/primitives';
import { cx } from '@/lib/format';
import { setUi } from '@/lib/ui-state';
import s from '../home.module.css';

/**
 * Notion-like building blocks for the Home page: H2, inline database (title + toolbar),
 * board columns/cards, list rows, tags. Purely presentational — callers pass data and handlers.
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

export function H2({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h2 className={s.h2} id={id}>
      {children}
    </h2>
  );
}

export function Tag({ hue = 'slate', children, dot = false }: { hue?: Hue; children: ReactNode; dot?: boolean }) {
  return (
    <span className={s.tag} style={hueVars(hue)} data-dot={dot || undefined}>
      {dot && <span className={s.tagDot} aria-hidden="true" />}
      {children}
    </span>
  );
}

/** Inline database header: icon + title on the left, a few tools and a blue "새로 만들기" on the right. */
export function Database({
  icon,
  title,
  href,
  hrefLabel,
  onNew,
  newLabel = '새로 만들기',
  children,
}: {
  icon: IconName;
  title: string;
  href?: string;
  hrefLabel?: string;
  onNew?: () => void;
  newLabel?: string;
  children: ReactNode;
}) {
  return (
    <section className={s.db}>
      <div className={s.dbHead}>
        <div className={s.dbTitle}>
          <Icon name={icon} size={20} strokeWidth={1.9} />
          {href ? (
            <Link href={href} className={s.dbTitleLink}>
              {title}
            </Link>
          ) : (
            <span>{title}</span>
          )}
        </div>
        <div className={s.dbTools}>
          <button className={s.dbTool} onClick={() => setUi({ palette: true })} aria-label="검색" {...tip('검색', { side: 'bottom' })}>
            <Icon name="search" size={16} />
          </button>
          {href && (
            <Link href={href} className={s.dbTool} aria-label={hrefLabel ?? '전체 보기'} {...tip(hrefLabel ?? '전체 보기', { side: 'bottom' })}>
              <Icon name="maximize" size={15} />
            </Link>
          )}
          {onNew && (
            <button className={s.dbNew} onClick={onNew}>
              {newLabel}
            </button>
          )}
        </div>
      </div>
      {children}
    </section>
  );
}

export function Board({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className={s.board} role="list" aria-label={label}>
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
}: {
  hue: Hue;
  title: string;
  count: number;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className={s.column} style={hueVars(hue)} role="listitem" aria-label={`${title} ${count}개`}>
      <div className={s.columnHead}>
        <Tag hue={hue} dot>
          {title}
        </Tag>
        <span className={s.columnCount}>{count}</span>
      </div>
      <div className={s.columnCards}>{children}</div>
      {footer}
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
  children,
}: {
  icon: IconName;
  iconColor?: string;
  title: string;
  done?: boolean;
  index?: number;
  href?: string;
  onOpen?: () => void;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  const inner = (
    <>
      <span className={s.cardTitle} data-done={done || undefined}>
        <span className={s.cardIcon} style={iconColor ? { color: iconColor } : undefined}>
          <Icon name={icon} size={17} />
        </span>
        <span className={s.cardTitleText}>{title}</span>
      </span>
      {children}
    </>
  );
  return (
    <div className={s.cardWrap} style={{ '--i': index } as CSSProperties}>
      {href ? (
        <Link href={href} className={s.card}>
          {inner}
        </Link>
      ) : (
        <button type="button" className={s.card} onClick={onOpen}>
          {inner}
        </button>
      )}
      {aside && <div className={s.cardAside}>{aside}</div>}
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
  icon: IconName;
  iconColor?: string;
  title: string;
  onOpen: () => void;
  children?: ReactNode;
  muted?: boolean;
}) {
  return (
    <button type="button" className={cx(s.row, muted && s.rowMuted)} onClick={onOpen}>
      <span className={s.rowIcon} style={iconColor ? { color: iconColor } : undefined}>
        <Icon name={icon} size={17} />
      </span>
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

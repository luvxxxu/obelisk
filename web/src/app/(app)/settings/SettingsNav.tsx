'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useId, type ReactNode } from 'react';
import { cx } from '@/lib/format';
import { useApp } from '@/lib/store';
import s from './settings.module.css';

/** Tabs shared by the settings pages. "조직" shows while an organization is open. */
export function SettingsNav() {
  const pathname = usePathname();
  const { workspace } = useApp();
  const tabs: { href: string; label: string }[] = [
    { href: '/settings', label: '일반' },
    ...(workspace?.kind === 'org' ? [{ href: '/settings/org', label: '조직' }] : []),
    { href: '/settings/ai', label: 'AI 연결' },
    { href: '/settings/jev', label: 'Jev' },
    { href: '/settings/webhooks', label: '웹훅' },
    { href: '/settings/migrate', label: '데이터 이전' },
  ];
  return (
    <nav className={s.nav} aria-label="설정 메뉴">
      {tabs.map((t) => {
        const active = pathname === t.href;
        return (
          <Link key={t.href} href={t.href} className={s.navItem} aria-current={active ? 'page' : undefined}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** A settings section: 15px heading + muted lead (+ an action on the right), then rows or free content. */
export function SettingsSection({
  title,
  lead,
  action,
  children,
  className,
}: {
  title: ReactNode;
  lead?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section className={cx(s.section, className)} aria-labelledby={id}>
      <div className={s.sectionHead}>
        <div className={s.sectionHeadText}>
          <h2 id={id} className={s.sectionTitle}>
            {title}
          </h2>
          {lead && <p className={s.sectionLead}>{lead}</p>}
        </div>
        {action && <div className={s.sectionAction}>{action}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * One setting: label + muted help on the left, the control on the right, hairline above.
 * `htmlFor` makes the label a <label>; `field` gives the control a fixed input width; `stack` puts the control underneath.
 */
export function SettingsRow({
  label,
  description,
  htmlFor,
  field,
  stack,
  children,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  field?: boolean;
  stack?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx(s.row, className)} data-field={field || undefined} data-stack={stack || undefined}>
      <div className={s.rowText}>
        {htmlFor ? (
          <label className={s.rowTitle} htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <p className={s.rowTitle}>{label}</p>
        )}
        {description && <div className={s.rowDesc}>{description}</div>}
      </div>
      {children && <div className={s.rowControl}>{children}</div>}
    </div>
  );
}

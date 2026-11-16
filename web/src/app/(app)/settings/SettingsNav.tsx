'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, type IconName } from '@/components/Icon';
import { ui } from '@/components/primitives';
import { cx } from '@/lib/format';
import { useApp } from '@/lib/store';
import s from './settings.module.css';

/** Tabs shared by the settings pages. "조직" shows while an organization is open. */
export function SettingsNav() {
  const pathname = usePathname();
  const { workspace } = useApp();
  const tabs: { href: string; label: string; icon: IconName }[] = [
    { href: '/settings', label: '일반', icon: 'user' },
    ...(workspace?.kind === 'org' ? [{ href: '/settings/org', label: '조직', icon: 'building' as IconName }] : []),
    { href: '/settings/ai', label: 'AI 연결', icon: 'sparkle' },
    { href: '/settings/jev', label: 'Jev', icon: 'target' },
  ];
  return (
    <nav className={cx(ui.tabs, s.subnav)} aria-label="설정 메뉴">
      {tabs.map((t) => {
        const active = pathname === t.href;
        return (
          <Link key={t.href} href={t.href} className={ui.tab} data-active={active || undefined} aria-current={active ? 'page' : undefined}>
            <Icon name={t.icon} size={15} />
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

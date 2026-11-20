'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { EmptyState, Page, ViewHeader } from '@/components/View';
import { api } from '@/lib/api';
import { useApp } from '@/lib/store';
import base from '../settings/settings.module.css';

const TABS: { href: string; label: string }[] = [
  { href: '/admin', label: '개요' },
  { href: '/admin/users', label: '사용자' },
  { href: '/admin/orgs', label: '조직' },
  { href: '/admin/signup', label: '가입' },
  { href: '/admin/notice', label: '공지' },
  { href: '/admin/log', label: '기록' },
];

/** The same quiet text tabs as 설정. */
export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className={base.nav} aria-label="서버 관리 메뉴">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} className={base.navItem} aria-current={pathname === t.href ? 'page' : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Every 서버 관리 page: title, tabs, then the content, or a plain note for anyone who isn't an
 * operator (the server refuses them anyway).
 */
export function AdminPage({ lead, children }: { lead?: ReactNode; children: ReactNode }) {
  const { user } = useApp();
  return (
    <Page>
      <ViewHeader title="서버 관리" description={user?.admin ? lead : undefined}>
        {user?.admin && <AdminNav />}
      </ViewHeader>
      {user?.admin ? (
        <div className={base.stack}>{children}</div>
      ) : (
        <EmptyState
          icon="shield"
          title="서버 운영자만 볼 수 있어요"
          body="가입, 사용자, 서버 설정은 이 서버의 운영자가 관리해요. 운영자가 되려면 지금 운영자에게 요청하세요."
        />
      )}
    </Page>
  );
}

/** GET an admin endpoint; `reload` fetches again (after an action). Errors land in `error`. */
export function useAdmin<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!path) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const d = await api<T>('GET', path);
      if (mine === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, setData, error, loading, reload };
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** "2026. 11. 20. 18:04" in the viewer's own time zone. */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
}

export function dateOnly(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('ko-KR', { dateStyle: 'medium' });
}

export const num = (n: number) => n.toLocaleString('ko-KR');

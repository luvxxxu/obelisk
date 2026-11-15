'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Icon, type IconName } from '@/components/Icon';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, ui } from '@/components/primitives';
import { Page, ViewHeader } from '@/components/View';
import { api } from '@/lib/api';
import { cx } from '@/lib/format';
import { load, reset, setUser, useApp } from '@/lib/store';
import { toast } from '@/lib/toast';
import { applyThemePref, modCombo } from '@/lib/ui-helpers';
import { setUi } from '@/lib/ui-state';
import type { User } from '@obelisk/core';
import s from './settings.module.css';

type Theme = 'system' | 'light' | 'dark';

const THEMES: { value: Theme; label: string; icon: IconName }[] = [
  { value: 'system', label: '시스템', icon: 'monitor' },
  { value: 'light', label: '라이트', icon: 'sun' },
  { value: 'dark', label: '다크', icon: 'moon' },
];

export default function SettingsPage() {
  const { user } = useApp();
  const router = useRouter();
  const [name, setName] = useState(user?.name ?? '');
  const [tz, setTz] = useState(user?.timezone ?? 'Asia/Seoul');
  const [theme, setTheme] = useState<Theme>('system');
  const [searchKey, setSearchKey] = useState('⌘K');
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
    } catch {
      return ['Asia/Seoul', 'UTC'];
    }
  }, []);

  useEffect(() => {
    try {
      const t = localStorage.getItem('obelisk-theme');
      if (t === 'light' || t === 'dark') setTheme(t);
    } catch {}
  }, []);

  // Display only: keep the selector in sync when the theme is changed elsewhere (sidebar user menu).
  useEffect(() => {
    const el = document.documentElement;
    const mo = new MutationObserver(() => {
      const t = el.dataset.theme;
      setTheme(t === 'light' || t === 'dark' ? t : 'system');
    });
    mo.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => setSearchKey(modCombo('K')), []);

  const applyTheme = (t: Theme, el?: HTMLElement) => {
    setTheme(t);
    const r = el?.getBoundingClientRect();
    applyThemePref(t, r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : undefined);
  };

  const save = async () => {
    try {
      const { user: u } = await api<{ user: User }>('PATCH', '/api/auth/me', { name: name.trim(), timezone: tz });
      setUser(u);
      await load(true);
      toast.success('저장했어요');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const dirty = name.trim() !== user?.name || tz !== user?.timezone;

  return (
    <Page>
      <ViewHeader icon="settings" title="설정" description="프로필과 화면, 계정을 관리해요.">
        <nav className={cx(ui.tabs, s.subnav)} aria-label="설정 메뉴">
          <Link href="/settings" className={ui.tab} data-active="true" aria-current="page">
            <Icon name="user" size={15} />
            일반
          </Link>
          <Link href="/settings/ai" className={ui.tab}>
            <Icon name="sparkle" size={15} />
            AI 연결
          </Link>
        </nav>
      </ViewHeader>

      <div className={s.stack}>
        {/* ───────── profile */}
        <Card className={s.section}>
          <CardHeader>
            <CardTitle>프로필</CardTitle>
            <CardDescription>이름과 시간대를 바꿀 수 있어요.</CardDescription>
          </CardHeader>
          <CardContent className={s.fields}>
            <div className={ui.field}>
              <label className={ui.label} htmlFor="name">
                이름
              </label>
              <input id="name" className={ui.input} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className={ui.field}>
              <label className={ui.label} htmlFor="email">
                이메일
              </label>
              <input id="email" className={ui.input} value={user?.email ?? ''} disabled />
              <p className={ui.help}>로그인에 쓰는 주소라 여기서는 바꿀 수 없어요.</p>
            </div>
            <div className={cx(ui.field, s.span2)}>
              <label className={ui.label} htmlFor="tz">
                시간대
              </label>
              <select id="tz" className={ui.input} value={tz} onChange={(e) => setTz(e.target.value)}>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
              <p className={ui.help}>‘오늘’과 기한 지남 판단, AI 도구가 받는 날짜가 이 시간대를 기준으로 해요.</p>
            </div>
          </CardContent>
          <CardFooter className={s.footer}>
            <span className={s.footerNote} data-dirty={dirty}>
              {dirty ? (
                <>
                  <span className={ui.dot} data-tone="warn" />
                  저장하지 않은 변경 사항이 있어요
                </>
              ) : (
                '바꾸면 저장 버튼이 켜져요'
              )}
            </span>
            <button className={`${ui.btn} ${ui.primary}`} disabled={!dirty} onClick={() => void save()}>
              저장
            </button>
          </CardFooter>
        </Card>

        {/* ───────── appearance */}
        <Card className={s.section}>
          <CardHeader>
            <CardTitle>화면</CardTitle>
            <CardDescription>테마는 바로 적용되고 이 브라우저에 저장돼요.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className={ui.field}>
              <span className={ui.label} id="theme-label">
                테마
              </span>
              <div className={cx(ui.tabs, s.themeTabs)} role="group" aria-labelledby="theme-label">
                {THEMES.map((t) => (
                  <button key={t.value} type="button" className={ui.tab} aria-pressed={theme === t.value} onClick={(e) => applyTheme(t.value, e.currentTarget)}>
                    <Icon name={t.icon} size={15} />
                    {t.label}
                  </button>
                ))}
              </div>
              <p className={ui.help}>‘시스템’은 기기의 라이트 · 다크 설정을 따라가요.</p>
            </div>
          </CardContent>
        </Card>

        {/* ───────── keyboard */}
        <Card className={s.section}>
          <CardContent>
            <div className={s.row}>
              <div className={s.rowText}>
                <p className={s.rowTitle}>키보드 단축키</p>
                <p className={s.rowDesc}>
                  <kbd>N</kbd> 새 작업 · <kbd>{searchKey}</kbd> 검색 · <kbd>?</kbd> 전체 목록
                </p>
              </div>
              <button type="button" className={cx(ui.btn, ui.outline)} onClick={() => setUi({ shortcuts: true })}>
                <Icon name="keyboard" size={15} />
                단축키 보기
              </button>
            </div>
          </CardContent>
        </Card>

        {/* ───────── account */}
        <Card className={s.section}>
          <CardHeader>
            <CardTitle>계정</CardTitle>
            {user?.email && <CardDescription>{user.email} 계정으로 로그인되어 있어요.</CardDescription>}
          </CardHeader>
          <CardContent>
            <div className={s.dangerRow}>
              <div className={s.rowText}>
                <p className={s.rowTitle}>로그아웃</p>
                <p className={s.rowDesc}>이 기기에서 로그아웃해요. 작업은 그대로 남아 있어요.</p>
              </div>
              <button
                className={cx(ui.btn, ui.outline)}
                onClick={async () => {
                  await api('POST', '/api/auth/logout').catch(() => {});
                  reset();
                  router.replace('/login');
                }}
              >
                <Icon name="logout" size={15} /> 로그아웃
              </button>
            </div>
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}

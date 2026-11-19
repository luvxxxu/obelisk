'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Icon, type IconName } from '@/components/Icon';
import { ui } from '@/components/primitives';
import { Page, ViewHeader } from '@/components/View';
import { api } from '@/lib/api';
import { cx } from '@/lib/format';
import { load, reset, setUser, useApp } from '@/lib/store';
import { toast } from '@/lib/toast';
import { applyThemePref, modCombo } from '@/lib/ui-helpers';
import { setUi } from '@/lib/ui-state';
import type { User } from '@obelisk/core';
import { DeleteAccountDialog } from './DeleteAccount';
import { SettingsNav, SettingsRow, SettingsSection } from './SettingsNav';
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
  const [deleting, setDeleting] = useState(false);
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
      <ViewHeader title="설정">
        <SettingsNav />
      </ViewHeader>

      <div className={s.stack}>
        {/* ───────── profile */}
        <SettingsSection title="프로필" lead="이름과 시간대를 바꿀 수 있어요.">
          <SettingsRow label="이름" htmlFor="name" field>
            <input id="name" className={ui.input} value={name} onChange={(e) => setName(e.target.value)} />
          </SettingsRow>
          <SettingsRow label="이메일" description="로그인에 쓰는 주소라 여기서는 바꿀 수 없어요.">
            <span className={s.value}>{user?.email ?? ''}</span>
          </SettingsRow>
          <SettingsRow
            label="시간대"
            htmlFor="tz"
            field
            description="‘오늘’과 기한 지남 판단, AI 도구가 받는 날짜가 이 시간대를 기준으로 해요."
          >
            <select id="tz" className={ui.input} value={tz} onChange={(e) => setTz(e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </SettingsRow>
          <div className={s.footer}>
            <span className={s.footerNote} data-dirty={dirty}>
              {dirty ? '저장하지 않은 변경 사항이 있어요' : '바꾸면 저장 버튼이 켜져요'}
            </span>
            <button className={cx(ui.btn, ui.primary)} disabled={!dirty} onClick={() => void save()}>
              저장
            </button>
          </div>
        </SettingsSection>

        {/* ───────── appearance + keyboard */}
        <SettingsSection title="화면" lead="테마는 바로 적용되고 이 브라우저에 저장돼요.">
          <SettingsRow label={<span id="theme-label">테마</span>} description="‘시스템’은 기기의 라이트 · 다크 설정을 따라가요.">
            <div className={ui.segmented} role="group" aria-labelledby="theme-label">
              {THEMES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  className={ui.segment}
                  aria-pressed={theme === t.value}
                  onClick={(e) => applyTheme(t.value, e.currentTarget)}
                >
                  <Icon name={t.icon} size={15} />
                  {t.label}
                </button>
              ))}
            </div>
          </SettingsRow>
          <SettingsRow
            label="키보드 단축키"
            description={
              <>
                <kbd>N</kbd> 새 작업 · <kbd>{searchKey}</kbd> 검색 · <kbd>?</kbd> 전체 목록
              </>
            }
          >
            <button type="button" className={cx(ui.btn, ui.outline, ui.sm)} onClick={() => setUi({ shortcuts: true })}>
              단축키 보기
            </button>
          </SettingsRow>
        </SettingsSection>

        {/* ───────── account */}
        <SettingsSection title="계정" lead={user?.email ? `${user.email} 계정으로 로그인되어 있어요.` : undefined}>
          <SettingsRow label="로그아웃" description="이 기기에서 로그아웃해요. 작업은 그대로 남아 있어요.">
            <button
              className={cx(ui.btn, ui.outline, ui.sm)}
              onClick={async () => {
                await api('POST', '/api/auth/logout').catch(() => {});
                reset();
                router.replace('/login');
              }}
            >
              로그아웃
            </button>
          </SettingsRow>
          <SettingsRow label="계정 삭제" description="계정과 개인 공간의 모든 작업이 영구히 지워져요. 되돌릴 수 없어요.">
            <button className={cx(ui.btn, ui.danger, ui.sm)} onClick={() => setDeleting(true)}>
              계정 삭제
            </button>
          </SettingsRow>
        </SettingsSection>
      </div>
      <DeleteAccountDialog open={deleting} onClose={() => setDeleting(false)} />
    </Page>
  );
}

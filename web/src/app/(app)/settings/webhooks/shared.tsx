'use client';

import type { Webhook, WebhookDelivery } from '@obelisk/core';
import { useRef, type ReactNode } from 'react';
import { Icon, type IconName } from '@/components/Icon';
import { Popover, ui, useDisclosure } from '@/components/primitives';
import { cx, relativeTime } from '@/lib/format';
import s from './webhooks.module.css';

export function hourLabel(h: number): string {
  if (h === 0) return '자정';
  if (h === 12) return '정오';
  return h < 12 ? `오전 ${h}시` : `오후 ${h - 12}시`;
}

export type Tone = 'ok' | 'danger' | 'warn' | 'info' | 'muted';

export function deliveryTone(status: WebhookDelivery['status']): Tone {
  return status === 'success' ? 'ok' : status === 'failed' ? 'danger' : 'info';
}

/** "정상 · 3분 전", "실패 · HTTP 404", "꺼짐" … */
export function hookStatus(h: Webhook): { tone: Tone; label: string; detail: string | null } {
  if (!h.enabled) return { tone: h.disabledReason ? 'warn' : 'muted', label: '꺼짐', detail: null };
  const last = h.lastDelivery;
  if (!last) return { tone: 'muted', label: '대기 중', detail: '아직 보낸 적 없음' };
  const when = relativeTime(last.at);
  if (last.status === 'success') return { tone: 'ok', label: '정상', detail: when };
  if (last.status === 'pending') return { tone: 'info', label: '재시도 대기', detail: when };
  return { tone: 'danger', label: '실패', detail: last.responseStatus ? `HTTP ${last.responseStatus} · ${when}` : when };
}

export interface MenuAction {
  label: string;
  icon: IconName;
  onSelect: () => void;
  danger?: boolean;
  hidden?: boolean;
}

/** "⋯" button with a small action menu. */
export function RowMenu({ label, actions }: { label: string; actions: MenuAction[] }) {
  const ref = useRef<HTMLButtonElement>(null);
  const d = useDisclosure();
  const shown = actions.filter((a) => !a.hidden);
  return (
    <>
      <button ref={ref} type="button" className={ui.iconBtn} aria-haspopup="menu" aria-expanded={d.open} aria-label={label} onClick={d.toggle}>
        <Icon name="more" size={16} />
      </button>
      <Popover anchor={ref} open={d.open} onClose={d.close} align="end" width={210}>
        <div role="menu" aria-label={label}>
          {shown.map((a, i) => (
            <div key={a.label}>
              {a.danger && i > 0 && <div className={ui.menuSep} role="separator" />}
              <button
                type="button"
                role="menuitem"
                className={ui.menuItem}
                data-tone={a.danger ? 'danger' : undefined}
                onClick={() => {
                  d.close();
                  a.onSelect();
                }}
              >
                <Icon name={a.icon} size={15} />
                {a.label}
              </button>
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}

/** Checkbox row in the shared "pick" style (custom box, native input for a11y). */
export function Pick({
  checked,
  onChange,
  children,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx(s.pick, className)} data-on={checked}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className={s.pickBox} aria-hidden="true">
        <Icon name="check" size={12} strokeWidth={3} />
      </span>
      {children}
    </label>
  );
}

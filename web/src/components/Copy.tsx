'use client';

import { useEffect, useState } from 'react';
import { cx } from '@/lib/format';
import { toast } from '@/lib/toast';
import { Icon } from './Icon';
import { ui } from './primitives';
import s from './Copy.module.css';

export function copyText(text: string, what = '복사했어요') {
  void navigator.clipboard?.writeText(text);
  toast.show(what);
}

/** Display-only "copied" flash for copy buttons. */
export function useFlash(ms = 1600): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    const t = window.setTimeout(() => setOn(false), ms);
    return () => window.clearTimeout(t);
  }, [on, ms]);
  return [on, () => setOn(true)];
}

/** Copyable code block (shell command / config). */
export function Code({ children, className }: { children: string; className?: string }) {
  const [copied, flash] = useFlash();
  return (
    <div className={cx(s.code, className)}>
      <pre className={s.codePre}>
        <code>{children}</code>
      </pre>
      <button
        type="button"
        className={cx(ui.iconBtn, s.codeCopy)}
        onClick={() => {
          copyText(children);
          flash();
        }}
        aria-label="복사"
        data-copied={copied}
      >
        <Icon name={copied ? 'check' : 'copy'} size={14} />
      </button>
    </div>
  );
}

/** Read-only value + copy button (shadcn "copy link" pattern). */
export function CopyField({ value, label, done }: { value: string; label: string; done: string }) {
  const [copied, flash] = useFlash();
  return (
    <div className={s.copyRow}>
      <input
        className={cx(ui.input, s.copyInput)}
        value={value}
        readOnly
        aria-label={label}
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
      />
      <button
        type="button"
        className={cx(ui.btn, ui.outline, s.copyBtn)}
        onClick={() => {
          copyText(value, done);
          flash();
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size={14} />
        {copied ? '복사됨' : '복사'}
      </button>
    </div>
  );
}

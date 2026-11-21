'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { markDismissPress } from '@/lib/selection';
import { Icon } from './Icon';
import ui from './ui.module.css';

export { ui };

/** Enter that is not the IME confirming a Hangul/Kana composition. */
export function isEnter(e: React.KeyboardEvent): boolean {
  return e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229;
}

/** Anchored floating panel that flips and clamps to the viewport. */
export function Popover({
  anchor,
  open,
  onClose,
  children,
  align = 'start',
  width,
  className,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: 'start' | 'end';
  width?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const el = ref.current;
      if (!a || !el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let left = align === 'end' ? a.right - w : a.left;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      let top = a.bottom + 6;
      if (top + h > window.innerHeight - 8 && a.top - h - 6 > 8) top = a.top - h - 6;
      top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
      setPos({ top, left });
    };
    place();
    // Content can change size while open (e.g. a menu that turns into a date picker).
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    if (ref.current) ro?.observe(ref.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchor, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      // The press only closes the popover: a list under it must not also drop its picks.
      markDismissPress(e);
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose, anchor]);

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={ref}
      className={`${ui.popover} ${className ?? ''}`}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width, visibility: pos ? 'visible' : 'hidden' }}
      role="dialog"
    >
      {children}
    </div>,
    document.body,
  );
}

export function useDisclosure(initial = false) {
  const [open, setOpen] = useState(initial);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  return { open, setOpen, close, toggle };
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width,
  icon,
  description,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  icon?: ReactNode;
  /** Optional muted line under the title. */
  description?: ReactNode;
}) {
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div className={ui.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={ui.modal}
        style={width ? { maxWidth: width } : undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
      >
        {title && (
          <div className={ui.modalHeader}>
            {icon}
            <h2 className={ui.modalTitle} id={titleId}>
              {title}
            </h2>
            <button className={ui.iconBtn} style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="닫기">
              <Icon name="x" />
            </button>
          </div>
        )}
        {title && description && <p className={ui.modalDescription}>{description}</p>}
        <div className={ui.modalBody}>{children}</div>
        {footer && <div className={ui.modalFooter}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={ui.switch}
      onClick={() => onChange(!checked)}
    />
  );
}

export function ConfirmModal({
  open,
  title,
  body,
  confirmLabel = '삭제',
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={420}
      footer={
        <>
          <button className={`${ui.btn} ${ui.outline}`} onClick={onClose}>
            취소
          </button>
          <button
            className={`${ui.btn} ${ui.danger}`}
            autoFocus
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div style={{ color: 'var(--text-2)', fontSize: 'var(--fs-base)', lineHeight: 1.55 }}>{body}</div>
    </Modal>
  );
}

/** Textarea that grows with its content. */
export function AutoTextarea({
  value,
  onChange,
  onBlur,
  onKeyDown,
  placeholder,
  className,
  minRows = 1,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  className?: string;
  minRows?: number;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  // Re-fit when the width changes (e.g. the task panel animates in from 0px wide,
  // which used to leave the title measured at one character per line).
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      // next frame, so resizing inside the observer callback can't trip the
      // "ResizeObserver loop completed with undelivered notifications" error
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        el.style.height = '0px';
        el.style.height = `${el.scrollHeight}px`;
      });
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);
  return (
    <textarea
      ref={ref}
      rows={minRows}
      value={value}
      placeholder={placeholder}
      className={`${ui.textarea} ${className ?? ''}`}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      autoFocus={autoFocus}
    />
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={className}>{children}</kbd>;
}

/* ─────────────────────────────────────────────────────────────────────────────
   shadcn-style presentational primitives (no logic). All accept className + native props.
   ───────────────────────────────────────────────────────────────────────────── */

function cls(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'dangerGhost' | 'link' | 'plain';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

/** Class string for a button: `buttonClass({ variant: 'outline', size: 'sm' })`. Default = primary md. */
export function buttonClass({
  variant = 'primary',
  size = 'md',
  icon = false,
  block = false,
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; icon?: boolean; block?: boolean; className?: string } = {}): string {
  return cls(
    ui.btn,
    variant !== 'plain' && ui[variant],
    size !== 'md' && ui[size],
    icon && ui.icon,
    block && ui.block,
    className,
  );
}

/** `<Button variant="outline" size="sm">` — thin wrapper over a native button (type="button" by default). */
export function Button({
  variant,
  size,
  icon,
  block,
  className,
  type = 'button',
  ...rest
}: ComponentProps<'button'> & { variant?: ButtonVariant; size?: ButtonSize; icon?: boolean; block?: boolean }) {
  return <button type={type} className={buttonClass({ variant, size, icon, block, className })} {...rest} />;
}

/* ───────── card */

export function Card({ className, interactive, ...rest }: ComponentProps<'div'> & { interactive?: boolean }) {
  return <div className={cls(ui.card, interactive && ui.interactive, className)} {...rest} />;
}

export function CardHeader({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cls(ui.cardHeader, className)} {...rest} />;
}

export function CardTitle({ className, ...rest }: ComponentProps<'h3'>) {
  return <h3 className={cls(ui.cardTitle, className)} {...rest} />;
}

export function CardDescription({ className, ...rest }: ComponentProps<'p'>) {
  return <p className={cls(ui.cardDescription, className)} {...rest} />;
}

export function CardAction({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cls(ui.cardAction, className)} {...rest} />;
}

export function CardContent({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cls(ui.cardContent, className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cls(ui.cardFooter, className)} {...rest} />;
}

/* ───────── badge, separator, avatar */

export type BadgeTone = 'default' | 'secondary' | 'outline' | 'danger' | 'warn' | 'ok' | 'info';

export function Badge({ tone, className, ...rest }: ComponentProps<'span'> & { tone?: BadgeTone }) {
  return <span className={cls(ui.badge, className)} data-tone={tone} {...rest} />;
}

export function Separator({
  orientation = 'horizontal',
  className,
  ...rest
}: ComponentProps<'div'> & { orientation?: 'horizontal' | 'vertical' }) {
  return <div role="none" data-orientation={orientation} className={cls(ui.separator, className)} {...rest} />;
}

/**
 * A person's photo, or their initial when they have none (or it fails to load).
 * Photos sit on a muted disc so a transparent logo still reads as round.
 */
export function Avatar({
  name,
  src,
  size = 'md',
  className,
}: {
  name?: string | null;
  src?: string | null;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}) {
  const initial = (name ?? '').trim().slice(0, 1).toUpperCase() || '?';
  const [broken, setBroken] = useState<string | null>(null);
  const photo = src && broken !== src ? src : null;
  return (
    <span
      className={cls(ui.avatar, className)}
      data-size={size === 'md' ? undefined : size}
      data-photo={photo ? '' : undefined}
      aria-hidden="true"
    >
      {photo ? (
        <img key={photo} src={photo} alt="" draggable={false} decoding="async" onError={() => setBroken(photo)} />
      ) : (
        initial
      )}
    </span>
  );
}

/* ───────── progress, skeleton, spinner */

export function Progress({
  value,
  max = 100,
  tone,
  size = 'md',
  label,
  className,
  style,
}: {
  value: number;
  max?: number;
  tone?: 'ok' | 'warn' | 'danger' | 'info';
  size?: 'sm' | 'md' | 'lg';
  label?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div
      className={cls(ui.progress, className)}
      data-tone={tone}
      data-size={size === 'md' ? undefined : size}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={label}
      style={style}
    >
      <span className={ui.progressBar} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Skeleton({
  width,
  height = 16,
  className,
  style,
}: {
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  return <span className={cls(ui.skeleton, className)} style={{ width, height, ...style }} aria-hidden="true" />;
}

export function Spinner({ label = '불러오는 중', className }: { label?: string; className?: string }) {
  return <span className={cls(ui.spinner, className)} role="status" aria-label={label} />;
}

/* ───────── tooltips
   tip(label, { side, kbd, meta }) → spread onto any element: <button {...tip('설정', { side: 'right' })}>
   Rendered by <TooltipLayer /> (mounted once in AppShell) in a fixed portal, so it is never clipped by
   overflow containers. Hover (mouse/pen) or keyboard focus shows it; touch never does. Pass a falsy
   label to disable (e.g. only when the sidebar is collapsed). */

export type TipSide = 'top' | 'right' | 'bottom' | 'left';

export interface TipProps {
  'data-tip'?: string;
  'data-tip-side'?: TipSide;
  'data-tip-kbd'?: string;
  'data-tip-meta'?: string;
}

export function tip(
  label: string | null | undefined | false,
  opts: { side?: TipSide; kbd?: string; meta?: string | number | null } = {},
): TipProps {
  if (!label) return {};
  const meta = opts.meta === undefined || opts.meta === null || opts.meta === '' ? undefined : String(opts.meta);
  return { 'data-tip': label, 'data-tip-side': opts.side, 'data-tip-kbd': opts.kbd, 'data-tip-meta': meta };
}

interface TipState {
  label: string;
  meta?: string;
  kbd?: string;
  side: TipSide;
  rect: DOMRect;
}

export function TooltipLayer() {
  const [state, setState] = useState<TipState | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current: HTMLElement | null = null;
    let timer: number | undefined;
    let lastHide = 0;

    const read = (el: HTMLElement): TipState | null => {
      const label = el.dataset.tip;
      if (!label) return null;
      return {
        label,
        meta: el.dataset.tipMeta || undefined,
        kbd: el.dataset.tipKbd || undefined,
        side: (el.dataset.tipSide as TipSide | undefined) || 'right',
        rect: el.getBoundingClientRect(),
      };
    };
    const show = (el: HTMLElement, instant: boolean) => {
      current = el;
      window.clearTimeout(timer);
      const run = () => {
        if (current === el) setState(read(el));
      };
      if (instant || Date.now() - lastHide < 400) run();
      else timer = window.setTimeout(run, 180);
    };
    const hide = () => {
      window.clearTimeout(timer);
      if (current) lastHide = Date.now();
      current = null;
      setState(null);
    };
    const target = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>('[data-tip]') : null);

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      // No tooltips while a board card is being dragged around (useBoardDnd).
      if (document.documentElement.dataset.dragging !== undefined) {
        if (current) hide();
        return;
      }
      const el = target(e.target);
      if (el?.dataset.tip) {
        if (el !== current) show(el, false);
      } else if (current) hide();
    };
    const onOut = (e: PointerEvent) => {
      if (!e.relatedTarget) hide();
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = target(e.target);
      if (!el?.dataset.tip) return;
      let visible = false;
      try {
        visible = el.matches(':focus-visible');
      } catch {}
      if (visible) show(el, true);
    };

    document.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerout', onOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!state || !el) {
      setPos(null);
      return;
    }
    const { rect, side } = state;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = 8;
    let top: number;
    let left: number;
    if (side === 'right') {
      left = rect.right + gap;
      top = rect.top + rect.height / 2 - h / 2;
    } else if (side === 'left') {
      left = rect.left - gap - w;
      top = rect.top + rect.height / 2 - h / 2;
    } else if (side === 'bottom') {
      top = rect.bottom + gap - 2;
      left = rect.left + rect.width / 2 - w / 2;
    } else {
      top = rect.top - gap - h + 2;
      left = rect.left + rect.width / 2 - w / 2;
    }
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    setPos({ top, left });
  }, [state]);

  if (!state || typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={ref}
      className={ui.tipLayer}
      role="tooltip"
      style={{ transform: `translate(${pos?.left ?? -9999}px, ${pos?.top ?? -9999}px)`, visibility: pos ? 'visible' : 'hidden' }}
    >
      <span>{state.label}</span>
      {state.meta && <span className={ui.tipMeta}>{state.meta}</span>}
      {state.kbd && <kbd>{state.kbd}</kbd>}
    </div>,
    document.body,
  );
}

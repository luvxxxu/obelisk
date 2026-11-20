'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '@/lib/format';
import { toast } from '@/lib/toast';
import { Icon } from './Icon';
import { Modal, ui } from './primitives';
import s from './PhotoEditor.module.css';

/** Pixels saved: sharp at 64 px on a 3x screen, a few dozen KB as WebP. */
const OUT = 256;
/** The crop circle's share of the stage; the rest shows what is cut away. */
const CROP_RATIO = 240 / 288;
const MAX_ZOOM = 5;
const MAX_INPUT_BYTES = 30 * 1024 * 1024;
/** The server takes 512 KB; keep a margin. */
const MAX_OUTPUT_BYTES = 480 * 1024;
const PREVIEWS = [40, 24];

export const PHOTO_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/avif,image/heic,image/heif';

interface Loaded {
  img: HTMLImageElement;
  url: string;
  w: number;
  h: number;
}

/** Zoom (1 = the short side just fills the circle) and the photo's offset from the stage centre, in CSS px. */
interface View {
  z: number;
  x: number;
  y: number;
}

type Pt = { x: number; y: number };

const START: View = { z: 1, x: 0, y: 0 };

/** Why a picked file can't be used, or null when it looks like a photo. */
export function photoProblem(file: File): string | null {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') return 'PNG, JPG, WebP 같은 사진 파일을 골라 주세요';
  if (file.size > MAX_INPUT_BYTES) return '30MB보다 작은 사진을 골라 주세요';
  return null;
}

/** The first image in a drop or paste, if any. */
export function imageFrom(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const f of Array.from(data.files)) if (f.type.startsWith('image/')) return f;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
  }
  return null;
}

async function load(file: Blob): Promise<Loaded> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('이 사진은 열 수 없어요. JPG나 PNG로 바꿔서 올려 주세요');
  }
  return { img, url, w: img.naturalWidth, h: img.naturalHeight };
}

function geometry(photo: Loaded, stage: number) {
  const crop = stage * CROP_RATIO;
  return { crop, base: crop / Math.min(photo.w, photo.h) };
}

/** Keep the zoom in range and the circle covered by the photo. */
function clamp(v: View, photo: Loaded, stage: number): View {
  const { crop, base } = geometry(photo, stage);
  const z = Math.min(MAX_ZOOM, Math.max(1, v.z));
  const mx = (photo.w * base * z - crop) / 2;
  const my = (photo.h * base * z - crop) / 2;
  return { z, x: Math.max(-mx, Math.min(mx, v.x)), y: Math.max(-my, Math.min(my, v.y)) };
}

/** Zoom to `z` keeping the point under `at` (relative to the stage centre) where it is. */
function zoomAt(v: View, z: number, at: Pt, photo: Loaded, stage: number): View {
  const next = Math.min(MAX_ZOOM, Math.max(1, z));
  const k = next / v.z;
  return clamp({ z: next, x: at.x - (at.x - v.x) * k, y: at.y - (at.y - v.y) * k }, photo, stage);
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Cut the circle's square out of the full-resolution photo, halving in steps so a big photo shrinks cleanly. */
async function render(photo: Loaded, v: View, stage: number): Promise<Blob> {
  const { crop, base } = geometry(photo, stage);
  const scale = base * v.z;
  const side = Math.min(crop / scale, photo.w, photo.h);
  let sx = Math.min(Math.max(0, photo.w / 2 - v.x / scale - side / 2), photo.w - side);
  let sy = Math.min(Math.max(0, photo.h / 2 - v.y / scale - side / 2), photo.h - side);
  let src: CanvasImageSource = photo.img;
  let sw = side;
  while (sw > OUT * 2) {
    const half = document.createElement('canvas');
    half.width = half.height = Math.round(sw / 2);
    const hc = half.getContext('2d')!;
    hc.imageSmoothingQuality = 'high';
    hc.drawImage(src, sx, sy, sw, sw, 0, 0, half.width, half.height);
    src = half;
    sx = sy = 0;
    sw = half.width;
  }
  const out = document.createElement('canvas');
  out.width = out.height = OUT;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sw, 0, 0, OUT, OUT);

  // WebP keeps transparency (logos) and is small; Safari can't encode it and hands back PNG instead.
  const webp = await toBlob(out, 'image/webp', 0.9);
  if (webp?.type === 'image/webp' && webp.size <= MAX_OUTPUT_BYTES) return webp;
  const png = await toBlob(out, 'image/png');
  if (png && png.size <= MAX_OUTPUT_BYTES) return png;
  const jpeg = await toBlob(out, 'image/jpeg', 0.9);
  if (jpeg) return jpeg;
  throw new Error('사진을 저장하지 못했어요');
}

/**
 * Cut a photo into a circle: drag to place it, pinch, scroll or use the slider to zoom.
 * Dropping or pasting another image swaps it in. Saves a 256 px square.
 */
export function PhotoEditor({
  file,
  title,
  description,
  onClose,
  onPickAnother,
  onReplace,
  onSave,
}: {
  /** The picked photo; null closes the editor. */
  file: File | null;
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  onPickAnother: () => void;
  onReplace: (file: File) => void;
  onSave: (blob: Blob) => Promise<void>;
}) {
  const [photo, setPhoto] = useState<Loaded | null>(null);
  const [view, setView] = useState<View>(START);
  const [stage, setStage] = useState(288);
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState(false);
  const [saving, setSaving] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  // Load each picked file; a new one starts centred.
  useEffect(() => {
    if (!file) return;
    let alive = true;
    let loaded: Loaded | null = null;
    setPhoto(null);
    load(file).then(
      (p) => {
        if (!alive) return URL.revokeObjectURL(p.url);
        loaded = p;
        setPhoto(p);
        setView(START);
      },
      (e: Error) => {
        if (!alive) return;
        toast.error(e.message);
        onClose();
      },
    );
    return () => {
      alive = false;
      if (loaded) URL.revokeObjectURL(loaded.url);
    };
  }, [file, onClose]);

  // The stage is 288 px but may shrink on a narrow phone; the maths follow its real size.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage(el.clientWidth || 288));
    ro.observe(el);
    return () => ro.disconnect();
  }, [file]);

  // A narrower stage may leave the photo short of the circle's edge: pull it back in.
  useEffect(() => {
    if (photo) setView((v) => clamp(v, photo, stage));
  }, [photo, stage]);

  const update = useCallback(
    (fn: (v: View) => View) => {
      if (!photo) return;
      setView((v) => fn(v));
    },
    [photo],
  );

  // Wheel and trackpad pinch zoom under the cursor (needs a non-passive listener to stop the page scrolling).
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !photo) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const at = { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
      const speed = e.ctrlKey ? 0.01 : 0.0025;
      setView((v) => zoomAt(v, v.z * Math.exp(-e.deltaY * speed), at, photo, stage));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [photo, stage]);

  // Paste another image while the editor is open.
  useEffect(() => {
    if (!file) return;
    const onPaste = (e: ClipboardEvent) => {
      const f = imageFrom(e.clipboardData);
      if (!f) return;
      e.preventDefault();
      onReplace(f);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [file, onReplace]);

  // ── pointer: one finger or the mouse pans, two fingers pinch.
  const pointers = useRef(new Map<number, Pt>());
  const gesture = useRef<{ start: View; a: Pt; dist: number; mid: Pt } | null>(null);

  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
  };

  const regrip = () => {
    const pts = [...pointers.current.values()];
    if (!pts.length) {
      gesture.current = null;
      setDragging(false);
      return;
    }
    const [a, b] = pts as [Pt, Pt | undefined];
    gesture.current = {
      start: viewRef.current,
      a,
      dist: b ? Math.hypot(b.x - a.x, b.y - a.y) : 0,
      mid: b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a,
    };
    setDragging(true);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!photo || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    regrip();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!photo || !pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, local(e));
    const g = gesture.current;
    const pts = [...pointers.current.values()];
    if (pts.length === 1) {
      const p = pts[0]!;
      setView(clamp({ ...g.start, x: g.start.x + p.x - g.a.x, y: g.start.y + p.y - g.a.y }, photo, stage));
    } else {
      const [a, b] = pts as [Pt, Pt];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const zoomed = zoomAt(g.start, g.start.z * (dist / Math.max(1, g.dist)), g.mid, photo, stage);
      setView(clamp({ ...zoomed, x: zoomed.x + mid.x - g.mid.x, y: zoomed.y + mid.y - g.mid.y }, photo, stage));
    }
  };

  const onPointerEnd = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    regrip();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!photo) return;
    const step = e.shiftKey ? 32 : 8;
    const center = { x: 0, y: 0 };
    const moves: Record<string, (v: View) => View> = {
      ArrowLeft: (v) => ({ ...v, x: v.x - step }),
      ArrowRight: (v) => ({ ...v, x: v.x + step }),
      ArrowUp: (v) => ({ ...v, y: v.y - step }),
      ArrowDown: (v) => ({ ...v, y: v.y + step }),
      '+': (v) => zoomAt(v, v.z * 1.15, center, photo, stage),
      '=': (v) => zoomAt(v, v.z * 1.15, center, photo, stage),
      '-': (v) => zoomAt(v, v.z / 1.15, center, photo, stage),
      '0': () => START,
    };
    const fn = moves[e.key];
    if (!fn) return;
    e.preventDefault();
    update((v) => clamp(fn(v), photo, stage));
  };

  const save = async () => {
    if (!photo || saving) return;
    setSaving(true);
    try {
      await onSave(await render(photo, view, stage));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const g = photo ? geometry(photo, stage) : null;
  const placed = (size: number) => {
    if (!photo || !g) return undefined;
    const k = size / g.crop;
    return {
      width: photo.w * g.base * k,
      height: photo.h * g.base * k,
      transform: `translate(-50%, -50%) translate(${view.x * k}px, ${view.y * k}px) scale(${view.z})`,
    };
  };

  return (
    <Modal
      open={!!file}
      onClose={() => !saving && onClose()}
      width={420}
      icon={<Icon name="camera" size={18} />}
      title={title}
      description={description}
      footer={
        <>
          <button className={cx(ui.btn, ui.ghost, s.another)} onClick={onPickAnother} disabled={saving}>
            <Icon name="image" size={15} /> 다른 사진
          </button>
          <button className={cx(ui.btn, ui.outline)} onClick={onClose} disabled={saving}>
            취소
          </button>
          <button className={cx(ui.btn, ui.primary)} onClick={() => void save()} disabled={!photo || saving}>
            {saving ? '저장 중…' : '저장'}
          </button>
        </>
      }
    >
      <div className={s.editor}>
        <div
          ref={stageRef}
          className={s.stage}
          data-ready={!!photo || undefined}
          data-dragging={dragging || undefined}
          data-over={over || undefined}
          tabIndex={0}
          role="group"
          aria-label="사진 위치. 화살표로 옮기고 +, − 로 확대해요"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onKeyDown={onKeyDown}
          onDragOver={(e) => {
            if (![...e.dataTransfer.types].includes('Files')) return;
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const f = imageFrom(e.dataTransfer);
            if (f) onReplace(f);
          }}
        >
          {photo && <img src={photo.url} alt="" draggable={false} className={s.photo} style={placed(g!.crop)} />}
          <div className={s.ring} style={{ width: g?.crop ?? stage * CROP_RATIO, height: g?.crop ?? stage * CROP_RATIO }} />
        </div>

        <div className={s.zoom}>
          <button
            type="button"
            className={ui.iconBtn}
            aria-label="축소"
            disabled={!photo || view.z <= 1}
            onClick={() => update((v) => zoomAt(v, v.z / 1.25, { x: 0, y: 0 }, photo!, stage))}
          >
            <Icon name="minus" size={16} />
          </button>
          <input
            type="range"
            className={s.slider}
            min={1}
            max={MAX_ZOOM}
            step={0.01}
            value={view.z}
            disabled={!photo}
            aria-label="확대"
            onChange={(e) => update((v) => zoomAt(v, Number(e.target.value), { x: 0, y: 0 }, photo!, stage))}
          />
          <button
            type="button"
            className={ui.iconBtn}
            aria-label="확대"
            disabled={!photo || view.z >= MAX_ZOOM}
            onClick={() => update((v) => zoomAt(v, v.z * 1.25, { x: 0, y: 0 }, photo!, stage))}
          >
            <Icon name="plus" size={16} />
          </button>
        </div>

        <div className={s.previews}>
          <div className={s.previewDiscs} aria-hidden="true">
            {PREVIEWS.map((size) => (
              <span key={size} className={s.preview} style={{ width: size, height: size }}>
                {photo && <img src={photo.url} alt="" draggable={false} className={s.photo} style={placed(size)} />}
              </span>
            ))}
          </div>
          <p className={s.hint}>끌어서 위치를 맞추고 확대해 보세요. 다른 사진을 끌어다 놓거나 붙여 넣어도 돼요.</p>
        </div>
      </div>
    </Modal>
  );
}

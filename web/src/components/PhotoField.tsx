'use client';

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { cx } from '@/lib/format';
import { toast } from '@/lib/toast';
import { Icon } from './Icon';
import { imageFrom, PHOTO_ACCEPT, PhotoEditor, photoProblem } from './PhotoEditor';
import { ui } from './primitives';
import s from './PhotoField.module.css';

/**
 * A settings control for a profile photo: the current photo (click it, or drop an image on it),
 * a change and a remove button, and the crop editor in between.
 */
export function PhotoField({
  preview,
  hasPhoto,
  editable,
  editorTitle,
  editorDescription,
  onSave,
  onRemove,
}: {
  /** The photo as it looks now (64 px). */
  preview: ReactNode;
  hasPhoto: boolean;
  editable: boolean;
  editorTitle: string;
  editorDescription?: string;
  onSave: (blob: Blob) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [removing, setRemoving] = useState(false);

  const pick = useCallback(() => input.current?.click(), []);
  const close = useCallback(() => setFile(null), []);
  const choose = useCallback((f: File) => {
    const problem = photoProblem(f);
    if (problem) toast.error(problem);
    else setFile(f);
  }, []);

  const remove = async () => {
    setRemoving(true);
    try {
      await onRemove();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className={s.field}>
      <button
        type="button"
        className={s.photo}
        data-over={over || undefined}
        disabled={!editable}
        aria-label={hasPhoto ? '사진 바꾸기' : '사진 올리기'}
        onClick={pick}
        onDragOver={(e) => {
          if (!editable || ![...e.dataTransfer.types].includes('Files')) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          if (!editable) return;
          e.preventDefault();
          setOver(false);
          const f = imageFrom(e.dataTransfer);
          if (f) choose(f);
        }}
      >
        {preview}
        {editable && (
          <span className={s.overlay} aria-hidden="true">
            <Icon name="camera" size={18} />
          </span>
        )}
      </button>
      {editable && (
        <div className={s.actions}>
          <button type="button" className={cx(ui.btn, ui.outline, ui.sm)} onClick={pick}>
            {hasPhoto ? '사진 바꾸기' : '사진 올리기'}
          </button>
          {hasPhoto && (
            <button type="button" className={cx(ui.btn, ui.ghost, ui.sm)} onClick={() => void remove()} disabled={removing}>
              삭제
            </button>
          )}
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept={PHOTO_ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = ''; // the same file can be picked again after cancelling
          if (f) choose(f);
        }}
      />
      <PhotoEditor
        file={file}
        title={editorTitle}
        description={editorDescription}
        onClose={close}
        onPickAnother={pick}
        onReplace={choose}
        onSave={async (blob) => {
          await onSave(blob);
          setFile(null);
        }}
      />
    </div>
  );
}

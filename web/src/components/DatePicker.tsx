'use client';

import {
  addDays,
  formatRelativeKo,
  fromDay,
  parseDatePhrase,
  startOfWeek,
  toDay,
  weekday,
  type ISODate,
} from '@obelisk/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '@/lib/format';
import { Icon } from './Icon';
import { isEnter } from './primitives';
import s from './DatePicker.module.css';

const WD = ['일', '월', '화', '수', '목', '금', '토'];

export function DatePickerPanel({
  value,
  today,
  onPick,
  clearable = true,
  rangeStart,
  rangeEnd,
  min,
}: {
  value: ISODate | null;
  today: ISODate;
  onPick: (date: ISODate | null) => void;
  clearable?: boolean;
  rangeStart?: ISODate | null;
  rangeEnd?: ISODate | null;
  min?: ISODate | null;
}) {
  const [cursor, setCursor] = useState(() => (value ?? today).slice(0, 7));
  const [text, setText] = useState('');
  const parsed = text.trim() ? parseDatePhrase(text, today) : null;
  const inputRef = useRef<HTMLInputElement>(null);

  // Popovers render hidden for one frame while they measure, which can swallow `autoFocus`.
  // Retry once visible — fine pointers only, so phones don't cover the calendar with a keyboard.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return;
    const id = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el && document.activeElement !== el) el.focus();
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const weeks = useMemo(() => {
    const first = `${cursor}-01`;
    const gridStart = addDays(first, -weekday(first));
    return Array.from({ length: 6 }, (_, w) =>
      Array.from({ length: 7 }, (_, d) => fromDay(toDay(gridStart) + w * 7 + d)),
    );
  }, [cursor]);

  const [y, m] = cursor.split('-').map(Number) as [number, number];
  const shift = (delta: number) => {
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    setCursor(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  };

  const nextMonday = addDays(startOfWeek(today), 7);
  const weekend = weekday(today) === 6 || weekday(today) === 0 ? today : addDays(today, 6 - weekday(today));
  const quick: { label: string; date: ISODate; icon: 'sun' | 'arrowRight' | 'calendar' }[] = [
    { label: '오늘', date: today, icon: 'sun' },
    { label: '내일', date: addDays(today, 1), icon: 'arrowRight' },
    { label: '이번 주말', date: weekend, icon: 'calendar' },
    { label: '다음 주', date: nextMonday, icon: 'calendar' },
  ];

  const disabled = (d: ISODate) => !!min && d < min;
  const awayFromToday = cursor !== today.slice(0, 7);

  return (
    <div className={s.panel}>
      <div className={s.inputRow}>
        <Icon name="calendar" size={15} className={s.inputIcon} />
        <input
          ref={inputRef}
          className={s.input}
          placeholder="다음 주 금요일, 11/20, 3일 후…"
          aria-label="날짜 입력 (예: 다음 주 금요일, 11/20, 3일 후)"
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (isEnter(e) && parsed && !disabled(parsed)) onPick(parsed);
          }}
        />
        {parsed && (
          <button className={s.parsed} onClick={() => !disabled(parsed) && onPick(parsed)} disabled={disabled(parsed)}>
            {formatRelativeKo(parsed, today)} <Icon name="arrowRight" size={12} />
          </button>
        )}
      </div>
      {text.trim() && !parsed && <div className={s.inputHint}>날짜를 알아듣지 못했어요</div>}
      {parsed && disabled(parsed) && <div className={s.inputHint}>고를 수 없는 날짜예요</div>}

      <div className={s.quick}>
        {quick.map((q) => (
          <button
            key={q.label}
            className={s.quickBtn}
            data-selected={value === q.date}
            disabled={disabled(q.date)}
            onClick={() => onPick(q.date)}
          >
            <Icon name={q.icon} size={14} />
            <span className={s.quickLabel}>{q.label}</span>
            <span className={s.quickHint}>{WD[weekday(q.date)]}</span>
          </button>
        ))}
      </div>

      <div className={s.calHeader}>
        <span className={s.month} aria-live="polite">
          {y}년 {m}월
        </span>
        {awayFromToday && (
          <button className={s.thisMonth} onClick={() => setCursor(today.slice(0, 7))} aria-label="이번 달로 이동">
            이번 달
          </button>
        )}
        <button className={s.nav} onClick={() => shift(-1)} aria-label="이전 달">
          <Icon name="chevronLeft" size={15} />
        </button>
        <button className={s.nav} onClick={() => shift(1)} aria-label="다음 달">
          <Icon name="chevronRight" size={15} />
        </button>
      </div>

      <div className={s.grid} role="grid" aria-label={`${y}년 ${m}월`}>
        {WD.map((w) => (
          <div key={w} className={s.wd} aria-hidden="true">
            {w}
          </div>
        ))}
        {weeks.flat().map((d) => {
          const inMonth = d.slice(0, 7) === cursor;
          const inRange = !!rangeStart && !!rangeEnd && d >= rangeStart && d <= rangeEnd;
          const wd = weekday(d);
          return (
            <button
              key={d}
              className={cx(
                s.day,
                !inMonth && s.out,
                d === today && s.today,
                inRange && s.inRange,
                inRange && (d === rangeStart || wd === 0) && s.rangeStart,
                inRange && (d === rangeEnd || wd === 6) && s.rangeEnd,
                d === value && s.selected,
              )}
              disabled={disabled(d)}
              aria-label={`${Number(d.slice(5, 7))}월 ${Number(d.slice(8))}일 ${WD[wd]}요일${d === today ? ', 오늘' : ''}`}
              aria-current={d === today ? 'date' : undefined}
              data-selected={d === value || undefined}
              onClick={() => onPick(d)}
            >
              {Number(d.slice(8))}
            </button>
          );
        })}
      </div>

      {clearable && value && (
        <button className={s.clear} onClick={() => onPick(null)}>
          <Icon name="x" size={14} /> 날짜 지우기
        </button>
      )}
    </div>
  );
}

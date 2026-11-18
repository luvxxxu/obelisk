'use client';

import {
  addDays,
  DAY_MINUTES,
  formatDurationKo,
  formatRelativeKo,
  formatTimeKo,
  fromDay,
  fromMinutes,
  parseDateTimePhrase,
  startOfWeek,
  toDay,
  toMinutes,
  weekday,
  type ISODate,
  type ISOTime,
} from '@obelisk/core';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { clockNow } from '@/lib/clock';
import { cx, withTime } from '@/lib/format';
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
  /** `time` is set only when the typed phrase named one ("내일 오후 3시"). */
  onPick: (date: ISODate | null, time?: ISOTime) => void;
  clearable?: boolean;
  rangeStart?: ISODate | null;
  rangeEnd?: ISODate | null;
  min?: ISODate | null;
}) {
  const [cursor, setCursor] = useState(() => (value ?? today).slice(0, 7));
  const [text, setText] = useState('');
  const phrase = text.trim() ? parseDateTimePhrase(text, today, clockNow().date === today ? clockNow().minutes : null) : null;
  const parsed = phrase?.date ?? null;
  const pick = (d: ISODate) => (phrase?.time ? onPick(d, phrase.time) : onPick(d));
  const inputRef = useRef<HTMLInputElement>(null);
  useFocusOnOpen(inputRef);

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
          placeholder="다음 주 금요일, 내일 오후 3시…"
          aria-label="날짜 입력 (예: 다음 주 금요일, 11/20, 내일 오후 3시)"
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (isEnter(e) && parsed && !disabled(parsed)) pick(parsed);
          }}
        />
        {parsed && (
          <button className={s.parsed} onClick={() => !disabled(parsed) && pick(parsed)} disabled={disabled(parsed)}>
            {withTime(formatRelativeKo(parsed, today), phrase?.time)} <Icon name="arrowRight" size={12} />
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

/**
 * Popovers render hidden for one frame while they measure, which can swallow `autoFocus`.
 * Retry once visible — fine pointers only, so phones don't cover the panel with a keyboard.
 */
function useFocusOnOpen(ref: React.RefObject<HTMLInputElement | null>, select = false) {
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return;
    const id = requestAnimationFrame(() => {
      const el = ref.current;
      if (el && document.activeElement !== el) el.focus();
      if (el && select) el.select();
    });
    return () => cancelAnimationFrame(id);
  }, [ref, select]);
}

const SLOT_STEP = 30;
const pad2 = (n: number) => String(n).padStart(2, '0');

/** The coming full hour, or an hour after `min` when there is one. */
function suggestedTime(min?: ISOTime | null): ISOTime {
  if (min) return fromMinutes(Math.min(DAY_MINUTES - 1, toMinutes(min) + 60));
  return fromMinutes(Math.min(DAY_MINUTES - SLOT_STEP, Math.ceil(clockNow().minutes / 60) * 60));
}

/**
 * Any minute of the day: 오전/오후 · 시 : 분, typed or stepped with ↑↓, applied with Enter.
 * The hour also takes a 24-hour value ("15" → 오후 3), so both habits work.
 */
function TimeEntry({ initial, min, onSubmit }: { initial: ISOTime; min?: ISOTime | null; onSubmit: (t: ISOTime) => void }) {
  const start = toMinutes(initial);
  const [pm, setPm] = useState(start >= 720);
  const [hour, setHour] = useState(String(Math.floor(start / 60) % 12 || 12));
  const [minute, setMinute] = useState(pad2(start % 60));
  const hourRef = useRef<HTMLInputElement>(null);
  const minuteRef = useRef<HTMLInputElement>(null);
  useFocusOnOpen(hourRef, true);

  const h = Number(hour);
  const m = Number(minute || '0');
  const time = hour && h >= 1 && h <= 12 && m <= 59 ? fromMinutes(((h % 12) + (pm ? 12 : 0)) * 60 + m) : null;
  const early = !!time && !!min && time < min;
  const submit = () => {
    if (time && !early) onSubmit(time);
  };

  // Synchronous, so the next keystroke of a fast typist already lands in the minutes.
  // (Focusing selects them; a value set in the same change then leaves the caret at its end.)
  const toMinute = () => minuteRef.current?.focus();

  const typeHour = (raw: string) => {
    // A whole time pasted or typed in one go ("15:47", "1547", "9:05") fills both boxes.
    const all = raw.replace(/\D/g, '');
    if (all.length >= 3 || /\d[:.]\d/.test(raw)) {
      const hh = Number(all.slice(0, -2) || '0');
      const mm = Number(all.slice(-2));
      if (all.length <= 4 && hh < 24 && mm < 60) {
        setPm(hh >= 12);
        setHour(String(hh % 12 || 12));
        setMinute(pad2(mm));
        return toMinute();
      }
    }
    const d = all.slice(0, 2);
    if (d.length < 2) {
      setHour(d);
      // 3–9 can only be a whole hour; 0, 1 and 2 may still get a second digit.
      if (d && Number(d) >= 3) toMinute();
      return;
    }
    const n = Number(d);
    if (n === 0) {
      setHour('12');
      setPm(false);
    } else if (n <= 12) setHour(String(n));
    else if (n <= 23) {
      setHour(String(n - 12));
      setPm(true);
    } else {
      // "24" was "2" then the first digit of the minutes.
      setHour(d[0]!);
      setMinute(d[1]!);
      return toMinute();
    }
    toMinute();
  };

  const typeMinute = (raw: string) => {
    const d = raw.replace(/\D/g, '').slice(0, 2);
    setMinute(d.length === 1 && Number(d) >= 6 ? `0${d}` : d);
  };

  const stepHour = (dir: 1 | -1) => {
    let n = (Number(hour) || 12) + dir;
    if (n === 13) n = 1;
    if (n === 0) n = 12;
    // Like a clock face: 11 → 12 crosses noon or midnight.
    if ((dir > 0 && n === 12) || (dir < 0 && n === 11)) setPm((p) => !p);
    setHour(String(n));
  };
  const stepMinute = (dir: 1 | -1, big: boolean) => setMinute(pad2(((Number(minute) || 0) + dir * (big ? 10 : 1) + 60) % 60));

  const keys = (e: React.KeyboardEvent, step: (dir: 1 | -1, big: boolean) => void) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      step(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
    } else if (isEnter(e)) {
      e.preventDefault();
      submit();
    }
  };

  const lengthHint = time && min && time > min ? `시작부터 ${formatDurationKo(toMinutes(time) - toMinutes(min))}` : null;

  return (
    <>
      <div className={s.entry}>
        <div className={s.timeField} data-invalid={(!time || early) && !!hour}>
          <button
            type="button"
            className={s.meridiem}
            aria-label={`${pm ? '오후' : '오전'}, 눌러서 바꾸기`}
            onClick={() => setPm((p) => !p)}
            onKeyDown={(e) => keys(e, () => setPm((p) => !p))}
          >
            {pm ? '오후' : '오전'}
          </button>
          <input
            ref={hourRef}
            className={s.seg}
            inputMode="numeric"
            autoComplete="off"
            aria-label="시"
            value={hour}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => typeHour(e.target.value)}
            onBlur={() => hour === '0' && (setHour('12'), setPm(false))}
            onKeyDown={(e) => {
              if (e.key === ':' || e.key === '.') {
                e.preventDefault();
                toMinute();
              } else keys(e, (dir) => stepHour(dir));
            }}
          />
          <span className={s.colon} aria-hidden="true">
            :
          </span>
          <input
            ref={minuteRef}
            className={s.seg}
            inputMode="numeric"
            autoComplete="off"
            maxLength={2}
            aria-label="분"
            value={minute}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => typeMinute(e.target.value)}
            onBlur={() => minute.length === 1 && setMinute(`0${minute}`)}
            onKeyDown={(e) => {
              if (e.key === 'Backspace' && !minute) {
                e.preventDefault();
                hourRef.current?.focus();
              } else keys(e, stepMinute);
            }}
          />
        </div>
        <button type="button" className={s.apply} disabled={!time || early} onClick={submit}>
          설정
        </button>
      </div>
      {early ? (
        <div className={s.inputHint}>시작 시각보다 빨라요</div>
      ) : lengthHint ? (
        <div className={s.inputHint}>{lengthHint}</div>
      ) : null}
    </>
  );
}

/**
 * Time of day: set any minute directly, or pick a half-hour slot (calendar-app style). With `min`
 * (the start time of a same-day task), earlier times are off and each slot shows the length.
 */
export function TimePickerPanel({
  value,
  onPick,
  min,
  clearable = true,
}: {
  value: ISOTime | null;
  onPick: (time: ISOTime | null) => void;
  min?: ISOTime | null;
  clearable?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const initial = value ?? suggestedTime(min);

  const slots = useMemo(() => {
    const list = Array.from({ length: DAY_MINUTES / SLOT_STEP }, (_, i) => fromMinutes(i * SLOT_STEP));
    for (const extra of [value, min]) if (extra && !list.includes(extra)) list.push(extra);
    return list.sort();
  }, [value, min]);

  const early = (t: ISOTime) => !!min && t < min;

  // Open the list on the chosen time, else just after the start time, else the coming hour.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const target = value ?? min ?? suggestedTime();
    const el = list.querySelector<HTMLElement>(`[data-time="${target}"]`);
    if (el) list.scrollTop = el.offsetTop - list.clientHeight / 2 + el.clientHeight / 2;
  }, [value, min]);

  return (
    <div className={cx(s.panel, s.timePanel)}>
      <TimeEntry initial={initial} min={min} onSubmit={onPick} />

      <div ref={listRef} className={s.slots} role="listbox" aria-label="빠른 선택">
        {slots.map((t) => (
          <button
            key={t}
            type="button"
            role="option"
            aria-selected={t === value}
            data-time={t}
            data-selected={t === value || undefined}
            className={s.slot}
            disabled={early(t)}
            onClick={() => onPick(t)}
          >
            <span className={s.slotTime}>{formatTimeKo(t)}</span>
            {min && !early(t) && <span className={s.slotHint}>{t === min ? '시작' : formatDurationKo(toMinutes(t) - toMinutes(min))}</span>}
            {t === value && <Icon name="check" size={14} className={s.slotCheck} />}
          </button>
        ))}
      </div>

      {clearable && value && (
        <button className={s.clear} onClick={() => onPick(null)}>
          <Icon name="x" size={14} /> 시간 지우기
        </button>
      )}
    </div>
  );
}

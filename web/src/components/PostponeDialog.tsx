'use client';

import { formatShortKo } from '@obelisk/core';
import { resolvePending, usePendingChange } from '@/lib/reschedule';
import { daysLabel } from '@/lib/format';
import { Icon } from './Icon';
import { ImpactView } from './ImpactView';
import { Modal, ui } from './primitives';
import s from './PostponeDialog.module.css';

/** Shown whenever a date edit would ripple into other tasks. */
export function PostponeDialog() {
  const p = usePendingChange();
  if (!p) return null;
  const { summary } = p.preview.report;
  const others = p.preview.cascade.length - 1;
  const days = p.preview.shiftDays;
  // Name the target date: for an overdue task "이틀 미루기" (from today) is a 4-day shift
  // from its old due date, and "4일 미루면" alone read like a mismatch with the menu.
  const target = p.next.dueDate ?? p.next.startDate;

  return (
    <Modal
      open
      onClose={() => void resolvePending('cancel')}
      width={600}
      title={
        days === 0
          ? `“${p.title}” 일정을 바꾸면`
          : `“${p.title}”을(를) ${target ? `${formatShortKo(target)}로 ` : ''}${daysLabel(Math.abs(days))} ${days > 0 ? '미루면' : '당기면'}`
      }
      description="적용하기 전에 아래 영향을 확인하고, 어떻게 옮길지 골라 주세요."
      footer={
        <div className={s.actions}>
          <button className={`${ui.btn} ${ui.ghost}`} onClick={() => void resolvePending('cancel')}>
            취소
          </button>
          <button className={`${ui.btn} ${ui.secondary}`} onClick={() => void resolvePending('only')}>
            이 작업만 변경
          </button>
          <button className={`${ui.btn} ${ui.primary}`} autoFocus onClick={() => void resolvePending('cascade')}>
            {others > 0 ? `연쇄 적용 · ${others}개 함께 이동` : '변경'}
          </button>
        </div>
      }
    >
      <div className={s.body}>
        <ImpactView report={p.preview.report} linkTasks={false} />

        {p.preview.startsBeforeBlockers.length > 0 && (
          <div className={ui.alert} data-tone="danger" role="alert">
            <Icon name="lock" size={16} />
            <div className={ui.alertTitle}>먼저 끝나야 하는 작업보다 앞서 시작하게 돼요</div>
            <ul className={`${ui.alertDescription} ${s.blockerList}`}>
              {p.preview.startsBeforeBlockers.map((b) => (
                <li key={b.taskId}>
                  {b.number ? `#${b.number} ` : ''}
                  {b.title} · {formatShortKo(b.dueDate)} 마감, {daysLabel(b.overlapDays)} 겹침
                </li>
              ))}
            </ul>
          </div>
        )}

        {others > 0 && (
          <dl className={s.choices}>
            <div className={s.choice}>
              <dt>연쇄 적용</dt>
              <dd>뒤에 이어진 작업 {others}개도 필요한 만큼 함께 옮겨요.</dd>
            </div>
            <div className={s.choice}>
              <dt>이 작업만 변경</dt>
              <dd>
                {summary.conflictCount === 0
                  ? '뒤 작업들이 이 작업보다 먼저 시작하는 일정이 돼요.'
                  : '이 작업만 옮기고, 뒤 작업 일정은 그대로 둬요.'}
              </dd>
            </div>
          </dl>
        )}

        {summary.conflictCount > 0 && (
          <p className={s.note}>
            <Icon name="info" size={14} />
            <span>고정 일정은 자동으로 옮기지 않아요. 충돌을 없애려면 지연 폭을 줄이거나, 고정 일정 자체를 직접 조정하세요.</span>
          </p>
        )}
      </div>
    </Modal>
  );
}

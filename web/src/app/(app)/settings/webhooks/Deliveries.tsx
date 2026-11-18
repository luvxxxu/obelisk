'use client';

import { chatMessage, orderPayload, type Webhook, type WebhookDelivery } from '@obelisk/core';
import { useCallback, useEffect, useState } from 'react';
import { Icon, type IconName } from '@/components/Icon';
import { Modal, Skeleton, Spinner, ui } from '@/components/primitives';
import { api } from '@/lib/api';
import { cx, relativeTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import { deliveryTone } from './shared';
import s from './webhooks.module.css';

const STATUS_LABEL: Record<WebhookDelivery['status'], string> = { success: '성공', failed: '실패', pending: '재시도 대기' };
const STATUS_ICON: Record<WebhookDelivery['status'], IconName> = { success: 'checkCircle', failed: 'xCircle', pending: 'clock' };

function sentBody(hook: Webhook, d: WebhookDelivery): string {
  const body = hook.format === 'json' ? orderPayload(d.payload) : chatMessage(d.payload, hook.format);
  return JSON.stringify(body, null, 2);
}

function prettyResponse(body: string | null): string {
  if (!body) return '(빈 응답)';
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export function Deliveries({ hook, onClose, onChanged }: { hook: Webhook | null; onClose: () => void; onChanged: () => void }) {
  const [list, setList] = useState<WebhookDelivery[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!hook) return;
    try {
      const r = await api<{ deliveries: WebhookDelivery[] }>('GET', `/api/webhooks/${hook.id}/deliveries`);
      setList(r.deliveries);
    } catch (e) {
      toast.error((e as Error).message);
      setList([]);
    }
  }, [hook]);

  useEffect(() => {
    setList(null);
    setOpen(null);
    if (hook) void load();
  }, [hook, load]);

  const redeliver = async (d: WebhookDelivery) => {
    if (!hook) return;
    setBusy(d.id);
    try {
      const r = await api<{ delivery: WebhookDelivery }>('POST', `/api/webhooks/${hook.id}/deliveries/${d.id}/redeliver`);
      if (r.delivery.status === 'success') toast.success(`다시 보냈어요 · HTTP ${r.delivery.responseStatus}`);
      else toast.error(`다시 보내지 못했어요 · ${r.delivery.error ?? '실패'}`);
      setList((cur) => (cur ? [r.delivery, ...cur] : [r.delivery]));
      setOpen(r.delivery.id);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open={!!hook}
      onClose={onClose}
      width={720}
      title={hook ? `전달 기록 · ${hook.name}` : '전달 기록'}
      description="최근 50건이에요. 실패하면 1분, 5분, 30분, 2시간, 6시간 뒤에 다시 보내고, 기록은 30일 동안 보관해요."
      footer={
        <>
          <button type="button" className={cx(ui.btn, ui.ghost, s.footLeft)} onClick={() => void load()}>
            <Icon name="undo" size={14} /> 새로고침
          </button>
          <button type="button" className={cx(ui.btn, ui.outline)} onClick={onClose}>
            닫기
          </button>
        </>
      }
    >
      {!list ? (
        <div className={s.logList}>
          {[0, 1, 2].map((i) => (
            <div key={i} className={s.logRow}>
              <Skeleton width={15} height={15} style={{ borderRadius: 99 }} />
              <Skeleton width={180 + i * 40} height={13} />
              <Skeleton width={60} height={12} style={{ marginLeft: 'auto' }} />
            </div>
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className={s.logEmpty}>
          <Icon name="clock" size={18} />
          <p>아직 보낸 기록이 없어요. 메뉴의 ‘테스트 보내기’로 연결을 확인해 보세요.</p>
        </div>
      ) : (
        <ul className={s.logList}>
          {list.map((d) => {
            const expanded = open === d.id;
            return (
              <li key={d.id} className={s.logItem} data-open={expanded || undefined}>
                <button type="button" className={s.logRow} aria-expanded={expanded} onClick={() => setOpen(expanded ? null : d.id)}>
                  <span className={s.logStatus} data-tone={deliveryTone(d.status)} role="img" aria-label={STATUS_LABEL[d.status]}>
                    <Icon name={STATUS_ICON[d.status]} size={15} />
                  </span>
                  <code className={s.logEvent}>{d.event}</code>
                  <span className={s.logText}>{d.payload.text}</span>
                  <span className={s.logMeta}>
                    {d.responseStatus ? `${d.responseStatus}` : d.status === 'failed' ? '오류' : ''}
                    {d.responseStatus || d.status === 'failed' ? ' · ' : ''}
                    {relativeTime(d.lastAttemptAt ?? d.createdAt)}
                  </span>
                  <Icon name="chevronDown" size={14} className={s.logChev} />
                </button>
                {expanded && (
                  <div className={s.logDetail}>
                    <dl className={s.facts}>
                      <div>
                        <dt>상태</dt>
                        <dd>
                          {STATUS_LABEL[d.status]}
                          {d.status === 'pending' && d.nextAttemptAt ? ` · ${new Date(d.nextAttemptAt).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })}에 다시 시도` : ''}
                        </dd>
                      </div>
                      <div>
                        <dt>시도</dt>
                        <dd>
                          {d.attempts}/{d.maxAttempts}회{d.durationMs !== null ? ` · ${d.durationMs}ms` : ''}
                        </dd>
                      </div>
                      <div>
                        <dt>만든 시각</dt>
                        <dd>{new Date(d.createdAt).toLocaleString('ko-KR')}</dd>
                      </div>
                    </dl>
                    {d.error && (
                      <div className={ui.alert} data-tone="danger" role="note">
                        <Icon name="alertCircle" size={16} />
                        <p className={ui.alertTitle}>{d.error}</p>
                      </div>
                    )}
                    <div className={s.bodies}>
                      <div>
                        <p className={s.bodyLabel}>보낸 본문</p>
                        <pre className={s.pre}>{sentBody(hook!, d)}</pre>
                      </div>
                      <div>
                        <p className={s.bodyLabel}>응답{d.responseStatus ? ` · HTTP ${d.responseStatus}` : ''}</p>
                        <pre className={s.pre}>{d.attempts ? prettyResponse(d.responseBody) : '(아직 보내지 않음)'}</pre>
                      </div>
                    </div>
                    <div className={s.logActions}>
                      <button type="button" className={cx(ui.btn, ui.sm, ui.outline)} disabled={busy === d.id} onClick={() => void redeliver(d)}>
                        {busy === d.id ? <Spinner /> : <Icon name="undo" size={14} />} 다시 보내기
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

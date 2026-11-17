'use client';

import {
  DEFAULT_WEBHOOK_EVENTS,
  detectWebhookFormat,
  isScheduleEvent,
  WEBHOOK_EVENT_GROUPS,
  WEBHOOK_FORMAT_LABEL,
  WEBHOOK_FORMATS,
  type Project,
  type Webhook,
  type WebhookEventKey,
  type WebhookFormat,
  type WorkspaceKind,
} from '@obelisk/core';
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { isEnter, Modal, ui } from '@/components/primitives';
import { api } from '@/lib/api';
import { cx } from '@/lib/format';
import { toast } from '@/lib/toast';
import { hourLabel, Pick } from './shared';
import s from './webhooks.module.css';

const FORMAT_HINT: Record<WebhookFormat, string> = {
  json: '서명된 JSON을 POST해요. 내 서버, Zapier, Make, n8n 등에서 받을 수 있어요.',
  slack: 'Slack Incoming Webhook으로 채널에 한국어 메시지를 보내요.',
  discord: 'Discord 채널 웹훅으로 한국어 메시지를 보내요. 멘션은 울리지 않아요.',
};

export function WebhookForm({
  open,
  initial,
  kind,
  projects,
  timezone,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** null = new webhook */
  initial: Webhook | null;
  kind: WorkspaceKind;
  projects: Project[];
  timezone: string;
  onClose: () => void;
  onSaved: (hook: Webhook, secret?: string) => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [format, setFormat] = useState<WebhookFormat>('json');
  const [formatTouched, setFormatTouched] = useState(false);
  const [events, setEvents] = useState<Set<WebhookEventKey>>(new Set(DEFAULT_WEBHOOK_EVENTS));
  const [scope, setScope] = useState<'all' | 'some'>('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [alertHour, setAlertHour] = useState(9);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? '');
    setUrl(initial?.url ?? '');
    setFormat(initial?.format ?? 'json');
    setFormatTouched(!!initial && initial.format !== detectWebhookFormat(initial.url));
    setEvents(new Set(initial?.events ?? DEFAULT_WEBHOOK_EVENTS));
    setScope(initial?.projectIds ? 'some' : 'all');
    setPicked(new Set(initial?.projectIds ?? []));
    setAlertHour(initial?.alertHour ?? 9);
    setSaving(false);
  }, [open, initial]);

  const groups = WEBHOOK_EVENT_GROUPS.filter((g) => !g.orgOnly || kind === 'org');
  const hasSchedule = [...events].some(isScheduleEvent);
  const liveProjects = useMemo(
    () => projects.filter((p) => !p.archivedAt || picked.has(p.id)).sort((a, b) => a.position - b.position),
    [projects, picked],
  );
  const urlOk = /^https?:\/\/[^\s/]+/i.test(url.trim());
  const problem = !name.trim()
    ? '이름을 입력하세요'
    : !urlOk
      ? 'https://로 시작하는 URL을 입력하세요'
      : !events.size
        ? '보낼 이벤트를 하나 이상 고르세요'
        : scope === 'some' && !picked.size
          ? '프로젝트를 하나 이상 고르세요'
          : null;

  const onUrl = (v: string) => {
    setUrl(v);
    if (!formatTouched) setFormat(detectWebhookFormat(v.trim()));
  };

  const toggle = (key: WebhookEventKey, on: boolean) =>
    setEvents((cur) => {
      const n = new Set(cur);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });

  const save = async () => {
    if (problem || saving) return;
    setSaving(true);
    const body = {
      name: name.trim(),
      url: url.trim(),
      format,
      events: [...events],
      projectIds: scope === 'all' ? null : [...picked],
      alertHour,
    };
    try {
      if (initial) {
        const r = await api<{ webhook: Webhook }>('PATCH', `/api/webhooks/${initial.id}`, body);
        onSaved(r.webhook);
      } else {
        const r = await api<{ webhook: Webhook; secret: string }>('POST', '/api/webhooks', body);
        onSaved(r.webhook, r.secret);
      }
    } catch (e) {
      toast.error((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={600}
      title={initial ? '웹훅 수정' : '보내는 웹훅 추가'}
      description="Obelisk에서 일어난 일을 다른 서비스로 보내요."
      footer={
        <>
          {problem && <span className={s.footHint}>{problem}</span>}
          <button type="button" className={cx(ui.btn, ui.outline)} onClick={onClose}>
            취소
          </button>
          <button type="button" className={cx(ui.btn, ui.primary)} disabled={!!problem || saving} onClick={() => void save()}>
            {saving ? '저장하는 중…' : initial ? '저장' : '만들기'}
          </button>
        </>
      }
    >
      <div className={s.form}>
        <div className={s.formRow}>
          <label className={ui.field}>
            <span className={ui.label}>이름</span>
            <input
              className={ui.input}
              value={name}
              placeholder="예: #팀-알림 채널"
              maxLength={80}
              autoFocus={!initial}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => isEnter(e) && void save()}
            />
          </label>
        </div>

        <label className={ui.field}>
          <span className={ui.label}>URL</span>
          <input
            className={cx(ui.input, s.mono)}
            value={url}
            placeholder="https://hooks.slack.com/services/…"
            spellCheck={false}
            inputMode="url"
            onChange={(e) => onUrl(e.target.value)}
            onKeyDown={(e) => isEnter(e) && void save()}
          />
        </label>

        <div className={ui.field}>
          <span className={ui.label}>보내는 형식</span>
          <div className={s.formatRow}>
            <div className={ui.segmented} role="radiogroup" aria-label="보내는 형식">
              {WEBHOOK_FORMATS.map((f) => (
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={format === f}
                  className={ui.segment}
                  aria-pressed={format === f}
                  onClick={() => {
                    setFormat(f);
                    setFormatTouched(true);
                  }}
                >
                  {WEBHOOK_FORMAT_LABEL[f]}
                </button>
              ))}
            </div>
            {!formatTouched && url.trim() && <span className={s.auto}>URL을 보고 골랐어요</span>}
          </div>
          <p className={ui.help}>{FORMAT_HINT[format]}</p>
        </div>

        <div className={ui.field}>
          <span className={ui.label}>보낼 이벤트</span>
          <div className={s.groups}>
            {groups.map((g) => {
              const all = g.events.every((e) => events.has(e.key));
              return (
                <fieldset key={g.id} className={s.group}>
                  <legend className={s.groupHead}>
                    <span>{g.label}</span>
                    {g.events.length > 1 && (
                      <button
                        type="button"
                        className={s.groupAll}
                        onClick={() =>
                          setEvents((cur) => {
                            const n = new Set(cur);
                            for (const e of g.events) {
                              if (all) n.delete(e.key);
                              else n.add(e.key);
                            }
                            return n;
                          })
                        }
                      >
                        {all ? '모두 해제' : '모두 선택'}
                      </button>
                    )}
                  </legend>
                  <div className={s.eventGrid}>
                    {g.events.map((e) => (
                      <Pick key={e.key} checked={events.has(e.key)} onChange={(v) => toggle(e.key, v)} className={s.eventPick}>
                        <span className={s.pickText}>
                          <span className={s.pickLabel}>{e.label}</span>
                          <span className={s.pickHint}>{e.hint}</span>
                        </span>
                      </Pick>
                    ))}
                  </div>
                  {g.id === 'schedule' && (
                    <div className={s.alertHour} data-on={hasSchedule}>
                      <Icon name="clock" size={14} />
                      <span>매일</span>
                      <select
                        className={cx(ui.input, s.hourSelect)}
                        value={alertHour}
                        disabled={!hasSchedule}
                        aria-label="일정 알림 시각"
                        onChange={(e) => setAlertHour(Number(e.target.value))}
                      >
                        {Array.from({ length: 24 }, (_, h) => (
                          <option key={h} value={h}>
                            {hourLabel(h)}
                          </option>
                        ))}
                      </select>
                      <span>부터 · 작업마다 하루 한 번</span>
                      <span className={s.tz}>{initial && initial.alertHour === alertHour ? initial.timezone : timezone}</span>
                    </div>
                  )}
                </fieldset>
              );
            })}
          </div>
        </div>

        <div className={ui.field}>
          <span className={ui.label}>프로젝트 범위</span>
          <div className={ui.segmented} role="radiogroup" aria-label="프로젝트 범위">
            <button type="button" role="radio" aria-checked={scope === 'all'} aria-pressed={scope === 'all'} className={ui.segment} onClick={() => setScope('all')}>
              모든 프로젝트
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={scope === 'some'}
              aria-pressed={scope === 'some'}
              className={ui.segment}
              disabled={!projects.length}
              onClick={() => setScope('some')}
            >
              고른 프로젝트만
            </button>
          </div>
          {scope === 'some' && (
            <ul className={s.pickList}>
              {liveProjects.map((p) => (
                <li key={p.id}>
                  <Pick
                    checked={picked.has(p.id)}
                    onChange={(v) =>
                      setPicked((cur) => {
                        const n = new Set(cur);
                        if (v) n.add(p.id);
                        else n.delete(p.id);
                        return n;
                      })
                    }
                  >
                    <span className={s.projectDot} style={{ background: `var(--c-${p.color})` }} aria-hidden="true" />
                    <span className={s.pickLabel}>{p.name}</span>
                    {p.archivedAt && <span className={s.pickHint}>보관됨</span>}
                  </Pick>
                </li>
              ))}
            </ul>
          )}
          <p className={ui.help}>
            {kind === 'org'
              ? '프로젝트에 속하지 않은 작업(인박스)은 만든 사람과 담당자만 보는 비공개라 보내지 않아요. 멤버·팀·초대 이벤트는 범위와 상관없이 보내요.'
              : '개인 공간의 모든 작업이 대상이에요. 범위를 고르면 그 프로젝트의 작업만 보내요.'}
          </p>
        </div>
      </div>
    </Modal>
  );
}

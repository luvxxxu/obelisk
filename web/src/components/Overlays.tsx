'use client';

import { setPref } from '@/lib/hooks';
import { formatRelativeKo } from '@obelisk/core';
import { usePathname, useRouter } from 'next/navigation';
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '@/lib/format';
import { canWriteProject, selectTask, switchWorkspace, useApp } from '@/lib/store';
import { dismiss, useToasts } from '@/lib/toast';
import { isApple, modKey } from '@/lib/ui-helpers';
import { setUi, useUi } from '@/lib/ui-state';
import { redo, undo, useUndoState } from '@/lib/undo';
import { Icon, type IconName } from './Icon';
import { Badge, Modal, ui } from './primitives';
import { QuickAdd } from './QuickAdd';
import s from './Overlays.module.css';

/* ───────────────────────────── quick add */

export function QuickAddModal() {
  const { quickAdd } = useUi();
  const app = useApp();
  const pathname = usePathname();
  const projectId = pathname.startsWith('/projects/') ? pathname.split('/')[2] : undefined;
  // A view-only project can't take new tasks: they go to your inbox instead.
  const project = app.projects.find((p) => p.id === projectId && canWriteProject(p.id));
  const onToday = pathname === '/today';
  const onMine = pathname === '/mine';

  const description = onMine
    ? '여기서 추가한 작업은 내가 담당자로 지정돼요.'
    : project
    ? `#프로젝트를 따로 적지 않으면 ‘${project.name}’에 추가돼요.`
    : onToday
      ? '날짜를 적지 않으면 오늘 할 일로 추가돼요.'
      : '자연어로 적으면 날짜 · 프로젝트 · 우선순위를 알아서 읽어요.';

  return (
    <Modal
      open={quickAdd}
      onClose={() => setUi({ quickAdd: false })}
      width={600}
      title={
        <span className={s.qaTitle}>
          <span>새 작업</span>
          {project && (
            <Badge tone="outline" className={s.qaBadge}>
              <span className={ui.dot} style={{ background: `var(--c-${project.color})` }} />
              <span className={ui.truncate}>{project.name}</span>
            </Badge>
          )}
          {onToday && (
            <Badge tone="outline" className={s.qaBadge}>
              <Icon name="sun" size={12} />
              오늘
            </Badge>
          )}
        </span>
      }
      description={description}
    >
      <div className={s.qaBody}>
        <QuickAdd
          variant="modal"
          autoFocus
          projectId={project?.id ?? null}
          defaultDueDate={pathname === '/today' ? app.today : null}
          defaultAssigneeId={onMine ? app.user?.id : null}
          onCreated={() => setUi({ quickAdd: false })}
        />
      </div>
      <div className={s.qaHints} aria-hidden="true">
        <span className={s.hint}>
          <kbd>↵</kbd>
          추가
        </span>
        <span className={s.hint}>
          <kbd>esc</kbd>
          닫기
        </span>
      </div>
    </Modal>
  );
}

/* ───────────────────────────── command palette */

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  /** Keyboard shortcut shown as kbd keys (display only). */
  keys?: string[];
  icon: IconName;
  color?: string;
  /** Finished/canceled task — rendered muted (display only). */
  muted?: boolean;
  run: () => void;
  group: string;
}

export function CommandPalette() {
  const { palette } = useUi();
  const app = useApp();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const uid = useId();
  const history = useUndoState();

  useEffect(() => {
    if (palette) {
      setQ('');
      setIdx(0);
    }
  }, [palette]);

  const items = useMemo<Cmd[]>(() => {
    const close = () => setUi({ palette: false });
    const go = (href: string) => () => (close(), router.push(href));
    const base: Cmd[] = [
      { id: 'new', label: '새 작업 만들기', icon: 'plus', keys: ['N'], group: '명령', run: () => setUi({ palette: false, quickAdd: true }) },
      {
        id: 'undo',
        label: '실행 취소',
        // What it would take back, so the palette answers "what does ⌘Z do now".
        hint: history.undoLabel ?? '되돌릴 작업 없음',
        icon: 'undo',
        keys: [modKey(), 'Z'],
        muted: !history.canUndo,
        group: '명령',
        run: () => (close(), void undo()),
      },
      {
        id: 'redo',
        label: '다시 실행',
        hint: history.redoLabel ?? '다시 실행할 작업 없음',
        icon: 'redo',
        keys: isApple() ? ['⌘', '⇧', 'Z'] : ['Ctrl', 'Y'],
        muted: !history.canRedo,
        group: '명령',
        run: () => (close(), void redo()),
      },
      { id: 'shortcuts', label: '키보드 단축키 보기', icon: 'keyboard', keys: ['?'], group: '명령', run: () => setUi({ palette: false, shortcuts: true }) },
      { id: 'commit', label: '약속하기 전에 · 가능한 날짜 계산', hint: '언제까지 된다고 말할 수 있을까', icon: 'target', group: '명령', run: () => setUi({ palette: false, commit: {} }) },
      {
        id: 'plan',
        label: '오늘 시간표 열기',
        hint: '할 일을 빈 시간에 배치',
        icon: 'clock',
        group: '명령',
        run: () => {
          setPref('today-mode', 'plan');
          go('/today')();
        },
      },
      ...(app.user?.jev.connected
        ? [
            { id: 'jev-priority', label: 'Jev · 우선순위 정리', hint: '중요도와 마감으로 제안', icon: 'flag' as const, group: 'Jev', run: () => setUi({ palette: false, jev: { kind: 'priority' } }) },
            { id: 'jev-postpone', label: 'Jev · 오늘 미룰 작업 고르기', icon: 'postpone' as const, group: 'Jev', run: () => setUi({ palette: false, jev: { kind: 'postpone', scope: 'today' } }) },
            { id: 'jev-postpone-week', label: 'Jev · 이번 주 일정 고르게 펴기', icon: 'calendar' as const, group: 'Jev', run: () => setUi({ palette: false, jev: { kind: 'postpone', scope: 'week' } }) },
          ]
        : []),
      { id: 'home', label: '홈', icon: 'home', keys: ['G', 'H'], group: '이동', run: go('/') },
      { id: 'overview', label: '모아보기', hint: '모든 공간의 내 일', icon: 'grid', keys: ['G', 'O'], group: '이동', run: go('/overview') },
      { id: 'today', label: '오늘', icon: 'sun', keys: ['G', 'T'], group: '이동', run: go('/today') },
      { id: 'upcoming', label: '예정', icon: 'calendar', keys: ['G', 'U'], group: '이동', run: go('/upcoming') },
      { id: 'inbox', label: '인박스', icon: 'inbox', keys: ['G', 'I'], group: '이동', run: go('/inbox') },
      { id: 'forecast', label: '파급 예측', icon: 'ripple', keys: ['G', 'F'], group: '이동', run: go('/forecast') },
      { id: 'all', label: '전체 작업', icon: 'layers', keys: ['G', 'A'], group: '이동', run: go('/all') },
      { id: 'logbook', label: '완료 기록', icon: 'checkCircle', keys: ['G', 'L'], group: '이동', run: go('/logbook') },
      { id: 'trash', label: '휴지통', hint: '지운 작업 되살리기', icon: 'trash', group: '이동', run: go('/trash') },
      { id: 'ai', label: 'AI 연결 (MCP · Skill)', icon: 'plug', group: '이동', run: go('/settings/ai') },
      { id: 'jev', label: 'Jev 설정', hint: '판단 모델 연결', icon: 'scale', group: '이동', run: go('/settings/jev') },
      { id: 'planning', label: '일정 계획 설정', hint: '근무 시간 · 집중 비율', icon: 'clock', group: '이동', run: go('/settings/planning') },
      { id: 'settings', label: '설정', icon: 'settings', group: '이동', run: go('/settings') },
      { id: 'migrate', label: '데이터 이전', hint: '다른 서버로 옮기기 · 가져오기', icon: 'upload', group: '이동', run: go('/settings/migrate') },
      ...(app.workspace?.kind === 'org'
        ? [
            { id: 'mine', label: '내 작업', icon: 'user' as const, group: '이동', run: go('/mine') },
            { id: 'org', label: '조직 설정 · 멤버 · 팀', icon: 'building' as const, group: '이동', run: go('/settings/org') },
          ]
        : []),
      ...app.workspaces
        .filter((w) => w.id !== app.workspace?.id)
        .map<Cmd>((w) => ({
          id: `w-${w.id}`,
          label: `${w.kind === 'personal' ? '개인 공간' : w.name}(으)로 전환`,
          hint: w.kind === 'personal' ? '나만 보는 공간' : `멤버 ${w.memberCount}명`,
          icon: w.kind === 'personal' ? 'user' : 'building',
          group: '공간',
          run: () => {
            close();
            router.push('/');
            void switchWorkspace(w.id);
          },
        })),
      ...app.projects
        .filter((p) => !p.archivedAt)
        .map((p) => ({
          id: `p-${p.id}`,
          label: p.name,
          icon: 'folder' as const,
          color: `var(--c-${p.color})`,
          group: '프로젝트',
          run: go(`/projects/${p.id}`),
        })),
    ];
    const needle = q.trim().toLowerCase().replace(/^#/, '');
    const filtered = needle ? base.filter((c) => c.label.toLowerCase().includes(needle)) : base;
    const tasks = needle
      ? Object.values(app.tasks)
          .filter((t) => t.title.toLowerCase().includes(needle) || String(t.number) === needle)
          .sort((a, b) => {
            const ra = a.status === 'todo' || a.status === 'doing' ? 0 : 1;
            const rb = b.status === 'todo' || b.status === 'doing' ? 0 : 1;
            return ra - rb || b.number - a.number;
          })
          .slice(0, 12)
          .map<Cmd>((t) => ({
            id: `t-${t.id}`,
            label: t.title,
            hint: t.dueDate ? formatRelativeKo(t.dueDate, app.today) : `#${t.number}`,
            icon: t.status === 'done' ? 'checkCircle' : 'circleDashed',
            muted: !(t.status === 'todo' || t.status === 'doing'),
            group: '작업',
            run: () => (setUi({ palette: false }), selectTask(t.id)),
          }))
      : [];
    return [...tasks, ...filtered];
  }, [q, app, router, history]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  if (!palette || typeof document === 'undefined') return null;

  // Consecutive items with the same group form one section (same grouping as before).
  const groups: { name: string; items: { c: Cmd; i: number }[] }[] = [];
  items.forEach((c, i) => {
    const last = groups[groups.length - 1];
    if (last && last.name === c.group) last.items.push({ c, i });
    else groups.push({ name: c.group, items: [{ c, i }] });
  });
  const optionId = (i: number) => `${uid}-opt-${i}`;
  const listId = `${uid}-list`;

  return createPortal(
    <div className={cx(ui.overlay, s.paletteOverlay)} onMouseDown={(e) => e.target === e.currentTarget && setUi({ palette: false })}>
      <div className={cx(ui.modal, s.palette)} role="dialog" aria-label="명령 팔레트">
        <div className={s.paletteInput}>
          <Icon name="search" size={16} className={s.paletteSearchIcon} />
          <input
            ref={inputRef}
            autoFocus
            placeholder="작업 검색, 이동, 명령…"
            value={q}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={items[idx] ? optionId(idx) : undefined}
            aria-label="작업 검색 및 명령"
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIdx((i) => Math.min(items.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIdx((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                items[idx]?.run();
              } else if (e.key === 'Escape') {
                setUi({ palette: false });
              }
            }}
          />
          {q && (
            <button
              type="button"
              className={cx(ui.iconBtn, s.paletteClear)}
              aria-label="검색어 지우기"
              onClick={() => {
                setQ('');
                setIdx(0);
                inputRef.current?.focus();
              }}
            >
              <Icon name="x" size={14} />
            </button>
          )}
        </div>

        <div className={s.paletteList} ref={listRef} id={listId} role="listbox" aria-label="검색 결과">
          {items.length === 0 && (
            <div className={s.paletteEmpty}>
              <span className={s.paletteEmptyIcon}>
                <Icon name="search" size={18} />
              </span>
              <p className={s.paletteEmptyTitle}>결과가 없어요</p>
              <p className={s.paletteEmptyBody}>다른 검색어나 작업 번호(#12)로 찾아보세요.</p>
            </div>
          )}
          {groups.map((g, gi) => (
            <Fragment key={`${g.name}-${gi}`}>
              {gi > 0 && <div className={s.paletteSep} role="separator" />}
              <div className={s.paletteGroup} role="group" aria-labelledby={`${uid}-g-${gi}`}>
                <div className={s.paletteHeading} id={`${uid}-g-${gi}`}>
                  {g.name}
                </div>
                {g.items.map(({ c, i }) => (
                  <button
                    key={c.id}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === idx}
                    className={cx(ui.menuItem, s.paletteItem)}
                    data-active={i === idx}
                    data-muted={c.muted || undefined}
                    onMouseMove={() => setIdx(i)}
                    onClick={c.run}
                  >
                    {c.color ? (
                      <span className={s.paletteDotWrap}>
                        <span className={ui.dot} style={{ background: c.color }} />
                      </span>
                    ) : (
                      <Icon name={c.icon} size={16} />
                    )}
                    <span className={s.paletteLabel}>{c.label}</span>
                    {c.hint && <span className={ui.menuHint}>{c.hint}</span>}
                    {c.keys && (
                      <span className={s.paletteKeys} aria-hidden="true">
                        {c.keys.map((k, ki) => (
                          <kbd key={ki}>{k}</kbd>
                        ))}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </Fragment>
          ))}
        </div>

        <div className={s.paletteFooter} aria-hidden="true">
          <span className={s.hint}>
            <kbd>↑</kbd>
            <kbd>↓</kbd>
            이동
          </span>
          <span className={s.hint}>
            <kbd>↵</kbd>
            선택
          </span>
          <span className={s.hint}>
            <kbd>esc</kbd>
            닫기
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ───────────────────────────── shortcuts help */

interface ShortcutRow {
  label: string;
  /** Alternatives ("또는"); each alternative is a list of keys. */
  combos: string[][];
  /** Keys of a combo are pressed one after another (G → T) instead of together. */
  seq?: boolean;
}

/** Mouse actions written as words beside the keys, not drawn as keys. */
const MOUSE = new Set(['클릭', '드래그', '우클릭']);

function shortcutSections(): { title: string; rows: ShortcutRow[] }[][] {
  const mod = modKey();
  const apple = isApple();
  const shift = apple ? '⇧' : 'Shift';
  const del = apple ? '⌫' : 'Delete';
  return [
    [
      {
        title: '기본',
        rows: [
          { label: '새 작업', combos: [['N']] },
          { label: '검색 · 명령 팔레트', combos: [[mod, 'K'], ['/']] },
          { label: '사이드바 열기/접기', combos: [[mod, 'B']] },
          { label: '패널 · 창 닫기', combos: [['Esc']] },
          { label: '단축키 보기', combos: [['?']] },
        ],
      },
      {
        title: '작업 목록',
        rows: [
          { label: '다음 · 이전 작업으로 이동', combos: [['J'], ['K']] },
          { label: '처음 · 마지막 작업으로', combos: [['Home'], ['End']] },
          { label: '작업 열기', combos: [['Enter']] },
          { label: '완료 토글', combos: [['X'], ['Space']] },
        ],
      },
      {
        title: '선택',
        rows: [
          { label: '모두 선택', combos: [[mod, 'A']] },
          { label: '하나씩 더하거나 빼기', combos: [[mod, '클릭']] },
          { label: '사이를 모두 선택', combos: [[shift, '클릭']] },
          { label: '끌어서 여러 개 선택', combos: [['드래그']] },
          { label: '위아래로 넓히기', combos: [[shift, '↑'], [shift, '↓']] },
          { label: '선택 해제', combos: [['Esc']] },
        ],
      },
    ],
    [
      {
        title: '편집',
        rows: [
          { label: '완료', combos: [[mod, 'Enter']] },
          { label: '오늘로', combos: [['T']] },
          { label: '하루 미루기', combos: [['P']] },
          { label: '우선순위 높음 · 보통 · 낮음 · 없음', combos: [['1'], ['2'], ['3'], ['4']] },
          { label: '제목 바꾸기', combos: [['E'], ['F2']] },
          { label: '복제', combos: [[mod, 'D']] },
          { label: '텍스트로 복사', combos: [[mod, 'C']] },
          { label: '붙여넣어 작업 만들기', combos: [[mod, 'V']] },
          { label: '휴지통으로 옮기기', combos: [[del]] },
          { label: '실행 취소', combos: [[mod, 'Z']] },
          { label: '다시 실행', combos: apple ? [['⌘', '⇧', 'Z']] : [['Ctrl', 'Shift', 'Z'], ['Ctrl', 'Y']] },
          { label: '메뉴 열기', combos: [['우클릭']] },
          { label: '사이드바로 끌어 옮기기', combos: [['드래그']] },
        ],
      },
    ],
    [
      {
        title: '페이지 이동',
        rows: [
          { label: '홈', combos: [['G', 'H']], seq: true },
          { label: '모아보기', combos: [['G', 'O']], seq: true },
          { label: '오늘', combos: [['G', 'T']], seq: true },
          { label: '예정', combos: [['G', 'U']], seq: true },
          { label: '인박스', combos: [['G', 'I']], seq: true },
          { label: '파급 예측', combos: [['G', 'F']], seq: true },
          { label: '전체 작업', combos: [['G', 'A']], seq: true },
          { label: '완료 기록', combos: [['G', 'L']], seq: true },
        ],
      },
    ],
  ];
}

export function ShortcutsHelp() {
  const { shortcuts } = useUi();
  const columns = shortcuts ? shortcutSections() : [];
  return (
    <Modal
      open={shortcuts}
      onClose={() => setUi({ shortcuts: false })}
      title="키보드 단축키"
      description="편집 단축키는 고른 작업에 쓰여요. 고른 작업이 없으면 J/K로 옮겨 간 작업이나 열어 둔 작업에 쓰여요."
      width={920}
    >
      <div className={s.shortcutCols}>
        {columns.map((sections, ci) => (
          <div key={ci} className={s.shortcutCol}>
            {sections.map((sec) => (
              <section key={sec.title} className={s.shortcutSection}>
                <h3 className={s.shortcutTitle}>{sec.title}</h3>
                <ul className={s.shortcutList}>
                  {sec.rows.map((row) => (
                    <li key={row.label} className={s.shortcut}>
                      <span className={s.shortcutLabel}>{row.label}</span>
                      <span className={s.keys}>
                        {row.combos.map((combo, i) => (
                          <Fragment key={i}>
                            {i > 0 && <span className={s.keysOr}>{row.combos.length > 2 ? '·' : '또는'}</span>}
                            <span className={s.combo}>
                              {combo.map((k, j) => (
                                <Fragment key={j}>
                                  {row.seq && j > 0 && (
                                    <span className={s.keysThen} aria-hidden="true">
                                      →
                                    </span>
                                  )}
                                  {MOUSE.has(k) ? <span className={s.mouse}>{k}</span> : <kbd>{k}</kbd>}
                                </Fragment>
                              ))}
                            </span>
                          </Fragment>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}

/* ───────────────────────────── toasts */

export function Toaster() {
  const toasts = useToasts();
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className={s.toaster} aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={s.toast} data-tone={t.tone}>
          {t.tone === 'error' && (
            <span className={s.toastIcon}>
              <Icon name="alertCircle" size={16} />
            </span>
          )}
          {t.tone === 'success' && (
            <span className={s.toastIcon}>
              <Icon name="checkCircle" size={16} />
            </span>
          )}
          <span className={s.toastMsg}>{t.message}</span>
          {t.secondary && (
            <button
              className={cx(ui.btn, ui.xs, ui.ghost, s.toastAction)}
              onClick={() => {
                t.secondary!.run();
                dismiss(t.id);
              }}
            >
              {t.secondary.label}
            </button>
          )}
          {t.action && (
            <button
              className={cx(ui.btn, ui.xs, ui.primary, s.toastAction)}
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className={cx(ui.iconBtn, s.toastClose)} onClick={() => dismiss(t.id)} aria-label="닫기">
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

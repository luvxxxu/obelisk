'use client';

/**
 * The commands every surface shares: keyboard shortcuts, the context menu, the selection bar and
 * drops on the sidebar all call these, so a change made any of those ways reads the same in its
 * toast and takes the same ⌘Z.
 */

import {
  addDays,
  diffDays,
  matchProject,
  parseQuickAdd,
  PRIORITY_LABEL_KO,
  type BulkCreateTasksInput,
  type ISODate,
  type Priority,
  type Task,
} from '@obelisk/core';
import { clockNow } from './clock';
import { requestGroupChange, type TimedSpan } from './reschedule';
import { clearPicks, getPicked, setPicked, visibleRowIds } from './selection';
import {
  canEdit,
  canWriteProject,
  createTasks,
  deleteTasks,
  getState,
  moveTasks,
  moveTasksSaved,
  movesBack,
  patchTasks,
  patchTasksSaved,
  READ_ONLY_MESSAGE,
  restoreTasks,
  selectTask,
  toggleDone,
  type MutationOpts,
} from './store';
import { pasteLines, taskLine } from './task-text';
import { nextByDays } from './timeline';
import { toast } from './toast';
import { projectIdFromPath } from './ui-helpers';
import { getUi, setUi } from './ui-state';
import { notify, pushUndo } from './undo';

/** How undo and redo call the store: no new entry, no second toast. */
const REPLAY: MutationOpts = { record: false, quiet: true };
/** From this many tasks on, moving them to the trash asks first. */
const CONFIRM_AT = 10;
/** One bulk request (duplicate, paste) holds at most this many tasks. */
const MAX_BATCH = 100;

const isActive = (t: Task) => t.status === 'todo' || t.status === 'doing';

function isField(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

/** `ids` top to bottom as the rows sit on screen; ids without a row (timeline picks) keep their order after them. */
function inScreenOrder(ids: Iterable<string>): string[] {
  const order = visibleRowIds();
  const at = new Map(order.map((id, i) => [id, i]));
  return [...new Set(ids)].sort((a, b) => (at.get(a) ?? order.length) - (at.get(b) ?? order.length));
}

function tasksOf(ids: string[]): Task[] {
  const { tasks } = getState();
  return ids.flatMap((id) => (tasks[id] ? [tasks[id]!] : []));
}

function projectName(projectId: string | null): string {
  if (!projectId) return '인박스';
  return getState().projects.find((p) => p.id === projectId)?.name ?? '프로젝트';
}

/** Undo trashes what was just created; redo brings the same rows back. */
function createdEntry(label: string, ids: string[]) {
  return pushUndo({
    label,
    undo: () => deleteTasks(ids, REPLAY),
    redo: async () => !!(await restoreTasks(ids, REPLAY)),
  });
}

// ─────────────────────────────── which tasks

/** What stands for one task when it has focus: a list row, a card of the home board, a timeline label. */
const TASK_HOLDER = '[data-task-row], [data-card], [data-task-focus]';

/**
 * What a shortcut acts on: the picks (those still in the list), else the task whose row (card,
 * label) has focus, else the task open in the panel unless focus is in the sidebar.
 * A focused row that is not a task here (휴지통, another space on 모아보기) means none.
 */
export function actionTargets(): string[] {
  const s = getState();
  const picks = [...getPicked()].filter((id) => s.tasks[id]);
  if (picks.length) return picks;
  if (typeof document === 'undefined') return [];
  const active = document.activeElement;
  if (isField(active)) return [];
  const holder = active instanceof HTMLElement ? active.closest<HTMLElement>(TASK_HOLDER) : null;
  if (holder) {
    const id = holder.dataset.taskRow ?? holder.dataset.card ?? holder.dataset.taskFocus;
    return id && s.tasks[id] ? [id] : [];
  }
  // A button that only opened the task (home list, forecast title) still means that task; the
  // sidebar does not (Backspace there must not trash the open task).
  const free = !active || !active.closest('#app-sidebar');
  if (free && s.selectedTaskId && s.tasks[s.selectedTaskId]) return [s.selectedTaskId];
  return [];
}

/** The ids the user may change; says so when some (or all) are view-only. */
export function editableOnly(ids: string[]): { ok: string[]; blocked: number } {
  const s = getState();
  const ok: string[] = [];
  let blocked = 0;
  for (const id of new Set(ids)) {
    const t = s.tasks[id];
    if (!t) continue;
    if (canEdit(t, s)) ok.push(id);
    else blocked++;
  }
  if (blocked) toast.error(ok.length ? `보기 전용 작업 ${blocked}개는 바꿀 수 없어요` : READ_ONLY_MESSAGE);
  return { ok, blocked };
}

// ─────────────────────────────── status, trash

/** ⌘↵ / x: when every target is done they reopen, otherwise the open ones are completed. One undo. */
export async function completeTasks(ids: string[]): Promise<void> {
  const list = tasksOf(editableOnly(ids).ok);
  if (!list.length) return;
  if (list.length === 1) return toggleDone(list[0]!.id);
  const reopen = list.every((t) => t.status === 'done');
  const targets = reopen ? list : list.filter(isActive);
  if (!targets.length) return;
  if (targets.length === 1) return toggleDone(targets[0]!.id);
  const status = reopen ? ('todo' as const) : ('done' as const);
  const changes = targets.map((t) => ({ taskId: t.id, position: t.position, status }));
  const before = movesBack(changes);
  // A large batch goes in parts; the undo covers the parts that went through.
  const saved = await moveTasksSaved(changes, { record: false });
  if (!saved.length) return;
  const went = new Set(saved.map((c) => c.taskId));
  const back = before.filter((c) => went.has(c.taskId));
  // Read now, after the move: where they are, done again with the same completion time.
  const again = movesBack(back);
  const label = reopen ? `작업 ${saved.length}개 완료 취소` : `작업 ${saved.length}개 완료`;
  notify(label, pushUndo({ label, undo: () => moveTasks(back, REPLAY), redo: () => moveTasks(again, REPLAY) }));
}

/** Delete / ⌫: to the trash at once with an undo toast; a batch of 10 or more asks first. */
export function trashTasks(ids: string[]): void {
  const { ok } = editableOnly(ids);
  if (!ok.length) return;
  if (ok.length >= CONFIRM_AT) {
    setUi({ confirmTrash: ok });
    return;
  }
  void deleteTasks(ok);
}

/** The 휴지통으로 옮기기 button of the confirmation. */
export async function confirmTrash(): Promise<void> {
  const ids = getUi().confirmTrash;
  setUi({ confirmTrash: null });
  if (ids?.length) await deleteTasks(ids);
}

// ─────────────────────────────── dates (through the impact preview: the dialog asks when others would slip)

/** Keep the length, end on `day`; a task without dates just gets `day` as its due date. */
function endingOn(t: Task, day: ISODate): TimedSpan {
  const end = t.dueDate ?? t.startDate;
  if (!end) return { startDate: null, dueDate: day };
  return nextByDays(t, 'move', diffDays(day, end));
}

/** T: open tasks that do not already end today are moved so they do. */
export function moveToToday(ids: string[]): void {
  const today = getState().today;
  const open = tasksOf(editableOnly(ids).ok).filter(isActive);
  if (!open.length) return;
  const moves = open.filter((t) => (t.dueDate ?? t.startDate) !== today).map((t) => ({ taskId: t.id, next: endingOn(t, today) }));
  if (!moves.length) {
    toast.show(open.length === 1 ? '이미 오늘 할 작업이에요' : '모두 이미 오늘 할 작업이에요');
    return;
  }
  requestGroupChange(moves);
}

/** P: open dated tasks move `days` later (a day by default). */
export function postponeTasks(ids: string[], days = 1): void {
  const open = tasksOf(editableOnly(ids).ok).filter(isActive);
  if (!open.length) return;
  const dated = open.filter((t) => t.startDate || t.dueDate);
  if (!dated.length) {
    toast.show('날짜가 있는 작업이 없어요');
    return;
  }
  requestGroupChange(dated.map((t) => ({ taskId: t.id, next: nextByDays(t, 'move', days) })));
}

// ─────────────────────────────── fields

/** 1–4: one priority for all of them, one undo. */
export async function setPriority(ids: string[], p: Priority): Promise<void> {
  const changing = tasksOf(editableOnly(ids).ok).filter((t) => t.priority !== p);
  if (!changing.length) return;
  // Some may fail (a task trashed elsewhere): the ones that changed still get their undo.
  const saved = new Set(await patchTasksSaved(changing.map((t) => ({ id: t.id, patch: { priority: p } })), { record: false }));
  const done = changing.filter((t) => saved.has(t.id));
  if (!done.length) return;
  const changes = done.map((t) => ({ id: t.id, patch: { priority: p } }));
  const back = done.map((t) => ({ id: t.id, patch: { priority: t.priority as Priority } }));
  const entry = pushUndo({ label: '우선순위 변경', undo: () => patchTasks(back, REPLAY), redo: () => patchTasks(changes, REPLAY) });
  const name = PRIORITY_LABEL_KO[p];
  notify(done.length === 1 ? `우선순위 ${name}` : `작업 ${done.length}개 우선순위 ${name}`, entry);
}

async function moveProject(ids: string[], projectId: string | null): Promise<boolean> {
  if (!canWriteProject(projectId)) {
    toast.error(`‘${projectName(projectId)}’ 프로젝트는 보기 전용이라 작업을 옮길 수 없어요`);
    return false;
  }
  const moving = tasksOf(editableOnly(ids).ok).filter((t) => t.projectId !== projectId);
  if (!moving.length) return false;
  const saved = new Set(await patchTasksSaved(moving.map((t) => ({ id: t.id, patch: { projectId } })), { record: false }));
  const moved = moving.filter((t) => saved.has(t.id));
  if (!moved.length) return false;
  const changes = moved.map((t) => ({ id: t.id, patch: { projectId } }));
  const back = moved.map((t) => ({ id: t.id, patch: { projectId: t.projectId } }));
  const entry = pushUndo({ label: '프로젝트 이동', undo: () => patchTasks(back, REPLAY), redo: () => patchTasks(changes, REPLAY) });
  const name = projectName(projectId);
  notify(
    moved.length === 1 ? `“${moved[0]!.title}”을(를) ${name}(으)로 옮겼어요` : `작업 ${moved.length}개를 ${name}(으)로 옮겼어요`,
    entry,
  );
  return true;
}

/** 프로젝트로 옮기기 (null = 인박스). True when at least one task moved (then the picks may go). */
export function moveToProject(ids: string[], projectId: string | null): Promise<boolean> {
  return moveProject(ids, projectId);
}

/**
 * E / F2 and the menu's 제목 바꾸기: in its row when a list row that can edit in place shows it,
 * otherwise (timeline, 모아보기, a folded group) in the panel's title field.
 */
export function renameTask(id: string): void {
  if (typeof document !== 'undefined' && document.querySelector(`main [data-renamable][data-task-row="${CSS.escape(id)}"]`)) startRename(id);
  else selectTask(id);
}

/** Edit the title in its row (only a TaskRow reacts; `renameTask` checks that one is on screen). */
export function startRename(id: string): void {
  const t = getState().tasks[id];
  if (!t) return;
  if (!canEdit(t)) {
    toast.error(READ_ONLY_MESSAGE);
    return;
  }
  setUi({ renaming: id });
}

export function openTaskMenu(x: number, y: number, ids: string[]): void {
  if (!ids.length) return;
  setUi({ taskMenu: { x, y, ids } });
}

// ─────────────────────────────── duplicate, copy, paste

/**
 * ⌘D: a fresh copy of each (open, same fields, waiting for what the original waits for), picked so
 * the next shortcut acts on the copies. Undo moves the copies to the trash.
 */
export async function duplicateTasks(ids: string[]): Promise<void> {
  const s = getState();
  const list = tasksOf(inScreenOrder(ids));
  const allowed = list.filter((t) => canWriteProject(t.projectId, s));
  if (allowed.length < list.length) {
    toast.error(allowed.length ? `보기 전용 프로젝트의 작업 ${list.length - allowed.length}개는 복제할 수 없어요` : READ_ONLY_MESSAGE);
  }
  if (!allowed.length) return;
  if (allowed.length > MAX_BATCH) toast.show(`한 번에 ${MAX_BATCH}개까지 복제할 수 있어요`);
  const source = allowed.slice(0, MAX_BATCH);
  const tasks: BulkCreateTasksInput['tasks'] = source.map((t) => {
    const waitsFor = s.deps.filter((d) => d.taskId === t.id).map((d) => d.dependsOnId);
    return {
      title: t.title,
      ...(t.notes ? { notes: t.notes } : {}),
      priority: t.priority as Priority,
      projectId: t.projectId,
      startDate: t.startDate,
      startTime: t.startTime,
      dueDate: t.dueDate,
      dueTime: t.dueTime,
      fixed: t.fixed,
      assigneeIds: t.assigneeIds,
      ...(waitsFor.length ? { blockedBy: waitsFor.slice(0, 50) } : {}),
    };
  });
  const created = await createTasks({ tasks }, { record: false });
  if (!created?.length) return;
  const copies = created.map((t) => t.id);
  setPicked(copies);
  const n = copies.length;
  const entry = createdEntry(n === 1 ? '작업 복제' : `작업 ${n}개 복제`, copies);
  notify(n === 1 ? `“${created[0]!.title}”을(를) 복제했어요` : `작업 ${n}개를 복제했어요`, entry);
}

/**
 * One line per task, top to bottom as on screen, written in quick-add words so pasting it back (here,
 * or into a chat) reads the same: `견적서 보내기 11/22 15:00 #런칭 !높음`. Status stays out: it is
 * meant as plain text a person would paste, and pasted lines become open tasks.
 */
export function tasksAsText(ids: string[]): string {
  const s = getState();
  return tasksOf(inScreenOrder(ids))
    .map((t) => taskLine(t, s.today, t.projectId ? projectName(t.projectId) : null))
    .join('\n');
}

type CopiedTask = Pick<Task, 'title' | 'priority' | 'projectId' | 'startDate' | 'startTime' | 'dueDate' | 'dueTime' | 'fixed'>;

/**
 * The last ⌘C as data, keyed by the exact text it put on the clipboard. Pasting that same text
 * back makes the tasks from these fields: a title such as `금요일 회의록 정리` or `PR #123` would
 * otherwise be read as a date or a project on the way back. Kept in localStorage too, so a paste in
 * another tab or after a reload gets the same tasks; only text from elsewhere is parsed.
 */
interface CopySnapshot {
  text: string;
  workspaceId: string | null;
  tasks: CopiedTask[];
}
let lastCopy: CopySnapshot | null = null;
const COPY_KEY = 'obelisk:last-copy';

function rememberCopy(copy: CopySnapshot) {
  lastCopy = copy;
  try {
    localStorage.setItem(COPY_KEY, JSON.stringify(copy));
  } catch {}
}

function recalledCopy(): CopySnapshot | null {
  try {
    const raw = localStorage.getItem(COPY_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as CopySnapshot;
      if (saved && typeof saved.text === 'string' && Array.isArray(saved.tasks)) return saved;
    }
  } catch {}
  return lastCopy;
}

const clipText = (text: string) => text.replace(/\r\n?/g, '\n').trim();

/** `tasksAsText` for the clipboard: also remembers the tasks behind the text for a paste back here. */
export function textForCopy(ids: string[]): string {
  const s = getState();
  const text = tasksAsText(ids);
  rememberCopy({
    text: clipText(text),
    workspaceId: s.workspace?.id ?? null,
    tasks: tasksOf(inScreenOrder(ids)).map((t) => ({
      title: t.title,
      priority: t.priority,
      projectId: t.projectId,
      startDate: t.startDate,
      startTime: t.startTime,
      dueDate: t.dueDate,
      dueTime: t.dueTime,
      fixed: t.fixed,
    })),
  });
  return text;
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    toast.error('클립보드에 복사하지 못했어요');
    return false;
  }
}

/** ⌘C (menu: 텍스트로 복사). */
export async function copyTasks(ids: string[]): Promise<void> {
  const list = tasksOf(ids);
  if (!list.length) return;
  if (await writeClipboard(textForCopy(ids))) toast.show(list.length === 1 ? '작업을 복사했어요' : `작업 ${list.length}개를 복사했어요`);
}

/** 링크 복사: one `/t/:id` link per line. */
export async function copyTaskLinks(ids: string[]): Promise<void> {
  const list = tasksOf(inScreenOrder(ids));
  if (!list.length) return;
  const text = list.map((t) => `${location.origin}/t/${t.id}`).join('\n');
  if (await writeClipboard(text)) toast.show(list.length === 1 ? '작업 링크를 복사했어요' : `작업 링크 ${list.length}개를 복사했어요`);
}

export interface PasteContext {
  /** Where lines without a known `#project` land (null = 인박스; undefined = 인박스 too, but the page has no project). */
  projectId?: string | null;
  /** Lines without a date get this due date (the page's own quick add does the same). */
  defaultDueDate?: ISODate;
  assigneeId?: string;
}

/** What a page's ⌘V means, the same defaults as its quick add; null = this page does not take pasted tasks. */
export function pasteContext(pathname: string): PasteContext | null {
  const s = getState();
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const pid = projectIdFromPath(path);
  if (pid) return s.projects.some((p) => p.id === pid) && canWriteProject(pid, s) ? { projectId: pid } : null;
  switch (path) {
    case '/inbox':
      return { projectId: null };
    case '/today':
      return { defaultDueDate: s.today };
    case '/upcoming':
      return { defaultDueDate: addDays(s.today, 1) };
    case '/all':
      return {};
    case '/mine':
      return s.workspace?.kind === 'org' && s.user ? { assigneeId: s.user.id } : null;
    default:
      return null;
  }
}

/**
 * ⌘V: each non-empty line (list markers dropped) is read like quick add. A `#project` that matches a
 * project you can write to is used; an unknown one is not created, the line lands where the page
 * puts new tasks. Our own last ⌘C pasted back is made from its tasks' fields instead. The new tasks
 * are picked; one undo moves them all to the trash.
 */
export async function pasteTasks(text: string, ctx: PasteContext): Promise<void> {
  const s = getState();
  const saved = recalledCopy();
  const copied = saved && saved.workspaceId === (s.workspace?.id ?? null) && saved.text === clipText(text) ? saved.tasks : null;
  const tasks = copied ? fromCopied(copied, ctx) : fromLines(text, ctx);
  if (!tasks) return;
  if (!tasks.length) {
    toast.show('붙여넣을 작업이 없어요');
    return;
  }
  const created = await createTasks({ tasks }, { record: false });
  if (!created?.length) return;
  const ids = created.map((t) => t.id);
  setPicked(ids);
  const n = ids.length;
  const entry = createdEntry(n === 1 ? '작업 붙여넣기' : `작업 ${n}개 붙여넣기`, ids);
  notify(n === 1 ? `“${created[0]!.title}”을(를) 붙여넣었어요` : `작업 ${n}개를 붙여넣었어요`, entry);
}

function capped<T>(list: T[]): T[] {
  if (list.length <= MAX_BATCH) return list;
  toast.show(`한 번에 ${MAX_BATCH}줄까지만 붙여넣었어요`);
  return list.slice(0, MAX_BATCH);
}

/** Our own ⌘C pasted back: the same fields, in the page's project when theirs cannot take it. */
function fromCopied(list: CopiedTask[], ctx: PasteContext): BulkCreateTasksInput['tasks'] {
  const s = getState();
  const writable = (id: string | null): id is string => !!id && s.projects.some((p) => p.id === id && !p.archivedAt) && canWriteProject(id, s);
  return capped(list).map((t) => ({
    title: t.title,
    projectId: writable(t.projectId) ? t.projectId : (ctx.projectId ?? null),
    startDate: t.startDate,
    startTime: t.startTime,
    dueDate: t.dueDate ?? (t.startDate ? null : (ctx.defaultDueDate ?? null)),
    dueTime: t.dueDate ? t.dueTime : null,
    priority: t.priority as Priority,
    ...(t.fixed ? { fixed: true } : {}),
    ...(ctx.assigneeId ? { assigneeIds: [ctx.assigneeId] } : {}),
  }));
}

/** Text from anywhere else: each line read like quick add. Null when there is no line at all. */
function fromLines(text: string, ctx: PasteContext): BulkCreateTasksInput['tasks'] | null {
  const s = getState();
  const lines = pasteLines(text);
  if (!lines.length) return null;
  const now = clockNow();
  const nowMinutes = now.date === s.today ? now.minutes : null;
  const projects = s.projects.filter((p) => !p.archivedAt);
  return capped(lines).flatMap((line) => {
    const q = parseQuickAdd(line, s.today, { nowMinutes });
    const title = q.title.slice(0, 500).trim();
    if (!title) return [];
    const matched = q.projectName ? matchProject(projects, q.projectName) : null;
    const projectId = matched && canWriteProject(matched.id, s) ? matched.id : (ctx.projectId ?? null);
    return [
      {
        title,
        projectId,
        startDate: q.startDate,
        startTime: q.startTime,
        dueDate: q.dueDate ?? (q.startDate ? null : (ctx.defaultDueDate ?? null)),
        dueTime: q.dueDate ? q.dueTime : null,
        priority: q.priority ?? 0,
        ...(q.fixed ? { fixed: true } : {}),
        ...(ctx.assigneeId ? { assigneeIds: [ctx.assigneeId] } : {}),
      },
    ];
  });
}

// ─────────────────────────────── drops on the sidebar

/** Picked rows dropped on 인박스 (`inbox`), 오늘 (`today`) or a project (`project:<id>`). */
export async function dropTasksOn(target: string, ids: string[]): Promise<void> {
  if (target === 'today') {
    moveToToday(ids);
    return;
  }
  const projectId = target === 'inbox' ? null : target.startsWith('project:') ? target.slice('project:'.length) : undefined;
  if (projectId === undefined) return;
  // They leave the list on screen, so the selection goes with them.
  if (await moveProject(ids, projectId)) clearPicks();
}

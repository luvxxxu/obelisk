import { describe, expect, test } from 'bun:test';
import { atLeast, canEditTask, canViewTask, describeActivity, maxLevel, taskAccess, type AccessLevel, type AccessView } from '../src';

const view = (levels: Record<string, AccessLevel>, kind: 'personal' | 'org' = 'org'): AccessView => ({
  userId: 'me',
  kind,
  projectLevel: (id) => levels[id] ?? null,
});

describe('levels', () => {
  test('atLeast orders view < edit < manage and treats none/null as nothing', () => {
    expect(atLeast('edit', 'view')).toBe(true);
    expect(atLeast('view', 'edit')).toBe(false);
    expect(atLeast('manage', 'manage')).toBe(true);
    expect(atLeast('none', 'view')).toBe(false);
    expect(atLeast(null, 'view')).toBe(false);
  });

  test('maxLevel picks the best grant (everyone, own, team)', () => {
    expect(maxLevel('none', 'view', undefined)).toBe('view');
    expect(maxLevel('view', 'manage', 'edit')).toBe('manage');
    expect(maxLevel('none', null)).toBeNull();
  });
});

describe('task access', () => {
  const a = view({ p1: 'view', p2: 'edit' });

  test('project tasks follow the project level', () => {
    expect(taskAccess({ projectId: 'p1', createdBy: 'me', assigneeIds: ['me'] }, a)).toBe('view');
    expect(canEditTask({ projectId: 'p1', createdBy: 'me', assigneeIds: ['me'] }, a)).toBe(false);
    expect(canEditTask({ projectId: 'p2', createdBy: 'x', assigneeIds: [] }, a)).toBe(true);
    expect(canViewTask({ projectId: 'p3', createdBy: 'me', assigneeIds: ['me'] }, a)).toBe(false);
  });

  test('org inbox tasks are private to their creator and assignees', () => {
    expect(canEditTask({ projectId: null, createdBy: 'me', assigneeIds: [] }, a)).toBe(true);
    expect(canEditTask({ projectId: null, createdBy: 'x', assigneeIds: ['me'] }, a)).toBe(true);
    expect(canViewTask({ projectId: null, createdBy: 'x', assigneeIds: ['y'] }, a)).toBe(false);
    expect(canEditTask({ projectId: null, createdBy: 'x', assigneeIds: ['y', 'me'] }, a)).toBe(true);
  });

  test('everything in a personal space is yours', () => {
    expect(taskAccess({ projectId: null, createdBy: 'x', assigneeIds: [] }, view({}, 'personal'))).toBe('manage');
  });
});

describe('activity phrases', () => {
  test('field changes read as arrows', () => {
    const text = describeActivity({
      action: 'task.updated',
      subject: '#3 개발',
      data: { changes: { dueDate: { from: '2026-11-20', to: '2026-11-23' }, status: { from: 'todo', to: 'done' } } },
    });
    expect(text).toContain('마감일 11/20');
    expect(text).toContain('11/23');
    expect(text).toContain('완료');
  });

  test('sharing changes name who got what', () => {
    const text = describeActivity({
      action: 'project.access',
      subject: '런칭',
      data: { changes: [{ everyone: { from: 'none', to: 'view' } }, { member: '김민지', from: null, to: 'edit' }] },
    });
    expect(text).toBe('공유 설정 · 조직 전체 권한 없음 → 보기 · 김민지 권한 없음 → 쓰기');
  });

  test('a task back from the trash says so', () => {
    expect(describeActivity({ action: 'task.deleted', subject: '#3 개발', data: {} })).toBe('작업을 삭제했습니다');
    expect(describeActivity({ action: 'task.restored', subject: '#3 개발', data: {} })).toBe('작업을 휴지통에서 되살렸습니다');
  });
});

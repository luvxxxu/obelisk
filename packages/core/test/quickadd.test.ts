import { describe, expect, test } from 'bun:test';
import { matchProject, parseQuickAdd } from '../src/quickadd';

const TODAY = '2026-11-13'; // Friday

describe('parseQuickAdd', () => {
  test('korean basics', () => {
    const r = parseQuickAdd('디자인 리뷰 내일 #런칭 !높음', TODAY);
    expect(r).toMatchObject({ title: '디자인 리뷰', dueDate: '2026-11-14', projectName: '런칭', priority: 3, fixed: false });
    expect(r.tokens.map((t) => t.kind)).toEqual(['date', 'project', 'priority']);
  });

  test('next-week weekday with particle', () => {
    expect(parseQuickAdd('보고서 다음주 수요일까지 p1', TODAY)).toMatchObject({
      title: '보고서',
      dueDate: '2026-11-18',
      priority: 3,
    });
    expect(parseQuickAdd('보고서 다음 주 수요일', TODAY).dueDate).toBe('2026-11-18');
  });

  test('range and fixed', () => {
    expect(parseQuickAdd('워크숍 11/20~11/22 @고정', TODAY)).toMatchObject({
      title: '워크숍',
      startDate: '2026-11-20',
      dueDate: '2026-11-22',
      fixed: true,
    });
    expect(parseQuickAdd('이사 준비 내일부터 금요일까지', TODAY)).toMatchObject({
      title: '이사 준비',
      startDate: '2026-11-14',
      dueDate: '2026-11-20',
    });
  });

  test('english', () => {
    expect(parseQuickAdd('Ship beta next friday #launch !2', TODAY)).toMatchObject({
      title: 'Ship beta',
      dueDate: '2026-11-20',
      projectName: 'launch',
      priority: 2,
    });
    expect(parseQuickAdd('call mom in 3 days', TODAY).dueDate).toBe('2026-11-16');
  });

  test('weekday on the same weekday means next week', () => {
    expect(parseQuickAdd('정산 금요일', TODAY).dueDate).toBe('2026-11-20');
  });

  test('relative and absolute', () => {
    expect(parseQuickAdd('3일 후 회의', TODAY).dueDate).toBe('2026-11-16');
    expect(parseQuickAdd('11월 25일 마감 보고', TODAY)).toMatchObject({ title: '마감 보고', dueDate: '2026-11-25' });
    expect(parseQuickAdd('세금 1/10', TODAY).dueDate).toBe('2027-01-10');
    expect(parseQuickAdd('월말 정산', TODAY).dueDate).toBe('2026-11-30');
  });

  test('disabled kinds stay in the title', () => {
    const r = parseQuickAdd('오늘 할 일 정리', TODAY, { disabled: ['date'] });
    expect(r).toMatchObject({ title: '오늘 할 일 정리', dueDate: null });
  });

  test('project matching is forgiving but not ambiguous', () => {
    const ps = [{ name: '제품 런칭' }, { name: '개인' }, { name: '블로그 운영' }, { name: '블로그 디자인' }];
    expect(matchProject(ps, '런칭')?.name).toBe('제품 런칭');
    expect(matchProject(ps, '제품런칭')?.name).toBe('제품 런칭');
    expect(matchProject(ps, '개')?.name).toBe('개인');
    expect(matchProject(ps, '블로그')?.name).toBe('블로그 운영'); // prefix wins
    expect(matchProject(ps, '디자인')?.name).toBe('블로그 디자인');
    expect(matchProject(ps, '없음')).toBeNull();
  });

  test('plain text is untouched', () => {
    expect(parseQuickAdd('그냥 메모', TODAY)).toMatchObject({ title: '그냥 메모', dueDate: null, tokens: [] });
  });
});

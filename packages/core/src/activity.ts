/**
 * Korean phrases for activity-log entries, shared by the web app and the MCP markdown.
 * Values use arrows ("마감일 11/20 → 11/22") so no particle has to agree with a name.
 */
import { formatDurationKo, formatShortKo, formatTimeKo, isISOTime } from './dates';
import {
  LEVEL_LABEL_KO,
  PRIORITY_LABEL_KO,
  ROLE_LABEL_KO,
  STATUS_LABEL_KO,
  type AccessLevel,
  type ActivityEntry,
  type Priority,
  type TaskStatus,
  type WorkspaceRole,
} from './types';

const FIELD_KO: Record<string, string> = {
  title: '제목',
  status: '상태',
  priority: '우선순위',
  startDate: '시작일',
  dueDate: '마감일',
  startTime: '시작 시각',
  dueTime: '마감 시각',
  fixed: '고정',
  estimateMinutes: '예상 시간',
  project: '프로젝트',
  assignee: '담당자',
  name: '이름',
  color: '색',
  membersCanCreateProjects: '멤버 프로젝트 생성',
};

type Change = { from: unknown; to: unknown };

function val(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') {
    return field === 'project' ? '인박스' : '없음';
  }
  switch (field) {
    case 'status':
      return STATUS_LABEL_KO[v as TaskStatus] ?? String(v);
    case 'priority':
      return PRIORITY_LABEL_KO[v as Priority] ?? String(v);
    case 'startDate':
    case 'dueDate':
      return formatShortKo(String(v));
    case 'startTime':
    case 'dueTime':
      return isISOTime(v) ? formatTimeKo(v) : String(v);
    case 'estimateMinutes':
      return typeof v === 'number' ? formatDurationKo(v) : String(v);
    case 'fixed':
    case 'membersCanCreateProjects':
      return v ? '켬' : '끔';
    case 'title':
    case 'name':
      return `“${String(v)}”`;
    default:
      return String(v);
  }
}

/** "https://a.example:8443/x" → "a.example:8443"; null when it isn't a URL. */
function hostOf(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

const level = (l: unknown) => LEVEL_LABEL_KO[(l as AccessLevel | null) ?? 'none'] ?? String(l);
const role = (r: unknown) => ROLE_LABEL_KO[r as WorkspaceRole] ?? String(r);

/** "마감일 11/20 → 11/22" per changed field, with friendlier words for status and assignee. */
export function changePhrases(changes: Record<string, unknown> | undefined): string[] {
  if (!changes) return [];
  const out: string[] = [];
  for (const [field, raw] of Object.entries(changes)) {
    if (field === 'notes') {
      out.push('메모 수정');
      continue;
    }
    const c = raw as Change;
    if (field === 'status') {
      const to = c.to as TaskStatus;
      if (to === 'done') out.push('완료');
      else if (to === 'canceled') out.push('취소');
      else if (c.from === 'done' || c.from === 'canceled') out.push(to === 'doing' ? '다시 열고 진행 중으로' : '다시 열기');
      else out.push(`상태 → ${val('status', to)}`);
      continue;
    }
    if (field === 'assignee') {
      out.push(c.to ? `담당자 → ${String(c.to)}` : '담당자 해제');
      continue;
    }
    if (field === 'archived') continue;
    if (field === 'photo') {
      out.push(c.to ? '사진 변경' : '사진 삭제');
      continue;
    }
    const label = FIELD_KO[field] ?? field;
    out.push(`${label} ${val(field, c.from)} → ${val(field, c.to)}`);
  }
  return out;
}

/**
 * What happened, without the actor ("마감일 11/20 → 11/22", "프로젝트를 만들었습니다").
 * The caller puts the actor's name and, in a feed, the subject in front.
 */
export function describeActivity(e: Pick<ActivityEntry, 'action' | 'data' | 'subject'>): string {
  const d = e.data ?? {};
  const changes = d.changes as Record<string, unknown> | undefined;
  switch (e.action) {
    case 'task.created':
      return d.assignee ? `작업을 만들고 ${String(d.assignee)}님을 담당자로 지정했습니다` : '작업을 만들었습니다';
    case 'task.updated': {
      const parts = changePhrases(changes);
      const cause = d.cause ? ` · ${String(d.cause)} 지연으로 함께 밀림` : '';
      return (parts.join(' · ') || '작업을 수정했습니다') + cause;
    }
    case 'task.postponed': {
      const days = Number(d.days ?? 0);
      const verb = days >= 0 ? `${days}일 미뤘습니다` : `${-days}일 앞당겼습니다`;
      const moved = Number(d.moved ?? 0);
      return d.cascade && moved ? `${verb} · 후속 작업 ${moved}개도 함께 옮김` : verb;
    }
    case 'task.deleted':
      return '작업을 삭제했습니다';
    case 'dependency.added':
      return `선행 작업 연결 · ${String(d.blockedBy ?? '')}`;
    case 'dependency.removed':
      return `선행 작업 연결 해제 · ${String(d.blockedBy ?? '')}`;
    case 'project.created':
      return d.memberAccess && d.memberAccess !== 'none'
        ? `프로젝트를 만들었습니다 · 조직 전체 ${level(d.memberAccess)}`
        : '프로젝트를 만들었습니다';
    case 'project.updated':
      return changePhrases(changes).join(' · ') || '프로젝트를 수정했습니다';
    case 'project.archived':
      return '프로젝트를 보관했습니다';
    case 'project.unarchived':
      return '프로젝트를 보관 해제했습니다';
    case 'project.deleted':
      return d.tasks === 'deleted' ? '프로젝트와 작업을 삭제했습니다' : '프로젝트를 삭제했습니다 · 작업은 인박스로';
    case 'project.access': {
      const list = (d.changes as Record<string, unknown>[] | undefined) ?? [];
      const parts = list.map((c) => {
        if (c.everyone) {
          const ev = c.everyone as Change;
          return `조직 전체 ${level(ev.from)} → ${level(ev.to)}`;
        }
        const who = c.member ? String(c.member) : `팀 ${String(c.team)}`;
        return `${who} ${level(c.from)} → ${level(c.to)}`;
      });
      return `공유 설정 · ${parts.join(' · ')}`;
    }
    case 'project.moved_out':
      return `${String(d.to)}(으)로 옮겼습니다 · 작업 ${Number(d.tasks ?? 0)}개`;
    case 'project.moved_in':
      return `${String(d.from)}에서 옮겨 왔습니다 · 작업 ${Number(d.tasks ?? 0)}개`;
    case 'workspace.created':
      return '조직을 만들었습니다';
    case 'workspace.updated':
      return `조직 설정 · ${changePhrases(changes).join(' · ')}`;
    case 'workspace.imported': {
      const host = hostOf(d.from);
      return host ? `다른 서버에서 가져왔어요 · ${host}` : '다른 서버에서 가져왔어요';
    }
    case 'workspace.exported': {
      if (d.to === 'file') return '파일로 내보냈어요';
      const host = hostOf(d.to);
      return host ? `다른 서버로 보냈어요 · ${host}` : '다른 서버로 보냈어요';
    }
    case 'member.joined':
      if (d.reservation && d.verifiedEmail) return `확인된 메일 주소로 가져온 자리에 합류했어요 · ${role(d.role)}`;
      if (d.reservation && d.alreadyMember) return `가져온 자리를 이어받았어요 · ${role(d.role)}`;
      if (d.reservation) return `가져온 자리로 합류했어요 · ${role(d.role)}`;
      return `초대 링크로 참여했습니다 · ${role(d.role)}`;
    case 'member.role':
      if (d.byOperator) return `서버 운영자가 소유자로 지정했어요 · ${role(d.from)} → ${role(d.to)}`;
      return `역할 ${role(d.from)} → ${role(d.to)}`;
    case 'member.removed':
      return '조직에서 내보냈습니다';
    case 'member.left':
      if (d.byOperator) return '서버 운영자가 계정을 삭제해 조직을 떠났습니다';
      return d.accountDeleted ? '계정을 삭제해 조직을 떠났습니다' : '조직을 떠났습니다';
    case 'invite.created':
      return `${role(d.role)} 초대 링크를 만들었습니다`;
    case 'invite.revoked':
      return '초대 링크를 취소했습니다';
    case 'team.created':
      return '팀을 만들었습니다';
    case 'team.updated': {
      const parts: string[] = [];
      if (d.renamed) parts.push(`이름 ${val('name', (d.renamed as Change).from)} → ${val('name', (d.renamed as Change).to)}`);
      const added = (d.added as string[] | undefined)?.length ?? 0;
      const removed = (d.removed as string[] | undefined)?.length ?? 0;
      if (added) parts.push(`멤버 ${added}명 추가`);
      if (removed) parts.push(`멤버 ${removed}명 제외`);
      return `팀 수정 · ${parts.join(' · ')}`;
    }
    case 'team.deleted':
      return '팀을 삭제했습니다';
    default:
      return e.action;
  }
}

/** Which kind of thing an entry is about, for grouping and icons. */
export function activityKind(action: string): 'task' | 'project' | 'member' | 'team' | 'invite' | 'workspace' {
  const head = action.split('.')[0]!;
  if (head === 'dependency') return 'task';
  return (['task', 'project', 'member', 'team', 'invite', 'workspace'].includes(head) ? head : 'workspace') as never;
}

export function viaLabelKo(via: ActivityEntry['via'], client: string | null): string | null {
  if (via === 'oauth') return client ? `${client} 통해` : 'AI 앱 통해';
  if (via === 'api_token') return client ? `API 토큰 “${client}”` : 'API 토큰';
  if (via === 'webhook') return client ? `웹훅 “${client}” 통해` : '웹훅 통해';
  return null;
}

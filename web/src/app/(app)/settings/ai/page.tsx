'use client';

import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmModal,
  isEnter,
  Skeleton,
  ui,
} from '@/components/primitives';
import { Page, ViewHeader } from '@/components/View';
import { api } from '@/lib/api';
import { cx, relativeTime } from '@/lib/format';
import { setUser, useApp } from '@/lib/store';
import { toast } from '@/lib/toast';
import { workspaceLabel, WorkspaceMark } from '@/components/WorkspaceSwitcher';
import type { User } from '@obelisk/core';
import { SettingsNav } from '../SettingsNav';
import base from '../settings.module.css';
import s from './ai.module.css';

interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}
interface GrantRow {
  id: string;
  clientName: string;
  clientId: string;
  lastUsedAt: string | null;
  createdAt: string;
}

type Client = 'claude' | 'chatgpt' | 'claude-code' | 'codex' | 'other';

function copy(text: string, what = '복사했어요') {
  void navigator.clipboard?.writeText(text);
  toast.show(what);
}

/** Display-only "copied" flash for copy buttons. */
function useFlash(ms = 1600): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    const t = window.setTimeout(() => setOn(false), ms);
    return () => window.clearTimeout(t);
  }, [on, ms]);
  return [on, () => setOn(true)];
}

/** Copyable code block (shell command / config). */
function Code({ children }: { children: string }) {
  const [copied, flash] = useFlash();
  return (
    <div className={s.code}>
      <pre className={s.codePre}>
        <code>{children}</code>
      </pre>
      <button
        type="button"
        className={cx(ui.iconBtn, s.codeCopy)}
        onClick={() => {
          copy(children);
          flash();
        }}
        aria-label="복사"
        data-copied={copied}
      >
        <Icon name={copied ? 'check' : 'copy'} size={14} />
      </button>
    </div>
  );
}

/** Read-only value + copy button (shadcn "copy link" pattern). */
function CopyField({ value, label, done }: { value: string; label: string; done: string }) {
  const [copied, flash] = useFlash();
  return (
    <div className={s.copyRow}>
      <input
        className={cx(ui.input, s.copyInput)}
        value={value}
        readOnly
        aria-label={label}
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
      />
      <button
        type="button"
        className={cx(ui.btn, ui.outline, s.copyBtn)}
        onClick={() => {
          copy(value, done);
          flash();
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size={14} />
        {copied ? '복사됨' : '복사'}
      </button>
    </div>
  );
}

const FEATURES: [string, string][] = [
  ['get_overview', '오늘 할 일·기한 지남·위험 요약'],
  ['create_tasks', '목표를 의존 관계 있는 계획으로 한 번에 생성'],
  ['simulate_delay', '미루면 무엇이 밀리는지 예측'],
  ['postpone_task', '연쇄 적용으로 일정 이동'],
  ['get_forecast', '기한 지난 작업이 일으키는 지연'],
  ['get_bottlenecks', '여유 없는 핵심 작업 순위'],
  ['update_task · complete_task', '모든 필드 수정·완료'],
  ['projects · dependencies', '프로젝트·선행 작업 관리'],
];

const CLIENTS: [Client, string][] = [
  ['claude', 'Claude'],
  ['chatgpt', 'ChatGPT'],
  ['claude-code', 'Claude Code'],
  ['codex', 'Codex'],
  ['other', '기타'],
];

function SkeletonRows({ cols }: { cols: number }) {
  return (
    <>
      {[0, 1].map((r) => (
        <tr key={r} className={ui.tr}>
          <td className={ui.td}>
            <div className={s.nameCell}>
              <Skeleton width={32} height={32} />
              <div className={s.nameText}>
                <Skeleton width={120} height={13} />
                <Skeleton width={80} height={11} style={{ marginTop: 6 }} />
              </div>
            </div>
          </td>
          {Array.from({ length: cols - 1 }, (_, i) => (
            <td key={i} className={ui.td}>
              <Skeleton width={i === cols - 2 ? 48 : 64} height={13} style={{ marginLeft: i === cols - 2 ? 'auto' : undefined }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** Which workspace AI tools use when a request doesn't name one. Permissions always follow the account. */
function AiWorkspaceCard() {
  const app = useApp();
  if (app.workspaces.length < 2) return null;
  const current = app.user?.defaultWorkspaceId ?? app.workspaces[0]?.id;
  const choose = async (id: string) => {
    try {
      const { user } = await api<{ user: User }>('PATCH', '/api/auth/me', { defaultWorkspaceId: id });
      setUser(user);
      const w = app.workspaces.find((x) => x.id === id);
      toast.success(`AI 기본 공간을 ${workspaceLabel(w)}(으)로 바꿨어요`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <Card className={base.section}>
      <CardHeader>
        <CardTitle>
          <Icon name="building" size={16} className={s.titleIcon} /> AI 기본 공간
        </CardTitle>
        <CardDescription>
          연결 하나로 개인 공간과 모든 조직을 다뤄요. AI가 공간을 따로 말하지 않으면 여기서 고른 곳에서 일해요. 조직에서는 내 계정 권한(보기·쓰기·관리)이 그대로 적용돼요.
        </CardDescription>
      </CardHeader>
      <CardContent className={s.content}>
        <div className={s.wsList} role="radiogroup" aria-label="AI 기본 공간">
          {app.workspaces.map((w) => (
            <button
              key={w.id}
              role="radio"
              aria-checked={current === w.id}
              className={s.wsOption}
              data-selected={current === w.id}
              onClick={() => current !== w.id && void choose(w.id)}
            >
              <WorkspaceMark ws={w} size="sm" />
              <span className={s.wsText}>
                <span className={s.wsName}>{workspaceLabel(w)}</span>
                <span className={s.wsMeta}>{w.kind === 'personal' ? '나만 보는 공간' : `조직 · 멤버 ${w.memberCount}명`}</span>
              </span>
              {current === w.id && <Icon name="check" size={15} />}
            </button>
          ))}
        </div>
        <p className={ui.help}>
          AI에게 “에이컴퍼니에서 할 일 보여줘”처럼 공간을 말하면 그 공간을 써요. <code>list_workspaces</code> 도구로 목록을 확인할 수 있어요.
        </p>
      </CardContent>
    </Card>
  );
}

export default function AiSettingsPage() {
  const [info, setInfo] = useState<{ publicUrl: string; mcpUrl: string; skillUrl: string } | null>(null);
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [tab, setTab] = useState<Client>('claude');
  const [tokenName, setTokenName] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<{ kind: 'token' | 'grant'; id: string; name: string } | null>(null);
  const [origin, setOrigin] = useState('');
  const [loaded, setLoaded] = useState(false); // display only: skeleton until the first refresh settles

  const refresh = useCallback(async () => {
    const [i, t, g] = await Promise.all([
      api<{ publicUrl: string; mcpUrl: string; skillUrl: string }>('GET', '/api/integrations'),
      api<{ tokens: TokenRow[] }>('GET', '/api/tokens'),
      api<{ grants: GrantRow[] }>('GET', '/api/oauth/grants'),
    ]);
    setInfo(i);
    setTokens(t.tokens);
    setGrants(g.grants);
  }, []);

  useEffect(() => {
    setOrigin(location.origin);
    refresh()
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setLoaded(true));
  }, [refresh]);

  const mcpUrl = info?.mcpUrl ?? `${origin}/mcp`;
  const mismatch = info && origin && info.publicUrl !== origin;
  const tokenHint = fresh ?? 'obk_…';

  const createToken = async () => {
    const name = tokenName.trim() || 'AI 도구';
    try {
      const r = await api<{ token: string }>('POST', '/api/tokens', { name });
      setFresh(r.token);
      setTokenName('');
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <Page>
      <ViewHeader
        icon="sparkle"
        iconColor="var(--accent)"
        title="AI 연결"
        subtitle="Claude, ChatGPT 같은 AI 도구가 Obelisk의 모든 기능을 MCP와 Agent Skill로 사용할 수 있어요."
      >
        <SettingsNav />
      </ViewHeader>

      <div className={base.stack}>
        {/* ───────── MCP endpoint */}
        <Card className={base.section}>
          <CardHeader>
            <CardTitle>
              <Icon name="bolt" size={16} className={s.titleIcon} /> MCP 서버 주소
            </CardTitle>
            <CardDescription>AI 도구의 커넥터 설정에 이 주소를 붙여넣으면 연결돼요.</CardDescription>
          </CardHeader>
          <CardContent className={s.content}>
            <CopyField value={mcpUrl} label="MCP 서버 주소" done="MCP 주소를 복사했어요" />
            {mismatch && (
              <div className={ui.alert} data-tone="warn" role="note">
                <Icon name="alert" size={16} />
                <p className={ui.alertTitle}>접속 주소가 서버 설정과 달라요</p>
                <p className={ui.alertDescription}>
                  서버의 <code>PUBLIC_URL</code>이 <b>{info!.publicUrl}</b>로 설정되어 있지만 지금은 <b>{origin}</b>로 접속 중이에요. AI 도구의
                  OAuth 로그인이 실패할 수 있으니 배포 환경변수 <code>PUBLIC_URL</code>을 실제 주소로 맞춰주세요.
                </p>
              </div>
            )}
            <div>
              <p className={s.subhead}>AI가 할 수 있는 일</p>
              <ul className={s.features}>
                {FEATURES.map(([k, v]) => (
                  <li key={k} className={s.feature}>
                    <Icon name="check" size={14} strokeWidth={2.4} />
                    <span>
                      <code>{k}</code>
                      <span className={s.featureText}>{v}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>

        <AiWorkspaceCard />

        {/* ───────── how to connect */}
        <Card className={base.section}>
          <CardHeader>
            <CardTitle>연결 방법</CardTitle>
            <CardDescription>쓰고 있는 AI 도구를 고르고 순서대로 따라 하세요.</CardDescription>
          </CardHeader>
          <CardContent className={s.content}>
            <div className={cx(ui.tabs, s.clientTabs)} role="group" aria-label="AI 도구">
              {CLIENTS.map(([k, label]) => (
                <button key={k} type="button" className={ui.tab} aria-pressed={tab === k} onClick={() => setTab(k)}>
                  {label}
                </button>
              ))}
            </div>

            {tab === 'claude' && (
              <ol className={s.steps}>
                <li>
                  Claude(웹·데스크톱)에서 <b>Customize → Connectors</b>를 열고 <b>Add → Add custom connector</b>를 눌러요.
                  Team·Enterprise 플랜은 Owner가 <b>Organization settings → Connectors</b>에서 추가해야 해요.
                </li>
                <li>
                  이름은 <b>Obelisk</b>, URL에는 위의 MCP 주소를 붙여넣고 <b>Continue</b>. 인증 설정은 <b>Detected</b>로
                  표시된 그대로 두고 <b>Add</b>해요.
                </li>
                <li>
                  <b>연결</b>을 누르면 Obelisk 승인 화면이 열려요. 로그인 후 <b>허용</b>하면 끝.
                </li>
                <li>
                  아래 <b>Agent Skill</b>도 함께 올리면 Claude가 지연 예측을 언제 써야 하는지까지 알게 돼요.
                </li>
              </ol>
            )}
            {tab === 'chatgpt' && (
              <ol className={s.steps}>
                <li>
                  ChatGPT <b>Plugins</b>에서 <b>+ → Add custom MCP server</b>를 눌러요. Codex에 추가한 MCP 서버는 ChatGPT
                  대화에 공유되지 않으니 여기서 따로 추가해야 해요.
                </li>
                <li>
                  이름 <b>Obelisk</b>, Server URL에 위 주소, Authentication은 <b>OAuth</b>를 고르고 경고를 확인한 뒤{' '}
                  <b>Create as a plugin</b>을 눌러요.
                </li>
                <li>
                  내 플러그인에서 Obelisk를 열어 <b>+</b>로 설치하고, 위쪽 탭을 <b>Work</b>로 바꾼 새 대화에서{' '}
                  <b>@Obelisk</b>를 골라 물어보면 돼요. Obelisk 승인 화면이 뜨면 로그인 후 허용해요.
                </li>
              </ol>
            )}
            {tab === 'claude-code' && (
              <ol className={s.steps}>
                <li>
                  OAuth로 연결 (권장) — 실행 후 <b>/mcp</b>에서 Obelisk를 선택해 로그인해요.
                  <Code>{`claude mcp add --transport http obelisk ${mcpUrl}`}</Code>
                </li>
                <li>
                  또는 개인 토큰으로 연결:
                  <Code>{`claude mcp add --transport http obelisk ${mcpUrl} --header "Authorization: Bearer ${tokenHint}"`}</Code>
                </li>
                <li>
                  Skill 설치: 아래에서 받은 zip을 풀어 <b>~/.claude/skills/obelisk</b>에 넣어요.
                </li>
              </ol>
            )}
            {tab === 'codex' && (
              <ol className={s.steps}>
                <li>
                  <b>~/.codex/config.toml</b>에 추가해요.
                  <Code>{`[mcp_servers.obelisk]\nurl = "${mcpUrl}"\nbearer_token_env_var = "OBELISK_TOKEN"`}</Code>
                </li>
                <li>
                  개인 토큰을 환경변수로 지정해요.
                  <Code>{`export OBELISK_TOKEN="${tokenHint}"`}</Code>
                </li>
                <li>
                  Skill 설치: zip을 풀어 <b>~/.codex/skills/obelisk</b>에 넣어요.
                </li>
              </ol>
            )}
            {tab === 'other' && (
              <ol className={s.steps}>
                <li>Streamable HTTP를 지원하는 모든 MCP 클라이언트에서 사용할 수 있어요 (Cursor, Windsurf, VS Code 등).</li>
                <li>
                  OAuth 2.1(동적 클라이언트 등록, PKCE)을 지원하면 URL만 넣으면 돼요. 아니라면 헤더로 토큰을 전달하세요:
                  <Code>{`{\n  "mcpServers": {\n    "obelisk": {\n      "url": "${mcpUrl}",\n      "headers": { "Authorization": "Bearer ${tokenHint}" }\n    }\n  }\n}`}</Code>
                </li>
                <li>
                  MCP가 없는 환경에서는 REST API를 직접 쓸 수 있어요. Skill 안의 <b>references/rest-api.md</b>를 참고하세요.
                </li>
              </ol>
            )}
          </CardContent>
        </Card>

        {/* ───────── agent skill */}
        <Card className={base.section}>
          <CardHeader>
            <CardTitle>
              <Icon name="sparkle" size={16} className={s.titleIcon} /> Agent Skill
            </CardTitle>
            <CardDescription>
              MCP가 ‘무엇을 할 수 있는지’라면, Skill은 ‘언제 어떻게 써야 하는지’예요. 미루기 전 반드시 파급 예측을 먼저 보여주고, 목표를 의존 관계가 있는
              계획으로 쪼개는 방법이 담겨 있어요. 이 서버 주소가 미리 들어간 상태로 받아져요.
            </CardDescription>
          </CardHeader>
          <CardContent className={s.content}>
            <div>
              <a className={`${ui.btn} ${ui.primary}`} href="/api/skill.zip" download>
                <Icon name="download" size={15} /> obelisk-skill.zip 받기
              </a>
            </div>
            <ul className={s.install}>
              <li>
                <b>Claude</b>
                <span>설정 → 기능 → Skills → 업로드</span>
              </li>
              <li>
                <b>Claude Code</b>
                <span>
                  <code>~/.claude/skills/obelisk</code>에 압축 해제
                </span>
              </li>
              <li>
                <b>Codex</b>
                <span>
                  <code>~/.codex/skills/obelisk</code>에 압축 해제
                </span>
              </li>
            </ul>
          </CardContent>
        </Card>

        {/* ───────── personal tokens */}
        <Card className={base.section}>
          <CardHeader>
            <CardTitle>
              <Icon name="key" size={16} className={s.titleIcon} /> 개인 API 토큰
            </CardTitle>
            <CardDescription>OAuth를 지원하지 않는 도구나 스크립트용이에요. 토큰은 만들 때 한 번만 보여드려요.</CardDescription>
          </CardHeader>
          <CardContent className={s.content}>
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead>
                  <tr className={ui.tr}>
                    <th className={ui.th}>이름</th>
                    <th className={cx(ui.th, s.colWhen)}>마지막 사용</th>
                    <th className={cx(ui.th, s.colAction)}>
                      <span className="sr-only">관리</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {!loaded ? (
                    <SkeletonRows cols={3} />
                  ) : tokens.length === 0 ? (
                    <tr className={ui.tr}>
                      <td className={cx(ui.td, s.emptyCell)} colSpan={3}>
                        아직 만든 토큰이 없어요
                      </td>
                    </tr>
                  ) : (
                    tokens.map((t) => (
                      <tr key={t.id} className={ui.tr}>
                        <td className={ui.td}>
                          <div className={s.nameCell}>
                            <span className={s.rowIcon}>
                              <Icon name="key" size={15} />
                            </span>
                            <div className={s.nameText}>
                              <div className={s.name}>{t.name}</div>
                              <code className={s.sub}>{t.prefix}</code>
                            </div>
                          </div>
                        </td>
                        <td className={cx(ui.td, s.colWhen)}>{relativeTime(t.lastUsedAt)}</td>
                        <td className={cx(ui.td, s.colAction)}>
                          <button
                            className={`${ui.btn} ${ui.sm} ${ui.dangerGhost}`}
                            onClick={() => setRevoke({ kind: 'token', id: t.id, name: t.name })}
                          >
                            폐기
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className={s.createRow}>
              <input
                className={ui.input}
                placeholder="토큰 이름 (예: Claude Code 노트북)"
                aria-label="새 토큰 이름"
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
                onKeyDown={(e) => isEnter(e) && void createToken()}
              />
              <button type="button" className={`${ui.btn} ${ui.primary}`} onClick={() => void createToken()}>
                <Icon name="plus" size={15} /> 토큰 만들기
              </button>
            </div>

            {fresh && (
              <div className={cx(ui.alert, s.reveal)} data-tone="ok" role="status">
                <Icon name="checkCircle" size={16} />
                <p className={ui.alertTitle}>새 토큰이에요. 지금 복사해 두세요 — 다시 볼 수 없어요.</p>
                <div className={s.revealBody}>
                  <CopyField value={fresh} label="새 토큰" done="토큰을 복사했어요" />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ───────── connected apps */}
        <Card className={base.section}>
          <CardHeader>
            <CardTitle>
              <Icon name="shield" size={16} className={s.titleIcon} /> 연결된 앱
            </CardTitle>
            <CardDescription>OAuth로 접근을 허용한 AI 도구들이에요. 연결을 끊으면 즉시 접근이 차단돼요.</CardDescription>
          </CardHeader>
          <CardContent className={s.content}>
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead>
                  <tr className={ui.tr}>
                    <th className={ui.th}>앱</th>
                    <th className={cx(ui.th, s.colWhen)}>마지막 사용</th>
                    <th className={cx(ui.th, s.colAction)}>
                      <span className="sr-only">관리</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {!loaded ? (
                    <SkeletonRows cols={3} />
                  ) : grants.length === 0 ? (
                    <tr className={ui.tr}>
                      <td className={cx(ui.td, s.emptyCell)} colSpan={3}>
                        연결된 앱이 없어요
                      </td>
                    </tr>
                  ) : (
                    grants.map((g) => (
                      <tr key={g.id} className={ui.tr}>
                        <td className={ui.td}>
                          <div className={s.nameCell}>
                            <span className={s.rowIcon}>
                              <Icon name="sparkle" size={15} />
                            </span>
                            <div className={s.nameText}>
                              <div className={s.name}>{g.clientName}</div>
                              <div className={s.sub}>{new Date(g.createdAt).toLocaleDateString('ko-KR')} 연결</div>
                            </div>
                          </div>
                        </td>
                        <td className={cx(ui.td, s.colWhen)}>{relativeTime(g.lastUsedAt)}</td>
                        <td className={cx(ui.td, s.colAction)}>
                          <button
                            className={`${ui.btn} ${ui.sm} ${ui.dangerGhost}`}
                            onClick={() => setRevoke({ kind: 'grant', id: g.id, name: g.clientName })}
                          >
                            연결 끊기
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>

      <ConfirmModal
        open={!!revoke}
        onClose={() => setRevoke(null)}
        title={revoke?.kind === 'token' ? '토큰을 폐기할까요?' : '연결을 끊을까요?'}
        body={`“${revoke?.name}”은(는) 더 이상 Obelisk에 접근할 수 없어요.`}
        confirmLabel={revoke?.kind === 'token' ? '폐기' : '연결 끊기'}
        onConfirm={async () => {
          if (!revoke) return;
          try {
            await api('DELETE', revoke.kind === 'token' ? `/api/tokens/${revoke.id}` : `/api/oauth/grants/${revoke.id}`);
            await refresh();
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
      />
    </Page>
  );
}

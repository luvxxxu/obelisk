/**
 * Minimal client for the System One API — TypeSafe's Jev by default, or any service that serves the
 * same API at another base URL (OpenRouter, Cloudflare Workers AI's Clef models, a self-hosted server).
 * https://docs.typesafe.ai/api/system-one
 *
 * One request carries a `state` and any number of typed questions; each question is
 * answered independently and in parallel, so batching many tasks into one call costs
 * barely more time than asking about one. Billing is per input token.
 */
import { DEFAULT_JEV_BASE_URL, jevEndpoint } from '@obelisk/core';

export const JEV_ENDPOINT = jevEndpoint(DEFAULT_JEV_BASE_URL);
/** The model asked when the user didn't name one. */
export const JEV_MODEL = process.env.JEV_MODEL?.trim() || 'jev-latest';
/** Questions per request: Cloudflare's Clef takes at most 64, so every caller stays under that. */
export const MAX_QUESTIONS = 64;

/** The user's own key for a System One service. */
export interface JevConnection {
  apiKey: string;
  /** null = TypeSafe. */
  baseUrl?: string | null;
  /** null = JEV_MODEL. */
  model?: string | null;
}

type Desc = string | Record<string, unknown> | unknown[];

export type JevQuestion =
  | { type: 'choice'; instructions: Desc; criteria: Record<string, Desc> }
  | { type: 'score'; instructions: Desc; criteria: Desc[] }
  | { type: 'noul'; instructions: Desc; criteria?: { true: Desc; false: Desc } };

export type JevAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number }
  | { type: 'noul'; noul: number };

export interface JevResult {
  answers: Record<string, JevAnswer>;
  model: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** `quota`: a daily free allocation or prepaid credit is used up — retrying won't help. */
export type JevErrorCode = 'auth' | 'rate' | 'quota' | 'overloaded' | 'rejected' | 'network' | 'invalid';

export class JevError extends Error {
  constructor(
    message: string,
    readonly code: JevErrorCode,
    /** Upstream HTTP status, 0 when the request never got an answer. */
    readonly status = 0,
  ) {
    super(message);
  }
}

export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export interface AskOptions {
  fetch?: Transport;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Retries for 429 / 529 / 5xx / network failures (never for a used-up quota). */
  retries?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const prob = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);

function readAnswer(raw: unknown, q: JevQuestion): JevAnswer | null {
  if (!isObject(raw) || raw.type !== q.type) return null;
  if (q.type === 'noul') {
    const p = prob(raw.noul);
    return p === null ? null : { type: 'noul', noul: p };
  }
  const probabilities: Record<string, number> = {};
  if (isObject(raw.probabilities)) {
    for (const [k, v] of Object.entries(raw.probabilities)) {
      const p = prob(v);
      if (p !== null) probabilities[k] = p;
    }
  }
  // Not every compatible model reports `confidence` (Clef documents only probabilities): use the top one.
  const ps = Object.values(probabilities);
  const confidence = prob(raw.confidence) ?? (ps.length ? Math.max(...ps) : 0);
  if (q.type === 'choice') {
    if (typeof raw.choice !== 'string' || !(raw.choice in q.criteria)) return null;
    return { type: 'choice', choice: raw.choice, probabilities, confidence };
  }
  const highest = q.criteria.length - 1;
  if (typeof raw.score !== 'number' || !Number.isFinite(raw.score)) return null;
  return { type: 'score', score: Math.min(highest, Math.max(0, raw.score)), probabilities, confidence };
}

/** What a service is called in messages. */
export function serviceName(baseUrl: string | null | undefined): string {
  let host = '';
  try {
    host = new URL(baseUrl ?? DEFAULT_JEV_BASE_URL).hostname;
  } catch {}
  if (host === 'api.typesafe.ai') return 'Jev';
  if (host === 'openrouter.ai') return 'OpenRouter';
  if (host === 'api.cloudflare.com') return 'Cloudflare';
  return host || 'Jev';
}

/** Error codes in a Cloudflare (`{ errors: [{ code }] }`) or OpenRouter (`{ error: { code } }`) body. */
function errorCodes(detail: string): number[] {
  try {
    const body: unknown = JSON.parse(detail);
    if (!isObject(body)) return [];
    const list = Array.isArray(body.errors) ? body.errors : isObject(body.error) ? [body.error] : [];
    return list.flatMap((e) => (isObject(e) && typeof e.code === 'number' ? [e.code] : []));
  } catch {
    return [];
  }
}

function errorFor(status: number, baseUrl: string | null | undefined, detail: string): JevError {
  const name = serviceName(baseUrl);
  const codes = errorCodes(detail);
  const has = (...c: number[]) => c.some((x) => codes.includes(x));
  // Workers AI: https://developers.cloudflare.com/workers-ai/platform/errors/
  if (name === 'Cloudflare') {
    if (has(3036)) {
      return new JevError(
        '오늘 Cloudflare 무료 한도(하루 10,000 뉴런)를 다 썼어요. 매일 오전 9시(UTC 0시)에 다시 채워져요. Workers Paid 플랜이면 계속 쓸 수 있어요.',
        'quota',
        status,
      );
    }
    if (has(5035)) return new JevError('이 모델은 Cloudflare Workers Paid 플랜에서만 쓸 수 있어요. 설정 → Jev에서 다른 모델을 고르세요.', 'quota', status);
    if (has(5007, 3042, 5028)) return new JevError('Cloudflare에 이 모델이 없어요. 설정 → Jev에서 모델 이름을 확인하세요.', 'rejected', status);
    if (has(7000, 7003) || status === 404) {
      return new JevError('Cloudflare 계정 ID를 찾지 못했어요. 설정 → Jev에서 계정 ID를 확인하세요.', 'auth', status);
    }
    if (has(10000, 3023) || status === 401 || status === 403) {
      return new JevError('Cloudflare API 토큰이 올바르지 않거나 Workers AI 권한이 없어요. 설정 → Jev에서 토큰을 다시 입력하세요.', 'auth', status);
    }
    if (has(3040)) return new JevError('Cloudflare 서버가 잠시 붐벼요. 잠시 후 다시 시도하세요.', 'overloaded', status);
  }
  if (status === 401 || status === 403) {
    return new JevError(`${name} API 키가 올바르지 않거나 만료됐어요. 설정 → Jev에서 키를 다시 입력하세요.`, 'auth', status);
  }
  if (status === 402) return new JevError(`${name} 크레딧이 부족해요. 충전한 뒤 다시 시도하세요.`, 'quota', status);
  if (status === 404) return new JevError(`${name}에서 이 주소나 모델을 찾지 못했어요. 설정 → Jev에서 Base URL과 모델을 확인하세요.`, 'rejected', status);
  if (status === 429) return new JevError(`${name} 요청 한도를 넘었어요. 잠시 후 다시 시도하세요.`, 'rate', status);
  if (status === 529 || status >= 500) return new JevError(`${name} 서버가 잠시 붐벼요. 잠시 후 다시 시도하세요.`, 'overloaded', status);
  return new JevError(`${name} 서버가 요청을 처리하지 못했어요 (HTTP ${status})`, 'rejected', status);
}

const retryable = (e: JevError) => e.code === 'rate' || e.code === 'overloaded' || e.code === 'network';

/**
 * Ask the user's System One service. Answers that are missing or malformed are dropped rather than
 * failing the whole call, so callers treat a missing key as "no opinion".
 * Callers check a user-chosen URL first (JevService.endpoint): this only sends.
 */
export async function askJev(
  connection: JevConnection,
  call: { state: unknown; questions: Record<string, JevQuestion> },
  opts: AskOptions = {},
): Promise<JevResult> {
  const request = opts.fetch ?? fetch;
  const retries = opts.retries ?? 2;
  const url = connection.baseUrl ? jevEndpoint(connection.baseUrl) : JEV_ENDPOINT;
  const model = connection.model || JEV_MODEL;
  const name = serviceName(connection.baseUrl);
  const body = JSON.stringify({ model, state: call.state, questions: call.questions });
  let attempt = 0;
  for (;;) {
    opts.signal?.throwIfAborted();
    try {
      return await once();
    } catch (e) {
      const err = e instanceof JevError ? e : new JevError(`${name} 서버에 연결하지 못했어요. 잠시 후 다시 시도하세요.`, 'network');
      if (opts.signal?.aborted || !retryable(err) || attempt >= retries) throw err;
      await Bun.sleep(350 * 2 ** attempt + Math.random() * 150);
      attempt++;
    }
  }

  async function once(): Promise<JevResult> {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await request(url, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${connection.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      });
    } catch {
      throw new JevError(`${name} 서버에 연결하지 못했어요. 잠시 후 다시 시도하세요.`, 'network');
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (res.status === 400 || res.status === 422) console.warn(`[jev] ${name} HTTP ${res.status}: ${detail.slice(0, 300)}`);
      throw errorFor(res.status, connection.baseUrl, detail);
    }
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      throw new JevError(`${name} 응답을 읽지 못했어요`, 'invalid', res.status);
    }
    // Cloudflare's REST API may wrap the System One result in `{ result, success, errors }`.
    const payload = isObject(raw) && !isObject(raw.answers) && isObject(raw.result) ? raw.result : raw;
    if (!isObject(payload) || !isObject(payload.answers)) {
      throw new JevError(`${name} 응답이 System One 형식이 아니에요. Base URL을 확인하세요.`, 'invalid', res.status);
    }
    const answers: Record<string, JevAnswer> = {};
    for (const [id, q] of Object.entries(call.questions)) {
      const a = readAnswer(payload.answers[id], q);
      if (a) answers[id] = a;
    }
    return {
      answers,
      model: typeof payload.model === 'string' ? payload.model : model,
      usage: isObject(payload.usage) ? (payload.usage as JevResult['usage']) : undefined,
    };
  }
}

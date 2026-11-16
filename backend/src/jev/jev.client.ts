/**
 * Minimal client for TypeSafe's System One endpoint (model Jev).
 * https://docs.typesafe.ai/api/system-one
 *
 * One request carries a `state` and any number of typed questions; each question is
 * answered independently and in parallel, so batching many tasks into one call costs
 * barely more time than asking about one. Billing is per input token.
 */

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = process.env.JEV_MODEL?.trim() || 'jev-latest';

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

export type JevErrorCode = 'auth' | 'rate' | 'overloaded' | 'rejected' | 'network' | 'invalid';

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
  /** Retries for 429 / 529 / 5xx / network failures. */
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
  const confidence = prob(raw.confidence) ?? 0;
  if (q.type === 'choice') {
    if (typeof raw.choice !== 'string' || !(raw.choice in q.criteria)) return null;
    return { type: 'choice', choice: raw.choice, probabilities, confidence };
  }
  const top = q.criteria.length - 1;
  if (typeof raw.score !== 'number' || !Number.isFinite(raw.score)) return null;
  return { type: 'score', score: Math.min(top, Math.max(0, raw.score)), probabilities, confidence };
}

function errorFor(status: number): JevError {
  if (status === 401 || status === 403) {
    return new JevError('Jev API 키가 올바르지 않거나 만료됐어요. 설정 → Jev에서 키를 다시 입력하세요.', 'auth', status);
  }
  if (status === 429) return new JevError('Jev 요청 한도를 넘었어요. 잠시 후 다시 시도하세요.', 'rate', status);
  if (status === 529 || status >= 500) return new JevError('Jev가 잠시 붐벼요. 잠시 후 다시 시도하세요.', 'overloaded', status);
  return new JevError(`Jev가 요청을 처리하지 못했어요 (HTTP ${status})`, 'rejected', status);
}

const retryable = (e: JevError) => e.code === 'rate' || e.code === 'overloaded' || e.code === 'network';

/**
 * Ask Jev. Answers that are missing or malformed are dropped rather than failing the whole
 * call, so callers treat a missing key as "no opinion".
 */
export async function askJev(
  apiKey: string,
  call: { state: unknown; questions: Record<string, JevQuestion> },
  opts: AskOptions = {},
): Promise<JevResult> {
  const request = opts.fetch ?? fetch;
  const retries = opts.retries ?? 2;
  const body = JSON.stringify({ model: JEV_MODEL, state: call.state, questions: call.questions });
  let attempt = 0;
  for (;;) {
    opts.signal?.throwIfAborted();
    try {
      return await once();
    } catch (e) {
      const err = e instanceof JevError ? e : new JevError('Jev에 연결하지 못했어요. 잠시 후 다시 시도하세요.', 'network');
      if (opts.signal?.aborted || !retryable(err) || attempt >= retries) throw err;
      await Bun.sleep(350 * 2 ** attempt + Math.random() * 150);
      attempt++;
    }
  }

  async function once(): Promise<JevResult> {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await request(JEV_ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      });
    } catch {
      throw new JevError('Jev에 연결하지 못했어요. 잠시 후 다시 시도하세요.', 'network');
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (res.status === 400 || res.status === 422) console.warn(`[jev] HTTP ${res.status}: ${detail.slice(0, 300)}`);
      throw errorFor(res.status);
    }
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new JevError('Jev 응답을 읽지 못했어요', 'invalid', res.status);
    }
    if (!isObject(payload) || !isObject(payload.answers)) throw new JevError('Jev 응답 형식이 올바르지 않아요', 'invalid', res.status);
    const answers: Record<string, JevAnswer> = {};
    for (const [id, q] of Object.entries(call.questions)) {
      const a = readAnswer(payload.answers[id], q);
      if (a) answers[id] = a;
    }
    return {
      answers,
      model: typeof payload.model === 'string' ? payload.model : JEV_MODEL,
      usage: isObject(payload.usage) ? (payload.usage as JevResult['usage']) : undefined,
    };
  }
}

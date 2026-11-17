import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Outgoing webhooks must not become a way to reach the server's own network (SSRF):
 * every send resolves the host and refuses loopback, private, link-local, CGNAT,
 * multicast and reserved addresses, unless WEBHOOK_ALLOW_PRIVATE is on.
 */

export class UndeliverableError extends Error {
  constructor(
    message: string,
    /** A DNS hiccup is worth retrying; a private address is not. */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

function v4Number(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function v4Private(ip: string): boolean {
  const n = v4Number(ip);
  if (n === null) return true;
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((v4Number(base)! & mask) >>> 0);
  });
}

/** "::ffff:1.2.3.4" → 8 hextets. null if malformed. */
function v6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const n = v4Number(v4[1]!);
    if (n === null) return null;
    s = s.slice(0, -v4[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const parts = [...head, ...Array(fill).fill('0'), ...tail];
  if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map((p) => parseInt(p, 16));
}

function v6Private(ip: string): boolean {
  const h = v6Hextets(ip);
  if (!h) return true;
  const embedded = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (h.every((x) => x === 0)) return true; // ::
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1
  // IPv4-mapped / -compatible, NAT64 (64:ff9b::/96) and 6to4 (2002::/16) carry an IPv4 address.
  if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) return v4Private(embedded(h[6]!, h[7]!));
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return v4Private(embedded(h[6]!, h[7]!));
  if (h[0] === 0x2002) return v4Private(embedded(h[1]!, h[2]!));
  const first = h[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (first === 0x2001 && h[1] === 0x0db8) return true; // documentation
  if (first === 0x100 && h.slice(1, 4).every((x) => x === 0)) return true; // discard-only
  return false;
}

/** Loopback, private, link-local, CGNAT, multicast, documentation or otherwise not public. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, '').replace(/%.*$/, ''));
  if (kind === 4) return v4Private(ip);
  if (kind === 6) return v6Private(ip);
  return true;
}

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/i;

/** Throws UndeliverableError when the URL must not (or cannot now) be called. */
export async function assertDeliverable(raw: string, allowPrivate: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UndeliverableError('URL 형식이 올바르지 않습니다', false);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UndeliverableError('http:// 또는 https:// 주소만 쓸 수 있습니다', false);
  }
  if (url.username || url.password) {
    throw new UndeliverableError('주소에 아이디·비밀번호를 넣을 수 없습니다. 받는 쪽 토큰은 쿼리 문자열로 전달하세요', false);
  }
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new UndeliverableError('내부망·로컬 주소로는 보낼 수 없습니다', false);
    return url;
  }
  if (LOCAL_NAMES.test(host) || !host.includes('.')) {
    throw new UndeliverableError('내부망·로컬 주소로는 보낼 수 없습니다', false);
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UndeliverableError(`호스트 ${host}을(를) 찾을 수 없습니다`, true);
  }
  if (!addresses.length) throw new UndeliverableError(`호스트 ${host}을(를) 찾을 수 없습니다`, true);
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new UndeliverableError(`${host}이(가) 내부망 주소를 가리켜 보낼 수 없습니다`, false);
  }
  return url;
}

/**
 * `X-Obelisk-Signature: sha256=<hex>` over "<timestamp>.<raw body>" with the webhook's secret.
 * Receivers recompute it and compare in constant time, and reject old timestamps.
 */
export function signBody(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

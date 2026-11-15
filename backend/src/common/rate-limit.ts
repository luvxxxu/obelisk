import { HttpException } from '@nestjs/common';

/** Tiny fixed-window limiter for unauthenticated endpoints (single instance deployments). */
export function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string) => {
    const now = Date.now();
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    }
    const cur = hits.get(key);
    if (!cur || cur.reset < now) {
      hits.set(key, { n: 1, reset: now + windowMs });
      return;
    }
    if (++cur.n > limit) {
      throw new HttpException(
        { error: 'too_many_requests', error_description: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' },
        429,
      );
    }
  };
}

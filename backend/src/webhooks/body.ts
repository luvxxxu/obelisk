/** Plain text, `curl -d "보고서 내일"` (a form body with the text as its only key), JSON, or a form with fields. */
export function incomingBody(contentType: string | undefined, body: unknown): unknown {
  if (typeof body === 'string') return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const entries = Object.entries(body as Record<string, unknown>);
  if (!entries.length) return '';
  if ((contentType ?? '').includes('application/x-www-form-urlencoded') && entries.length === 1 && entries[0]![1] === '') {
    return entries[0]![0];
  }
  return body;
}

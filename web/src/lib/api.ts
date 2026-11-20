export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** A machine-readable reason some answers carry, e.g. 'email_unverified' or 'pending_approval'. */
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

let workspaceHeader: string | null = null;

/** The workspace this tab has open; sent with every call (calls by task/project id use that thing's own). */
export function setWorkspaceHeader(id: string | null) {
  workspaceHeader = id;
}

export function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  return request<T>(method, path, body !== undefined ? { type: 'application/json', data: JSON.stringify(body) } : undefined);
}

/** Send a file as the request body itself (profile photos), with its own content type. */
export function upload<T = unknown>(method: string, path: string, blob: Blob): Promise<T> {
  return request<T>(method, path, { type: blob.type || 'application/octet-stream', data: blob });
}

/**
 * Send a JSON body (or none) and save the response as a file (exports). The name comes from the
 * response's Content-Disposition (`filename*` first, so Korean names survive), else `fallbackName`.
 * Returns the name the file was saved as.
 */
export async function download(method: string, path: string, body?: unknown, fallbackName = 'download'): Promise<string> {
  const res = await send(method, path, body !== undefined ? { type: 'application/json', data: JSON.stringify(body) } : undefined);
  let blob: Blob;
  try {
    blob = await res.blob();
  } catch {
    throw new ApiError('파일을 끝까지 받지 못했어요. 다시 시도하세요', 0);
  }
  const name = dispositionName(res.headers.get('content-disposition')) ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Safari starts the download after the click returns; give it a moment before freeing the blob.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

function dispositionName(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star) {
    try {
      return cleanName(decodeURIComponent(star[1]!.trim().replace(/^"|"$/g, '')));
    } catch {}
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/.exec(header);
  const v = plain?.[1] ?? plain?.[2];
  return v ? cleanName(v.trim()) : null;
}

/** No folders, no control characters: just a file name. */
function cleanName(name: string): string | null {
  const n = name.replace(/[\\/\u0000-\u001f\u007f]/g, '').trim();
  return n || null;
}

async function send(method: string, path: string, body?: { type: string; data: BodyInit }): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        ...(body ? { 'content-type': body.type } : {}),
        'x-obelisk-client': 'web',
        ...(workspaceHeader ? { 'x-obelisk-workspace': workspaceHeader } : {}),
      },
      body: body?.data,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('서버에 연결할 수 없습니다', 0);
  }
  if (!res.ok) {
    const data = parse(await res.text().catch(() => ''));
    const msg = Array.isArray(data?.message) ? data.message[0] : data?.message;
    throw new ApiError(msg || `요청을 처리하지 못했습니다 (${res.status})`, res.status, typeof data?.code === 'string' ? data.code : null);
  }
  return res;
}

async function request<T>(method: string, path: string, body?: { type: string; data: BodyInit }): Promise<T> {
  const res = await send(method, path, body);
  return parse(await res.text()) as T;
}

function parse(text: string): any {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

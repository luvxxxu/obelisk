export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
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

async function request<T>(method: string, path: string, body?: { type: string; data: BodyInit }): Promise<T> {
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
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = Array.isArray(data?.message) ? data.message[0] : data?.message;
    throw new ApiError(msg || `요청을 처리하지 못했습니다 (${res.status})`, res.status);
  }
  return data as T;
}

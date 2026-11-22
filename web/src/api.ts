import type { ApiError, PostedReply, SpecDocument, SpecResponse, SyncPlan, SyncRequest, SyncResult } from '../../shared/types';

function sessionToken(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="redline-token"]');
  return meta?.content ?? (import.meta.env.VITE_REDLINE_TOKEN as string | undefined) ?? '';
}

const isApiError = (value: unknown): value is ApiError =>
  typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string';

async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'x-redline-token': sessionToken(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data: unknown = await res.json();
  if (!res.ok || isApiError(data)) {
    throw new Error(isApiError(data) ? data.error : `Request failed: ${res.status}`);
  }
  return data as T;
}

export const api = {
  spec: (): Promise<SpecResponse> => request<SpecResponse>('/api/spec'),
  plan: (doc: SpecDocument): Promise<SyncPlan> => request<SyncPlan>('/api/plan', { doc }),
  sync: (req: SyncRequest): Promise<SyncResult> => request<SyncResult>('/api/sync', req),
  replies: (doc: SpecDocument, commentIds: string[]): Promise<PostedReply[]> =>
    request<PostedReply[]>('/api/replies', { doc, commentIds }),
};

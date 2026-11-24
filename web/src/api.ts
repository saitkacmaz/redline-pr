import type {
  ApiError,
  LoadTarget,
  PostedReply,
  PrListResponse,
  ServerEvent,
  SpecDocument,
  SpecResponse,
  SyncPlan,
  SyncRequest,
  SyncResult,
} from '../../shared/types';

function sessionToken(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="redline-token"]');
  return meta?.content ?? (import.meta.env.VITE_REDLINE_TOKEN as string | undefined) ?? '';
}

const isApiError = (value: unknown): value is ApiError =>
  typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string';

/** fetch() rejects with a bare "Failed to fetch" when nothing answers; say what that means here. */
const UNREACHABLE = 'Can’t reach redline. It has probably stopped: check its terminal, and run `redline` again in your repo.';

async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'x-redline-token': sessionToken(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(() => {
    throw new Error(UNREACHABLE);
  });
  const data: unknown = await res.json().catch(() => {
    throw new Error(`redline answered ${res.status} with something other than JSON. Reload the page; if that doesn’t help, restart redline.`);
  });
  if (!res.ok || isApiError(data)) {
    throw new Error(isApiError(data) ? data.error : `Request failed: ${res.status}`);
  }
  return data as T;
}

export const api = {
  spec: (): Promise<SpecResponse> => request<SpecResponse>('/api/spec'),
  prs: (): Promise<PrListResponse> => request<PrListResponse>('/api/prs'),
  load: (target: LoadTarget): Promise<unknown> => request('/api/load', { target }),
  plan: (doc: SpecDocument): Promise<SyncPlan> => request<SyncPlan>('/api/plan', { doc }),
  sync: (req: SyncRequest): Promise<SyncResult> => request<SyncResult>('/api/sync', req),
  replies: (doc: SpecDocument, commentIds: string[]): Promise<PostedReply[]> =>
    request<PostedReply[]>('/api/replies', { doc, commentIds }),
};

/**
 * Follow /api/events (Server-Sent Events) until stopped, reconnecting if redline restarts.
 * Uses fetch rather than EventSource so the session token travels in a header, not the URL.
 */
export function subscribe(onEvent: (event: ServerEvent) => void, onConnection: (connected: boolean) => void): () => void {
  let stopped = false;
  let ctl: AbortController | null = null;
  let retryMs = 1000;

  const connect = async (): Promise<void> => {
    while (!stopped) {
      ctl = new AbortController();
      try {
        const res = await fetch('/api/events', { headers: { 'x-redline-token': sessionToken() }, signal: ctl.signal });
        if (!res.ok || !res.body) throw new Error(String(res.status));
        onConnection(true);
        retryMs = 1000;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let end: number;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = block
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trimStart())
              .join('\n');
            if (data) onEvent(JSON.parse(data) as ServerEvent);
          }
        }
      } catch {
        // Dropped or refused; retry below.
      }
      if (stopped) return;
      onConnection(false);
      // Back off while redline is gone (1s, 2s, 4s… up to 10s), so a closed server isn't hammered.
      await new Promise((r) => setTimeout(r, retryMs));
      retryMs = Math.min(retryMs * 2, 10_000);
    }
  };
  void connect();
  return () => {
    stopped = true;
    ctl?.abort();
  };
}

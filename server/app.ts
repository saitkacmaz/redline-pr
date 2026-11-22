import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { Hono } from 'hono';
import type { ApiError, PostedReply, SessionInfo, SpecDocument, SpecResponse, SyncPlan, SyncResult } from '../shared/types.js';
import { PlanRequestSchema, PostRepliesSchema, SyncRequestSchema } from './schema.js';
import { buildPlan, executeSync, hasApplied, mergeEdits, postWrittenReplies, SyncBusyError, type SyncContext } from './sync.js';

export interface AppOptions {
  doc: SpecDocument;
  session: SessionInfo;
  sync: SyncContext;
  webDir: string;
  /** Per-boot secret; every /api call must echo it so other local pages cannot drive the server. */
  token: string;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostOf(url: string): string {
  try {
    // WHATWG URL keeps IPv6 brackets: new URL('http://[::1]:5173').hostname === '[::1]'.
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

export function createApp(opts: AppOptions): Hono {
  const app = new Hono();

  app.onError((err, c) => c.json<ApiError>({ error: err.message }, err instanceof SyncBusyError ? 409 : 500));

  // DNS rebinding: a page on evil.example that resolves to 127.0.0.1 would otherwise be
  // same-origin with us and could read the token. Only loopback host names are served.
  app.use('*', async (c, next) => {
    const host = (c.req.header('host') ?? '').replace(/:\d+$/, '');
    if (!LOOPBACK.has(host)) return c.text('redline-pr only answers on 127.0.0.1 or localhost.', 403);
    const origin = c.req.header('origin');
    if (c.req.method !== 'GET' && origin && !LOOPBACK.has(hostOf(origin))) {
      return c.json<ApiError>({ error: 'Cross-origin request refused.' }, 403);
    }
    await next();
  });

  app.use('/api/*', async (c, next) => {
    if (c.req.header('x-redline-token') !== opts.token) {
      return c.json<ApiError>({ error: 'Missing or invalid session token. Reload the page from the redline-pr CLI URL.' }, 403);
    }
    await next();
  });

  app.get('/api/spec', (c) => c.json<SpecResponse>({ session: { ...opts.session, applied: hasApplied() }, doc: opts.doc }));

  app.post('/api/plan', async (c) => {
    const parsed = PlanRequestSchema.safeParse(await c.req.json<unknown>());
    if (!parsed.success) return c.json<ApiError>({ error: parsed.error.message }, 400);
    return c.json<SyncPlan>(buildPlan(mergeEdits(opts.doc, parsed.data.doc)));
  });

  app.post('/api/sync', async (c) => {
    const parsed = SyncRequestSchema.safeParse(await c.req.json<unknown>());
    if (!parsed.success) return c.json<ApiError>({ error: parsed.error.message }, 400);
    return c.json<SyncResult>(await executeSync(mergeEdits(opts.doc, parsed.data.doc), parsed.data.mode, opts.sync));
  });

  app.post('/api/replies', async (c) => {
    const parsed = PostRepliesSchema.safeParse(await c.req.json<unknown>());
    if (!parsed.success) return c.json<ApiError>({ error: parsed.error.message }, 400);
    return c.json<PostedReply[]>(await postWrittenReplies(mergeEdits(opts.doc, parsed.data.doc), parsed.data.commentIds, opts.sync));
  });

  const root = normalize(opts.webDir);
  const indexHtml = readFile(join(root, 'index.html'), 'utf8').then((html) =>
    html.replace('</head>', `<meta name="redline-token" content="${opts.token}" /></head>`),
  );

  app.get('*', async (c) => {
    const path = normalize(join(root, decodeURIComponent(c.req.path)));
    if (path.startsWith(root + sep) && extname(path)) {
      try {
        const body = await readFile(path);
        return c.body(body, 200, {
          'content-type': MIME[extname(path)] ?? 'application/octet-stream',
          'cache-control': 'public, max-age=31536000, immutable',
        });
      } catch {
        return c.notFound();
      }
    }
    return c.html(await indexHtml, 200, { 'cache-control': 'no-store' });
  });

  return app;
}

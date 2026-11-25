import { z } from 'zod';
import { clip, underRoot, type StreamHandlers } from './steps.js';

/*
 * `codex exec --json` prints one event per line:
 *   thread.started {thread_id} · turn.started · item.started / item.updated / item.completed {item}
 *   turn.completed {usage} · turn.failed {error} · error {message}
 * Items: agent_message, reasoning, command_execution, file_change, mcp_tool_call, web_search,
 * todo_list, error (a non-fatal warning).
 */

const ItemSchema = z.looseObject({
  id: z.string().optional(),
  type: z.string(),
  text: z.string().optional(),
  message: z.string().optional(),
  command: z.string().optional(),
  aggregated_output: z.string().optional(),
  exit_code: z.number().nullable().optional(),
  status: z.string().optional(),
  changes: z.array(z.looseObject({ path: z.string(), kind: z.string().optional() })).optional(),
  server: z.string().optional(),
  tool: z.string().optional(),
  query: z.string().optional(),
});
type Item = z.infer<typeof ItemSchema>;

const EventSchema = z.looseObject({
  type: z.string(),
  thread_id: z.string().optional(),
  item: z.unknown().optional(),
  message: z.string().optional(),
  error: z.looseObject({ message: z.string().optional() }).optional(),
});

/** Codex wraps API errors as JSON inside the message string; keep only the sentence. */
export function unwrapError(message: string): string {
  try {
    const parsed: unknown = JSON.parse(message);
    if (typeof parsed === 'object' && parsed !== null) {
      const o = parsed as { message?: unknown; error?: { message?: unknown } };
      if (typeof o.error?.message === 'string') return o.error.message;
      if (typeof o.message === 'string') return o.message;
    }
  } catch {
    // Plain text already.
  }
  return message.trim();
}

/** Shell-like split, enough to read a command's program and arguments. */
function words(command: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  for (const m of command.matchAll(re)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[3] ?? ''));
  return out;
}

/**
 * Codex runs every command inside a shell: `/bin/zsh -lc "<command>"` on macOS and Linux,
 * `powershell.exe -Command "<command>"` (or `cmd /c`) on Windows. Show the command, not the wrapper.
 */
export function unwrapShell(command: string): string {
  const trimmed = command.trim();
  const posix = /^\S*\/?(?:ba|z|)sh\s+-l?c\s+(["'])([\s\S]*)\1$/.exec(trimmed);
  if (posix?.[2]) return posix[1] === '"' ? posix[2].replace(/\\(["\\$`])/g, '$1') : posix[2];
  const windows = /^"?[^"]*?(?:powershell|pwsh|cmd)(?:\.exe)?"?\s+(?:-NoProfile\s+|-NoLogo\s+)*(?:-Command|\/d\s+\/c|\/c)\s+(["']?)([\s\S]*)\1$/i.exec(trimmed);
  if (windows?.[2]) return windows[2];
  return trimmed;
}

const READERS = new Set(['cat', 'sed', 'head', 'tail', 'nl', 'less', 'bat', 'wc', 'type', 'get-content', 'gc']);
const SEARCHERS = new Set(['rg', 'grep', 'ag', 'ack', 'findstr', 'select-string']);
const LISTERS = new Set(['ls', 'find', 'tree', 'fd', 'dir', 'get-childitem', 'gci']);

/** One honest sentence fragment for a command Codex ran, with paths relative to the repo. */
export function describeCommand(raw: string, root?: string): string {
  const command = unwrapShell(raw);
  // The first command of a pipeline or chain says what it's doing.
  const first = command.split(/\s*(?:\|\||&&|\||;)\s*/)[0] ?? command;
  const [prog = '', ...args] = words(first);
  const name = (prog.split(/[\\/]/).at(-1) ?? prog).replace(/\.exe$/i, '').toLowerCase();
  const operands = args.filter((a) => !a.startsWith('-'));
  if (READERS.has(name)) {
    const file = name === 'sed' ? operands.slice(1).at(-1) : operands.at(-1);
    if (file) return `Reading ${underRoot(file, root)}`;
  }
  if (SEARCHERS.has(name)) {
    if (args.includes('--files')) return 'Listing files';
    if (operands[0]) return `Searching for ${clip(operands[0], 48)}`;
  }
  if (LISTERS.has(name)) return `Listing ${operands[0] ? underRoot(operands[0], root) : 'files'}`;
  return `Running ${clip(command || 'a command')}`;
}

const VERB: Record<string, string> = { add: 'Writing', delete: 'Deleting', update: 'Editing' };

function describeItem(item: Item, root?: string): string | null {
  switch (item.type) {
    case 'command_execution':
      return describeCommand(item.command ?? '', root);
    case 'file_change': {
      const changes = item.changes ?? [];
      const firstChange = changes[0];
      if (!firstChange) return 'Editing files';
      const verb = VERB[firstChange.kind ?? ''] ?? 'Editing';
      const more = changes.length > 1 ? ` and ${changes.length - 1} more` : '';
      return `${verb} ${underRoot(firstChange.path, root)}${more}`;
    }
    case 'web_search':
      return 'Searching the web';
    case 'mcp_tool_call':
      return `Using ${item.tool ?? item.server ?? 'a tool'}`;
    case 'todo_list':
      return 'Planning the changes';
    default:
      return null;
  }
}

export interface CodexOutcome {
  /** The session, for `codex resume <id>`. */
  threadId?: string;
  /** Codex's last message: the final answer (JSON, for a spec run). */
  lastMessage?: string;
  /** Why the turn failed, in Codex's own words. */
  failure?: string;
  completed: boolean;
}

/**
 * Turns `codex exec --json` stdout into steps and log lines. Feed it chunks as they arrive;
 * `finish()` returns what the run produced. Only the last agent message counts as the
 * answer, so a progress note ("I'll read app.js first") never gets parsed as output.
 */
export function codexStream(root: string | undefined, handlers: StreamHandlers) {
  let buffer = '';
  const outcome: CodexOutcome = { completed: false };
  const stepped = new Set<string>();
  const errors: string[] = [];

  const step = (item: Item): void => {
    if (item.id && stepped.has(item.id)) return;
    if (item.id) stepped.add(item.id);
    const text = describeItem(item, root);
    if (text) handlers.onStep?.(text);
  };

  const handle = (line: string): void => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      handlers.onLog?.(line);
      return;
    }
    const event = EventSchema.safeParse(raw);
    if (!event.success) return;
    const e = event.data;
    if (e.type === 'thread.started') {
      outcome.threadId ??= e.thread_id;
    } else if (e.type === 'turn.completed') {
      outcome.completed = true;
    } else if (e.type === 'turn.failed') {
      outcome.failure = unwrapError(e.error?.message ?? errors.at(-1) ?? 'Codex stopped with an error.');
    } else if (e.type === 'error' && e.message) {
      const message = unwrapError(e.message);
      errors.push(message);
      handlers.onLog?.(`error: ${message}`);
    } else if (e.type === 'item.started' || e.type === 'item.completed') {
      const parsed = ItemSchema.safeParse(e.item);
      if (!parsed.success) return;
      const item = parsed.data;
      if (item.type === 'agent_message') {
        if (e.type !== 'item.completed' || !item.text?.trim()) return;
        outcome.lastMessage = item.text.trim();
        // A JSON answer is data for the caller, not notes for the log.
        if (!outcome.lastMessage.startsWith('{')) handlers.onLog?.(outcome.lastMessage);
      } else if (item.type === 'error') {
        if (e.type === 'item.completed' && item.message) handlers.onLog?.(`warning: ${item.message}`);
      } else {
        // An item usually starts and then completes; one that only completes still gets its step.
        step(item);
        if (e.type === 'item.completed' && item.type === 'command_execution' && item.exit_code) {
          const output = item.aggregated_output?.trim().split('\n').at(-1) ?? '';
          handlers.onLog?.(`  failed (exit ${item.exit_code})${output ? `: ${clip(output, 160)}` : ''}`);
        }
      }
    }
  };

  return {
    push(chunk: string): void {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) handle(line);
      }
    },
    finish(): CodexOutcome {
      if (buffer.trim()) handle(buffer.trim());
      buffer = '';
      if (!outcome.completed && !outcome.failure && errors.length > 0) outcome.failure = errors.at(-1);
      return outcome;
    },
  };
}

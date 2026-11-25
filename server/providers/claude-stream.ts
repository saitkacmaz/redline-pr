import { z } from 'zod';
import { clip, underRoot, type StreamHandlers } from './steps.js';

export type { StreamHandlers } from './steps.js';

/** The final `result` event of `claude -p --output-format stream-json` (and the whole output of `--output-format json`). */
export const ClaudeResultSchema = z.object({
  type: z.string().optional(),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
});
export type ClaudeResult = z.infer<typeof ClaudeResultSchema>;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** One honest sentence fragment for a tool call, with paths relative to the repo. */
export function describeToolUse(name: string, input: Record<string, unknown>, root?: string): string {
  const path = (key: string): string => {
    const p = str(input[key]);
    return p ? underRoot(p, root) : 'a file';
  };
  switch (name) {
    case 'Read':
      return `Reading ${path('file_path')}`;
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${path('file_path')}`;
    case 'NotebookEdit':
      return `Editing ${path('notebook_path')}`;
    case 'Write':
      return `Writing ${path('file_path')}`;
    case 'Bash':
      return `Running ${clip(str(input.command) || 'a command')}`;
    case 'Grep':
      return `Searching for ${clip(str(input.pattern), 48)}`;
    case 'Glob':
      return `Listing ${clip(str(input.pattern), 48)}`;
    case 'StructuredOutput':
      return 'Writing the spec';
    case 'TodoWrite':
      return 'Planning the changes';
    case 'Task':
    case 'Agent':
      return `Delegating: ${clip(str(input.description) || 'a subtask', 56)}`;
    case 'WebFetch':
    case 'WebSearch':
      return 'Searching the web';
    default:
      return `Using ${name}`;
  }
}

const ContentSchema = z.array(
  z.looseObject({
    type: z.string(),
    name: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    text: z.string().optional(),
    is_error: z.boolean().optional(),
    content: z.unknown().optional(),
  }),
);

const EventSchema = z.looseObject({
  type: z.string(),
  session_id: z.string().optional(),
  message: z.looseObject({ content: z.unknown() }).optional(),
});

/**
 * Turns `claude -p --output-format stream-json --verbose` stdout into steps and log lines.
 * Feed it chunks as they arrive; `result()` is the final result event, if one came.
 */
export function claudeStream(root: string | undefined, handlers: StreamHandlers) {
  let buffer = '';
  let final: ClaudeResult | undefined;
  let lastText = '';
  let session: string | undefined;

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
    session ??= event.data.session_id;
    if (event.data.type === 'result') {
      final = ClaudeResultSchema.parse(raw);
      // Claude's closing notes; a structured spec result is data, not notes.
      // (Usually the same as Claude's last message, already logged.)
      const notes = final.result?.trim();
      if (final.structured_output === undefined && notes && notes !== lastText) handlers.onLog?.(notes);
      return;
    }
    const content = ContentSchema.safeParse(event.data.message?.content);
    if (!content.success) return;
    for (const block of content.data) {
      if (event.data.type === 'assistant' && block.type === 'tool_use' && block.name) {
        // A step is logged by whoever records it; logging it here too would double it.
        handlers.onStep?.(describeToolUse(block.name, block.input ?? {}, root));
      } else if (event.data.type === 'assistant' && block.type === 'text' && block.text?.trim()) {
        lastText = block.text.trim();
        handlers.onLog?.(lastText);
      } else if (block.type === 'tool_result' && block.is_error) {
        const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        handlers.onLog?.(`  failed: ${clip(text, 160)}`);
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
    /** The Claude Code session this run was saved as, for `claude --resume`. */
    sessionId(): string | undefined {
      return session;
    },
    /** The final result event. Falls back to parsing a single JSON object (plain `--output-format json`). */
    result(stdout: string): ClaudeResult | undefined {
      if (buffer.trim()) {
        handle(buffer.trim());
        buffer = '';
      }
      if (final) return final;
      try {
        return ClaudeResultSchema.parse(JSON.parse(stdout));
      } catch {
        return undefined;
      }
    },
  };
}

import type { AgentName, ProviderStatus } from '../../shared/types.js';
import type { StreamHandlers } from './steps.js';

/** Writing the spec: read-only, from an empty scratch directory, with the repo reachable by path. */
export interface SpecRequest {
  system: string;
  prompt: string;
  /** JSON Schema of the answer. */
  schema: Record<string, unknown>;
  repoRoot: string;
  /** This repo's directory under ~/.cache/redline-pr/. Anything the agent needs on disk goes here. */
  artifactDir: string;
  model?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Applying the edited sentences: the agent works in the repo and may edit files. */
export interface RunRequest {
  prompt: string;
  cwd: string;
  model?: string;
  timeoutMs: number;
}

export interface AgentRun {
  exitCode: number;
  ok: boolean;
  timedOut: boolean;
  /** The agent's closing notes, plus stderr when something broke. */
  output: string;
  /** Why it failed, in one line, when it did. */
  error?: string;
  sessionId?: string;
}

/**
 * A local coding-agent CLI, used through the user's own login. Providers only spawn the
 * CLI and read its stream; validating the spec, caching, and measuring what changed in
 * the repo are shared (spec.ts, sync.ts), so every agent is held to the same rules.
 */
export interface AgentProvider {
  readonly name: AgentName;
  /** The product, for sentences: "Claude Code", "Codex". */
  readonly label: string;
  /** On PATH, and logged in. Fast (a few hundred ms), never throws, never touches the repo. */
  status(): Promise<ProviderStatus>;
  /** One calm line on how to make `status()` true, for when it isn't. */
  unavailable(status: ProviderStatus): string;
  /** The model's answer to `req.schema`. Throws one readable sentence on failure. */
  generateSpec(req: SpecRequest, handlers: StreamHandlers): Promise<unknown>;
  executeSync(req: RunRequest, handlers: StreamHandlers): Promise<AgentRun>;
  /** The command that continues a run's session, to be run in the repo. */
  resumeCommand(sessionId: string): string;
}

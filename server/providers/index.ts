import { AGENT_NAMES, type AgentName, type ProviderStatus, type ProviderStatuses } from '../../shared/types.js';
import { claudeProvider } from './claude.js';
import { codexProvider } from './codex.js';
import type { AgentProvider } from './types.js';

export { onPath } from './steps.js';

export type { AgentProvider } from './types.js';

export const PROVIDERS: Record<AgentName, AgentProvider> = { claude: claudeProvider, codex: codexProvider };

const ready = (s: ProviderStatus): boolean => s.installed && s.loggedIn;

/** Every agent's install and login state, checked in parallel (well under a second). */
export async function detectProviders(): Promise<ProviderStatuses> {
  const [claude, codex] = await Promise.all([PROVIDERS.claude.status(), PROVIDERS.codex.status()]);
  return { claude, codex };
}

export const NO_AGENT =
  'No logged-in agent found. Log in to Claude Code ("claude auth login") or the Codex CLI ("codex login"), then run redline again. Or try redline --demo.';

/**
 * Which agent to use. Asked for one (`redline codex`, --agent, REDLINE_AGENT): that one,
 * if it's installed and logged in, else one line saying how to fix it. Not asked: Claude
 * Code if it's ready, else Codex, without comment; neither is one calm line. The demo runs
 * nothing, so it needs no agent at all.
 */
export function chooseAgent(requested: string | undefined, statuses: ProviderStatuses, demo = false): AgentName {
  const asked = requested?.trim().toLowerCase();
  if (asked) {
    if (!(AGENT_NAMES as readonly string[]).includes(asked)) {
      throw new Error(`Unknown agent "${requested}". Use redline claude or redline codex.`);
    }
    const name = asked as AgentName;
    if (!demo && !ready(statuses[name])) throw new Error(PROVIDERS[name].unavailable(statuses[name]));
    return name;
  }
  const first = AGENT_NAMES.find((name) => ready(statuses[name]));
  if (first) return first;
  if (demo) return 'claude';
  throw new Error(NO_AGENT);
}

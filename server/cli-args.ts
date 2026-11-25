import { parseArgs } from 'node:util';
import { AGENT_NAMES, type AgentName } from '../shared/types.js';

export interface CliOptions {
  help: boolean;
  version: boolean;
  demo: boolean;
  dryRun: boolean;
  open: boolean;
  base?: string;
  /** 0: pick a port per repo. */
  port: number;
  pr?: number;
  /** Asked for by name (`redline codex`, --agent, REDLINE_AGENT); unset means auto. */
  agent?: AgentName;
  model?: string;
}

const isAgent = (word: string): word is AgentName => (AGENT_NAMES as readonly string[]).includes(word);

function whole(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${flag} expects a whole number, got "${value}"`);
  return Number(value);
}

/**
 * `redline [claude|codex] [<pr>] [flags]`, positionals in any order: `redline codex 12`,
 * `redline 12 claude`, `redline claude --base develop`. --agent and --pr are aliases of the
 * positionals; giving both with different values is an error, not a guess.
 */
export function parseCliArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      agent: { type: 'string' },
      model: { type: 'string' },
      base: { type: 'string' },
      pr: { type: 'string' },
      demo: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      port: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const numbers: string[] = [];
  const agents: AgentName[] = [];
  for (const word of positionals) {
    const lower = word.toLowerCase();
    if (/^\d+$/.test(word)) numbers.push(word);
    else if (isAgent(lower)) agents.push(lower);
    else throw new Error(`Unknown argument "${word}". Pass a PR number (redline 14), an agent (redline codex), or see --help.`);
  }
  if (numbers.length > 1) throw new Error(`Expected at most one PR number, got: ${numbers.join(' ')}`);
  if (new Set(agents).size > 1) throw new Error('Pick one agent: redline claude or redline codex, not both.');

  const positionalPr = numbers[0] !== undefined ? Number(numbers[0]) : undefined;
  const flagPr = whole('--pr', values.pr);
  if (flagPr !== undefined && positionalPr !== undefined && flagPr !== positionalPr) {
    throw new Error(`Both --pr ${values.pr} and ${numbers[0]} were given. Pass one.`);
  }
  const pr = flagPr ?? positionalPr;
  if (pr === 0) throw new Error('--pr expects a PR number, got 0');

  const flagAgent = values.agent?.trim().toLowerCase();
  if (flagAgent !== undefined && !isAgent(flagAgent)) throw new Error(`Unknown agent "${values.agent}". Use redline claude or redline codex.`);
  if (flagAgent && agents[0] && flagAgent !== agents[0]) throw new Error(`Both --agent ${flagAgent} and ${agents[0]} were given. Pass one.`);
  const envAgent = env.REDLINE_AGENT?.trim().toLowerCase();
  if (envAgent && !isAgent(envAgent)) throw new Error(`REDLINE_AGENT must be claude or codex, got "${env.REDLINE_AGENT}".`);
  const agent = agents[0] ?? flagAgent ?? (envAgent || undefined);

  const port = whole('--port', values.port) ?? 0;
  if (port > 65535) throw new Error(`--port must be at most 65535, got ${port}`);
  const model = (values.model ?? env.REDLINE_MODEL)?.trim() || undefined;

  return {
    help: values.help,
    version: values.version,
    demo: values.demo,
    dryRun: values['dry-run'],
    open: !values['no-open'],
    ...(values.base ? { base: values.base } : {}),
    port,
    ...(pr !== undefined ? { pr } : {}),
    ...(agent ? { agent: agent as AgentName } : {}),
    ...(model ? { model } : {}),
  };
}

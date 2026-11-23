import type { Activity, ServerEvent } from '../shared/types.js';

type Listener = (event: ServerEvent) => void;

const MAX_LOG_LINES = 400;

/** Reports one running activity's steps. Inert once a newer activity starts. */
export interface Tracker {
  /** A new real step; also logged. */
  step(text: string): void;
  /** A step that is also printed in the terminal (diff, comments, drafting; not every tool call). */
  phase(text: string): void;
  log(line: string): void;
  done(step: string): void;
  fail(message: string): void;
  readonly current: boolean;
}

/**
 * The one thing redline is doing right now (writing a spec, or a Claude Code run),
 * broadcast to every open page. Steps are only ever what actually happened.
 */
export class ActivityBus {
  private listeners = new Set<Listener>();
  private activity: Activity | null = null;
  private lines: string[] = [];
  private nextId = 1;

  constructor(private readonly onPhase: (text: string) => void = () => {}) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** What a page that connects now needs to catch up. */
  snapshot(): ServerEvent[] {
    if (!this.activity) return [];
    const { id } = this.activity;
    return [{ type: 'activity', activity: this.activity }, ...this.lines.map((line) => ({ type: 'log' as const, id, line }))];
  }

  viewChanged(): void {
    this.emit({ type: 'view' });
  }

  start(kind: Activity['kind'], step: string): Tracker {
    const id = this.nextId++;
    const startedAt = Date.now();
    this.activity = { id, kind, state: 'running', step, startedAt };
    this.lines = [];
    this.emit({ type: 'activity', activity: this.activity });
    this.onPhase(step);

    const isCurrent = (): boolean => this.activity?.id === id;
    const stamp = (): string => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };
    const log = (line: string): void => {
      if (!isCurrent()) return;
      const text = `${stamp()}  ${line}`;
      this.lines.push(text);
      if (this.lines.length > MAX_LOG_LINES) this.lines.shift();
      this.emit({ type: 'log', id, line: text });
    };
    const set = (patch: Partial<Activity>): void => {
      if (!isCurrent() || !this.activity) return;
      this.activity = { ...this.activity, ...patch };
      this.emit({ type: 'activity', activity: this.activity });
    };
    log(step);

    return {
      step: (text) => {
        if (!isCurrent() || this.activity?.state !== 'running') return;
        log(text);
        set({ step: text });
      },
      phase: (text) => {
        if (!isCurrent() || this.activity?.state !== 'running') return;
        log(text);
        set({ step: text });
        this.onPhase(text);
      },
      log,
      done: (text) => {
        if (!isCurrent()) return;
        log(text);
        set({ state: 'done', step: text, endedAt: Date.now() });
        this.onPhase(text);
      },
      fail: (message) => {
        if (!isCurrent()) return;
        log(message);
        set({ state: 'error', step: message, endedAt: Date.now() });
        this.onPhase(message);
      },
      get current() {
        return isCurrent();
      },
    };
  }

  private emit(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

# AGENTS.md: the redline-pr contract

This file is binding for every coding agent working in this repository (Claude Code, Codex, and others). If a request conflicts with it, stop and say which rule it breaks. Don't quietly work around it. Change this file only when a human explicitly asks you to.

## 1. What this product is for

redline-pr helps a human **understand** an AI-written pull request and **judge** it. It turns the diff into plain-English behavioral sentences, lets the human edit those sentences, and syncs the edits back to code only when asked.

- It is not a diff viewer, a code-review bot, or an "auto-fix everything" agent. Claude writes the spec and applies the human's edits. It never decides on its own what should change.
- Subtraction beats features. Reject or push back on any change that adds clicks, settings, chrome, or visual noise without making a PR easier to understand. When in doubt, leave it out and ask.
- Plain language beats cleverness, both in the spec and in every UI string. Status and error messages are one calm sentence that says what happened and what to do next. Raw tool output belongs in the log, never in the page.

## 2. Visual contract (zero AI slop)

**Aesthetic.** Plain-paper editorial minimalism, in the spirit of iA Writer, Tufte sidenotes, and Linear's quietest views.

**Palette.** Use only the tokens in `web/src/styles.css`:

| token   | value     | use                                |
| ------- | --------- | ---------------------------------- |
| `paper` | `#FCFCFB` | canvas                             |
| `ink`   | `#141413` | primary text, focus, active state  |
| `muted` | `#6B6B68` | secondary text                     |
| `rule`  | `#E6E6E3` | 1px hairlines                      |
| `edge`  | `#D4D4D0` | outline of a secondary button      |
| `faint` | `#A3A39E` | unavailable buttons, directory part of a path, fold triangles |
| `del`   | `#B91C1C` | deletions and errors only          |
| `ins`   | `#15803D` | insertions only (or `ink`)         |

Don't add colors. Tints of `ink` (such as `bg-ink/[0.04]` for hover) are the only exception.

**Typography.**
- Prose uses Inter / system-ui, with generous line height.
- Monospace is only for inline code, file anchors, diffs, branch names, and status or log lines.

**Banned.**
- Gradients, glassmorphism, and drop shadows.
- SaaS dashboard chrome: sidebars, stat cards, KPI rows, toolbars full of buttons.
- Pill badges, and colored or filled boxes around sections.
- Boxed `<select>` dropdowns. Menus are flat lists on paper with one hairline border.
- Spinners, skeleton shimmer, and fake progress percentages.
- Icons where a word is clearer, and emoji in the UI.
- Tailwind's default purple, indigo, or blue palettes.
- Modals for whole views.

**Layout and navigation.**
- **Responsive layout.** One layout in three tiers, defined once in `web/src/grid.ts` (`SHELL`, `COLUMNS`) and shared by the top bar, the spec, the margin and every row that lines up with them:
  - **`wide`, 1120px and up:** a 680px spec column, 48px gap, and 340px margin, centred.
  - **`split`, 860–1119px:** two fluid columns, `minmax(0,1fr)` prose and a `minmax(240px,300px)` margin, 32px apart, with 24px side padding. This is the split-screen case (browser beside an IDE).
  - **Below 860px:** one column of 680px text with 16–24px padding. Each comment thread renders directly under its sentence, behind a `2px` `rule` left hairline, with the same reply box and collapse. No hamburger, no drawer, no hidden comments.
  - The breakpoints are in rem (`styles.css`), like Tailwind's own. Mixing px and rem breakpoints sorts the variants wrongly.
- **Never a sideways page scroll, at any width.**
  - Grid and flex children get `min-w-0`. Code, diffs and logs scroll inside themselves (`overflow-x: auto`). Long paths, branches and URLs break (`overflow-wrap: anywhere`).
  - Fix overflow at its source; don't mask it with `overflow: hidden` or `clip` on the page.
  - The UI test sweeps 1440 → 1024 → 960 → 860 → 600 → 360 widths on one live page and asserts zero overflow.
- **Short windows.** Use `min-height: 100dvh`, never a fixed `100vh` height. Popovers are capped to the viewport (`max-h-[calc(100dvh-72px)]`) and scroll within themselves; logs and prompts cap at a share of the viewport height.
- **Sync view.** It is `max-w-[760px]` with `clamp(16px,4vw,32px)` padding. Its Run buttons and the Copy link wrap rather than squeeze.
- **Two decoupled columns.** From `split` up, the spec column and the margin sit side by side in `SpecBody.tsx`.
  - Margin notes are absolutely positioned by the collision solver in `web/src/layout.ts`: `top = max(targetTop, prevBottom + 16)`.
  - They are re-placed at most once per animation frame on any resize of the prose, the margin, a note, or the window, so dragging a window edge never makes them drift or jitter.
  - A note, a thread, or an expanded reply must never change the height of the prose or open a gap between sentences. `test/layout.test.ts` and the UI tests guard this. Keep them passing.
- **Paths.** Every file path (anchors, peeks, margin, Sync) renders through `PathLabel`: the directory in `faint`, the file name and lines in the surrounding color. The full path is always shown, never shortened.
- **Files list.** "N files" in the top bar opens a flat popover: the diff's files indented by directory (single-child directories folded into one line), with `+N`/`-N` counts. Picking a file scrolls to the first sentence about it, unfolding its section if needed. Files no sentence points at are muted and not clickable.
- **Folding.** A section heading is a button (`aria-expanded`) that folds its sentences into a one-line summary ("5 sentences · 1 edit · 2 comments"). Folded content stays mounted with `hidden`, so edits and replies survive and still reach Sync; its margin notes leave the solver. Fold state is per spec and resets when the spec changes.
- **Spacing.** 20px between sentences and 36px between sections.
- **Run buttons.** The Sync view always shows **Run with Claude** and **Run with Codex** side by side, as plain words with no logos or icons.
  - The launch agent's button comes first and is solid ink (`bg-ink`, paper text, 3px radius, no shadow).
  - The other agent's button is an outline (`border-edge`) that darkens to ink on hover.
  - An agent that isn't installed or logged in gets a visibly disabled button (`text-faint`, `border-rule`, `cursor-not-allowed`, `disabled`). Its reason goes in a native `title` ("Codex CLI not logged in"), never in a banner.
  - **Copy spec diff** is a quiet text link.
- **One run at a time.** Clicking either Run disables both at once (a ref lock, before React re-renders) and labels the clicked one "Running Codex…".
  - The server enforces the same rule. `POST /api/sync` refuses an overlapping request, whichever agent it names, with 409 `Sync already in progress`.
  - The lock is taken synchronously and released in `finally`. Never weaken either side.
- **Views are pages, not modals.** A dedicated view such as Sync gets its own history entry (`pushState`/`popstate`, `#sync`). Browser Back, Esc, and a quiet "← Back" link all return to the spec, with edits, scroll position, and focus intact.
- **Progress is honest.**
  - Show the 2px hairline, plus a status line fed by the agent's real event stream (`claude -p` stream-json or `codex exec --json`) and the server's real phases.
  - Never estimate, never animate fake steps.
  - Respect `prefers-reduced-motion`.

## 3. Architectural invariants (non-negotiable)

1. **Zero-trace isolation.** redline-pr never creates, modifies, or leaves behind a file, folder, log, cache, lock, or config in the target repository's working tree or `.git` directory.
   - **Where state lives.** All state goes under `<cache root>/<sha256 of repo path>/`. The cache root is `$XDG_CACHE_HOME/redline-pr` when that's set, else `%LOCALAPPDATA%\redline-pr` on Windows, else `~/.cache/redline-pr` (`cacheRoot()` in `server/platform.ts`). Temp dirs come from `os.tmpdir()` and are removed on exit. Drafts live in the browser's `localStorage`.
   - **Git calls.**
     - Read-only plumbing (`diff-index`, `rev-parse`, `merge-base`, `cat-file`, `ls-files`) with `GIT_OPTIONAL_LOCKS=0`.
     - Never porcelain `git diff` or `git status`: they rewrite `.git/index`.
     - Never `git fetch`, `checkout`, `stash`, or anything else that writes.
   - **The spec writer.** It runs from an empty scratch cwd and reaches the repo only by path, never with the repo as its cwd: Claude Code's startup touches `.git` there, and Codex would load the repo's `AGENTS.md` and `.codex/` as instructions.
     - Claude: an `os.tmpdir()` scratch dir and `--add-dir`.
     - Codex: everything it needs on disk lives under the cache. That is the strict schema in `<cache root>/schemas/spec-schema.json`, plus a per-run scratch dir and `--output-last-message` file under the repo's cache directory, all removed after the run.
2. **Read-only until Sync.**
   - Launching, loading, switching PRs, refreshing, and reviewing never change the repo and never post to GitHub.
   - Only an explicit **Run** in the Sync view may edit files (through Claude Code or Codex). Only an explicit **Post replies** may write to GitHub, and only the replies the human wrote, once each.
3. **Subscription-first.**
   - All model calls go through a local agent CLI and the user's existing login: `claude -p` (Claude Code) or `codex exec` (Codex, ChatGPT login).
   - Never use `--bare`, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Never call a model API directly, and never add an API-key path or an `anthropic`/`openai` SDK dependency.
   - Agents live behind `AgentProvider` in `server/providers/`. A provider only spawns its CLI and parses its stream. Spec validation, caching, and measuring what changed in the repo stay shared, so every agent is held to the same rules. A new agent gets a provider, not special cases elsewhere.
   - **Claude spec writer:** `--tools Read,Grep,Glob`, `--setting-sources ""`, hooks disabled, `--strict-mcp-config`, no session persistence.
   - **Codex spec writer:** `--sandbox read-only`, `--ignore-user-config`, `--ignore-rules`, `--ephemeral`.
   - Don't widen either one.
   - **Sync** runs in the repo like the user typing the CLI themselves: Claude with `--permission-mode acceptEdits`, Codex with `--sandbox workspace-write`, each overridable only through `REDLINE_CLAUDE_FLAGS` or `REDLINE_CODEX_FLAGS`.
   - `--model` applies only to the agent picked at launch.
   - **Picking the agent.** `redline claude` / `redline codex` (or `--agent`, or `REDLINE_AGENT`) asks for one by name, in any order with a PR number. Plain `redline` takes Claude Code if it's installed and logged in, else Codex, silently.
   - "Ready" means the binary is on PATH and its own login check passes: `claude auth status` (exit 0, and not `authMethod: "none"`), or `codex login status` (exit 0).
   - Login checks run in parallel from the OS temp dir, with a 5s timeout. Their output names the account, so expose only `installed`/`loggedIn` booleans, never the output.
   - An agent asked for by name that isn't ready is one actionable line ("Codex CLI is not logged in. Run "codex login" and try again."). Never use an interactive picker.
4. **Works on any git repository.**
   - GitHub is optional. A repo with no remote, a remote on GitLab, Bitbucket or a private server, or a machine with no `gh` (or a logged-out one) must boot, load the local branch diff, and say in one muted sentence why there are no PRs.
   - No crash, no red banner, no raw `gh` stderr in the page. See `githubAccess` and `NotOnGitHubError` in `server/github.ts`.
   - The base branch is resolved in this order: `--base`, then the PR's base, then `origin/HEAD`, then `main`, then `master`, then `develop`. If none exists, show a calm empty state that suggests `--base`.
5. **Comment handling is deterministic.**
   - Resolved and outdated review threads are filtered by GitHub's own flags (GraphQL `reviewThreads`), never by a model. They appear in neither the margin nor the prompt.
   - Each open thread is one margin item.
6. **Local and safe by default.**
   - The server binds to `127.0.0.1` only. Every API call needs the per-launch page token, and Host and Origin are checked.
   - Review comments are untrusted text. The margin renders their Markdown through `web/src/markdown.ts` into React elements, never as HTML (no `dangerouslySetInnerHTML`), and links only `http(s)` URLs, opened with `rel="noopener noreferrer"`.
   - Child processes are spawned without a shell, in their own process group (a `taskkill` tree on Windows), and are killed with redline.
7. **macOS, Linux and Windows.** Anything platform-specific lives in `server/platform.ts`, as a pure function of the platform, with a test for each branch.
   - **Finding a CLI.** Search PATH directly (with PATHEXT on Windows) instead of spawning `which` or `where`.
   - **Spawning.** Spawn through `run()` in `server/exec.ts`, never with `shell: true`. On Windows it runs npm `.cmd` shims as node plus their script, so stdin and multi-line arguments survive; any other `.cmd` goes through cmd.exe with every argument quoted. Process trees are killed with `taskkill /T` there.
   - **Paths and text.** Use `path.join`/`path.resolve`, never `/dev/null`, and normalize CRLF before parsing diffs. Keep package scripts free of shell-only commands (see `scripts/postbuild.mjs`).
   - **The browser.** Opened with `open`, `cmd /c start ""` or `xdg-open`. On Linux with no `DISPLAY`/`WAYLAND_DISPLAY` (SSH, headless), print the URL instead.
8. **Nothing personal in the repo.** No real names, emails, home paths, tokens, or private repo names in code, fixtures, docs, or commits. The demo uses made-up people.

## 4. How to work here

- **Stack.** TypeScript throughout: Hono server (`server/`), React + Vite + Tailwind v4 UI (`web/`), shared types (`shared/types.ts`), and the CLI entry (`bin/cli.ts`).
- **Before you say you're done:**
  ```sh
  npm run typecheck
  npm test        # builds first, then runs the unit, CLI and headless-browser tests
  ```
  Every behavior change comes with a test. The CLI tests snapshot the target repo before and after, and assert it is byte-identical. Any new code path that touches the repo needs the same assertion.
- **Tests never use the network, a real `claude` or `codex` login, or a real GitHub repo.**
  - Use the fakes in `test/helpers.ts` (`fakeClaude`, `fakeCodex`, plus `isolatedPath` so a real CLI on the machine can't leak in) and `test/cli-harness.ts` (`fakeGh`, `fakeGhWithPr`).
- **Real runs.** Never run a real Sync or post replies against a user's repository unless they ask you to in that conversation. Use a scratch clone.
- **Match the code around you.** Short doc comments that say *why*, no new dependencies without a reason, and no speculative options or flags.
- **Keep the README in step** when user-visible behavior changes.

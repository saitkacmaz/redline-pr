# redline-pr

<table><tr><td>

## The one-minute read, written for people

**Start from a clean worktree: commit or stash everything first.** redline reads your working tree, so uncommitted changes show up in the spec as if they were part of the PR, and after a Sync your edits and the agent's are mixed together in `git diff`.

`redline-pr` turns a pull request's diff into a one-page, plain-English description of what the code does, with the PR's open review comments in the margin. Edit a sentence, and Claude Code or Codex changes the code to match.

### Why

A coding agent writes an 800-line PR in minutes. Reviewing it means either reverse-engineering the diff and prompting a fix for every comment by hand, or letting the agent act on every comment at once with none of your judgment. `redline-pr` keeps the judgment with you and the typing with the agent.

### How you use it

1. Run `redline` in your repo, on your branch. `redline claude` or `redline codex` picks the agent; `redline --demo` needs no repo.
2. Read the spec. Each sentence is a checkable statement (*"If the S3 read raises, the handler logs and still returns 200 OK"*), linked to its lines; click to open the hunk inline.
3. Answer the margin comments: rewrite a sentence to dictate a fix, or reply in the margin to push back without touching the code.
4. Press **Sync**. Only the sentences you changed go to the agent. Check the diff it made, then click **Re-analyze diff** and repeat. The agent's session isn't lost: the page gives you the command to reopen it in your terminal (`claude --resume <id>` or `codex resume <id>`) to ask why it did something or keep going by hand.

### Before you adopt it

- **No API keys.** Uses your logged-in `claude` or `codex` CLI and the Claude or ChatGPT plan you already have.
- **Zero trace.** Caches live in `~/.cache/redline-pr/` (`%LOCALAPPDATA%` on Windows), never in your repo.
- **Read-only until Sync.** Nothing in the repo changes, and nothing posts to GitHub, until you ask. `redline` never commits or pushes.
- **Any Git repo.** PRs and review comments come through `gh` on GitHub; on GitLab, Bitbucket, or a repo with no remote, you review the local branch diff.
- **No stale comments.** Resolved and outdated threads are filtered out deterministically using GitHub's own flags, not a model.
- **Cross-platform.** Fits a split-screen window and runs on macOS, Linux, and Windows. Linux and Windows are covered by unit tests; day-to-day use so far is on macOS.

</td></tr></table>

## Reference

Everything below is the detail: install, commands, flags, how it works, and the guarantees it keeps. Coding agents working on redline should read [`AGENTS.md`](AGENTS.md) too.

### Install

```
npm install -g redline-pr
redline --demo           # try it without a repo
cd ~/work/some-repo
redline
```

`-g` installs the `redline` command globally, on your `PATH`. Without it, npm would add `node_modules/` to whatever folder you're in. To try it without installing: `npx redline-pr --demo`.

To update: `npm install -g redline-pr@latest`.

Releases are published from this repo's GitHub Actions with npm provenance, so npm can show which commit each version was built from.

<details>
<summary>From source</summary>

```
git clone https://github.com/saitkacmaz/redline-pr.git && cd redline-pr
npm install
npm run install-global   # builds dist/ and links the global `redline` command
```

To update a source install, run `git pull && npm install && npm run build` in that folder.

</details>

The command is also installed as `redline-pr`, if `redline` clashes with something on your machine.

The demo loads a pre-baked PR: an S3 CSV ingestion endpoint with a silent `200 OK` on failure, a Postgres check-then-act race in job claiming, and three teammate comments. It needs no repo, no `gh`, and no agent login.

### Usage

```
redline            # the current branch's PR, or its local diff if it has none
redline 14         # PR #14 (same as --pr 14)
redline codex      # write the spec with Codex instead of Claude Code
redline claude     # ask for Claude Code by name
redline codex 14   # PR #14 with Codex (any order: redline 14 codex)
redline claude --base develop
redline codex --model <model>   # any model your Codex plan offers
redline [claude|codex] [<pr>] [--model <name>] [--base main] [--demo] [--dry-run] [--port <n>] [--no-open]
```

**Which agent.** Plain `redline` uses Claude Code if it's installed and logged in, otherwise Codex, without asking. `redline claude` or `redline codex` asks for one by name. If that one isn't installed or logged in, redline says so in one line ("Codex CLI is not logged in. Run "codex login" and try again.") and exits. `--agent <name>` and `REDLINE_AGENT` do the same as the positional. "Logged in" is what the CLI itself reports: `claude auth status` or `codex login status`. Only yes/no is kept; the account details those commands print are never shown or stored. Logins are checked again on every Refresh.

The agent picked at launch writes the spec. On the Sync page, **Run with Claude** and **Run with Codex** sit side by side: the launch agent's button is solid, the other an outline, and one whose CLI isn't installed or logged in is disabled, with the reason in its tooltip. Clicking either disables both until the run ends. The server also refuses a second run while one is going (409 `Sync already in progress`), so two tabs, or both buttons, can never edit the repo at once.

The page opens right away and loads in place. While a spec is being written or the agent is running, a 2px line under the top bar glides, and a status line shows the real current step (`Reading src/ingest.py · 11s`, `Editing db.py · 18s`). **Show log** opens the raw stream. Nothing is estimated; there are no percentages.

- **Switch PRs** by clicking the PR title. It lists the repo's open PRs (`gh pr list`) and **Local branch diff**. A PR that isn't checked out loads from `gh pr diff`, read-only, so you can read it and reply, but Run is off until you `gh pr checkout` it and Refresh. redline never fetches or checks out for you.
- **Refresh** re-reads the current diff and comments without restarting. Unsaved redlines are kept.
- **Fold a section** by clicking its heading once you've read it. A folded heading keeps a count (`5 sentences · 1 edit · 2 comments`). Folding only changes the view: the section's edits and replies still go to Sync, and a new spec opens with every section unfolded.
- **N files** in the top bar lists the diff's files by directory, with their added and removed lines. Click one to jump to the first sentence about it. Every anchor shows its full path, the directory in lighter ink (`services/ingest/handler.py:20–24`).
- **Re-analyze diff** appears when a run finishes ("Synced — 2 files modified in 18s", with the files and the diff). It writes a fresh spec of the changed code and clears the redlines that were just applied, so you can check the agent's work and keep going.
- With no PR and no local changes, the page says so and opens the PR list instead of exiting. Without GitHub (no remote, a non-GitHub host, or no `gh`), it simply reviews the local diff.
- **Sync** is a page of its own (`#sync`). The browser's Back button, Esc, or **← Back to spec** returns to the spec where you left it, edits and scroll position intact.
- **The margin** holds only open review threads, one item per thread: the opening comment and the latest reply, with a toggle to read the whole thread in place. A thread you answered last is marked *replied* (it's waiting on the reviewer). Resolved and outdated threads are left out of the margin and out of the agent's prompt; a single muted line at the bottom (`2 resolved/outdated hidden`) shows them if you want to look. Notes sit level with their sentence and cascade below each other when they run long; they never push the sentences apart. Hovering a note marks its sentence, and the other way round. The layout follows the window: beside an editor in a split screen the two columns narrow together, and below 860px each thread sits directly under its sentence. The page never scrolls sideways.

| Flag | Meaning |
| --- | --- |
| `claude`, `codex`, or `--agent <name>` | Agent CLI that writes the spec, and the primary Run button. Default: Claude Code if installed and logged in, else Codex. Also `REDLINE_AGENT`. |
| `--model <name>` | Model for that agent: `claude --model` or `codex --model`. Default: the CLI's own. Also `REDLINE_MODEL`. It applies only to the launch agent, so a Claude model name never reaches a Codex run. |
| `--base <branch>` | Branch to diff against. Default: the PR's base, then the repo's default branch (`origin/HEAD`, then `main`, `master`, `develop`), never the branch you're on. |
| `--pr <number>`, or a bare number | PR to load. Default: the PR for the current branch (via `gh pr view`), else the local diff. |
| `--demo` | Load the built-in demo PR. Sync writes `sync-plan.md` to the cache directory instead of running anything. |
| `--dry-run` | Nothing runs and nothing is posted: **Run** writes the exact prompt it would send to `sync-plan.md` in the cache directory instead. Use it to see what the agent would be asked before trusting it with a real repo. |
| `--port <n>` | Port to listen on. Default: a fixed port derived from the repo path (4400-4999, or any free port if that one is taken), so the page keeps the same origin and your drafts survive a restart. The server binds to `127.0.0.1` only. |
| `--no-open` | Don't open the browser. |
| `-v`, `--version` | Print the version. |

#### Requirements

- Node 20+ and `git`.
- At least one agent CLI on `PATH`, logged in:
  - [Claude Code](https://claude.com/claude-code) (`claude`), with your Claude login. No `ANTHROPIC_API_KEY`.
  - [Codex CLI](https://developers.openai.com/codex/cli) (`codex`), after `codex login` with your ChatGPT account. No `OPENAI_API_KEY`.
- Optional: [`gh`](https://cli.github.com), authenticated, to list PRs, load review comments, and post replies. Without it, or in a repo with no remote or one hosted outside GitHub (GitLab, Bitbucket, your own server), redline reviews the local branch diff as usual. The PR list then says in one line why it's empty, and `gh` isn't run at all when there's no remote.

#### Environment

| Variable | Default | |
| --- | --- | --- |
| `REDLINE_AGENT` | Claude Code if logged in, else Codex | Same as `redline claude` / `redline codex`. |
| `REDLINE_MODEL` | the agent CLI's default | Same as `--model`, e.g. `opus` for Claude Code, or any model your Codex plan offers. |
| `REDLINE_CLAUDE_FLAGS` | `--permission-mode acceptEdits` | Flags passed to `claude -p` on Sync, split like a shell would. The default lets Claude edit files but not run commands, so it can't run your tests. To allow that: `REDLINE_CLAUDE_FLAGS='--permission-mode acceptEdits --allowedTools "Bash(npm test)"' redline`. Set to an empty string to use your Claude Code defaults. |
| `REDLINE_CODEX_FLAGS` | `--sandbox workspace-write` | Flags passed to `codex exec` on Sync, split like a shell would. The default lets Codex edit files and run commands inside the repo, without network access by default. Set to an empty string to use your Codex config's sandbox. |
| `XDG_CACHE_HOME` | `~/.cache` (`%LOCALAPPDATA%` on Windows) | Root for all runtime artifacts (see below). Must be outside the repo. |

### How it works

**The diff.** `git diff-index -p <merge-base>` against the base branch, covering committed, staged, and unstaged changes to tracked files. Untracked files aren't included, so `git add` new files first. Lockfiles, source maps, minified files, snapshots (`*.snap`, `__snapshots__/`), generated protobuf and Dart code, `__generated__/` directories, and anything your `.gitattributes` marks `linguist-generated` or `linguist-vendored` are excluded. Diffs too large to read in one pass (about 150k tokens) fail fast and list the largest files.

**The spec.** The diff, with explicit new-side line numbers, and every review comment are piped over stdin to the agent, which can read the repository but not change it. The agent decides what context beyond the diff is worth reading: the code the diff calls, its callers and tests, and whatever docs or contributor and agent instructions the project keeps. Its steps stream to the page.

The result is held to a JSON schema: sections, clauses, line anchors, an optional `riskFlag`, and a mapping from each comment to a clause. The system prompt in [`server/prompts.ts`](server/prompts.ts) requires falsifiable statements, and requires the model to surface error handling, swallowed exceptions, edge cases, concurrency, and anything that fails silently. The server attaches the real diff hunks to each anchor. Results are cached by agent, model, diff, comments, and prompt in the out-of-repo cache directory, so restarting costs nothing. Exploring the repo makes a first read take longer (minutes on a large PR) and uses more of your plan than reading the diff alone.

Both agents start in an empty scratch directory rather than the repo, and none of your agent configuration is loaded for the spec:

- **Claude Code:** `claude -p --output-format stream-json --verbose --json-schema <schema>`, with the repo added through `--add-dir`. Starting in the repo would be a problem because Claude Code runs `git status` there on startup, which can write `.git/index`.
  - Tools are `Read`, `Grep` and `Glob` only: no shell (even `git status` rewrites `.git/index`) and nothing that writes.
  - None of the repo's Claude Code configuration is loaded (`--setting-sources ""`, hooks disabled, no MCP servers, no skills), because hooks can run commands. Session persistence is off.
  - The spec prompt replaces the default system prompt. The answer is read from the final event's `structured_output`.
- **Codex:** `codex exec --json --sandbox read-only --output-schema <schema> --output-last-message <file> --ephemeral --ignore-user-config --ignore-rules`. Starting in the repo would load its `AGENTS.md` and `.codex/` config as instructions.
  - The schema is a strict version of the same one (every object closed, every field required), written to `schemas/spec-schema.json` under the cache root.
  - The scratch directory and the answer file live under the repo's cache directory and are deleted after the run.
  - Your own Codex config, rules and hooks are skipped, and the session isn't saved. Only Codex's last message is taken as the answer, so a progress note can't be mistaken for the spec.

**Sync.** Only sentences whose text changed go into the `spec.diff`:

```diff
@@ s3-c3 · Failure Reporting · services/ingest/handler.py:52-52 @@
- The handler always returns HTTP 200 OK, even when every record failed; failed records are simply absent from `ingested`.
+ The handler returns 502 when no record was ingested and 207 with a `failed` list when only some records failed.
```

The execution prompt gives the agent each change as CURRENT vs REQUIRED behavior, the anchors, and the reviewer comments on that sentence. It tells the agent to make the smallest change that makes each sentence true and to leave everything else alone. Comments you pushed back on are listed explicitly as "do not act on". Nothing is committed.

- **How it runs.** Claude Code runs as `claude -p --output-format stream-json --verbose` and Codex as `codex exec --json --sandbox workspace-write`, both in the repo root. Each read, edit, or command shows up as it happens.
- **What you see after.** The Sync page shows the files the agent changed and their diff (also saved as `last-run.md` in the cache directory). redline measures the changes itself, the same way for both agents, rather than trusting the agent's report. The diff is relative to each file's contents just before the run, so edits you had already made aren't shown as the agent's.
- **Resuming.** The page also shows the command that continues that exact session in your terminal, to ask why it did something or to keep going by hand: `cd <repo> && claude --resume <session id>` or `cd <repo> && codex resume <session id>`.
- **After a run.** After a successful run the spec no longer matches the code, so another run against it is refused until you **Re-analyze diff**. Loading is refused while an agent is editing.

**Comments.** Review threads come from GitHub's GraphQL API (`reviewThreads`), which knows which threads are resolved or outdated; that filtering is deterministic, with no model involved. Open threads keep their replies (the opening comment plus up to the latest 20). Review summaries and conversation comments come from the REST API. If GraphQL isn't available, redline falls back to REST and says in the log that resolved threads are included.

**Replies.** Only what you write is ever posted. `redline-pr` never drafts a reply for you, because a generated "fixed it" could claim a change the agent skipped. Replies you write in the margin are listed on the Sync page, where you can still edit them, and are posted only when you click **Post replies to GitHub**. That is separate from running the agent, so you can answer a reviewer without changing code, or post after you have seen what the run did. An identical reply is never posted twice (posted replies are recorded in the cache directory). Inline review comments get threaded replies. Review summaries and conversation comments get a quoted PR comment.

**Export.** **Copy spec diff** copies a Markdown plan to the clipboard and writes it to `redline-sync.md` in the cache directory. The plan includes the spec.diff, target files, your replies, and the full prompt.

Your edits are saved in the browser's `localStorage` per branch. Because each repo gets the same port every launch, they survive reloads and restarts, until the spec itself changes.

### Zero-trace isolation

`redline-pr` is built to run inside sensitive work repositories. It never creates, modifies, or leaves behind anything in the repository's working tree or its `.git` directory.

- **Artifacts live outside the repo.** Spec caches, sync plans, and exports go to `<cache root>/<sha256 of the repo's real path>/`. The cache root is `$XDG_CACHE_HOME/redline-pr` when that's set, `%LOCALAPPDATA%\redline-pr` on Windows, and otherwise `~/.cache/redline-pr`. The directory is created only when something is written to it, with `0700` permissions and `0600` files. The CLI prints its location at startup. Delete it whenever you like. If `XDG_CACHE_HOME` resolves to a path inside the repo, `redline-pr` refuses to start.
- **Git, gh, and the spec writer are read-only.** Diff and `gh` output are read into memory and never written to disk. The diff comes from plumbing `git diff-index`, not porcelain `git diff`: porcelain refreshes stale stat data and writes `.git/index` back (even with `GIT_OPTIONAL_LOCKS=0`, e.g. after an editor re-saves an unchanged file). While writing the spec, the agent can only read: Claude Code gets read-only file tools, and Codex a read-only sandbox, and neither loads the repo's or your own agent hooks or settings. The test suite checks every byte of a repo, `.git` included, before and after a run.
- **No temp files in the repo.** Prompts are piped to the agent over stdin. There are only a few scratch files, and all are deleted when done:
  - Claude's empty working folder for the spec writer, and the before-copies of changed files used to show a run's diff, go in the OS temp directory.
  - Codex's schema, working folder and answer file go under the cache root.
- **Edits stay in the browser.** Your in-progress sentence edits and replies are kept in `localStorage`.

The one exception is what you ask for: **Run** lets the agent edit source files in the repo to apply your spec changes. Those edits are the point of the tool, and they show up in `git status` for you to review.

### macOS, Linux and Windows

Everything platform-specific lives in [`server/platform.ts`](server/platform.ts). redline is used daily on macOS; the Linux and Windows code paths are covered by unit tests that run each branch on any machine.

- **Finding the CLIs.** `claude`, `codex`, `git` and `gh` are found on `PATH` directly (with `PATHEXT` on Windows), without spawning `which` or `where`.
- **Windows shims.** On Windows, npm's `.cmd` shims for `claude` and `codex` run as node plus the script they wrap. Prompts still go over stdin, and arguments with newlines or quotes arrive intact. Process trees are stopped with `taskkill /T`.
- **The browser.** It opens with `open`, `start` or `xdg-open`. Over SSH or on a Linux box with no display, redline just prints the URL.
- **Line endings.** Diffs with Windows line endings parse the same as Unix ones.

### Security

The local server binds to `127.0.0.1` and requires a per-launch token, which is injected into the page, on every `/api` call. Other sites open in your browser can't trigger a sync. Requests whose `Host` isn't `127.0.0.1` or `localhost` are refused, which blocks DNS-rebinding pages from reading the token. The server builds every prompt from its own copy of the spec and takes only your sentence edits, comment statuses, and replies from the browser. An agent run that hits the 30-minute limit is stopped with its whole process group and reported as a failure. Ctrl-C or closing the terminal stops any running `claude` or `codex` too.

What **Run** may do depends on the agent:

- **Claude Code** runs `claude -p --permission-mode acceptEdits` in your repo root. That lets it edit any file in the repo without asking, but not run commands.
- **Codex** runs `codex exec --sandbox workspace-write`. That lets it edit files and run commands inside the repo (your tests, for example), but by default not write outside the repo or use the network.

Either way, the agent is told to change only what your edited sentences require, but nothing enforces that. Like typing `claude` or `codex` there yourself, a run loads your own and the repo's agent settings, hooks, and MCP servers; only the spec writer runs without them. Use `--dry-run`, or set `REDLINE_CLAUDE_FLAGS` or `REDLINE_CODEX_FLAGS`, if you want something stricter.

Your code goes to the agent's provider through your login, as with any use of that CLI: the diff, the files the agent chooses to read, and the review comments. That means Anthropic for Claude Code and OpenAI for Codex. Review comments can be written by anyone who can comment on the PR, so the execution prompt fences them as quoted data and tells the agent never to act on instructions inside them.

### Development

```
npm install
npm run build          # vite build (web) + tsc (cli/server) → dist/
npm run typecheck      # tsc --noEmit over everything
npm test               # builds, then unit + integration + browser tests
npx tsx bin/cli.ts --demo
```

Running from source (`npx tsx bin/cli.ts`) still serves the page from the built `dist/web`, so run `npm run build` after changing anything under `web/`, and restart redline after changing the server. Otherwise the page and the server can be different versions.

`npm test` never calls the real `claude`, `codex`, or GitHub: integration tests put fake `claude`, `codex`, and `gh` binaries on `PATH` and run the built CLI against throwaway repos, checking every byte of each repo (`.git` included) before and after. Browser tests drive headless Chrome and are skipped if Chrome or Chromium isn't installed (set `CHROME_PATH` to point at one).

Working on redline with a coding agent? [`AGENTS.md`](AGENTS.md) is the contract it must follow (design rules and the invariants above). `CLAUDE.md` points Claude Code at it.

**Releasing.** Bump the version and push the tag: `npm version patch && git push --follow-tags`. The `v*` tag triggers [`.github/workflows/publish.yml`](.github/workflows/publish.yml), which typechecks, tests, and publishes to npm through trusted publishing (no npm token exists). A tag that doesn't match `package.json` fails the run.

For hot reload on the UI, run the server with a fixed token and point Vite at it:

```
REDLINE_DEV_TOKEN=dev npx tsx bin/cli.ts --demo --port 4317 --no-open
VITE_REDLINE_TOKEN=dev npm run dev:web
```

```
bin/cli.ts         entrypoint: args, server boot, first load
server/
  app.ts           Hono routes: /api/spec, /api/prs, /api/load, /api/plan, /api/sync, /api/replies, /api/events (SSE), static UI
  workspace.ts     what's loaded: resolves PR/local targets, loads in place, guards runs
  activity.ts      the one running activity and its log, broadcast to every open page
  providers/       one AgentProvider per CLI: claude.ts (claude -p), codex.ts (codex exec),
                   their stream parsers (events → plain steps like "Editing db.py"), detection
  prompts.ts       spec system prompt + surgical execution prompt
  spec.ts          the spec call (any agent), schema validation, anchor/comment assembly, cache
  sync.ts          spec.diff, edit merging, export, agent runs and what they changed, reply posting
  git.ts diff.ts   diff collection and unified-diff parsing
  platform.ts      macOS / Linux / Windows differences: cache root, PATH lookup, .cmd shims, browser
  cli-args.ts      redline [claude|codex] [<pr>] [flags], in any order
  github.ts        PRs, review threads (GraphQL, resolved/outdated triage), comments, reply posting
  demo.ts          pre-baked demo PR
shared/types.ts    the data contract between server and web
web/src/           React + Tailwind UI (layout.ts: margin-note placement)
```

### License

MIT

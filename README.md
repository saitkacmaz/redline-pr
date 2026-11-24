# redline-pr

Read your PR as a one-page, plain-English **Behavioral Spec**.

Edit the sentences to say what the code *should* do. Hit **Sync** and Claude Code makes exactly those changes.

**No API key needed.** `redline-pr` uses your local [`claude`](https://claude.com/claude-code) CLI and the Claude login you already have, both to write the spec and to apply your edits.

`redline-pr` is for engineers who ship code written with AI coding agents. Instead of reading a raw diff and hand-prompting the agent once per review comment, you:

1. **Read.** The diff against your base branch becomes a list of concrete, falsifiable statements ("If the S3 read raises, the handler logs and still returns 200 OK"). Every sentence links to the exact lines it describes.
2. **Review.** Open GitHub review threads sit in the right margin, next to the sentence they're about. Resolved and outdated threads are set aside.
3. **Redline.** Click a sentence and rewrite it. Or reply in the margin and push back.
4. **Sync.** `redline-pr` computes a surgical `spec.diff` (only the sentences you changed, plus their code anchors), pipes a strict prompt to `claude -p`, and shows you exactly what Claude changed. Your margin replies post to GitHub only when you click **Post replies**.

### Install

`redline-pr` isn't on npm yet. Install it from source once, then use the `redline` command in any repo:

```
git clone https://github.com/saitkacmaz/redline-pr.git && cd redline-pr
npm install
npm run install-global   # builds dist/ and links the global `redline` command
redline --demo           # try it without a repo
cd ~/work/some-repo
redline
```

The command is also installed as `redline-pr`, if `redline` clashes with something on your machine.

The demo loads a pre-baked PR: an S3 CSV ingestion endpoint with a silent `200 OK` on failure, a Postgres check-then-act race in job claiming, and three teammate comments. It needs no repo, no `gh`, and no Claude login.

## Usage

```
redline            # the current branch's PR, or its local diff if it has none
redline 14         # PR #14 (same as --pr 14)
redline [<pr>] [--base main] [--pr <number>] [--demo] [--dry-run] [--port <n>] [--no-open]
```

The page opens right away and loads in place. While a spec is being written or Claude Code is running, a 2px line under the top bar glides, and a status line shows the real current step (`Reading src/ingest.py · 11s`, `Editing db.py · 18s`). **Show log** opens the raw stream. Nothing is estimated; there are no percentages.

- **Switch PRs** by clicking the PR title. It lists the repo's open PRs (`gh pr list`) and **Local branch diff**. A PR that isn't checked out loads from `gh pr diff`, read-only, so you can read it and reply, but Run is off until you `gh pr checkout` it and Refresh. redline never fetches or checks out for you.
- **Refresh** re-reads the current diff and comments without restarting. Unsaved redlines are kept.
- **Re-analyze diff** appears when a run finishes ("Synced — 2 files modified in 18s", with the files and the diff). It writes a fresh spec of the changed code and clears the redlines that were just applied, so you can check Claude's work and keep going.
- With no PR and no local changes, the page says so and opens the PR list instead of exiting.
- **Sync** is a page of its own (`#sync`). The browser's Back button, Esc, or **← Back to spec** returns to the spec where you left it, edits and scroll position intact.
- **The margin** holds only open review threads, one item per thread: the opening comment and the latest reply, with a toggle to read the whole thread in place. A thread you answered last is marked *replied* (it's waiting on the reviewer). Resolved and outdated threads are left out of the margin and out of Claude's prompt; a single muted line at the bottom (`2 resolved/outdated hidden`) shows them if you want to look. Notes sit level with their sentence and cascade below each other when they run long; they never push the sentences apart. Hovering a note marks its sentence, and the other way round.

| Flag | Meaning |
| --- | --- |
| `--base <branch>` | Branch to diff against. Default: the PR's base, then the repo's default branch (`origin/HEAD`, then `main`, `master`, `develop`), never the branch you're on. |
| `--pr <number>`, or a bare number | PR to load. Default: the PR for the current branch (via `gh pr view`), else the local diff. |
| `--demo` | Load the built-in demo PR. Sync writes `sync-plan.md` to the cache directory instead of running anything. |
| `--dry-run` | Nothing runs and nothing is posted: **Run with Claude Code** writes the exact prompt it would send to `sync-plan.md` in the cache directory instead. Use it to see what Claude would be asked before trusting it with a real repo. |
| `--port <n>` | Port to listen on. Default: a fixed port derived from the repo path (4400-4999, or any free port if that one is taken), so the page keeps the same origin and your drafts survive a restart. The server binds to `127.0.0.1` only. |
| `--no-open` | Don't open the browser. |

### Requirements

- Node 20+ and `git`.
- [Claude Code](https://claude.com/claude-code): `claude` on `PATH`, logged in. It writes the spec and applies your edits on **Run with Claude Code**. No `ANTHROPIC_API_KEY` is needed.
- Optional: [`gh`](https://cli.github.com), authenticated, to list PRs, load review comments, and post replies. Without it, or in a repo with no remote or one hosted outside GitHub (GitLab, Bitbucket, your own server), redline reviews the local branch diff as usual. The PR list then says in one line why it's empty, and `gh` isn't run at all when there's no remote.

### Environment

| Variable | Default | |
| --- | --- | --- |
| `REDLINE_MODEL` | your `claude` default | Passed to `claude --model` when writing the spec, e.g. `sonnet` or `opus`. |
| `REDLINE_CLAUDE_FLAGS` | `--permission-mode acceptEdits` | Flags passed to `claude -p` on Sync, split like a shell would. The default lets Claude edit files but not run commands, so it can't run your tests. To allow that: `REDLINE_CLAUDE_FLAGS='--permission-mode acceptEdits --allowedTools "Bash(npm test)"' redline`. Set to an empty string to use your Claude Code defaults. |
| `XDG_CACHE_HOME` | `~/.cache` | Root for all runtime artifacts (see below). Must be outside the repo. |

## How it works

**The diff.** `git diff-index -p <merge-base>` against the base branch, covering committed, staged, and unstaged changes to tracked files. Untracked files aren't included, so `git add` new files first. Lockfiles, source maps, minified files, snapshots (`*.snap`, `__snapshots__/`), generated protobuf and Dart code, `__generated__/` directories, and anything your `.gitattributes` marks `linguist-generated` or `linguist-vendored` are excluded. Diffs too large to read in one pass (about 150k tokens) fail fast and list the largest files.

**The spec.** The diff, with explicit new-side line numbers, and every review comment are piped over stdin to `claude -p --output-format stream-json --verbose --json-schema <schema>`, with read-only access to the repository (`--add-dir`, tools `Read`, `Grep`, `Glob`). It starts in an empty temp directory rather than the repo, because Claude Code runs `git status` in its working directory on startup, and that can write `.git/index`. Claude decides what context beyond the diff is worth reading: the code the diff calls, its callers and tests, and whatever docs or contributor and agent instructions the project keeps. It has no shell (even `git status` rewrites `.git/index`) and no tools that write. None of the repo's own Claude Code configuration is loaded (`--setting-sources ""`, hooks disabled, no MCP servers, no skills), because hooks can run commands. Session persistence is off. The default Claude Code system prompt is replaced by the spec prompt. Tool calls stream to the page as steps. The schema-validated result is read from the final event's `structured_output`, falling back to parsing `result`. It contains sections, clauses, line anchors, an optional `riskFlag`, and a mapping from each comment to a clause. The system prompt in [`server/prompts.ts`](server/prompts.ts) requires falsifiable statements and requires the model to surface error handling, swallowed exceptions, edge cases, concurrency, and anything that fails silently. The server attaches the real diff hunks to each anchor. Results are cached by diff, comments, model, and prompt in the out-of-repo cache directory, so restarting costs nothing. Exploring the repo makes a first read take longer (minutes on a large PR) and use more of your Claude plan than reading the diff alone.

**Sync.** Only sentences whose text changed go into the `spec.diff`:

```diff
@@ s3-c3 · Failure Reporting · services/ingest/handler.py:52-52 @@
- The handler always returns HTTP 200 OK, even when every record failed; failed records are simply absent from `ingested`.
+ The handler returns 502 when no record was ingested and 207 with a `failed` list when only some records failed.
```

The execution prompt gives Claude Code each change as CURRENT vs REQUIRED behavior, the anchors, and the reviewer comments on that sentence. It tells Claude to make the smallest change that makes each sentence true and to leave everything else alone. Comments you pushed back on are listed explicitly as "do not act on". The run uses `--output-format stream-json --verbose`, so each Read, Edit, Write, or command shows up as it happens. Nothing is committed. When the run ends, the Sync sheet shows the files Claude changed and their diff (also saved as `last-run.md` in the cache directory), and the command to pick up that exact Claude Code session in your terminal (`cd <repo> && claude --resume <session id>`), to ask why it did something or to keep going by hand. After a successful run the spec no longer matches the code, so another run against it is refused until you **Re-analyze diff**. Loading is refused while Claude Code is editing. The diff is relative to each file's contents just before the run, so edits you had already made aren't shown as Claude's.

**Comments.** Review threads come from GitHub's GraphQL API (`reviewThreads`), which knows which threads are resolved or outdated; that filtering is deterministic, with no model involved. Open threads keep their replies (the opening comment plus up to the latest 20). Review summaries and conversation comments come from the REST API. If GraphQL isn't available, redline falls back to REST and says in the log that resolved threads are included.

**Replies.** Only what you write is ever posted. `redline-pr` never drafts a reply for you, because a generated "fixed it" could claim a change Claude skipped. Replies you write in the margin are listed in the Sync sheet, where you can still edit them, and are posted only when you click **Post replies to GitHub**. That is separate from running Claude Code, so you can answer a reviewer without changing code, or post after you have seen what the run did. An identical reply is never posted twice (posted replies are recorded in the cache directory). Inline review comments get threaded replies. Review summaries and conversation comments get a quoted PR comment.

**Export.** **Copy / Export spec diff** copies a Markdown plan to the clipboard and writes it to `redline-sync.md` in the cache directory. The plan includes the spec.diff, target files, your replies, and the full prompt.

Your edits are saved in the browser's `localStorage` per branch. Because each repo gets the same port every launch, they survive reloads and restarts, until the spec itself changes.

## Zero-trace isolation

`redline-pr` is built to run inside sensitive work repositories. It never creates, modifies, or leaves behind anything in the repository's working tree or its `.git` directory.

- **Artifacts live outside the repo.** Spec caches, sync plans, and exports go to `$XDG_CACHE_HOME/redline-pr/<sha256 of the repo's real path>/`, which defaults to `~/.cache/redline-pr/…`. The directory is created only when something is written to it, with `0700` permissions and `0600` files. The CLI prints its location at startup. Delete it whenever you like. If `XDG_CACHE_HOME` resolves to a path inside the repo, `redline-pr` refuses to start.
- **Git, gh, and the spec writer are read-only.** Diff and `gh` output are read into memory and never written to disk. The diff comes from plumbing `git diff-index`, not porcelain `git diff`: porcelain refreshes stale stat data and writes `.git/index` back (even with `GIT_OPTIONAL_LOCKS=0`, e.g. after an editor re-saves an unchanged file). While writing the spec, Claude Code gets only read-only file tools, and none of the repo's hooks or settings. The test suite checks every byte of a repo, `.git` included, before and after a run.
- **No temp files in the repo.** Prompts are piped to `claude -p` over stdin. The only scratch files (an empty working folder for the spec writer, and before-copies of changed files used to show a run's diff) go in the OS temp directory and are deleted when done.
- **Edits stay in the browser.** Your in-progress sentence edits and replies are kept in `localStorage`.

The one exception is what you ask for: **Run with Claude Code** lets Claude Code edit source files in the repo to apply your spec changes. Those edits are the point of the tool, and they show up in `git status` for you to review.

## Security

The local server binds to `127.0.0.1` and requires a per-launch token, which is injected into the page, on every `/api` call. Other sites open in your browser can't trigger a sync. Requests whose `Host` isn't `127.0.0.1` or `localhost` are refused, which blocks DNS-rebinding pages from reading the token. The server builds every prompt from its own copy of the spec and takes only your sentence edits, comment statuses, and replies from the browser. A Claude Code run that hits the 30-minute limit is stopped with its whole process group and reported as a failure. Ctrl-C or closing the terminal stops any running `claude` too. **Run with Claude Code** runs `claude -p --permission-mode acceptEdits` in your repo root, which lets Claude edit any file in the repo without asking (it is told to change only what your edited sentences require, but nothing enforces that). Like typing `claude` there yourself, a run loads the repo's own Claude Code settings, hooks, and MCP servers; only the spec writer runs without them. Use `--dry-run`, or set `REDLINE_CLAUDE_FLAGS`, if you want something stricter. Your code is sent to Anthropic through your Claude login, as with any Claude Code use: the diff, the files Claude chooses to read, and the review comments. Review comments can be written by anyone who can comment on the PR, so the execution prompt fences them as quoted data and tells Claude never to act on instructions inside them.

## Development

```
npm install
npm run build          # vite build (web) + tsc (cli/server) → dist/
npm run typecheck      # tsc --noEmit over everything
npm test               # builds, then unit + integration + browser tests
npx tsx bin/cli.ts --demo
```

Running from source (`npx tsx bin/cli.ts`) still serves the page from the built `dist/web`, so run `npm run build` after changing anything under `web/`, and restart redline after changing the server. Otherwise the page and the server can be different versions.

`npm test` never calls the real `claude` or GitHub: integration tests put fake `claude` and `gh` binaries first on `PATH` and run the built CLI against throwaway repos, checking every byte of each repo (`.git` included) before and after. Browser tests drive headless Chrome and are skipped if Chrome or Chromium isn't installed (set `CHROME_PATH` to point at one).

Working on redline with a coding agent? [`AGENTS.md`](AGENTS.md) is the contract it must follow (design rules and the invariants above). `CLAUDE.md` points Claude Code at it.

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
  claude-stream.ts stream-json events → plain steps ("Editing db.py")
  prompts.ts       spec system prompt + surgical execution prompt
  spec.ts          claude -p --json-schema call, anchor/comment assembly, cache
  sync.ts          spec.diff, edit merging, export, claude -p runs, reply posting
  git.ts diff.ts   diff collection and unified-diff parsing
  github.ts        PRs, review threads (GraphQL, resolved/outdated triage), comments, reply posting
  demo.ts          pre-baked demo PR
shared/types.ts    the data contract between server and web
web/src/           React + Tailwind UI (layout.ts: margin-note placement)
```

## License

MIT

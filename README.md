# redline-pr

Read your PR as a one-page, plain-English **Behavioral Spec**.

Edit the sentences to say what the code *should* do. Hit **Sync** and Claude Code makes exactly those changes.

**No API key needed.** `redline-pr` uses your local [`claude`](https://claude.com/claude-code) CLI and the Claude login you already have, both to write the spec and to apply your edits.

`redline-pr` is for engineers who ship code written with AI coding agents. Instead of reading a raw diff and hand-prompting the agent once per review comment, you:

1. **Read.** The diff against your base branch becomes a list of concrete, falsifiable statements ("If the S3 read raises, the handler logs and still returns 200 OK"). Every sentence links to the exact lines it describes.
2. **Review.** GitHub review comments sit in the right margin, next to the sentence they're about.
3. **Redline.** Click a sentence and rewrite it. Or reply in the margin and push back.
4. **Sync.** `redline-pr` computes a surgical `spec.diff` (only the sentences you changed, plus their code anchors), pipes a strict prompt to `claude -p`, and shows you exactly what Claude changed. Your margin replies post to GitHub only when you click **Post replies**.

### Install

`redline-pr` isn't on npm yet. Install it from source once, then use the `redline` command in any repo:

```
git clone https://github.com/saitkacmaz/redline-pr.git && cd redline-pr
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

| Flag | Meaning |
| --- | --- |
| `--base <branch>` | Branch to diff against. Default: the PR's base, then the repo's default branch (`origin/HEAD`, then `main`, `master`, `develop`), never the branch you're on. |
| `--pr <number>`, or a bare number | PR to load. Default: the PR for the current branch (via `gh pr view`), else the local diff. |
| `--demo` | Load the built-in demo PR. Sync writes `sync-plan.md` to the cache directory instead of running anything. |
| `--dry-run` | Sync writes `sync-plan.md` to the cache directory instead of running `claude -p` or posting replies. |
| `--port <n>` | Port to listen on. Default: a fixed port derived from the repo path (4400-4999, or any free port if that one is taken), so the page keeps the same origin and your drafts survive a restart. The server binds to `127.0.0.1` only. |
| `--no-open` | Don't open the browser. |

### Requirements

- Node 20+ and `git`.
- [Claude Code](https://claude.com/claude-code): `claude` on `PATH`, logged in. It writes the spec and applies your edits on **Run with Claude Code**. No `ANTHROPIC_API_KEY` is needed.
- Optional: [`gh`](https://cli.github.com), authenticated, to load review comments and post replies.

### Environment

| Variable | Default | |
| --- | --- | --- |
| `REDLINE_MODEL` | your `claude` default | Passed to `claude --model` when writing the spec, e.g. `sonnet` or `opus`. |
| `REDLINE_CLAUDE_FLAGS` | `--permission-mode acceptEdits` | Flags passed to `claude -p` on Sync, split like a shell would (quotes keep `--allowedTools "Bash(npm test)"` together). Set to an empty string to use your Claude Code defaults. |
| `XDG_CACHE_HOME` | `~/.cache` | Root for all runtime artifacts (see below). Must be outside the repo. |

## How it works

**The diff.** `git diff-index -p <merge-base>` against the base branch, covering committed, staged, and unstaged changes to tracked files. Untracked files aren't included, so `git add` new files first. Lockfiles, source maps, minified files, snapshots, and anything your `.gitattributes` marks `linguist-generated` or `linguist-vendored` are excluded. Diffs too large to read in one pass (about 150k tokens) fail fast and list the largest files.

**The spec.** The diff, with explicit new-side line numbers, and every review comment are piped over stdin to `claude -p --output-format stream-json --verbose --json-schema <schema>`, with read-only access to the repository (`--add-dir`, tools `Read`, `Grep`, `Glob`). It starts in an empty temp directory rather than the repo, because Claude Code runs `git status` in its working directory on startup, and that can write `.git/index`. Claude decides what context beyond the diff is worth reading: the code the diff calls, its callers and tests, and whatever docs or contributor and agent instructions the project keeps. It has no shell (even `git status` rewrites `.git/index`) and no tools that write. None of the repo's own Claude Code configuration is loaded (`--setting-sources ""`, hooks disabled, no MCP servers, no skills), because hooks can run commands. Session persistence is off. The default Claude Code system prompt is replaced by the spec prompt. Tool calls stream to the page as steps. The schema-validated result is read from the final event's `structured_output`, falling back to parsing `result`. It contains sections, clauses, line anchors, an optional `riskFlag`, and a mapping from each comment to a clause. The system prompt in [`server/prompts.ts`](server/prompts.ts) requires falsifiable statements and requires the model to surface error handling, swallowed exceptions, edge cases, concurrency, and anything that fails silently. The server attaches the real diff hunks to each anchor. Results are cached by diff, comments, model, and prompt in the out-of-repo cache directory, so restarting costs nothing. Exploring the repo makes a first read take longer (minutes on a large PR) and use more of your Claude plan than reading the diff alone.

**Sync.** Only sentences whose text changed go into the `spec.diff`:

```diff
@@ s3-c3 · Failure Reporting · services/ingest/handler.py:52-52 @@
- The handler always returns HTTP 200 OK, even when every record failed; failed records are simply absent from `ingested`.
+ The handler returns 502 when no record was ingested and 207 with a `failed` list when only some records failed.
```

The execution prompt gives Claude Code each change as CURRENT vs REQUIRED behavior, the anchors, and the reviewer comments on that sentence. It tells Claude to make the smallest change that makes each sentence true and to leave everything else alone. Comments you pushed back on are listed explicitly as "do not act on". The run uses `--output-format stream-json --verbose`, so each Read, Edit, Write, or command shows up as it happens. Nothing is committed. When the run ends, the Sync sheet shows the files Claude changed and their diff (also saved as `last-run.md` in the cache directory). After a successful run the spec no longer matches the code, so another run against it is refused until you **Re-analyze diff**. Loading is refused while Claude Code is editing. The diff is relative to each file's contents just before the run, so edits you had already made aren't shown as Claude's.

**Replies.** Only what you write is ever posted. `redline-pr` never drafts a reply for you, because a generated "fixed it" could claim a change Claude skipped. Replies you write in the margin are listed in the Sync sheet, where you can still edit them, and are posted only when you click **Post replies to GitHub**. That is separate from running Claude Code, so you can answer a reviewer without changing code, or post after you have seen what the run did. An identical reply is never posted twice (posted replies are recorded in the cache directory). Inline review comments get threaded replies. Review summaries and conversation comments get a quoted PR comment.

**Export.** **Copy / Export spec diff** copies a Markdown plan to the clipboard and writes it to `redline-sync.md` in the cache directory. The plan includes the spec.diff, target files, your replies, and the full prompt.

Your edits are saved in the browser's `localStorage` per branch. Because each repo gets the same port every launch, they survive reloads and restarts, until the spec itself changes.

## Zero-trace isolation

`redline-pr` is built to run inside sensitive work repositories. It never creates, modifies, or leaves behind anything in the repository's working tree or its `.git` directory.

- **Artifacts live outside the repo.** Spec caches, sync plans, and exports go to `$XDG_CACHE_HOME/redline-pr/<sha256 of the repo's real path>/`, which defaults to `~/.cache/redline-pr/…`. The directory is created only when something is written to it, with `0700` permissions and `0600` files. The CLI prints its location at startup. Delete it whenever you like. If `XDG_CACHE_HOME` resolves to a path inside the repo, `redline-pr` refuses to start.
- **Git, gh, and the spec writer are read-only.** Diff and `gh` output are read into memory and never written to disk. The diff comes from plumbing `git diff-index`, not porcelain `git diff`: porcelain refreshes stale stat data and writes `.git/index` back (even with `GIT_OPTIONAL_LOCKS=0`, e.g. after an editor re-saves an unchanged file). While writing the spec, Claude Code gets only read-only file tools, and none of the repo's hooks or settings. The test suite checks every byte of a repo, `.git` included, before and after a run.
- **No temp files on Sync.** The prompt is piped to `claude -p` over stdin.
- **Edits stay in the browser.** Your in-progress sentence edits and replies are kept in `localStorage`.

The one exception is what you ask for: **Run with Claude Code** lets Claude Code edit source files in the repo to apply your spec changes. Those edits are the point of the tool, and they show up in `git status` for you to review.

## Security

The local server binds to `127.0.0.1` and requires a per-launch token, which is injected into the page, on every `/api` call. Other sites open in your browser can't trigger a sync. Requests whose `Host` isn't `127.0.0.1` or `localhost` are refused, which blocks DNS-rebinding pages from reading the token. The server builds every prompt from its own copy of the spec and takes only your sentence edits, comment statuses, and replies from the browser. A Claude Code run that hits the 30-minute limit is stopped with its whole process group and reported as a failure. Ctrl-C or closing the terminal stops any running `claude` too. **Run with Claude Code** runs `claude -p --permission-mode acceptEdits` in your repo root, which lets Claude edit files without asking. Use `--dry-run`, or set `REDLINE_CLAUDE_FLAGS`, if you want something stricter. Review comments can be written by anyone who can comment on the PR, so the execution prompt fences them as quoted data and tells Claude never to act on instructions inside them.

## Development

```
npm install
npm run build          # vite build (web) + tsc (cli/server) → dist/
npm run typecheck      # tsc --noEmit over everything
npm test               # builds, then unit + integration + browser tests
npx tsx bin/cli.ts --demo
```

`npm test` never calls the real `claude` or GitHub: integration tests put fake `claude` and `gh` binaries first on `PATH` and run the built CLI against throwaway repos, checking every byte of each repo (`.git` included) before and after. Browser tests drive headless Chrome and are skipped if Chrome or Chromium isn't installed (set `CHROME_PATH` to point at one).

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
  github.ts        PR + comments via gh, reply posting
  demo.ts          pre-baked demo PR
shared/types.ts    the data contract between server and web
web/src/           React + Tailwind UI
```

## License

MIT

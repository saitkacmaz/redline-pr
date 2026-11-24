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
- **Two decoupled columns.** The spec column is 680px and the margin is 340px, set side by side in `SpecBody.tsx`.
  - Margin notes are absolutely positioned by the collision solver in `web/src/layout.ts`: `top = max(targetTop, prevBottom + 16)`.
  - A note, a thread, or an expanded reply must never change the height of the prose or open a gap between sentences. `test/layout.test.ts` and the UI tests guard this. Keep them passing.
- **Spacing.** 20px between sentences and 36px between sections.
- **Views are pages, not modals.** A dedicated view such as Sync gets its own history entry (`pushState`/`popstate`, `#sync`). Browser Back, Esc, and a quiet "← Back" link all return to the spec, with edits, scroll position, and focus intact.
- **Progress is honest.**
  - Show the 2px hairline, plus a status line fed by the real `claude -p` stream-json events and the server's real phases.
  - Never estimate, never animate fake steps.
  - Respect `prefers-reduced-motion`.
- **Narrow screens.** Below 1024px, margin notes render inline after their sentence. Never hide them.

## 3. Architectural invariants (non-negotiable)

1. **Zero-trace isolation.** redline-pr never creates, modifies, or leaves behind a file, folder, log, cache, lock, or config in the target repository's working tree or `.git` directory.
   - **Where state lives.** All state goes under `$XDG_CACHE_HOME/redline-pr/<sha256 of repo path>/`, which defaults to `~/.cache/redline-pr/`. Temp dirs come from `os.tmpdir()` and are removed on exit. Drafts live in the browser's `localStorage`.
   - **Git calls.**
     - Read-only plumbing (`diff-index`, `rev-parse`, `merge-base`, `cat-file`, `ls-files`) with `GIT_OPTIONAL_LOCKS=0`.
     - Never porcelain `git diff` or `git status`: they rewrite `.git/index`.
     - Never `git fetch`, `checkout`, `stash`, or anything else that writes.
   - **The spec writer.** It runs from an empty temp cwd and reaches the repo only through `--add-dir`, because Claude Code's startup touches `.git` in its cwd.
2. **Read-only until Sync.**
   - Launching, loading, switching PRs, refreshing, and reviewing never change the repo and never post to GitHub.
   - Only an explicit **Run** in the Sync view may edit files (through Claude Code). Only an explicit **Post replies** may write to GitHub, and only the replies the human wrote, once each.
3. **Subscription-first.**
   - All model calls go through the user's local `claude` CLI and its existing login.
   - Never use `--bare` or `ANTHROPIC_API_KEY`, never call the Anthropic API directly, and never add an API-key path or an SDK dependency.
   - The spec writer runs with `--tools Read,Grep,Glob`, `--setting-sources ""`, hooks disabled, and `--strict-mcp-config`. Don't widen its tools.
4. **Works on any git repository.**
   - GitHub is optional. A repo with no remote, a remote on GitLab, Bitbucket or a private server, or a machine with no `gh` (or a logged-out one) must boot, load the local branch diff, and say in one muted sentence why there are no PRs.
   - No crash, no red banner, no raw `gh` stderr in the page. See `githubAccess` and `NotOnGitHubError` in `server/github.ts`.
   - The base branch is resolved in this order: `--base`, then the PR's base, then `origin/HEAD`, then `main`, then `master`, then `develop`. If none exists, show a calm empty state that suggests `--base`.
5. **Comment handling is deterministic.**
   - Resolved and outdated review threads are filtered by GitHub's own flags (GraphQL `reviewThreads`), never by a model. They appear in neither the margin nor the prompt.
   - Each open thread is one margin item.
6. **Local and safe by default.**
   - The server binds to `127.0.0.1` only. Every API call needs the per-launch page token, and Host and Origin are checked.
   - Child processes are spawned without a shell, in their own process group, and are killed with redline.
7. **Nothing personal in the repo.** No real names, emails, home paths, tokens, or private repo names in code, fixtures, docs, or commits. The demo uses made-up people.

## 4. How to work here

- **Stack.** TypeScript throughout: Hono server (`server/`), React + Vite + Tailwind v4 UI (`web/`), shared types (`shared/types.ts`), and the CLI entry (`bin/cli.ts`).
- **Before you say you're done:**
  ```sh
  npm run typecheck
  npm test        # builds first, then runs the unit, CLI and headless-browser tests
  ```
  Every behavior change comes with a test. The CLI tests snapshot the target repo before and after, and assert it is byte-identical. Any new code path that touches the repo needs the same assertion.
- **Tests never use the network, a real `claude` login, or a real GitHub repo.** Use the fakes in `test/helpers.ts` (`fakeClaude`) and `test/cli-harness.ts` (`fakeGh`, `fakeGhWithPr`).
- **Real runs.** Never run a real Sync or post replies against a user's repository unless they ask you to in that conversation. Use a scratch clone.
- **Match the code around you.** Short doc comments that say *why*, no new dependencies without a reason, and no speculative options or flags.
- **Keep the README in step** when user-visible behavior changes.

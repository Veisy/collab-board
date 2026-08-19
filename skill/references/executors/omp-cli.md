# Executor: omp-cli — dispatching Oh My Pi as SECONDARY

Selected by `SecondaryAdapter: omp-cli`; requires `SECONDARY=OMP` or an `OMP_*` family
name (lint `L18`). Implements the executor contract in `../adapters.md`.

Flag surface verified on OMP 17.2.11. OMP is a harness, not a model: this executor never
assumes DeepSeek, Claude, Gemini, or any other provider.

## Probes

Run once per session, through the PRIMARY host's own shell:

- `omp --version` — binary present. If PATH is stale, resolve the installed binary by absolute
  path before concluding it is absent.
- A short live call using the same launcher/posture as dispatch, with the project root as
  `--cwd`: `Reply with exactly: OK`. Require exit 0 and a non-empty reply containing `OK`.
- If `SecondaryModel:` is set, run `omp models find <model> --json` first. Do not validate or
  pin a model when the key is absent; absence deliberately means inherit OMP's active model.

An install/auth/probe failure pauses the board at its last saveable point. It is not permission
to substitute the PRIMARY's self-review.

## The dispatch

Use the installed `omp-headless` launcher when available (the Windows harness-setup package
installs `omp-headless.ps1` beside `omp.exe`); it fixes noninteractive, no-session, text, yolo,
and safety-guard settings. On macOS and Linux, or when that optional launcher is absent, use the
equivalent official `omp` flags directly. Run from
the project root with an explicit `--cwd`, foreground, timeout at least 600000 ms, and capture
spawn PID/stdout/stderr in per-session, per-turn, per-attempt scratch files outside the board.

Reference argv (pass as an argv array, never a shell-interpolated prompt):

```text
omp-headless --cwd <absolute-project-root>
  --tools=read,grep,glob,write,edit,bash
  --max-time=20m
  <scoped-prompt>
```

For direct OMP, the equivalent fixed flags are:

```text
omp -p --cwd <absolute-project-root> --no-title --no-session --mode text
  --approval-mode yolo --tools=read,grep,glob,write,edit,bash --max-time=20m
  <scoped-prompt>
```

On PowerShell, quote the comma-separated `--tools=...` token as one argv element; an unquoted
comma is split by PowerShell and OMP rejects the dispatch. Put a large scoped prompt in a unique
UTF-8/no-BOM/LF scratch file and pass it through OMP's documented `@<file>` message expansion.

The tool set allows project checks during IMPL review and board writes during ordinary mode. It
is not a sandbox: Rule 7 remains a prompt/protocol obligation. Prefer
`BoardWriteMode: PRIMARY_ONLY` for panels or when the PRIMARY wants OMP to return a relay capture
without writing `.collab-board/`; in that mode omit `write,edit` unless the scoped task explicitly
needs a non-board artifact, and request the exact relay/v1 grammar from `../relay.md`.

Append only when present in `SESSION.md`:

- `SecondaryModel: <m>` -> `--model <m>`
- `SecondaryEffort: <e>` -> `--thinking <e>` (OMP's name for its reasoning-effort level)

Absent keys inherit OMP configuration. Pass the value through only when the selected model's
catalog entry supports that level; do not invent a provider-specific remapping.

## Result validity

The process result is valid only when exit code is 0 and captured stdout is non-empty. That is
still not a landed turn: ordinary mode additionally requires the expected shard and its
`TURN_COMMIT`/`HANDOFF`; sole-writer mode requires a complete relay/v1 capture ending in
`--- END ---`. `confirm()` and lint decide, never OMP's narration.

## Execution mode

Foreground with the spawn PID captured before waiting. The parent shell timeout must be no
shorter than OMP's `--max-time`. OMP's safety extension is defense in depth, not filesystem
confinement; use an isolated worktree for untrusted repositories.

## Failure path

Follow `../recovery.md`: check whether the board already landed; kill-confirm the process tree
from the captured PID (missing identity means possibly alive, so do not retry); classify a usage
limit; reconcile partial writes; then make at most one fresh retry with new scratch names. Recheck
PowerShell comma quoting and the explicit `--cwd` before retrying a no-op or argument failure.

## WRITE_BLOCKED

If no turn landed and stdout begins `WRITE_BLOCKED:` with a complete concrete verdict, use
`../relay.md`. In `PRIMARY_ONLY` mode this is not an error—the expected result is a relay
capture. Do not widen permissions in response to a blocked board write.

## Usage-limit signatures

Classify only when no turn landed and stdout/stderr contains a case-insensitive family such as
`usage limit`, `rate limit` / `rate_limit`, `429`, `quota`, `resets at`, or `try again at|in`.
Extract any reset time and apply `../recovery.md`; a provider login/API-key error is
an auth failure, not a limit.

## Resume

Fresh per turn is deliberate. The supported headless posture uses `--no-session`, so write
`EXECUTOR_THREAD: NONE` and never guess with `--continue`. A future session-persistent OMP adapter
may use `--resume <stored-id>` only after it has a machine-readable id and follows
`../recovery.md` lineage.

Upstream: https://github.com/can1357/oh-my-pi

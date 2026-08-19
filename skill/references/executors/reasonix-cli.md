# Executor: reasonix-cli — dispatching Reasonix as SECONDARY

Selected by `SecondaryAdapter: reasonix-cli`; requires `SECONDARY=REASONIX` or a
`REASONIX_*` family name (lint `L18`). Implements the executor contract in `../adapters.md`.

Flag surface verified on Reasonix 1.21.3. Reasonix is DeepSeek-oriented, but its CLI is
multi-model and this adapter is model-agnostic: no model or provider is hard-coded.

## Probes

Run once per session, through the PRIMARY host's own shell:

- `reasonix --version` — binary present; if PATH is stale, resolve an absolute install path.
- `reasonix doctor --json` — configuration/credential diagnostics, not a network proof.
- A short live call through the same host shell and writer posture:
  `reasonix run --auto --dir <absolute-project-root> --output-format json
  [--model <SecondaryModel>]
  "Reply with exactly: OK"`. Include `--model` when the session pins one, so the probe exercises
  the same command surface and model as the real dispatch. A `reasonix -p` probe is insufficient:
  it does not prove `run --auto`, which is the write-capable path this executor dispatches.
  Require exit 0, valid JSON, `is_error:false`, and non-empty `result` containing `OK`.

When `SecondaryModel:` is absent, do not infer DeepSeek from the product name: inherit Reasonix's
configured default. An install/auth/live-probe failure pauses the board; never degrade to
self-review.

## The dispatch

Write the scoped prompt to a unique UTF-8/no-BOM/LF scratch file outside the board. Run from the
project root, foreground, timeout at least 600000 ms, redirect that file to stdin, and capture
spawn PID/stdout/stderr to unique per-session, per-turn, per-attempt files:

```text
reasonix run --auto --dir <absolute-project-root> --output-format json
  --allowed-tools Read,Write,Edit,Grep,Glob,Bash
```

Pass every argument as its own argv element. The PascalCase tool rules above were verified on
Reasonix 1.21.3. `--auto` is the unattended writer posture on Windows, macOS, and Linux; configured
deny rules, native hooks, and workspace file-writer boundaries still apply. `--dir` is mandatory:
it defines the project root for config, tools, and writes. On Windows there is no Reasonix
OS-level Bash sandbox, so hooks are defense in depth rather than confinement.

The tool set permits board writes and executable IMPL checks. Rule 7 still prohibits a SECONDARY
from editing project source. Prefer `BoardWriteMode: PRIMARY_ONLY` for a multi-executor panel; ask
for the relay/v1 grammar and, when practical, narrow tools to read/search/Bash because the PRIMARY
will perform all board writes.

Append only when present in `SESSION.md`:

- `SecondaryModel: <m>` -> `--model <m>`
- `SecondaryEffort: <e>` -> `--effort <e>`

Absent means inherit Reasonix configuration. Do not remap effort names on the board's behalf; the
configured model/provider owns their semantics.

## Result validity

Valid process output requires exit code 0, one parseable JSON result, `is_error:false`, and a
non-empty `result`; read it only after process exit. Ordinary mode still requires the shard plus
its `TURN_COMMIT`/`HANDOFF`. Sole-writer mode requires a complete relay/v1 capture ending
`--- END ---`. The board landing and lint are authoritative, never the JSON narration.

## Execution mode

Foreground with the spawn PID captured before waiting. Reasonix 1.21.3 exposes no internal
wall-clock deadline flag, so the parent shell's timeout is the only watchdog. 600000 ms is a floor,
not a target, and a floor with no guide above it gets adopted as the setting: measured review turns
on this executor have run 407 s, 489 s, 503 s and 739 s, so budget at least 1800000 ms and raise the
host cap to match rather than discovering the ceiling with a live dispatch. A
session can launch background jobs
internally, but collab-board waits for the one parent dispatch and accepts only a landed board or
complete capture. Give independent writing agents separate worktrees.

## Failure path

Follow `../recovery.md`: board-landed check; PID-rooted process-tree kill-confirm; usage-limit
classification; partial-turn recovery; one fresh retry with new scratch names. Before retrying,
verify `--auto`, the exact `--dir`, and that stdin carried the full prompt.

## WRITE_BLOCKED

If the board is unchanged and `result` begins `WRITE_BLOCKED:` with the complete turn and exact
mutations, apply `../relay.md`. Under `PRIMARY_ONLY`, a relay/v1 capture is the expected
success path and must be handled by `relay`, not treated as a blocked write. Never switch to
`bypassPermissions` to make a turn land.

## Usage-limit signatures

When no turn landed, match a small case-insensitive family in JSON/stderr: `usage limit`,
`rate limit` / `rate_limit`, `429`, `quota`, `resets at`, `try again at|in`. Extract reset language
and use `../recovery.md`. `401`, missing credentials, or provider setup failures
are auth/configuration failures, not limits.

## Resume

Fresh is the default. Every successful JSON result carries `session_id`; store it only when the
session deliberately opts into memory, under `EXECUTOR_THREAD` in the actor file. Resume with
`reasonix run --resume <stored-session-id> ...`, never `--continue` (latest-session guessing).
Discard the id after rollback, a superseded lint-failed turn, or any lineage mismatch, per
`../recovery.md`.

Upstream: https://github.com/esengine/deepseek-reasonix

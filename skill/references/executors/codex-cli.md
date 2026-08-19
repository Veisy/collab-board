# Executor: codex-cli

Dispatch local Codex as `SECONDARY=CODEX`/`CODEX_*`; `codex` is a legacy alias. Verified on
codex-cli 0.144.1. Prerequisites: `@openai/codex` and login.

## Probes

- `codex --version`; re-check `codex exec --help` on another major.
- `codex login status`.
- Run a short live `codex exec` through the PRIMARY host shell. Install/auth failure pauses; it is
  not a limit and never licenses self-review.

## The dispatch

Create unique UTF-8/no-BOM/LF prompt, output, stderr, and PID files outside the project. Run from
the PRIMARY shell with >=600000 ms watchdog:

```text
codex exec -C <absolute-project-root> -s workspace-write
  -o <last-message-file> - < <prompt-file> > <stdout-file> 2> <stderr-file>
```

Capture the spawn PID before waiting. Add `--skip-git-repo-check` only outside git. Add `--json`
only when deliberate resume needs the `thread_id`. Append only configured pins:

- `SecondaryModel` -> `-m <model>`
- `SecondaryEffort` -> `-c model_reasoning_effort=<effort>`

Absent pins inherit user configuration. Do not use low effort for a gate turn.

## Verification

Under `-s workspace-write` this child runs `git`, a single-process `node` script,
`collab-board.mjs lint`, `doc-verify.mjs` and its own byte censuses, but cannot spawn a further
process (`node`->`node` returns `EPERM`; workspace and temp writes both succeed, so it is process
depth, not the filesystem). `skill/scripts/test.mjs` is therefore the PRIMARY's to run. Codex also
enforces a ~124 s per-command ceiling, which the full suite exceeds; `--only <pattern>` selects
blocks before they execute and prints `PASS(SUBSET)`, which cannot be quoted as a full run.

```text
VERIFICATION: run exactly these and report each command with its outcome:
  node skill/scripts/test.mjs --only <pattern>
  node skill/scripts/collab-board.mjs lint --all --root <frozen tree>
Set `verified=self` on your GATE_SET for a check you ran, `reported` where you relied on the
PRIMARY's result. Both require justified_by=<turn-id> and real Evidence in that shard.
```

Elevate only when one named command the turn needs is proven blocked: swap in
`-s danger-full-access` and list the commands in full, since `node -e <anything>` is not a list.
That removes the sandbox for the dispatch — writes outside the workspace, free spawning — and the
list is auditable policy, not confinement, which board confirmation cannot check. Grant it per
dispatch, prefer a turn that reviews over one that authors board state, and never carry it
forward. A host may refuse the flag: dispatch under `workspace-write` with the reduced list and
let the gate carry `verified=reported`.

## Result validity

Require exit 0 and a non-empty `-o` file, read after exit. Stdout is a potentially large human
transcript and stays in scratch. Direct-write mode still requires shard, TURN_COMMIT, HANDOFF, and
lint; PRIMARY_ONLY requires a complete relay capture. Narration never proves landing.

## Execution mode

Foreground by default. For longer work, use the host background/watchdog mechanism and poll board
landing, not a completion notification. The host owns timeout/process mechanics.

## Failure path

Stop and follow `../recovery.md`: board-first landing check, PID-rooted tree kill-confirm, limit
classification, partial reconciliation, then at most one fresh retry. Missing PID is UNKNOWN, not
dead. Re-check cwd/sandbox/full stdin before retry.

## WRITE_BLOCKED

If no turn landed and the `-o` message begins `WRITE_BLOCKED:` with complete exact content, use
`../relay.md` scribe rules (`via=codex-cli relayed_by=<PRIMARY>`). Do not discard a sound verdict
or widen the sandbox.

## Usage-limit signatures

Case-insensitive family across stderr and last message: `usage limit`, `rate limit`/`rate_limit`,
`429`, `quota`, `too many requests`, `try again at|in`. Extract reset language and apply
`../recovery.md`. `401`, not logged in, or failed login status is auth, not a limit.

## Resume

Fresh is default. Store a JSONL `thread_id` only in actor `EXECUTOR_THREAD`, then resume from the
project root:

```text
codex exec resume <thread-id> -c sandbox_mode="workspace-write" -o <last-file> - < <prompt>
```

Resume has no `-C`/`-s`; never guess with `--last`. If the installed version rejects the config
override, dispatch fresh. Discard ids per `../recovery.md` lineage rules.

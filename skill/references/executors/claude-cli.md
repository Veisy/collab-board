# Executor: claude-cli

Dispatch Claude CLI as `SECONDARY=CLAUDE`/`CLAUDE_*` (the common inverted pairing). Verified on
Claude 2.1.207. Requires Claude Code CLI plus login/API key.

## Probes

- `claude --version`; re-check flags on another major.
- `claude auth status`; require `loggedIn:true` (local auth only).
- Live through the PRIMARY host shell: `claude -p "Reply with exactly: OK" --output-format json`;
  require exit 0 and `is_error:false`. This probe is mandatory from a Codex host.

## The dispatch

Run from project root with unique UTF-8/no-BOM/LF stdin/stdout/stderr/PID scratch files and a
>=600000 ms host watchdog:

```text
claude -p --safe-mode --output-format json
  --tools Read,Grep,Glob,Edit,Write
  --allowedTools Read Grep Glob Edit(.collab-board/**) Write(.collab-board/**)
  < <prompt-file> > <out-json> 2> <err-file>
```

Capture spawn PID first. `--tools` removes ambient Bash; `--allowedTools` preauthorizes only the
listed/path-scoped surface. This narrows tool-mediated writes but is not a security boundary.
Never add a Bash rule: measured Bash-enabled headless runs hung silently, and prefix rules can
admit indirect execution. A reviewer that cannot run an IMPL check must disclose that; use another
panel contributor for executable verification.

Do not use bare `acceptEdits`, `--bare`, `--no-session-persistence`, or dangerous permission bypass.
Append configured `--model`/`--effort` only; absent pins inherit user configuration.

## Result validity

Require exit 0, one parseable JSON result, `is_error:false`, and non-empty `result`, read after
exit. `permission_denials` diagnose only. Direct-write requires board landing; PRIMARY_ONLY requires
complete relay/v1. JSON narration is not evidence.

## Execution mode

Foreground by default; host watchdog/background mechanics for longer work. The board landing is
completion authority. If command execution is exceptionally required, seal/verify fan-out because
that posture is outside this profile.

## Failure path

Use `../recovery.md`: board-first check, PID-tree death confirmation, limit classification,
partial reconciliation, one fresh retry. Missing PID means possibly alive.

## WRITE_BLOCKED

Trigger when `result` starts `WRITE_BLOCKED:` or a denial names Edit/Write under `.collab-board`
while the board is unchanged. A complete verdict follows `../relay.md` with
`via=claude-cli relayed_by=<PRIMARY>`; never widen permissions.

## Usage-limit signatures

Case-insensitive JSON/stderr family: `usage limit`, `rate limit`/`rate_limit`, `429`, `quota`,
`resets at`, `try again at|in`. Extract embedded reset time and use `../recovery.md`. `401`,
`loggedIn:false`, and invalid keys are auth failures.

## Resume

Fresh is default. Valid JSON carries `session_id`; store only in actor `EXECUTOR_THREAD` and use:

```text
claude -p --resume <session-id> --safe-mode --output-format json ... < <prompt-file>
```

Never use `--continue` (directory-latest guessing). Discard ids per `../recovery.md` lineage.

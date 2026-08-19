# Host: Claude Code

PRIMARY runs in Claude Code. Protocol, board state, and executor argv are host-independent; this
profile owns tool/process/wait mechanics.

## Skill and commands

Claude loads SKILL.md plus project/global slash commands. Bash runs board CLI and child executors;
Read/Edit/Write author PRIMARY turns. The Agent tool enables `subagent:<name>` and optional manager
fan-out.

## Preflight

Before each session, create/read/delete a board probe and run the selected executor's live probe
through Claude's Bash environment. Probe every panel contributor. Auth/version alone is not an
end-to-end check.

## Dispatch watchdog

Use the executor's redirected PID-capture form. Foreground is preferred only while the turn fits the
host's command cap — 10 minutes by default, raised via `BASH_MAX_TIMEOUT_MS`. A wait killed by that
cap leaves the child alive and the turn partial, which costs a rollback, and a reviewing turn
routinely exceeds the default. Either raise the cap above the executor's observed worst case or use
the background path; do not dispatch a turn you expect to outlive its own watchdog. For anything
longer:

1. persist `ACTIVE_RECOVERY` with turn/attempt/start/expected duration/spawn id;
2. launch with PID capture before waiting;
3. schedule bounded background checks within the same host channel;
4. at wake, check board HANDOFF first, then process tree by captured PID;
5. landed -> confirm/lint; unlanded -> `../recovery.md`.

Missing PID is UNKNOWN/possibly alive. Never retry by process-name matching. Background sleep is a
fallback, not durable scheduling; host exit loses it, while the persisted note supports resume.

Compute dispatch UTC immediately before prompt creation:

```text
node -e "process.stdout.write(new Date().toISOString())"
```

Do not substitute a shell date command that returns local time.

## Limit waiting

Follow `../recovery.md`. Claude Code cannot rely on a long foreground sleep; chain bounded
background sleeps up to the host cap, recompute remaining time, and re-dispatch once at reset +
buffer. Persist the note before waiting and do not poll the provider.

## Scratch and adapters

Use OS temp outside project/session, unique per session+turn+attempt. Available: `codex-cli`,
`copilot-cli`, `agy-cli`, `omp-cli`, `reasonix-cli`, `subagent:<name>`, and `manual`. `claude-cli` is
not an independent SECONDARY when PRIMARY is this live Claude host.

For executor paths and redirection, follow the executor profile. A host timeout or notification is
never completion evidence; the board HANDOFF is.

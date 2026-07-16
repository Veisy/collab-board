# Host: codex-cli — orchestrating from the Codex CLI

How the PRIMARY runs the collab-board loop when it is Codex (TUI or `codex exec`). Status:
**SUPPORTED-WITH-CAVEATS** — the mandatory preflight below must pass, and a live dry-run
session is required before relying on this host in production.

## Skill loading

Codex supports `SKILL.md` skills natively — install/point it at the collab-board skill
directory and it loads the same files. An `AGENTS.md` note or `~/.codex/prompts` custom
prompts mirroring the `/collab-*` commands are a convenience fallback only, not the
mechanism.

## MANDATORY preflight (every session, through Codex's OWN shell)

Run these before the first turn; any failure below is **disqualifying for the run** — fix
the posture or move the orchestrator, don't degrade:

1. **Board-write probe** — create and delete a file under `.collab-board/`. A PRIMARY has
   **no scribe fallback** (there is no one to relay its writes), so unreliable board
   writes end the run. On some Windows machines the Codex sandbox denies these writes
   intermittently with no established trigger — probe every session, not once.
2. **Child executor probe** — the short `claude -p ... --output-format json` probe from
   `../executors/claude-cli.md`, run through this same shell. This is the end-to-end
   proof; a local `claude auth status` is NOT sufficient (auth-status can succeed while
   the actual child call is network-blocked).
3. **Network-enabled sandbox posture** — `codex exec -s workspace-write` denies network
   to spawned children by default; set `[sandbox_workspace_write] network_access = true`
   (config or `-c` override), or run with the user's explicit consent at a wider sandbox.
   This relaxes only Codex's own layer — an outer runner/firewall can still block, which
   is why probe 2 must actually run even when this posture is configured.

## Running commands (script + dispatch)

- `node .../collab-board.mjs` subcommands run in the shell as usual (the sandbox permits
  process spawn; it is writes and network that are gated).
- **Timeout is owned by this host's shell runner** — `codex exec` has no per-command
  timeout flag. Give a dispatched secondary turn ≥ 600 s and kill-confirm before any retry
  per the executor failure path: a process-**tree** check rooted at the
  `Start-Process -PassThru` identity captured below (missing identity = UNKNOWN = possibly
  alive, never retry over it; never match by process name).
- No background-notification mechanism is assumed: for long turns, poll the **board**
  (the turn's `HANDOFF` line is the landed criterion), never the process.

On Windows PowerShell, do not paste the executor's POSIX `<`/`>` form (`<` is a parser
error and Windows PowerShell 5.1 can re-encode native redirected output). Use redirected
`Start-Process`; the fixed arguments are individually quoted PowerShell literals, scratch
paths are typed parameters rather than a shell command string, and `-PassThru` exposes the
exit code required by the executor validity rule:

```powershell
$claudeArgs = @(
  '-p', '--safe-mode', '--output-format', 'json',
  '--tools', 'Read,Grep,Glob,Edit,Write',
  '--allowedTools', 'Read', 'Grep', 'Glob',
  'Edit(.collab-board/**)', 'Write(.collab-board/**)'
)
$start = @{
  FilePath = 'claude'; ArgumentList = $claudeArgs
  RedirectStandardInput = $promptPath
  RedirectStandardOutput = $outPath
  RedirectStandardError = $errPath
  WindowStyle = 'Hidden'; PassThru = $true
}
$child = Start-Process @start
Set-Content -Path $pidPath -Value $child.Id -Encoding ascii  # spawn identity BEFORE waiting
$child.WaitForExit()
if ($child.ExitCode -ne 0) { throw "claude exited $($child.ExitCode)" }
```

Immediately before creating `$promptPath`, compute the adapter skeleton's
`DISPATCH_UTC` from host UTC and `HEAD.LAST_UPDATE`; do not let Claude estimate time.

## Waiting out a usage limit (the host wait mechanism)

No background-notification mechanism is assumed here: wait with **foreground shell sleeps
in loop-recomputed chunks of at most 60 seconds** (`sleep 60` / `Start-Sleep -Seconds 60`
— this host's shell runner kills longer blocking waits), recomputing the remaining time
after each chunk, until the reset time + ~2 min buffer passes — then retry the dispatch
once per the shared auto-resume rule (`../adapters.md`). The §4 wait note is written
before the wait begins; during the wait itself nothing further touches the board, and no
calls are spent polling the limit — the retried dispatch is the probe. The wait is
process-local: if the host session dies, the wake is lost — the persisted wait note in
`agents/<primary>.md` plus the host's resume flow recover the session; no OS scheduler is
involved.

## Scratch files

Use a directory outside the project and the session tree (e.g. the OS temp dir), named
unique per session+turn+attempt per the executor spec.

## Available adapters

`claude-cli` (the inverted default), the `codex-cli` **executor** is N/A here (an executor
must differ from the PRIMARY — distinct from this `codex-cli` *host*, see the naming note in
`../adapters.md`), `subagent:<name>` is **unavailable** (no Agent tool in this host),
`manual` (incl. peer mode).

## Host quirks

- Keep every board write **ASCII-only** (lint `L21` — this runtime's write path can
  corrupt pre-existing non-ASCII).
- The sandbox may deny writes mid-session even after a passing preflight; for a PRIMARY
  that is a stall (Rule 5 pause at a saveable point), not a scribe case.

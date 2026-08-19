# Host: Codex CLI

PRIMARY runs in Codex TUI/`codex exec`. Board protocol and executor argv remain host-independent;
this profile owns preflight, PowerShell process mechanics, timeout, and waiting.

## Skill loading

Install/discover the native SKILL.md. AGENTS/custom prompts may expose shortcuts but are not the
protocol source.

## Mandatory preflight

Every session, through Codex's own shell:

1. Create/read/delete one file under `.collab-board`; PRIMARY has no scribe fallback.
2. Run every selected executor's short live probe, including all panel contributors. Version/auth
   alone does not prove child network/process posture.
3. Ensure spawned children have network. `codex exec -s workspace-write` needs
   `[sandbox_workspace_write] network_access=true` (or explicit wider posture); outer controls may
   still block, hence the live probe.

Any failure pauses or moves the orchestrator; never degrade the gate.

## Commands and child processes

Run Node board commands normally. The shell runner owns dispatch timeout (>=600 seconds). Capture
the child PID before waiting and apply `recovery.md` PID-tree confirmation before retry.

On Windows PowerShell, use `Start-Process` redirection; POSIX `<`/`>` is invalid and Windows
PowerShell 5.1 may re-encode native redirected streams. Pass each fixed argument as its own argv
item and scratch paths as typed variables. Example shape:

```powershell
$start = @{
  FilePath = $resolvedExecutable
  ArgumentList = $executorArgs
  RedirectStandardInput = $promptPath
  RedirectStandardOutput = $outPath
  RedirectStandardError = $errPath
  WindowStyle = 'Hidden'; PassThru = $true
}
$child = Start-Process @start
Set-Content -LiteralPath $pidPath -Value $child.Id -Encoding ascii
$child.WaitForExit()
if ($child.ExitCode -ne 0) { throw "child exited $($child.ExitCode)" }
```

Resolve npm launchers deliberately. `Get-Command <bin> -All` may return `.ps1`, `.cmd`, and an
extensionless shim; `Start-Process` on the extensionless/npm shim can fail with "not a valid Win32
application". Launch a native executable, the resolved `.cmd` through `cmd.exe`, or its Node
entrypoint via `node.exe`; keep PID identity rooted at the actual long-lived process.

Compute dispatch UTC immediately before prompt creation:

```text
node -e "process.stdout.write(new Date().toISOString())"
```

Do not use local-time shell date commands. For a long child, poll the board's HANDOFF under the
watchdog; no background completion notification is assumed.

## Limit waiting

Follow `../recovery.md`. Wait in foreground shell chunks of at most 60 seconds, recomputing
remaining time until reset + buffer. Persist `ACTIVE_RECOVERY` before waiting; spend no calls
polling the provider. If this host exits, its process-local wake is lost but the board note allows
resume.

## Scratch and adapters

Use OS temp outside project/session, unique per session+turn+attempt. Available child executors:
`claude-cli`, `copilot-cli`, `agy-cli`, `omp-cli`, `reasonix-cli`, and `manual`. `codex-cli` is not
an independent SECONDARY when PRIMARY is the same live Codex host; `subagent:<name>` is unavailable
without an Agent tool.

Use ASCII board writes: this runtime can corrupt pre-existing non-ASCII while touching a file.
Intermittent PRIMARY write denial after preflight is a pause at the last safe HANDOFF, not scribe.

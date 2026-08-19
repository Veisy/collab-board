# Executor: agy-cli

Dispatch Antigravity/Gemini as `SECONDARY=ANTIGRAVITY`/`ANTIGRAVITY_*`. Verified end-to-end on
Antigravity CLI 1.1.10 (Windows); flags are platform-independent, but probe install/login on Linux,
macOS, and another major release.

## Probes

- `agy --version`.
- `agy models` (binary + authenticated session).
- Short live writer/relay-posture call through the PRIMARY host shell.

If current PATH predates install, resolve the persisted install by absolute path before declaring
it absent. Auth/install failure pauses.

## The dispatch

Use unique scratch files and >=600000 ms host watchdog:

```text
agy -p <scoped-prompt> --add-dir <absolute-project-root>
  --dangerously-skip-permissions --output-format text --print-timeout 20m
  > <stdout> 2> <stderr>
```

Run from the exact project root and capture spawn PID. `--add-dir` is mandatory and must name the
existing exact root. Without it, agy has returned `DONE`, exit 0, and written nothing; a parent
directory can also redirect relative writes. It grants access, not confinement. Permission bypass
is required for unattended tool use; `--print-timeout 20m` replaces a too-short five-minute
default. Add `--disable-slash-commands` when prompt lines begin `/`.

Prompt is argv, so keep it a few KB for Windows' command-line limit. Optional JSON output can
provide machine fields; direct text is sufficient when board confirmation follows. Append model or
effort only when the CLI version supports and SESSION explicitly pins it; otherwise inherit agy.

## Result validity

Exit 0/text is diagnostic only. Direct-write requires shard, TURN_COMMIT, HANDOFF, and lint;
PRIMARY_ONLY requires complete relay/v1. Invalid flag exits 2 with usage stderr; runtime error
typically exits 1/ERROR. Exit 0 with no board/capture is INVALID.

## Execution mode

Foreground, captured PID, host timeout >=600000 ms and CLI print-timeout 20m. The shorter watchdog
must not kill a still-valid turn.

## Failure path

Use `../recovery.md`. Before the one fresh retry, verify exact `--add-dir`, root existence, prompt
length, and full argv. Missing `--add-dir` is a dispatch defect, not WRITE_BLOCKED.

## WRITE_BLOCKED

Only a complete concrete stdout verdict with a correct dispatch may use `../relay.md` scribe rules
and `via=agy-cli relayed_by=<PRIMARY>`. Prefer correcting a missing/wrong add-dir.

## Usage-limit signatures

Exact quota wording is unverified. Classify only from an unlanded run's actual repeatable output;
do not invent a literal that could convert ordinary failure into a long wait. Then apply
`../recovery.md` ambiguous-signature rules.

## Resume

Fresh is default. For deliberate memory, use `--output-format json`, store `conversation_id` in
`EXECUTOR_THREAD`, and resume `--conversation <id>`; never latest `--continue`. Unknown ids silently
start fresh, so compare returned id with requested id and discard on mismatch. Apply recovery
lineage rules.

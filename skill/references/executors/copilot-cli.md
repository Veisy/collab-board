# Executor: copilot-cli

Dispatch GitHub Copilot CLI as `SECONDARY=COPILOT`/`COPILOT_*`. Verified end-to-end on 1.0.78
(Windows). Flags are platform-independent; probe install/login on Linux, macOS, and another major.
Requires `@github/copilot` and `copilot login`.

## Probes

- `copilot --version`.
- Live round trip: `copilot -p "reply OK" --allow-all-tools --no-ask-user -s` (there is no offline
  login-status command).
- Probe project access outside OS temp; Copilot auto-allows temp and can hide a missing add-dir.

## The dispatch

Prompt is argv, not stdin; keep it a few KB. Use unique scratch outputs, captured PID, and
>=600000 ms watchdog:

```text
copilot -C <absolute-project-root> --add-dir <absolute-project-root>
  -p <scoped-prompt> --allow-all-tools --no-ask-user --no-custom-instructions -s
  --autopilot --max-autopilot-continues 30 > <stdout> 2> <stderr>
```

`-C` selects cwd; `--add-dir` separately grants access. Both are mandatory. `--allow-all-tools`
prevents an unattended permission wait; `--no-ask-user` prevents an unanswerable tool call;
`--no-custom-instructions` prevents repo instructions from silently steering independent review.
Autopilot is mandatory: without it Copilot has narrated completion at exit 0 after reading but
before writing. Thirty continuations bounds a multi-step board turn.

Optional `--max-ai-credits <n>` may cap one dispatch. Add model/effort flags only when supported by
the installed version and explicitly pinned; otherwise inherit CLI configuration.

## Result validity

`-s` stdout diagnoses but never proves. Direct-write requires shard, TURN_COMMIT, HANDOFF, and lint;
PRIMARY_ONLY requires complete relay/v1. Exit 0 with no landing is observed and INVALID. An
unresolvable path may produce a wrong-location write and success narration, so verify exact files.

## Execution mode

Foreground with spawn PID and host timeout >=600000 ms; Copilot has no internal print deadline.

## Failure path

Use `../recovery.md`. Before the one fresh retry verify `-C`, `--add-dir`, autopilot, continuation
budget, prompt size, and target paths.

## WRITE_BLOCKED

A complete concrete stdout verdict with unchanged board may follow `../relay.md` verbatim scribe
rules (`via=copilot-cli relayed_by=<PRIMARY>`). Do not summarize or soften findings.

## Usage-limit signatures

Copilot bills AI credits. Treat an unlanded non-zero run with repeatable stderr mentioning credits,
rate limit, or quota as limit-shaped; exact exhausted-credit wording is unverified. Apply
`../recovery.md`, not a guessed literal.

## Resume

Fresh is default. For deliberate continuity, preset `--session-id <uuid>`, store it in
`EXECUTOR_THREAD`, and use `--resume=<uuid>`. The short `-r=<id>` is broken on 1.0.78. JSONL output
can expose `sessionId`/`exitCode`, but the board remains authoritative. Apply lineage rules.

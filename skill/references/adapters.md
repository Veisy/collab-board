# Secondary adapters

Contents: adapter map · interface · shared CLI requirements · direct-write prompt · result routing

## Adapter map

| Adapter | Executor | SECONDARY family |
|---|---|---|
| `codex-cli` | `executors/codex-cli.md` | `CODEX` |
| `claude-cli` | `executors/claude-cli.md` | `CLAUDE` |
| `copilot-cli` | `executors/copilot-cli.md` | `COPILOT` |
| `agy-cli` | `executors/agy-cli.md` | `ANTIGRAVITY` |
| `omp-cli` | `executors/omp-cli.md` | `OMP` |
| `reasonix-cli` | `executors/reasonix-cli.md` | `REASONIX` |
| `codex` | legacy alias of `codex-cli` | `CODEX` |
| `subagent:<name>` | `non-cli-adapters.md` | any |
| `manual` | `non-cli-adapters.md`; includes peer mode | any |

The engine derives canonical CLI entries from `CLI_EXECUTOR_SPECS`; tests reconcile this table, the protocol, lint L18, and SKILL.md with that registry. An executor drives an actor family: `CLAUDE`, `CLAUDE_2`, and `CLAUDE_FRESH` match `claude-cli`; `CLAUDEX` and `CLAUDE_` do not. Actors must be distinct, but models need not be. Same-family review is valid but weaker than a second vendor.

Hosts and executors are orthogonal. A **host** describes the PRIMARY runtime (shell, timeouts, waiting, preflight); an **executor** describes one child CLI (probe, argv, output, vendor facts). Merging them creates a host-by-executor matrix. `codex-cli` names both a host and an executor; `claude-code`/`claude-cli` do not.

## Interface

```text
prepareTurn(sessionId) -> scopedPrompt
dispatch(scopedPrompt, {memory: fresh|resume}) -> rawOutput
confirm(sessionId) -> ok|fail
```

`prepareTurn` reads HEAD and emits the bounded prompt below. Supply `DISPATCH_UTC=max(host UTC now, HEAD.LAST_UPDATE+1ms)`.

`dispatch` is the only vendor-specific step. Fresh is the default, including after a failed attempt. Use resume only with a stored executor id whose lineage still matches the board; see `recovery.md`.

`confirm` re-reads only HEAD plus the new shard, verifies the attempt's `HANDOFF` and shard, then runs lint. **THE REPLY IS NEVER EVIDENCE.** Exit 0, `DONE`, empty stderr, and confident narration do not prove a turn landed. The board must contain both:

```text
turns/<turn-id>-<secondary>.md
TURN_COMMIT <turn-id> ... and its later HANDOFF in log.md
```

The `HANDOFF` is the state-transfer commit point. A shard or `TURN_COMMIT` alone is partial state.

## Shared CLI requirements

- Probe once per session through the PRIMARY host's actual shell. A version/auth check is not the required live call.
- A CLI missing from current `PATH` may still be installed through a persisted user PATH or shell profile. Resolve and probe its absolute path before declaring it absent.
- Run from the project root and keep the board inside the CLI's allowed write root. Convert paths explicitly when an emulation shell launches a native binary (`cygpath -w`/`wslpath -w`).
- Re-check `--help` when the installed major version differs from the executor's verified version.
- Write the prompt and stdout/stderr/PID to unique per-session, per-turn, per-attempt scratch files outside the project and board. UTF-8, no BOM, LF for prompts.
- Capture the spawn PID before waiting. 600 seconds is a floor, not a target: a watchdog shorter than the turn kills the wait, leaves the child alive, and costs a partial-turn rollback. The host owns the watchdog; the executor owns argv and output validity.
- A SECONDARY IMPL turn is review-only; it never edits project source or authors branch/commit state. `BoardWriteMode: PRIMARY_ONLY` should narrow write tools; the PRIMARY lands bytes.
- On success, confirm the board. On any other outcome, stop and read `recovery.md`; do not retry first. A blocked complete verdict also requires `relay.md`.

Every `executors/*.md` file supplies: Probes; Dispatch; Result validity; vendor-specific execution facts; WRITE_BLOCKED signal; limit signatures; resume flag; model/effort argv mapping. Shared recovery sequencing lives only in `recovery.md`.

## Direct-write scoped prompt

Use this block only when `BoardWriteMode` is absent. For `PRIMARY_ONLY`, use the shorter relay prompt in `relay.md`; never send both write blocks.

```text
You are SECONDARY=<SECONDARY> in collab-board session <id>. Project root is the cwd.
Read HEAD.md first; confirm <SECONDARY> has START, else output NOT_MY_TURN and stop. Then follow
the protocol path declared by HEAD.PROTOCOL, whose §0 decides how you weigh evidence, what earns a
point, what a shard costs the turns after it, and when a gate may be refused.

DISPATCH_UTC=<PRIMARY-supplied RFC3339>. Use it plus ordered 1 ms increments for log events and
HEAD.LAST_UPDATE. Never estimate wall-clock time.

READ EXACTLY THESE BOARD FILES, NOTHING ELSE:
  - .collab-board/sessions/<id>/HEAD.md
  - <HEAD.PROTOCOL resolved relative to the session directory> [resumed] (skip if cached)
  [first turn] - .collab-board/sessions/<id>/SESSION.md
  - .collab-board/sessions/<id>/points.md [first SECONDARY turn: after INDEPENDENT candidate]
  - .collab-board/sessions/<id>/<RESPONDS_TO> (first turn: after candidate)
  - .collab-board/sessions/<id>/agents/<secondary_lc>.md
  [IMPL] - .collab-board/sessions/<id>/plan/context.md
  [IMPL] - .collab-board/sessions/<id>/impl/code_state.md

[first SECONDARY turn] From SESSION Topic/Goal/Done plus explicitly scoped task sources, form your
own answer BEFORE opening points.md or the predecessor. Then compare and record one INDEPENDENT
line. ACK the contract in FINDINGS.

Take one <PHASE> turn <NEXT_TURN_ID> responding to <RESPONDS_TO>. Do not run board lint; PRIMARY does.

WRITE IN THIS ORDER:
1. Create turns/<NEXT_TURN_ID>-<secondary_lc>.md (turn/v1; PREV; NEXT: pending).
2. After creation, change only the predecessor's `NEXT: pending` to the new link.
3. Update points.md rows changed by this turn.
4. Ensure log.md ends in newline; append TURN_COMMIT and any POINT_SET/GATE_SET events. Verify the
   first line remains `# Event Log`.
5. Update agents/<secondary_lc>.md — the keys ITS schema declares, plus notes.
6. Atomically rewrite HEAD: hands, gates, cursor, SEQ+1, open-point count, LAST_UPDATE.
7. Append HANDOFF to log.md; it is the commit point.

If a write is denied, output WRITE_BLOCKED plus a complete, exact scribe-ready verdict and
mutations. Output a three-line summary; files are the deliverable.
```

For a Rule 11 step-back response, add before `Take one`: form an independent answer to what would actually converge before opening the predecessor, then challenge its `- REFRAME:` outcome.

The mutex covers the board alone, so a project file can change under a review already in flight and
turn a correct finding into a wrong one. Name the artifacts under scrutiny with the byte size each
had when sent, leave them alone until the turn lands, and pass anything found meanwhile as evidence
to weigh — never as an instruction, never to induce a gate.

Add nothing else by default. A turn that must weigh an executable claim — a gate, a challenge to a measurement, a regression check — carries the executor's verification block and returns `verified=self|reported` on its `GATE_SET`. The PRIMARY decides that split before dispatching: a sandboxed child usually cannot spawn processes, so the PRIMARY runs those checks itself and supplies the exact output as a fact to weigh, never as a claim to accept, while whatever the SECONDARY can reproduce alone comes back `self`. Each executor states what its child runs and whether it can be elevated; an executor that cannot is still a reviewer, not a lesser one.

## Result routing

0. `NOT_MY_TURN`: re-read HEAD and re-delegate the correct turn; never patch state to fit a dispatch.
1. If shard + `TURN_COMMIT` + `HANDOFF` landed and HEAD hands START to PRIMARY, run lint.
2. If lint has only L10, keep the turn; PRIMARY decides next. Any other FAIL is routed by `recovery.md`'s "Lint correction", which decides from §0 whether it is re-delegated or repaired in place; never silently patch authoritative state.
3. If no complete landing, read `recovery.md` and the executor's validity/signature sections.
4. If the complete verdict could not write, read `relay.md`; relay verbatim, never reconstruct.

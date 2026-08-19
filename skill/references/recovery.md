# Dispatch recovery

Read only after an invalid, timed-out, killed, limited, lint-failed, partial, or deliberately resumed
SECONDARY dispatch. The executor supplies vendor signatures/flags; the host supplies process and
wait mechanics. Classify before mutating or retrying.

## Decision order

1. Check the attempt's `HANDOFF`, shard, `TURN_COMMIT`, and HEAD. If fully landed, keep it and lint
   even when the process result is invalid.
2. If the process may still be alive, stop. Kill/check the process **tree rooted at the captured
   spawn PID**. Missing identity means UNKNOWN/possibly alive, never permission to retry. Never
   match by process name.
3. Classify a limit before spending the single failure retry. Auth/install/probe failures pause for
   the user. A complete blocked verdict routes to `relay.md`.
4. Reconcile partial board writes below.
5. Retry once, fresh, with new scratch names and corrected argv/path/stdin. Never overlap attempts.

## Partial-turn recovery

The seven direct-write steps form a contiguous prefix. `TURN_COMMIT` is content durability;
`HANDOFF` is state transfer. Use log replay as oracle.

**ROLLBACK — no `TURN_COMMIT`:** delete the orphan shard, reset the predecessor `NEXT` to pending,
and restore every changed points row (Status and Resolved In) from pre-turn log replay. Agent notes
are non-authoritative. Discard any executor thread id, then retry fresh.

**ROLL-FORWARD — `TURN_COMMIT` exists but `HANDOFF` does not:** preserve committed content. Append
missing POINT_SET derived from persisted points rows versus pre-turn replay (never shard prose),
update the secondary agent mirror, derive/write HEAD, then append HANDOFF with PRIMARY timestamps.
Record the recovery in PRIMARY notes. Do not edit or reorder prior log lines.

All mutable whole-file writes are atomic replacements. Before replay, quarantine a torn final log
line (truncated or no terminal newline) verbatim in PRIMARY notes, then remove only that torn line.

## Lint correction

A landed turn with only L10 remains committed; PRIMARY decides next. Any other FAIL is corrected
according to what it names (§0): a FAIL against authoritative state — HEAD, the log, point rows,
gates, a shard — is corrected by re-delegation, never by rewriting it under the other actor's name;
a FAIL confined to `agents/<actor>.md` is PRIMARY repairing the value in place and disclosing it in
its next shard, because re-delegating would need that actor to write without START (§3). If a failed
landed turn is superseded, discard its stored executor thread id.

## Resume lineage

Fresh is default. Under `agent/v2`, a deliberate stored id lives in `EXECUTOR_THREAD`; an in-flight
attempt/limit wait lives in `ACTIVE_RECOVERY`. Both use explicit `NONE` when empty.

Resume only while the executor's remembered committed lineage matches the board. Discard the id
after rollback, superseded lint-failed content, or any unidentified chain mismatch. Scribe/relay of
the executor's faithful payload preserves lineage. Prefer fresh at PLAN->IMPL for independent
review, though the phase change alone does not invalidate lineage. Failure retries are fresh.

## Usage limits

A known limit is scheduling, not failure or stall. Do not self-review, lower effort, author ahead,
or force STALL_HANDOFF.

- On a declared panel, mark the limited contributor/cell `--absent` and relay surviving captures;
  the recorded gap costs one cell, not the turn.
- For a single SECONDARY, pause at the last confirmed HANDOFF. Record signature, reset, and attempt
  in PRIMARY `ACTIVE_RECOVERY`; announce the safe cursor and resume time without asking permission.
- If reset time is present, wake at reset + about two minutes. Otherwise back off 15, 30, then 60
  minutes (60-minute cap). The host file defines how to wait.
- Re-dispatch once at wake; that dispatch is the probe. Do not poll the provider.
- A no-reset signature is ambiguous on first occurrence: spend the single fresh retry, then classify
  as a limit only if it repeats. Three consecutive capped wakes with the same no-reset signature is
  a hard block; stop scheduling and ask the user.
- Auth, missing binary, invalid credentials, or failed live probe are hard pauses, not limits.

A known limit wait is not Rule 5 silence; an expected L9 staleness warning is explained by the
persisted recovery note. If PRIMARY itself is limited, the user resumes the crash-safe board later.

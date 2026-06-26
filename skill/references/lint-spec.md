# Lint specification

`node scripts/collab-board.mjs lint --session <id>` (or `--all`) is **read-only**. It
recomputes every denormalized field from its authoritative source and prints one line per
finding — `PASS`, `WARN <code> ...`, or `FAIL <code> ...` — exiting non-zero if any `FAIL`.
Run it after **every** turn (especially each secondary delegation) and before any
phase/terminal transition. `--quick` skips the full-log projection (L2) for hot-loop use.

Authoritative sources, by field:

- hand-state, phase, cursor, gates → `HEAD.md` (and re-derivable from `log.md` via L2)
- point statuses / open count → `points.md`
- impl metadata → `impl/code_state.md` + the impl shard
- contract → `SESSION.md`

| Code | Severity | Rule | Checks |
|------|----------|------|--------|
| L0 PRECONDITION | FAIL | — | The session directory has no `HEAD.md` — there is nothing to verify, so lint reports this and stops (no other checks run for that session). |
| L1 SPLIT-STATE | FAIL | 1 | A full State-section assignment `- <ACTOR>: <HAND> - <ROLE>` appears in any file other than `HEAD.md`. (Anchored on the trailing ` - <ROLE>`, so prose/notes bullets, `SELF_HAND:` mirrors, and turn Handoff lines don't match.) Also FAILs if `HEAD.md ## State` lists the same actor name twice — PRIMARY and SECONDARY must be distinct. |
| L2 PROJECTION | FAIL | 1,4 | Replay `log.md` (OPEN/STATE_SET/HANDOFF/STALL_HANDOFF/GATE_SET/PHASE_SET/TERMINAL) → recompute hands, phase, gates, SEQ → assert equal to `HEAD.md`. `STALL_HANDOFF` flips the stalled actor to `ON_HOLD` and the `next=` actor to `START` (it carries `seq=`, like a handoff), so a Rule 5 recovery replays cleanly. Divergence means `HEAD` is corrupt; the log wins. Skipped under `--quick`. |
| L3 DUAL-START | FAIL | 4 | While `SESSION_STATUS=ACTIVE`, exactly one hand is in {START,WORKING}; hand tokens are valid; `NEXT_ACTOR` equals that holder. Also emits a **WARN** (advisory) if an `IDLE` session has any `START`/`WORKING` hand. |
| L4 PLAN-GATE | FAIL | 3,10 | `PLAN_OPEN_POINTS` equals the actual count of `OPEN` `P*` rows. If `PHASE=IMPL`: that count is 0, both `PLAN_AGREE_*=YES`, and `plan/context.md` is a real digest (not `STATUS: EMPTY`). Also: any `\| <id> \|`-shaped point row that fails to parse cleanly (e.g. missing trailing pipe) is a FAIL — an unparseable OPEN point must never be silently treated as resolved. |
| L5 IMPL-BEFORE-GATE | FAIL | 3 | Any `I*` turn shard / `TURN_COMMIT` exists but there is no prior `PHASE_SET PLAN->IMPL` in the log. |
| L6 IMPL-AUTHORITY | FAIL | 7 | A SECONDARY impl turn carries a real `BRANCH` or `LATEST_COMMIT` (the markers that it authored code — review-only turns omit the `Impl:` line). A PRIMARY impl turn leaves any of `BRANCH/BASE_COMMIT/LATEST_COMMIT` at the `—`/`-` placeholder (in `impl/code_state.md` or the shard). The literal `NONE` is a VALID "no git / not tracked" value — a non-git repo, or before the first commit — and passes. |
| L7 CONTRACT | FAIL | 2 | `P1` exists but `SESSION.md` still has `Topic`/`Goal`/`Done` = `—`. |
| L8 ACK | WARN | 2 | The secondary's first turn body does not mention `ACK` of the contract. |
| L9 STALL | WARN | 5 | `now − LAST_UPDATE > CHECK` → WARN; `> CHECK+HANDOFF` with no `STALL_HANDOFF` logged → WARN (advisory only — a paused-but-healthy board must not hard-FAIL; if the owed actor is truly silent, log `STALL_HANDOFF` and force the handoff). Timers from `SESSION.Stall`. |
| L10 DEADLOCK | FAIL | 6 | A point still `OPEN` with more than 3 `TURN_COMMIT`s referencing it and no `DECISION` line. |
| L11 TERMINAL | FAIL | 8 | `SESSION_STATUS` terminal but both hands ≠ `DONE`; or a `TURN_COMMIT`/`HANDOFF` logged after the `TERMINAL` line; or `SESSION_STATUS=COMPLETED` without (`PHASE=IMPL` and both `IMPL_AGREE_*=YES`) — the completion gate. |
| L12 ESCALATION | WARN | 9 | A turn body has `USER_QUESTION:` but there are fewer matching `USER_QUESTION` log lines. |
| L13 TURN-SCHEMA | FAIL | turn fmt | A `turns/*.md` shard is missing a required line (heading, `Header`, `Body`, `Evidence`, `Handoff`, `PREV:`, `NEXT:`); a PRIMARY IMPL shard missing its `Impl:` line. |
| L14 CHAIN/ORPHAN | FAIL | §3 | Every shard has a matching `TURN_COMMIT` and vice-versa (an orphan = crash mid-turn); `HEAD.RESPONDS_TO` resolves; and each shard's `PREV` link target exists (`NEW` excepted). |
| L15 MIRROR-DRIFT | WARN | 1 | `agents/<a>.md` `SELF_HAND` ≠ that actor's hand in `HEAD.md`, for an actor **not** at `START` or `DONE`. Both are skipped because their mirrors are legitimately stale: a `START`-holder set `SELF_HAND=ON_HOLD` ending its last turn and hasn't acted yet, and a `DONE` actor was flipped by `terminal` (an engine action, not a turn — and a terminated session takes no more turns, so the drift is moot). L3 guarantees at most one `START` holder, so a genuine stale mirror on an ON_HOLD/WORKING actor is still caught. |
| L16 CATALOG-SYNC | WARN | catalog | The `index.md` row for this session disagrees with `HEAD` on Status/Phase. Reconciled to `ACTIVE` by `activate` on the first turn, and by `advance`/`terminal`/`reset` thereafter. |
| L18 CODEX-ADAPTER | FAIL | adapter | `SecondaryAdapter: codex` but `Roles` are not `PRIMARY=CLAUDE, SECONDARY=CODEX` — the codex plugin runs inside Claude Code, so the codex adapter is valid only for that pairing. |
| L19 EVIDENCE-ON-RESOLVE | WARN | evidence | A turn that **resolves** a point (a `POINT_SET` to a non-`OPEN` status in the log) has an `- Evidence:` line whose inline value is literally `N/A`. Advisory only (never FAIL): a resolved decision should cite resolvable evidence (`file:line`, command/test output, doc/URL). Whether a claim is "disputed" is prose guidance, not lintable — L19 flags only the explicit empty-evidence token, never judges content. Reinforces "challenge and ask with evidence"; mutual agreement is not verification. |
| L20 GATE-AUTHORSHIP | FAIL | 10 | A `GATE_SET` whose `by=<ACTOR>` disagrees with the gate's role suffix (`*_PRIMARY`/`*_SECONDARY`) — i.e. one actor flipping the other's agreement gate (a forged sign-off). Each gate is set by its own actor; this is the machine-checkable half of the §4 anti-rubber-stamp norm (`justified_by=`/`relayed_by=` are not matched). |

*(L17 — formerly `EXPECT≠PHASE` — was retired when `HEAD.EXPECT` was removed in a hardening pass; the id is intentionally not reused, hence the L16→L18 gap.)*

**Remediation, in general:** a `FAIL` means a write step was skipped or done out of order.
Because `HEAD.md` is written last and the `HANDOFF` log line is the commit point, an
incomplete turn is recoverable: either complete the missing writes (then re-lint) or, for an
orphan shard with no `HANDOFF`, delete the orphan and re-delegate the turn. Never paper over a
projection (L2) mismatch by editing `HEAD` to match a wrong assumption — reconcile against the
log, which is the immutable derivation.

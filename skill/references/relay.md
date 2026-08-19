# Relay and panels

Read this file only for `BoardWriteMode: PRIMARY_ONLY`, `SecondaryPanel`, or a complete verdict
whose write was blocked. The PRIMARY is the sole board writer in every case.

## Scribe fallback

When a write-capable SECONDARY returns a complete verdict plus exact mutations but no shard,
`TURN_COMMIT`, or `HANDOFF` landed, preserve the work: transcribe it verbatim and log
`via=<adapter> relayed_by=<PRIMARY>`. Do not scribe vague prose or invent missing mutations.

- Stamp real relay-time UTC; never reuse proposed timestamps.
- Transcribe turn, points, gates, and event intent, not only prose.
- After one environmental `WRITE_BLOCKED`, later turns in that session may request a scribe-ready
  verdict directly. Retry writes in the next session; the denial is not assumed permanent.
- `confirm()` and lint remain mandatory. A faithful scribe does not invalidate resume lineage.

## Sole-writer mode

Add before the first turn:

```text
BoardWriteMode: PRIMARY_ONLY
```

The SECONDARY never edits `.collab-board`; it returns `relay/v1`, and `relay` performs all board
writes. Existing sessions without the key retain direct-write behavior. Lint L25 requires every
relayed SECONDARY `TURN_COMMIT` to include `relayed_by=<PRIMARY>`, positive `attempt=`, and retained
capture hashes. Hashes prove retained bytes, not that a fused shard preserved every finding.

## `relay/v1`

Request exactly:

```text
RELAY: collab-board/relay/v1
SESSION: <session-id>
ACTOR: <SECONDARY>
TURN: <NEXT_TURN_ID>
--- TURN ---
<complete turn/v1: Header, Body, Evidence, Handoff; PREV/NEXT optional>
--- LOG ---
<POINT_SET lines and this actor's *_SECONDARY GATE_SET, without timestamps>
--- POINTS ---
<id=STATUS; for a new id use `id=STATUS | title`>
--- END ---
```

`--- END ---` is mandatory. Section markers occur once, in order, at column 0; indent a marker
quoted inside prose. `--- LOG ---` accepts only `POINT_SET` and the contributor's own SECONDARY
gate. A legacy ordered `--- HEAD ---` section is accepted but ignored; new captures omit it.

Use the session-declared protocol path in the relay prompt. Its read list matches the direct prompt
in `adapters.md`; replace the seven-step write block with: "Do not modify files. Return one complete
relay/v1 capture ending `--- END ---`." Do not send both modes.

## Landing a capture

```text
node "$SKILL/scripts/collab-board.mjs" relay --session <id> \
  --capture <TURN>-<who>.relay[,<TURN>-<who2>.relay...] \
  [--fused <file>] [--attempt <n>] [adjudication flags]
```

Capture basename is `<TURN_ID>-<contributor>.relay`, contributor `[A-Za-z0-9_]+`; cell captures use
`<TURN>-<MODEL>_S<n>.relay`. Scratch files stay outside the board; relay retains validated copies
under `captures/`. Attempt is a positive integer.

Relay is legal only while SECONDARY holds START. It validates every input before mutation, then:

1. retains captures;
2. writes the shard and predecessor link;
3. applies point rows and appends `TURN_COMMIT` plus capture events with PRIMARY timestamps;
4. updates `agents/<secondary>.md`;
5. derives HEAD state/cursor/gates/open count/time;
6. appends `HANDOFF`.

`relay` completes steps 5–7 itself; PRIMARY must not repeat actor, HEAD, or HANDOFF writes. Confirm
PRIMARY START, bumped cursor/SEQ, shard, `TURN_COMMIT`, `HANDOFF`, then lint.

## Fusion and adjudication

One capture is copied byte-for-byte; `--fused` is forbidden because it would let PRIMARY replace a
single SECONDARY's verdict under that actor's name. Two or more captures require a fused shard that
names every contributor. Captures remain the audit record because no check can detect an omitted
finding inside a named contributor.

Contributors propose; the fused turn decides:

- Conflicting statuses refuse until `--resolve <id>=<STATUS>` selects a contributor or PRIMARY
  ruling; `adjudicated=` records the choice and the shard preserves dissent.
- Two distinct new titles under one id refuse. Use `--renumber <id>:<who>=<newid>` for distinct
  findings or `--merge <id>:<who>` for corroborating wording. Relay records the decision. A new id
  always needs a title; `|` in a title is invalid.
- A capture contradicting its own LOG/POINTS status or title is malformed and re-delegated, never
  adjudicated.
- Byte-identical captures are one contributor filed twice and refuse.
- Before relay, points.md may be re-rendered from log projection; stdout reports repaired drift.

Gates are unanimous. With several contributors, write a SECONDARY gate only when every counted
contributor offers it; otherwise record `gate_partial=<GATE>:<k>/<n>`. Every offered gate records
`gate_set=<GATE>:<k>/<n>`. There is no PRIMARY override for a SECONDARY gate. Record
`gate_family=` when declared or actual contributors include PRIMARY's family; this discloses a
weaker gate without banning it.

## Panels and cross-product sweeps

A panel requires two or more distinct registered CLI executors and sole-writer mode:

```text
BoardWriteMode: PRIMARY_ONLY
SecondaryPanel: agy-cli,copilot-cli
```

Dispatch every contributor independently, fuse their one SECONDARY turn, then relay all captures.
A turn may also split into disjoint scopes: contributors x scopes. Every declared cell needs a
capture or `--absent <CELL>`; ordinary fused turns may declare `--absent <CONTRIBUTOR>`. Absence is
valid only against a declared roster, cannot accompany that contributor's capture, and is logged.
A missing some scopes contributor still counts for gates where it contributed.

No numeric cap exists. Add scopes only when their read-sets are disjoint; add contributors for
model/vendor decorrelation. Repeating the same contributor on the same scope buys neither. The
engine checks product completeness and duplicate contributors, not whether scopes are honestly
disjoint.

The gate denominator is the union/floor implied by the declared roster and captures actually
relayed, minus valid full absences. This prevents dispatch-many/relay-one from masquerading as a
unanimous panel.

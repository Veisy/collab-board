# Optional PRIMARY manager pattern

Read only when PRIMARY delegates parts of its own turn or when no permanent panel preference is
stored. Normal dyad turns do not need this file.

## Fan-out safety

PRIMARY is the sole writer of the board AND of project files (protocol Rule 7). A subagent reads,
searches, and returns findings or a patch payload written OUTSIDE the repo; PRIMARY reviews it and
applies it. One rule covers every delegate — a DeepSeek reader, a Claude subagent, a panel
contributor — so there is no class of helper that writes and no seam where the permission differs.

1. Run `fanout --seal` before dispatch and `fanout --verify --expect <digest>` after every report
   returns, before PRIMARY writes its turn. A mismatch detects an unauthorized board write; discard
   the candidate turn.
2. Split by disjoint read-set. One agent per independent operation buys coverage; multiple vendors
   on the same operation buy decorrelation. The SECONDARY panel product is scopes x contributors.
3. A scope must name what it reads. Extra agents on the same model/read-set spend tokens without
   adding either property. There is no fixed cap; decomposition is the bound.
4. Fuse one coherent turn and attribute every contributor plus scope. On SECONDARY relay this is
   mechanical; on PRIMARY it is auditable prose. Attribution cannot detect a dropped finding.
5. Retain PRIMARY-side reports for PLAN->IMPL and terminal turns because no later SECONDARY turn
   reviews those fusions. Reports stay outside board state and are cited from the turn.

Fan-out does not change the bounded board read-set; it intentionally increases total turn tokens.

## Why the driving seat is not itself delegated

Recurring proposal, rejected more than once, recorded here so it is not re-derived from scratch:
replace the PRIMARY with a thin manager that renews its context each turn and delegates the turn's
thinking wholesale.

**START is scoped to the ACTOR, not to the process.** Rule 4 admits one hand at a time, and the hand
belongs to the seat named in `HEAD.md`. Renewing the process behind that seat transfers no authority
and creates no second turn: a delegate that writes the board while the PRIMARY holds START is the
PRIMARY writing the board, with the accountability spread thinner. Nothing in the protocol forbids
the arrangement — that is exactly the problem, because nothing distinguishes it from the PRIMARY
simply doing the work, while the fusion step adds a place for a finding to be dropped silently.

What the manager pattern above DOES buy is bounded: extra coverage on disjoint read-sets, and
decorrelation across vendors, both inside one turn the PRIMARY still owns and signs. What it does
not buy is a smaller PRIMARY context, because the PRIMARY must read enough to attest what it signs.
A proposal to shrink the driving seat has to answer that, not restate the goal.

## Permanent panel preference

Panel availability belongs to the user's machine, not a session. Use
`~/.collab-board/preference.md` (override with `COLLAB_BOARD_HOME`) to avoid asking repeatedly.
`new`/`doctor` only display it; the engine never branches on it.

- Deduce an explicit request. If the request is silent and no record exists, ask once:
  "collab-board works best with several models (for example Claude + Codex). Add other models to
  the panel, or use copies of the same model?"
- Record only a durable instruction (`always`, `from now on`, or the direct answer), quoting its
  evidence. A one-off choice changes only the current SESSION.
- Record a declined choice as `Panel: no-preference` so it is not asked twice.

```text
Panel: multi-vendor (codex-cli, agy-cli)
Recorded: 2026-08-10
Evidence: "always use codex and gemini together"
```

The preference is advisory and outside board invariants. Registered executors are not necessarily
installed; `doctor` is advisory, and an absolute-path live probe is authoritative.

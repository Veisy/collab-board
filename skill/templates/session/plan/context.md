# Frozen Plan — {{ID}} (collab-board/context/v1)

<!-- Written ONCE by the gate-crossing actor at the PLAN→IMPL transition, then immutable.
     It is the ONLY plan artifact an IMPL turn reads, so it must faithfully digest the
     agreed plan. Link the source turns so a rare drill-down stays bounded.
     ENUMERATE every file the IMPL phase will touch — including cross-cutting consistency files
     (catalog/index, logs, a schema's status section) — so the SECONDARY's review doesn't flag
     legitimate consistency propagation as scope creep.
     IMPL must not begin while this file still says STATUS: EMPTY. -->

STATUS: EMPTY

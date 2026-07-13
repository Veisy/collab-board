# Event Log — {{ID}} (APPEND-ONLY)
SCHEMA: collab-board/log/v1

<!-- Append one event line per state change (see PROTOCOL.md §8). Events, not prose.
     The HANDOFF line is the commit point of a turn. Never edit or delete earlier lines. -->

{{TIMESTAMP}} OPEN session={{TYPE}} by={{PRIMARY}}

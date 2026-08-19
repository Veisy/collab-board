# Non-CLI adapters: `subagent:<name>`, `manual`, peer mode

Read only when `SecondaryAdapter` names one of these. A CLI thread never reads this file; it reads
one `executors/*.md` instead. The common interface, the direct-write prompt and result routing stay
in `adapters.md` and apply here unchanged — these are adapters, not a second protocol.

## `subagent:<name>`

Only hosts with an Agent tool support this adapter. Dispatch the same scoped prompt with the named
subagent synchronously; strict alternation leaves PRIMARY no legal board work while SECONDARY has
START. The subagent needs BOARD write access — the same scoped prompt forbids editing project
source, and Rule 7 reserves project files for the PRIMARY — and logs `via=subagent:<name>`.

- `SecondaryModel` -> the Agent tool's model parameter, which is how a second MODEL takes the seat
  when no second vendor is reachable.
- `SecondaryEffort` -> no mapping; the Agent tool exposes no effort control. Declaring it on a
  subagent board records an intent nothing applies, so leave it out.

Absent, the model comes from the named subagent's own definition, not from any CLI configuration.

A subagent runs inside the PRIMARY's host, so it usually inherits that host's tools rather than a
child CLI's sandbox. Where that includes a shell, this SECONDARY can execute the checks a sandboxed
child cannot and its gate can honestly say `verified=self` — the reason to prefer it once a
cross-vendor CLI is unavailable. Same host also means same vendor: a different model removes
anchoring, not a blind spot the family holds by construction, so record the weaker gate rather than
claiming the stronger one.

## `manual` and peer mode

For a non-write-capable model or human, print the scoped prompt and ask the user to relay the
answer. The PRIMARY may transcribe a complete verdict under `via=manual relayed_by=<PRIMARY>`;
follow `relay.md` scribe fidelity rules.

Peer mode uses two interactive agents on one shared board. Each reads its declared protocol and
acts only when HEAD gives it START; the user normally nudges the terminals. A self-authored peer
turn omits `via=`. Poll only the HEAD hand line when a host provides a bounded wake mechanism.

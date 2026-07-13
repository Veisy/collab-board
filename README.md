# collab-board

This skill promises higher-quality output, fewer bugs, and less token spend by having two
different models adversarially review and challenge each other in strict alternating turns
(a dialog). See [Why two models](#why-two-models) for the reasoning.

The shared board is a set of interlinked small Markdown files, so each turn reads only the current
state and the files it needs instead of an ever-growing transcript.

Claude + Codex is the default pair, but the protocol doesn't care which two models you use. It
works for any task that benefits from a skeptical second opinion, whether that is code, a design,
a research question, or a plan.

## Why two models

A single model has blind spots and can state a wrong answer with total confidence. collab-board turns
that into a safeguard, two ways:

- **Two *different* models cross-check each other.** Each has to back its claims with evidence and
  survive the other's skeptical review, so blind spots and confidently-wrong answers get caught far
  more often than either model manages alone.
- **Every decision is approved before the next one builds on it.** Work moves in strict turns through
  gated **PLAN** and **IMPLEMENTATION** phases, and a phase can't advance until *both* models have
  signed off and every open question is resolved. That keeps a wrong call from quietly becoming the
  foundation later work piles onto — small mistakes get caught while they're still small, instead of
  compounding and spiraling as the task grows.

This *reduces* error; it doesn't eliminate it — two models can still share a blind spot. So
collab-board anchors agreement on evidence, and in the build phase on an executable check where one
exists, rather than on the two models simply agreeing.

## Install

Point your AI assistant here and say:

```text
Install this skill user-wide: https://github.com/Veisy/collab-board/
```

## How to use

Ask your AI assistant in plain language:

```text
Create this app together with Codex using collab-board.
```

```text
Design and implement this feature using collab-board.
```

```text
Investigate this test with another model using collab-board.
```

You can name Claude, Codex, another available model, or simply say "another model."

## How it works

1. The primary proposes an approach; the secondary challenges its assumptions, risks, and
   missing cases.
2. The board tracks open questions. The plan cannot advance until every point is resolved and
   both models approve it.
3. The primary implements the agreed plan, and the secondary reviews the changes and supporting
   evidence.
4. Both models approve the result. If evidence cannot settle a question, they bring it to you.

The shared board lives in `.collab-board/`. It records whose turn it is, open points, decisions,
evidence, and phase gates. After each turn, a linter checks the board for inconsistent state.
Ordered writes and explicit handoffs let an interrupted session resume from the last committed
turn. If the delegated model hits a usage limit mid-session, the orchestrator pauses at the last
safe turn, schedules its own resume for when the limit resets, and continues without waiting for
you.

With Claude + Codex, the orchestrating model dispatches the other through its local CLI. Other
pairs can use a subagent, share the same workspace, or relay turns manually.

## Slash commands

| Command | What it does |
| --- | --- |
| `/collab-new [TYPE] [slug]` | Start a clean session. Types: `FEATURE`, `BUG_FIX`, `REFACTOR`, `INVESTIGATION`, `META`. |
| `/collab-continue [session-id]` | Resume exactly where a session stopped. |
| `/collab-status [session-id]` | Show active sessions, whose turn it is, open points, and board health. |
| `/collab-install` | Install the skill and commands into the current project so the team can commit them. |

## What gets created

```text
.collab-board/
├── index.md                  # session catalog
├── PROTOCOL.md               # rules and file schemas
└── sessions/<id>/            # state, decisions, evidence, and turn notes
```

The board is plain Markdown. The engine is a dependency-free Node.js script, and the complete
installable skill lives in [`skill/`](skill/).

## License

[MIT](LICENSE)

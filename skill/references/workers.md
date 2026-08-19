# Workers — delegated execution outside the board

Read only when the PRIMARY delegates a well-defined job. Normal turns do not need this file.

A **worker** is not a seat. PRIMARY and SECONDARY think, plan, design and review; a worker executes
one job and holds no seat, hand, turn, point or gate. It never appears in `HEAD.md`, is never a
`SecondaryAdapter` value, and adds nothing to board state. An N=2 board is byte-identical whether
workers are used or not.

"Executor" means something else here — `references/executors/*.md` are the CLI harnesses that drive
a SECONDARY **seat**. A worker drives no seat.

## The rule this preserves

Protocol Rule 7 gives project-file authority to the PRIMARY. A SECONDARY reviews project files and
never edits them, and that is unchanged. A worker is dispatched by the PRIMARY, inside the PRIMARY's
own IMPL turn, and **the PRIMARY attests the diff before HANDOFF**.

**Applicability is per snapshot, not per install.** Rule 7 now states this clause, so a board whose
pinned `PROTOCOL.md` contains it may use the tier. A board pinned BEFORE that amendment is governed
by the snapshot it pinned, in which the worker tier does not exist: on such a board the PRIMARY
authors every project edit itself, and a worker may only read, measure, or return a patch payload
outside the repository for the PRIMARY to review and apply. Reading this file does not grant the
authority — the session's own snapshot does. That is the same rule that makes an immutable snapshot
worth pinning, applied to the tier that most wants to escape it.

## Zero board context

The worker prompt carries exactly: the task, a read manifest, a write manifest, a base revision,
acceptance criteria, allowed commands, the working directory, and a timeout. It carries **no** board
file, no protocol, no turn format and no session history. Isolation comes from a fresh context and
an executor sandbox that cannot reach `.collab-board`, not from scanning the prompt for board words:
a paraphrase walks past a word list, and a legitimate task that happens to name one fails it.

## The diff is the deliverable

```text
node "$SKILL/scripts/worker.mjs" baseline --out <scratch outside the repo>
  ... dispatch the worker ...
node "$SKILL/scripts/worker.mjs" verify --baseline <file> --allow <paths> [--expect-changes]
```

`verify` refuses if a change lands outside the write manifest; if anything under `.collab-board`
changed at all, which it reads off the filesystem so the refusal inherits none of git's blind spots
and no `--allow` entry can grant it; if `HEAD` moved (a worker that commits makes its own diff
disappear); if a change that existed before the dispatch is gone (it reverted work it did not own);
if `git diff --check` reports damage; or, for a write job, if nothing changed at all — an empty diff
is not a completed task.

On a clean verify **the PRIMARY does not read the worker's transcript**. That is the saving. Read it
only when verification fails, and read it raw: filtering diagnostics is an optimisation that must be
measured before it ships, because dropping a line that looked like noise can remove the cause.

A **read** job has no diff, so its answer is its output and the PRIMARY must read it. `--expect-changes`
is what distinguishes the two; without it an unchanged tree is fine.

## What verification is not

Verification is not confinement, and `worker.mjs` prints its scope on every run. It compares the
paths git reports as differing from HEAD, by content, plus HEAD itself, plus the board tree. Outside
the board it does not see an ignored path, a mode-only change, a symlink retargeted to identical
bytes, `.git` internals, paths outside the repository, or anything done off disk. Every one of those
was found by review rather than by reasoning, which is why this is stated as a boundary and not a
guarantee. `assume-unchanged`/`skip-worktree` left the list when the flags themselves became
compared state: they were the only entry a worker could reach without leaving the repository, since
setting one is a legitimate git operation on a permitted path, and a flag set mid-dispatch silences
every check that reads `git status`. The comparison is on the flag lines, not on which path they
name — no manifest grants the right to disable the check that reads it. Deny them at dispatch with the executor's own sandbox;
this is the second check, sound only to the extent the first one held. Nor does a green check mean the work
is *right*: tests and clean mechanics are necessary controls, never a semantic oracle, so the
PRIMARY inspects the diff and accepts or reverts it.

## One at a time

One sequential worker. Disjoint write manifests do not make parallel workers safe — generated files,
shared APIs, test state and one worker reading another's half-written output all conflict through
paths no manifest mentions. Parallelism needs isolated worktrees pinned to one base, declared read
dependencies and a PRIMARY-controlled merge; path refusal alone is not a concurrency model.

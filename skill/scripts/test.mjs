#!/usr/bin/env node
// Dependency-free self-test for the collab-board engine. Run:  node scripts/test.mjs
//
// It drives the REAL CLI (collab-board.mjs) on throwaway boards under the OS temp dir and asserts
// lint behavior — the engine's whole value is the correctness of these invariants, so they get a
// guard. Assertions are targeted: a fixture deliberately corrupts ONE thing and we check the
// specific code fires (other findings on the same board are tolerated). Exits non-zero on failure.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "collab-board.mjs");

let passed = 0, failed = 0;
const ok = (name, cond) => {
  if (cond) { passed++; console.log("  ok    " + name); }
  else { failed++; console.log("  FAIL  " + name); }
};

function run(args, root) {
  try { return { code: 0, out: execFileSync(process.execPath, [CLI, ...args, "--root", root], { encoding: "utf8" }) }; }
  catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` }; }
}
function scaffold(type = "FEATURE", slug = "selftest") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-selftest-"));
  const r = run(["new", "--type", type, "--slug", slug], root);
  const id = (r.out.match(/Created session (\S+)/) || [])[1];
  if (!id) throw new Error("scaffold failed:\n" + r.out);
  return { root, id, dir: path.join(root, ".collab-board", "sessions", id) };
}
const lint = (root, id) => run(["lint", "--session", id], root);
const has = (out, code) => new RegExp(`\\b${code}\\b`).test(out);     // word-boundary: L1 ≠ L15
const file = (dir, ...p) => path.join(dir, ...p);
const read = (p) => fs.readFileSync(p, "utf8");
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const edit = (p, fn) => write(p, fn(read(p)));

// Preflight: this harness drives the REAL CLI via nested `node` child processes. Some sandboxes
// (e.g. a workspace-write SECONDARY like the codex adapter) block spawning nested processes —
// execFileSync then returns status=null with empty output, which would surface as a confusing
// "scaffold failed". Detect that up front and SKIP cleanly (exit 0) so a sandboxed reviewer gets a
// clear signal instead of a false failure. A normal run probes OK and executes every assertion.
function canSpawnNode() {
  try { return execFileSync(process.execPath, ["-e", "process.stdout.write('cb-ok')"], { encoding: "utf8" }).trim() === "cb-ok"; }
  catch { return false; }
}
if (!canSpawnNode()) {
  console.log("SKIP: this environment blocks nested Node process spawning (e.g. a sandboxed runner).");
  console.log("      The self-test drives the real CLI as a child process, so it cannot run here —");
  console.log("      run it in an unsandboxed environment. `lint --all` remains the production invariant.");
  process.exit(0);
}

console.log("collab-board self-test\n");

// 1. A freshly scaffolded board is clean (exit 0, no FAIL findings).
{
  const { root, id } = scaffold();
  const r = lint(root, id);
  ok("fresh scaffold lints clean (exit 0)", r.code === 0 && !/\bFAIL\b\s+L\d/.test(r.out));
  ok("fresh scaffold has no L17 (EXPECT removed, P6)", !has(r.out, "L17"));
}

// 2. L14 CHAIN/ORPHAN — a turn shard with no TURN_COMMIT in the log is an orphan.
{
  const { root, id, dir } = scaffold();
  write(file(dir, "turns", "P1-claude.md"), "### TURN-P1 (CLAUDE)\nSCHEMA: collab-board/turn/v1\n");
  const r = lint(root, id);
  ok("orphan shard → L14 FAIL", r.code !== 0 && has(r.out, "L14"));
}

// 3. L3 DUAL-START — two actors at START while ACTIVE.
{
  const { root, id, dir } = scaffold();
  edit(file(dir, "HEAD.md"), (t) => t
    .replace("SESSION_STATUS: IDLE", "SESSION_STATUS: ACTIVE")
    .replace("- CLAUDE: ON_HOLD - PRIMARY", "- CLAUDE: START - PRIMARY")
    .replace("- CODEX: ON_HOLD - SECONDARY", "- CODEX: START - SECONDARY"));
  const r = lint(root, id);
  ok("dual START → L3 FAIL", r.code !== 0 && has(r.out, "L3"));
}

// 4. L4 PLAN-GATE — PLAN_OPEN_POINTS must equal the count of OPEN P* rows.
{
  const { root, id, dir } = scaffold();
  edit(file(dir, "points.md"), (t) => t.trimEnd() + "\n| P1 | PLAN | x | OPEN |  |\n");  // HEAD still says 0
  const r = lint(root, id);
  ok("open-point count mismatch → L4 FAIL", r.code !== 0 && has(r.out, "L4"));
}

// 5. L6 IMPL-AUTHORITY / git-optional (P1) — a PRIMARY impl turn needs real code_state; `—` is
//    rejected, the literal NONE is accepted (no-git).
{
  const { root, id, dir } = scaffold();
  write(file(dir, "turns", "I1-claude.md"),
    "### TURN-I1 (CLAUDE)\nSCHEMA: collab-board/turn/v1\n- Impl: BRANCH=NONE BASE_COMMIT=NONE LATEST_COMMIT=NONE\n");
  edit(file(dir, "impl", "code_state.md"), (t) => t
    .replace("BRANCH: —", "BRANCH: NONE")
    .replace("BASE_COMMIT: —", "BASE_COMMIT: NONE")
    .replace("LATEST_COMMIT: —", "LATEST_COMMIT: NONE"));
  ok("code_state=NONE accepted (no L6) for a PRIMARY impl turn", !has(lint(root, id).out, "L6"));
  edit(file(dir, "impl", "code_state.md"), (t) => t.replace("BRANCH: NONE", "BRANCH: —"));
  ok("code_state=`—` placeholder → L6 FAIL", has(lint(root, id).out, "L6"));
}

// 6. L15 MIRROR-DRIFT (P7) — skip the START-holder (legitimately stale), still flag others.
{
  const { root, id, dir } = scaffold();
  edit(file(dir, "HEAD.md"), (t) => t
    .replace("SESSION_STATUS: IDLE", "SESSION_STATUS: ACTIVE")
    .replace("- CODEX: ON_HOLD - SECONDARY", "- CODEX: START - SECONDARY")
    .replace("NEXT_ACTOR: CLAUDE", "NEXT_ACTOR: CODEX"));
  // CODEX holds START with a stale ON_HOLD mirror (expected) — must NOT warn.
  // CLAUDE is ON_HOLD with a WORKING mirror (real drift) — must warn.
  edit(file(dir, "agents", "claude.md"), (t) => t.replace("SELF_HAND: ON_HOLD", "SELF_HAND: WORKING"));
  const r = lint(root, id);
  ok("L15 flags real drift on the non-START actor (claude)", /L15.*claude\.md/.test(r.out));
  ok("L15 skips the START-holder (codex)", !/L15.*codex\.md/.test(r.out));
}

// 7. P6 — an EXPECT line in HEAD that disagrees with PHASE produces NO L17 (the check is gone).
{
  const { root, id, dir } = scaffold();
  edit(file(dir, "HEAD.md"), (t) => t.replace("SEQ: 0", "EXPECT: IMPL\nSEQ: 0"));  // EXPECT≠PHASE(PLAN)
  ok("EXPECT≠PHASE no longer fails (no L17)", !has(lint(root, id).out, "L17"));
}

// 8. P8 — `activate` reconciles the catalog so L16 stops firing during the PLAN phase.
{
  const { root, id, dir } = scaffold();
  edit(file(dir, "HEAD.md"), (t) => t.replace("SESSION_STATUS: IDLE", "SESSION_STATUS: ACTIVE"));
  ok("before activate: catalog drift → L16", has(lint(root, id).out, "L16"));
  run(["activate", "--session", id], root);
  ok("after activate: catalog reconciled (no L16)", !has(lint(root, id).out, "L16"));
}

// 9. L19 EVIDENCE-ON-RESOLVE (this hardening pass) — a turn that RESOLVES a point with `Evidence: N/A`
//    WARNs (advisory); the same turn with real evidence does not. Whether a claim is "disputed" stays
//    prose-only — we flag only the literal empty-evidence token on a resolving turn.
{
  const { root, id, dir } = scaffold();
  const shard = (ev) =>
    "### TURN-P1 (CLAUDE)\nSCHEMA: collab-board/turn/v1\n- Header: PART=PLAN · RESPONDS_TO=NEW · POINTS=P1\n" +
    "- Body:\n  - FINDINGS: x\n  - CHALLENGE: N/A\n  - PROPOSAL: x\n- Evidence: " + ev +
    "\n- Handoff: CLAUDE WORKING->ON_HOLD, CODEX ON_HOLD->START\nPREV: NEW\nNEXT: pending\n";
  write(file(dir, "turns", "P1-claude.md"), shard("N/A"));
  edit(file(dir, "log.md"), (t) => t.trimEnd() +
    "\n2026-01-01T00:00:00Z TURN_COMMIT P1 actor=CLAUDE responds_to=NEW points=P1" +
    "\n2026-01-01T00:00:00Z POINT_SET P1=AGREED in=P1\n");
  ok("resolving turn w/ Evidence: N/A → L19 WARN", has(lint(root, id).out, "L19"));
  edit(file(dir, "turns", "P1-claude.md"), (t) => t.replace("- Evidence: N/A", "- Evidence: foo.js:42 (verified)"));
  ok("resolving turn w/ real evidence → no L19", !has(lint(root, id).out, "L19"));
}

// 10. L15 on a TERMINATED session — both hands DONE with stale ON_HOLD mirrors must NOT warn.
//     `terminal` flips hands via the engine (not a turn), so mirrors can't update; a terminated
//     session takes no more turns, so the drift is moot. Regression guard for the START-and-DONE skip.
{
  const { root, id, dir } = scaffold();
  edit(file(dir, "HEAD.md"), (t) => t
    .replace("SESSION_STATUS: IDLE", "SESSION_STATUS: COMPLETED")
    .replace("- CLAUDE: ON_HOLD - PRIMARY", "- CLAUDE: DONE - PRIMARY")
    .replace("- CODEX: ON_HOLD - SECONDARY", "- CODEX: DONE - SECONDARY"));
  // agents/*.md mirrors stay at the scaffold default SELF_HAND: ON_HOLD (stale vs DONE) — must not warn.
  ok("terminated session w/ stale mirrors → no L15", !has(lint(root, id).out, "L15"));
}

// 11. STALL_HANDOFF (Rule 5 recovery) must replay in the L2 projection — following the protocol's own
//     recovery path must not diverge from HEAD. (Audit fix: projectLog had no STALL_HANDOFF case.)
{
  const { root, id, dir } = scaffold();
  edit(file(dir, "HEAD.md"), (t) => t
    .replace("SESSION_STATUS: IDLE", "SESSION_STATUS: ACTIVE")
    .replace("- CLAUDE: ON_HOLD - PRIMARY", "- CLAUDE: START - PRIMARY")
    .replace("SEQ: 0", "SEQ: 2"));
  edit(file(dir, "log.md"), (t) => t.trimEnd() +
    "\n2026-01-01T00:00:00Z STATE_SET CLAUDE=WORKING CODEX=ON_HOLD cursor=- next=P1/CLAUDE seq=0" +
    "\n2026-01-01T00:00:01Z HANDOFF CLAUDE:WORKING->ON_HOLD CODEX:ON_HOLD->START next=P2/CODEX seq=1" +
    "\n2026-01-01T00:00:02Z STALL_HANDOFF stalled=CODEX next=P3/CLAUDE seq=2\n");
  ok("STALL_HANDOFF recovery projects clean (no L2)", !has(lint(root, id).out, "L2"));
}

// 12. L20 GATE-AUTHORSHIP — a forged gate (one actor flipping the other's agreement) must FAIL (Rule 10).
{
  const { root, id, dir } = scaffold();
  edit(file(dir, "log.md"), (t) => t.trimEnd() +
    "\n2026-01-01T00:00:00Z GATE_SET PLAN_AGREE_PRIMARY=YES by=CODEX justified_by=P1\n");
  ok("forged gate (PRIMARY gate set by=CODEX) → L20 FAIL", has(lint(root, id).out, "L20"));
}

// 13. new/reset must reject PRIMARY==SECONDARY (they'd collapse to one actor and lint clean otherwise).
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-selftest-"));
  const r = run(["new", "--type", "META", "--primary", "Sage", "--secondary", "sage", "--adapter", "manual"], root);
  ok("new rejects PRIMARY==SECONDARY (non-zero exit)", r.code !== 0 && /distinct/i.test(r.out));
}

// 14. A lowercase point id must be flagged malformed (L4), never silently dropped from the OPEN count.
{
  const { root, id, dir } = scaffold();
  edit(file(dir, "points.md"), (t) => t.trimEnd() + "\n| p1 | PLAN | lower | OPEN |  |\n");
  ok("lowercase point id → L4 malformed (not silently dropped)", has(lint(root, id).out, "L4"));
}

console.log(`\n${failed ? "FAIL" : "PASS"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

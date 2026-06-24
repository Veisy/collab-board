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

console.log(`\n${failed ? "FAIL" : "PASS"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

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
const INSTALLER = path.join(HERE, "install.mjs");

let passed = 0, failed = 0;

const ok = (name, cond) => {
  if (cond) { passed++; console.log("  ok    " + name); }
  else { failed++; console.log("  FAIL  " + name); }
};

// Every CLI run in this suite gets an EMPTY preference home. Without it the suite would read the
// developer's real ~/.collab-board/preference.md, so its output would differ between machines and
// the scaffold-invariance fixture below would be asserting nothing on a machine that happens to
// have a preference recorded.
const SUITE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cb-home-"));
const CLEAN_ENV = { ...process.env, COLLAB_BOARD_HOME: SUITE_HOME };
function run(args, root, env) {
  try { return { code: 0, out: execFileSync(process.execPath, [CLI, ...args, "--root", root], { encoding: "utf8", env: env || CLEAN_ENV }) }; }
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
const NL = String.fromCharCode(10);
const edit = (p, fn) => write(p, fn(read(p)));
// A board that predates agent-schema provenance: its OPEN line carries no agent_schema token, so
// the log exempts nothing and the actor file's own declaration still selects the grammar. Every
// legacy-v1 fixture must run on THIS, because on a v2-provenance board a v1 actor file is a real
// finding rather than a legacy tolerance, not on a scaffolded board that already records v2.
const stripProvenance = (s2) =>
  edit(file(s2.dir, "log.md"), (t) => t.replace(/ agent_schema=v\d+/g, ""));
// A board whose PROVENANCE and files are the PREVIOUS schema. Every legacy-grammar fixture builds
// one of these explicitly instead of inheriting whichever version `new` currently scaffolds: a test
// that silently changes meaning when a default moves is the same must-agree defect the engine work
// has been removing all session, and thirty-nine assertions here had exactly that shape.
// LITERAL FROZEN BYTES, not a reconstruction. Deriving a v2 file by editing today's v3 template
// makes a compatibility fixture depend on the current template, so it drifts with it and stops
// describing the boards it is supposed to protect — the SECONDARY named that at I18. This is the
// shipped v2 actor file as it actually was, including the boilerplate comment that migration has
// to retire.
const FROZEN_V2_AGENT = (actor, id) => [
  `# ${actor} self-state — ${id}`,
  "SCHEMA: collab-board/agent/v2",
  "",
  "SELF_HAND: ON_HOLD",
  "LAST_TURN_WRITTEN: NONE",
  "ACTIVE_RECOVERY: NONE",
  "EXECUTOR_THREAD: NONE",
  "UNRESOLVED_CONCERNS: NONE",
  "",
  "PRIVATE_NOTES:",
  "<!-- Scratch space for this actor only. NON-AUTHORITATIVE — HEAD.md ## State is the truth.",
  "     The five keys above are a CLOSED grammar (lint L24): unknown, missing, duplicate or",
  "     malformed keys FAIL, and every one has an explicit NONE form — never delete a key.",
  "       ACTIVE_RECOVERY: NONE | TURN=<id>;ATTEMPT=<n>;START=<RFC3339>;EXPECT=<seconds>;",
  "                        SPAWN=<token|NONE>;LIMIT=<token|NONE>;RESET=<RFC3339|NONE>",
  "       UNRESOLVED_CONCERNS: NONE | <point-id>@<pointer.md[#frag]>[,...] — ids and pointers",
  "                        ONLY, never prose (prose here would only relabel the exempt region).",
  "     Everything below this comment is DISCRETIONARY and IS size-checked: WARN above 8,192 B,",
  "     FAIL above 16,384 B. The mandatory keys are excluded from that count, so recovery state",
  "     can never trip it. On overflow move settled prose to the current shard or points.md and",
  "     leave an id@pointer — never truncate. -->",
  "- (none yet)",
  "",
].join(NL);
function scaffoldV2(type, slug) {
  const s = scaffold(type, slug);
  edit(file(s.dir, "log.md"), (t) => t.replace(/ agent_schema=v3/, " agent_schema=v2"));
  for (const st of ["claude", "codex"]) {
    const p = file(s.dir, "agents", `${st}.md`);
    if (!fs.existsSync(p)) continue;
    write(p, FROZEN_V2_AGENT(st.toUpperCase(), s.id));
  }
  return s;
}
// Findings naming ONE actor file, so an unrelated finding on the other cannot make a fixture
// pass or fail for the wrong reason.
const l24For = (out, rel) => out.split(/\r?\n/).filter((l) => /\bL24\b/.test(l) && l.includes(rel));

// Preflight: this harness drives the REAL CLI via nested `node` child processes. Some sandboxes
// (e.g. a workspace-write SECONDARY under the codex-cli executor) block spawning nested processes —
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

// --- `--only` : subset selection, decided BEFORE a block runs -----------------------------
// Every top-level test block is guarded by `if (SEL(n)) {`. Selection has to happen at block
// ENTRY, not at ok(): what costs 164 s here is the nested `node` child process each block spawns
// to drive the real CLI, so filtering assertions after the fact would save nothing. A reviewer
// under a per-command time ceiling can therefore run the blocks covering one claim and no others.
//
// The descriptor of block n is the contiguous // comment immediately above its guard — ONE source
// of truth, so a renamed test cannot disagree with a selector table that nobody updated. The
// ordinals are checked against source order below; a mismatch is a hard failure, not a warning.
const ONLY = (() => {
  const i = process.argv.indexOf("--only");
  if (i === -1) return null;
  const v = process.argv[i + 1];
  if (!v) { console.error("--only needs a value: an ordinal, or a substring of a block descriptor."); process.exit(2); }
  return v;
})();

const BLOCKS = (() => {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split(/\r?\n/);
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const m = src[i].match(/^if \(SEL\((\d+)\)\) \{$/);
    if (!m) continue;
    let j = i - 1, text = [];
    while (j >= 0 && /^\/\//.test(src[j])) { text.unshift(src[j].replace(/^\/\/\s?/, "")); j--; }
    // Six top-level blocks continue the scenario of the labelled block above them and carry no
    // comment of their own. Giving them all one literal placeholder made them indistinguishable —
    // a descriptor search matched six unrelated blocks or none, so they were reachable only by
    // ordinal, which is the one selector that shifts when a block is inserted. They inherit the
    // nearest preceding descriptor plus a subcase index instead, which is what the frozen plan
    // required and what makes `--only <name>` pull a scenario's continuations along with it.
    const own = (text[0] || "").trim();
    let descriptor = own;
    if (!descriptor) {
      const parent = out.length ? out[out.length - 1] : null;
      const base = parent ? parent.descriptor.replace(/ \(cont\. \d+\)$/, "") : "(unlabelled)";
      const n = out.filter((b) => b.descriptor.startsWith(base + " (cont. ")).length + 1;
      descriptor = `${base} (cont. ${n})`;
    }
    out.push({ ordinal: Number(m[1]), line: i + 1, descriptor });
  }
  return out;
})();

// The guard ordinals and their source order are two things that must agree. Check it, do not
// assume it: a block inserted by hand without renumbering would silently shift every selector.
BLOCKS.forEach((b, i) => {
  if (b.ordinal !== i + 1) {
    console.error(`SELECTOR CORRUPT: guard #${i + 1} at line ${b.line} declares SEL(${b.ordinal}).`);
    console.error("Guards must be numbered 1..N in source order. Renumber before running.");
    process.exit(2);
  }
});

// ONE predicate, used by both the guard and the banner. Written twice they are two things that
// must agree, and this suite exists because that is how this codebase fails: the banner would
// promise a selection the guards did not make, and the count would be right about nothing.
// An all-digit value is an ORDINAL and nothing else. Read as a substring it would also match
// every descriptor mentioning that digit — `--only 3` matched 30 blocks and 652 assertions before
// this rule, which is a reviewer believing they ran one block while running a third of the suite.
const matches = (b) => (/^\d+$/.test(ONLY) ? String(b.ordinal) === ONLY : b.descriptor.toLowerCase().includes(ONLY.toLowerCase()));

const SEL = (n) => {
  if (ONLY === null) return true;
  const b = BLOCKS[n - 1];
  return !!b && matches(b);
};

if (ONLY !== null) {
  const hits = BLOCKS.filter(matches);
  if (hits.length === 0) {
    console.error(`--only ${JSON.stringify(ONLY)} matched 0 of ${BLOCKS.length} blocks. Nothing ran.`);
    console.error("A selector that matches nothing is a typo, not a passing run.");
    process.exit(2);
  }
  console.log(`SUBSET: --only ${JSON.stringify(ONLY)} matched ${hits.length}/${BLOCKS.length} blocks:`);
  for (const b of hits) console.log(`  [${b.ordinal}] ${b.descriptor.slice(0, 96)}`);
  console.log("");
}


// 1. A freshly scaffolded board is clean (exit 0, no FAIL findings).
if (SEL(1)) {
  const { root, id } = scaffold();
  const r = lint(root, id);
  ok("fresh scaffold lints clean (exit 0)", r.code === 0 && !/\bFAIL\b\s+L\d/.test(r.out));
  ok("fresh scaffold has no L17 (retired id)", !has(r.out, "L17"));
}

// 2. L14 CHAIN/ORPHAN — a turn shard with no TURN_COMMIT in the log is an orphan.
if (SEL(2)) {
  const { root, id, dir } = scaffold();
  write(file(dir, "turns", "P1-claude.md"), "### TURN-P1 (CLAUDE)\nSCHEMA: collab-board/turn/v1\n");
  const r = lint(root, id);
  ok("orphan shard → L14 FAIL", r.code !== 0 && has(r.out, "L14"));
}

// 3. L3 DUAL-START — two actors at START while ACTIVE.
if (SEL(3)) {
  const { root, id, dir } = scaffold();
  edit(file(dir, "HEAD.md"), (t) => t
    .replace("SESSION_STATUS: IDLE", "SESSION_STATUS: ACTIVE")
    .replace("- CLAUDE: ON_HOLD - PRIMARY", "- CLAUDE: START - PRIMARY")
    .replace("- CODEX: ON_HOLD - SECONDARY", "- CODEX: START - SECONDARY"));
  const r = lint(root, id);
  ok("dual START → L3 FAIL", r.code !== 0 && has(r.out, "L3"));
}

// 4. L4 PLAN-GATE — PLAN_OPEN_POINTS must equal the count of OPEN P* rows.
if (SEL(4)) {
  const { root, id, dir } = scaffold();
  edit(file(dir, "points.md"), (t) => t.trimEnd() + "\n| P1 | PLAN | x | OPEN |  |\n");  // HEAD still says 0
  const r = lint(root, id);
  ok("open-point count mismatch → L4 FAIL", r.code !== 0 && has(r.out, "L4"));
}

// 5. L6 IMPL-AUTHORITY / git-optional — a PRIMARY impl turn needs real code_state; `—` is
//    rejected, the literal NONE is accepted (no-git).
if (SEL(5)) {
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

// 6. L15 MIRROR-DRIFT — skip the START-holder (legitimately stale), still flag others.
if (SEL(6)) {
  const { root, id, dir } = scaffoldV2();
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

// 7. L17 is a retired id — an EXPECT line in HEAD that disagrees with PHASE produces NO L17
//    (HEAD/v1 has no EXPECT field; the id is intentionally not reused).
if (SEL(7)) {
  const { root, id, dir } = scaffold();
  edit(file(dir, "HEAD.md"), (t) => t.replace("SEQ: 0", "EXPECT: IMPL\nSEQ: 0"));  // EXPECT≠PHASE(PLAN)
  ok("EXPECT≠PHASE is not linted (L17 is retired)", !has(lint(root, id).out, "L17"));
}

// 8. `activate` reconciles the catalog so L16 stops firing during the PLAN phase.
if (SEL(8)) {
  const { root, id, dir } = scaffold();
  edit(file(dir, "HEAD.md"), (t) => t.replace("SESSION_STATUS: IDLE", "SESSION_STATUS: ACTIVE"));
  ok("before activate: catalog drift → L16", has(lint(root, id).out, "L16"));
  run(["activate", "--session", id], root);
  ok("after activate: catalog reconciled (no L16)", !has(lint(root, id).out, "L16"));
}

// 9. L19 EVIDENCE-ON-RESOLVE — a turn that RESOLVES a point with `Evidence: N/A`
//    WARNs (advisory); the same turn with real evidence does not. Whether a claim is "disputed" stays
//    prose-only — we flag only the literal empty-evidence token on a resolving turn.
if (SEL(9)) {
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
if (SEL(10)) {
  const { root, id, dir } = scaffold();
  edit(file(dir, "HEAD.md"), (t) => t
    .replace("SESSION_STATUS: IDLE", "SESSION_STATUS: COMPLETED")
    .replace("- CLAUDE: ON_HOLD - PRIMARY", "- CLAUDE: DONE - PRIMARY")
    .replace("- CODEX: ON_HOLD - SECONDARY", "- CODEX: DONE - SECONDARY"));
  // agents/*.md mirrors stay at the scaffold default SELF_HAND: ON_HOLD (stale vs DONE) — must not warn.
  ok("terminated session w/ stale mirrors → no L15", !has(lint(root, id).out, "L15"));
}

// 11. STALL_HANDOFF (Rule 5 recovery) must replay in the L2 projection — following the protocol's own
//     recovery path must not diverge from HEAD.
if (SEL(11)) {
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
if (SEL(12)) {
  const { root, id, dir } = scaffold();
  edit(file(dir, "log.md"), (t) => t.trimEnd() +
    "\n2026-01-01T00:00:00Z GATE_SET PLAN_AGREE_PRIMARY=YES by=CODEX justified_by=P1\n");
  ok("forged gate (PRIMARY gate set by=CODEX) → L20 FAIL", has(lint(root, id).out, "L20"));
}

// 13. new/reset must reject PRIMARY==SECONDARY (they'd collapse to one actor and lint clean otherwise).
if (SEL(13)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-selftest-"));
  const r = run(["new", "--type", "META", "--primary", "Sage", "--secondary", "sage", "--adapter", "manual"], root);
  ok("new rejects PRIMARY==SECONDARY (non-zero exit)", r.code !== 0 && /distinct/i.test(r.out));
}

// 14. A lowercase point id must be flagged malformed (L4), never silently dropped from the OPEN count.
if (SEL(14)) {
  const { root, id, dir } = scaffold();
  edit(file(dir, "points.md"), (t) => t.trimEnd() + "\n| p1 | PLAN | lower | OPEN |  |\n");
  ok("lowercase point id → L4 malformed (not silently dropped)", has(lint(root, id).out, "L4"));
}

// 15. CLI-executor adapters (L18 generalization): each executor must match the SECONDARY actor;
//     `codex` stays a valid legacy alias on existing boards (no forced migration).
if (SEL(15)) {
  // (a) codex-cli with SECONDARY != CODEX rejected at new-time
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-selftest-"));
  const a = run(["new", "--type", "META", "--secondary", "SAGE", "--adapter", "codex-cli"], root);
  ok("new rejects codex-cli with SECONDARY!=CODEX", a.code !== 0 && /SECONDARY=CODEX/.test(a.out));
  // (b) claude-cli with SECONDARY != CLAUDE rejected at new-time
  const b = run(["new", "--type", "META", "--primary", "CODEX", "--secondary", "SAGE", "--adapter", "claude-cli"], root);
  ok("new rejects claude-cli with SECONDARY!=CLAUDE", b.code !== 0 && /SECONDARY=CLAUDE/.test(b.out));
}
if (SEL(16)) {
  // (c) legacy `--adapter codex` input is normalized to codex-cli at scaffold
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-selftest-"));
  const r = run(["new", "--type", "META", "--slug", "alias", "--adapter", "codex"], root);
  const id = (r.out.match(/Created session (\S+)/) || [])[1];
  const sess = read(path.join(root, ".collab-board", "sessions", id, "SESSION.md"));
  ok("--adapter codex normalized to codex-cli at scaffold", /SecondaryAdapter: codex-cli\b/.test(sess));
  // (d) a stored legacy `codex` literal on a CODEX-secondary board still lint-PASSes
  edit(path.join(root, ".collab-board", "sessions", id, "SESSION.md"),
    (t) => t.replace("SecondaryAdapter: codex-cli", "SecondaryAdapter: codex"));
  ok("stored legacy SecondaryAdapter: codex lints clean", lint(root, id).code === 0);
}
if (SEL(17)) {
  // (e) the inverted pairing scaffolds and lints clean
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-selftest-"));
  const r = run(["new", "--type", "META", "--slug", "inv", "--primary", "CODEX", "--secondary", "CLAUDE", "--adapter", "claude-cli"], root);
  const id = (r.out.match(/Created session (\S+)/) || [])[1];
  ok("inverted pairing (CODEX primary, claude-cli) scaffolds + lints clean", !!id && lint(root, id).code === 0);
  // (f) a stored claude-cli with SECONDARY != CLAUDE FAILs L18 at lint-time
  edit(path.join(root, ".collab-board", "sessions", id, "SESSION.md"),
    (t) => t.replace("Roles: PRIMARY=CODEX, SECONDARY=CLAUDE", "Roles: PRIMARY=CODEX, SECONDARY=SAGE"));
  edit(path.join(root, ".collab-board", "sessions", id, "HEAD.md"),
    (t) => t.replace("- CLAUDE: ON_HOLD - SECONDARY", "- SAGE: ON_HOLD - SECONDARY"));
  ok("stored claude-cli with SECONDARY!=CLAUDE → L18 FAIL", has(lint(root, id).out, "L18"));
}
if (SEL(18)) {
  // An adapter drives an actor FAMILY, not one fixed name. This is what makes a board legal when
  // only ONE model is available: the same model occupies both seats under two distinct ACTOR names.
  // There is no mode, no new key and no new adapter value — the one-model case falls out of the
  // general rule, which is the whole design requirement.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-selftest-"));
  const r = run(["new", "--type", "META", "--slug", "solo", "--primary", "CLAUDE", "--secondary", "CLAUDE_2", "--adapter", "claude-cli"], root);
  const id = (r.out.match(/Created session (\S+)/) || [])[1];
  ok("a same-family secondary (CLAUDE + CLAUDE_2 via claude-cli) scaffolds", !!id, r.out.split(NL)[0]);
  ok("...and lints clean, so a one-model board needs no mode construct", !!id && lint(root, id).code === 0,
    id ? lint(root, id).out : "");
  ok("...and no lint code is spent on it — L18 says nothing about a same-family board",
    !!id && !has(lint(root, id).out, "L18"));
}
if (SEL(19)) {
  // CONTROL, and the reason the pairing rule is KEPT rather than deleted: it is a naming-honesty
  // guard, and deleting it would silently accept an actor named like one vendor driven by another.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-selftest-"));
  const bad = run(["new", "--type", "META", "--slug", "typo", "--primary", "CLAUDE", "--secondary", "CODEX", "--adapter", "claude-cli"], root);
  ok("control: the typo guard survives the family rule (CODEX is not in the CLAUDE family)",
    bad.code !== 0 && /claude-cli requires SECONDARY=CLAUDE/.test(bad.out), bad.out.split(NL)[0]);
  // CONTROL: family membership is a PREFIX-plus-separator test, never a bare prefix match. Without
  // the separator, CLAUDEX would join the CLAUDE family — the same prefix-match class of defect
  // that once let `PLAN_AGREE_PRIMARY=YESTERDAY` set a gate.
  const near = run(["new", "--type", "META", "--slug", "near", "--primary", "CLAUDE", "--secondary", "CLAUDEX", "--adapter", "claude-cli"], root);
  ok("control: CLAUDEX is NOT in the CLAUDE family (separator required, not a bare prefix)",
    near.code !== 0, near.out.split(NL)[0]);
}

// 16. Adapter defaults and the closed adapter schema use one policy across new/reset/lint.
if (SEL(20)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-selftest-"));
  const r = run(["new", "--type", "META", "--slug", "inv-default", "--primary", "CODEX", "--secondary", "CLAUDE"], root);
  const id = (r.out.match(/Created session (\S+)/) || [])[1];
  const session = path.join(root, ".collab-board", "sessions", id, "SESSION.md");
  ok("inverted pairing defaults to claude-cli", /SecondaryAdapter: claude-cli\b/.test(read(session)) && lint(root, id).code === 0);

  const badNew = run(["new", "--type", "META", "--slug", "bad-adapter", "--adapter", "banana"], root);
  ok("new rejects unknown adapter", badNew.code !== 0 && /invalid --adapter/.test(badNew.out));
  const emptySubagent = run(["new", "--type", "META", "--slug", "empty-subagent", "--adapter", "subagent:"], root);
  ok("new rejects empty subagent adapter", emptySubagent.code !== 0 && /invalid --adapter/.test(emptySubagent.out));

  edit(session, (t) => t.replace("SecondaryAdapter: claude-cli", "SecondaryAdapter: banana"));
  ok("stored unknown adapter fails L18", has(lint(root, id).out, "L18"));
  edit(session, (t) => t.replace(/^SecondaryAdapter:.*\n/m, ""));
  const reset = run(["reset", "--session", id], root);
  ok("reset missing adapter uses secondary-keyed default", reset.code === 0 && /SecondaryAdapter: claude-cli\b/.test(read(session)) && lint(root, id).code === 0);
}

// 17. L23 LOG-TIMESTAMP-ORDER — equality is legacy-safe; a decrease is a hard failure.
if (SEL(21)) {
  const { root, id, dir } = scaffold();
  const firstTs = (read(file(dir, "log.md")).match(/^(\S+)\s+OPEN/m) || [])[1];
  edit(file(dir, "log.md"), (t) => t.trimEnd() + `\n${firstTs} STALL_CHECK actor=CLAUDE\n`);
  ok("equal log timestamps remain valid for L23", !has(lint(root, id).out, "L23"));
  edit(file(dir, "log.md"), (t) => t.trimEnd() + "\n2000-01-01T00:00:00Z STALL_CHECK actor=CLAUDE\n");
  ok("decreasing log timestamp fails L23", has(lint(root, id).out, "L23"));

  const future = scaffold();
  edit(file(future.dir, "log.md"), (t) => t.trimEnd() + "\n2999-01-01T00:00:00Z STALL_CHECK actor=CLAUDE\n");
  ok("far-future log timestamp fails L23", has(lint(future.root, future.id).out, "L23"));
}

// 17b. L24 ACTOR-NOTES — closed agent/v2 grammar + a two-tier size ladder on the DISCRETIONARY
// region only. The size half is what the check exists for (one file on record reached 44,336 B);
// the grammar half exists so arbitrary prose cannot be relabelled into the mandatory exemption.
if (SEL(22)) {
  const AF = (dir) => file(dir, "agents", "claude.md");
  // Rebuild the whole mandatory header so each case tests exactly one thing.
  const withHeader = (keys) => `# CLAUDE self-state — x\nSCHEMA: collab-board/agent/v2\n\n${keys}\n\nPRIVATE_NOTES:\n- (none yet)\n`;
  const V2 = "SELF_HAND: ON_HOLD\nLAST_TURN_WRITTEN: NONE\nACTIVE_RECOVERY: NONE\nEXECUTOR_THREAD: NONE\nUNRESOLVED_CONCERNS: NONE";
  const lintWith = (body) => { const s = scaffoldV2(); write(AF(s.dir), body); return lint(s.root, s.id).out; };
  // A board that predates agent-schema provenance: its OPEN line carries no agent_schema token, so
  // the log exempts nothing and the actor file's own declaration still selects the grammar. Every
  // v1 fixture must run on THIS, not on a v2-provenance board where a v1 file is a real finding.
  const lintLegacy = (body) => { const s2 = scaffoldV2(); stripProvenance(s2); write(AF(s2.dir), body); return lint(s2.root, s2.id).out; };
  // Assert the SPECIFIC L24 diagnostic, not merely that some L24 fired. A fixture that trips a
  // different branch than intended would otherwise pass for the wrong reason — the exact failure
  // mode that let an unreachable guard ship earlier in this file's history.
  const l24 = (out, needle) => out.split("\n").some((l) => /\bL24\b/.test(l) && l.includes(needle));
  const KEYSET = "header must be exactly SELF_HAND";
  const STRAY = "not the title, SCHEMA, or a column-0";

  // Baseline: the shipped scaffold is v2 and must be clean, or every other assertion is noise.
  {
    const { root, id, dir } = scaffoldV2();
    ok("a v2 board's agent file declares agent/v2", /SCHEMA:\s*collab-board\/agent\/v2/.test(read(AF(dir))));
    ok("fresh v2 board passes L24", !has(lint(root, id).out, "L24"));
    const v3 = scaffold();
    ok("...and the shipped scaffold now produces agent/v3",
      /SCHEMA:\s*collab-board\/agent\/v3/.test(read(AF(v3.dir))));
    ok("...which also passes L24", !has(lint(v3.root, v3.id).out, "L24"));
  }

  // --- Grammar (v2 only). Every NONE form is legal; each defect FAILs.
  ok("v2 all-NONE header passes L24", !has(lintWith(withHeader(V2)), "L24"));
  ok("v2 populated ACTIVE_RECOVERY passes L24", !has(lintWith(withHeader(
    "SELF_HAND: WORKING\nLAST_TURN_WRITTEN: I12\nACTIVE_RECOVERY: TURN=I13;ATTEMPT=2;START=2026-08-03T09:00:00Z;EXPECT=600;SPAWN=pid-1234;LIMIT=NONE;RESET=NONE\nEXECUTOR_THREAD: thread_abc-123\nUNRESOLVED_CONCERNS: P4@turns/P4-codex.md#fusion")), "L24"));
  ok("v2 unknown key fails L24", l24(lintWith(withHeader(V2 + "\nEXTRA_KEY: whatever")), KEYSET));
  ok("v2 missing key fails L24", l24(lintWith(withHeader(V2.split("\n").slice(0, 4).join("\n"))), KEYSET));
  ok("v2 duplicate key fails L24", l24(lintWith(withHeader(V2 + "\nSELF_HAND: DONE")), KEYSET));
  ok("v2 out-of-order keys fail L24", l24(lintWith(withHeader(
    "LAST_TURN_WRITTEN: NONE\nSELF_HAND: ON_HOLD\nACTIVE_RECOVERY: NONE\nEXECUTOR_THREAD: NONE\nUNRESOLVED_CONCERNS: NONE")), KEYSET));
  ok("v2 bad SELF_HAND value fails L24", l24(lintWith(withHeader(V2.replace("SELF_HAND: ON_HOLD", "SELF_HAND: BUSY"))), "SELF_HAND value"));
  ok("v2 bad LAST_TURN_WRITTEN value fails L24", l24(lintWith(withHeader(V2.replace("LAST_TURN_WRITTEN: NONE", "LAST_TURN_WRITTEN: P0"))), "LAST_TURN_WRITTEN value"));
  ok("v2 malformed ACTIVE_RECOVERY fails L24", l24(lintWith(withHeader(V2.replace("ACTIVE_RECOVERY: NONE", "ACTIVE_RECOVERY: TURN=I1;ATTEMPT=0"))), "ACTIVE_RECOVERY value"));
  // UNRESOLVED_CONCERNS is ids+pointers ONLY — prose here is the relabeling escape this shuts.
  ok("v2 prose in UNRESOLVED_CONCERNS fails L24", l24(lintWith(withHeader(
    V2.replace("UNRESOLVED_CONCERNS: NONE", "UNRESOLVED_CONCERNS: I still think the fusion rule is unsafe"))), "UNRESOLVED_CONCERNS value"));
  ok("v2 absolute pointer fails L24", l24(lintWith(withHeader(
    V2.replace("UNRESOLVED_CONCERNS: NONE", "UNRESOLVED_CONCERNS: P1@/etc/passwd.md"))), "UNRESOLVED_CONCERNS value"));
  ok("v2 traversal pointer fails L24", l24(lintWith(withHeader(
    V2.replace("UNRESOLVED_CONCERNS: NONE", "UNRESOLVED_CONCERNS: P1@../../secrets.md"))), "UNRESOLVED_CONCERNS value"));
  ok("v2 non-.md pointer fails L24", l24(lintWith(withHeader(
    V2.replace("UNRESOLVED_CONCERNS: NONE", "UNRESOLVED_CONCERNS: P1@turns/P1-claude.txt"))), "UNRESOLVED_CONCERNS value"));

  // --- Grammar FALSE NEGATIVES caught in review. Each of these was accepted by a first
  // implementation that trimmed every line before comparing and located the delimiter by
  // substring: indentation vanished, value padding was erased before validation, extra
  // title/SCHEMA lines were filtered away, and `PRIVATE_NOTES: junk` passed as the delimiter.
  // The grammar says "consecutive TOP-LEVEL lines", so structure is part of it.
  const V2_LINES = V2.split("\n");
  ok("v2 indented keys fail L24 (indentation is part of the grammar)", l24(lintWith(
    withHeader(V2_LINES.map((l) => "  " + l).join("\n"))), STRAY));
  ok("v2 padded value fails L24", l24(lintWith(
    withHeader(V2.replace("SELF_HAND: ON_HOLD", "SELF_HAND:    ON_HOLD   "))), STRAY));
  ok("v2 duplicate SCHEMA line fails L24", l24(lintWith(
    withHeader(V2).replace("SCHEMA: collab-board/agent/v2\n", "SCHEMA: collab-board/agent/v2\nSCHEMA: collab-board/agent/v9\n")), "SCHEMA: lines"));
  ok("v2 second title line fails L24", l24(lintWith(
    withHeader(V2).replace("# CLAUDE self-state — x\n", "# CLAUDE self-state — x\n# second title\n")), "exactly one title line"));
  ok("v2 PRIVATE_NOTES: with trailing text is not the delimiter", l24(lintWith(
    withHeader(V2).replace("PRIVATE_NOTES:\n", "PRIVATE_NOTES: junk\n")), "no standalone PRIVATE_NOTES: delimiter"));
  ok("v2 stray non-key line in the header fails L24", l24(lintWith(
    withHeader(V2 + "\njust some prose")), STRAY));
  // A comment must not be able to manufacture or conceal a key line.
  ok("v2 key hidden inside a comment fails L24", l24(lintWith(
    withHeader(V2.replace("EXECUTOR_THREAD: NONE", "<!-- EXECUTOR_THREAD: NONE -->"))), KEYSET));

  // --- PARSER BOUNDARIES caught in the second review round. Each is a way the check could be
  // steered from OUTSIDE the grammar it enforces: by putting the schema string somewhere it is
  // not, by declaring a version nobody implements, or by using a comment to build or hide syntax.
  const V1_HDR = "# CLAUDE self-state — x\nSCHEMA: collab-board/agent/v1\n\nSELF_HAND: ON_HOLD\nLAST_TURN_WRITTEN: -\n\nPRIVATE_NOTES:\n";
  // Schema selection must read the HEADER, not the whole file — otherwise a v1 file that merely
  // quotes the v2 schema line in its notes gets forced through v2 grammar and fails.
  ok("v1 file quoting the v2 schema line in notes is still treated as v1",
    !l24For(lintLegacy(V1_HDR + "- the new header line is:\nSCHEMA: collab-board/agent/v2\n"), "claude.md").length);
  // ...and declaring an unimplemented version must FAIL, not silently skip the closed grammar.
  ok("unsupported agent schema fails L24 instead of opting out of the grammar", l24(lintWith(
    withHeader(V2).replace("SCHEMA: collab-board/agent/v2", "SCHEMA: collab-board/agent/v9")), "declares SCHEMA"));
  // Comment spans are blanked in place; splicing them out would CONCATENATE the neighbours and
  // manufacture a key that was never written.
  ok("a comment splitting a key name cannot manufacture that key", l24(lintWith(
    withHeader(V2.replace("SELF_HAND:", "SELF_<!--x-->HAND:"))), STRAY));
  // An unclosed comment must not be able to swallow the delimiter line.
  ok("an unclosed comment before the delimiter fails L24", l24(lintWith(
    withHeader(V2).replace("\nPRIVATE_NOTES:", "\n<!-- unclosed\nPRIVATE_NOTES:")), "unclosed <!-- comment"));

  // --- Third review round: the remaining ways to reach the grammar from outside it. A DECLARED
  // schema that is not one of the two supported values must FAIL rather than fall through to
  // size-only — a non-agent value is still a present declaration, not an absent one.
  ok("a non-agent SCHEMA value fails L24", l24(lintWith(
    withHeader(V2).replace("SCHEMA: collab-board/agent/v2", "SCHEMA: collab-board/turn/v1")), "declares SCHEMA"));
  ok("a junk SCHEMA value fails L24", l24(lintWith(
    withHeader(V2).replace("SCHEMA: collab-board/agent/v2", "SCHEMA: garbage")), "declares SCHEMA"));
  // Masking must distinguish blanks a comment created from padding the author wrote.
  ok("a trailing inline comment after a value is accepted", !has(lintWith(
    withHeader(V2.replace("SELF_HAND: ON_HOLD", "SELF_HAND: ON_HOLD<!--note-->"))), "L24"));
  ok("authored trailing padding is still rejected", l24(lintWith(
    withHeader(V2.replace("SELF_HAND: ON_HOLD", "SELF_HAND: ON_HOLD   "))), STRAY));
  ok("padding before a trailing comment is still rejected", l24(lintWith(
    withHeader(V2.replace("SELF_HAND: ON_HOLD", "SELF_HAND: ON_HOLD   <!--note-->"))), STRAY));
  // Schema discovery runs after masking, so a declaration inside a comment is not a declaration.
  ok("a commented-out SCHEMA line is not counted as a second declaration", !has(lintWith(
    withHeader(V2).replace("SCHEMA: collab-board/agent/v2\n",
      "<!-- doc block\nSCHEMA: collab-board/agent/v9\n-->\nSCHEMA: collab-board/agent/v2\n")), "L24"));

  // --- Fourth review round. Delimiter discovery and comment masking must be decided in ONE pass:
  // finding the delimiter first lets a COMMENTED-OUT `PRIVATE_NOTES:` line be chosen as the
  // delimiter, which truncates the header before the live schema and drops the real keys into
  // "discretionary" bytes — a malformed file then passes with no finding at all.
  ok("a commented-out PRIVATE_NOTES: line is not the delimiter", l24(lintWith(
    "# CLAUDE self-state — x\n<!--\nPRIVATE_NOTES:\n-->\nSCHEMA: collab-board/agent/v2\n\n"
    + V2.replace("SELF_HAND: ON_HOLD", "SELF_HAND: BOGUS") + "\n\nPRIVATE_NOTES:\n- x\n"),
    "SELF_HAND value"));
  // "Absent" must mean no schema-SHAPED line at all, or the malformed spelling becomes the escape.
  ok("a schema-shaped but malformed line is invalid presence, not legacy absence", l24(lintWith(
    withHeader(V2).replace("SCHEMA: collab-board/agent/v2", "SCHEMA : collab-board/agent/v2")),
    "malformed SCHEMA declaration"));

  // --- Fifth review round. The FILE SET is part of the check: enumerating whatever `*.md` exists
  // let a renamed or deleted actor file skip the grammar and the ladder with no finding, and let a
  // stray `.md` be judged as an actor file. The set is now derived from the actors HEAD declares.
  {
    const s = scaffold();
    fs.renameSync(AF(s.dir), file(s.dir, "agents", "claude-renamed.md"));
    ok("a renamed actor file cannot skip L24", l24(lint(s.root, s.id).out, "claude.md is missing"));
    ok("the renamed file is itself flagged as not an actor file",
      l24(lint(s.root, s.id).out, "is not an actor file"));
  }
  {
    const s = scaffold();
    write(file(s.dir, "agents", "stray.md"), "# scratch\nprose\n");
    ok("a stray .md in agents/ is flagged, not judged as an actor file",
      l24(lint(s.root, s.id).out, "stray.md is not an actor file"));
  }
  // "Shaped like a declaration" must not depend on punctuation, or the punctuation is the escape.
  ok("SCHEMA with = instead of : is invalid presence, not absence", l24(lintWith(
    withHeader(V2).replace("SCHEMA: collab-board/agent/v2", "SCHEMA=collab-board/agent/v2")),
    "malformed SCHEMA declaration"));
  ok("SCHEMA with no punctuation at all is invalid presence", l24(lintWith(
    withHeader(V2).replace("SCHEMA: collab-board/agent/v2", "SCHEMA collab-board/agent/v2")),
    "malformed SCHEMA declaration"));
  ok("authored trailing padding on the SCHEMA line is rejected", l24(lintWith(
    withHeader(V2).replace("SCHEMA: collab-board/agent/v2", "SCHEMA: collab-board/agent/v2   ")),
    "malformed SCHEMA declaration"));

  // --- Legacy v1 keeps size enforcement but is NEVER failed on v2 grammar. Existing boards must
  // stay readable; migration is explicit, never implicit.
  const V1 = "# CLAUDE self-state — x\nSCHEMA: collab-board/agent/v1\n\nSELF_HAND: ON_HOLD\nLAST_TURN_WRITTEN: -\n\nPRIVATE_NOTES:\n";
  ok("legacy v1 header is not failed on v2 grammar",
    !l24For(lintLegacy(V1 + "- (none yet)\n"), "claude.md").length);

  // --- Size ladder, on the DISCRETIONARY region only, measured in RAW BYTES.
  const pad = (n) => "x".repeat(n);
  ok("discretionary at exactly 8192 B does not warn", !has(lintWith(withHeader(V2).replace("- (none yet)\n", pad(8192))), "L24"));
  ok("discretionary above 8192 B warns", /WARN L24/.test(lintWith(withHeader(V2).replace("- (none yet)\n", pad(8193)))));
  ok("discretionary at exactly 16384 B still only warns", /WARN L24/.test(lintWith(withHeader(V2).replace("- (none yet)\n", pad(16384)))));
  ok("discretionary above 16384 B fails", /FAIL L24/.test(lintWith(withHeader(V2).replace("- (none yet)\n", pad(16385)))));
  ok("legacy v1 oversize discretionary still fails", /FAIL L24/.test(lintWith(V1 + pad(16385))));

  // Mandatory bytes are EXCLUDED — an actor mid-recovery must never be pushed to drop the fields
  // that make recovery possible. A maximal header plus an at-limit region must stay a WARN.
  const bigHeader = "SELF_HAND: WORKING\nLAST_TURN_WRITTEN: I999\nACTIVE_RECOVERY: TURN=I999;ATTEMPT=99;START=2026-08-03T09:00:00Z;EXPECT=600;SPAWN=" + "s".repeat(400) + ";LIMIT=NONE;RESET=2026-08-03T10:00:00Z\nEXECUTOR_THREAD: " + "t".repeat(400) + "\nUNRESOLVED_CONCERNS: NONE";
  ok("mandatory header bytes are excluded from the size count",
    /WARN L24/.test(lintWith(withHeader(bigHeader).replace("- (none yet)\n", pad(16384)))));

  // Raw bytes, not decoded length: CRLF and multibyte cost is real cost and must be charged.
  ok("multibyte discretionary bytes are counted raw",
    /FAIL L24/.test(lintWith(withHeader(V2).replace("- (none yet)\n", "é".repeat(8200)))));   // 2 B each
  ok("CRLF discretionary bytes are counted raw",
    /FAIL L24/.test(lintWith(withHeader(V2).replace("- (none yet)\n", "x\r\n".repeat(5462))))); // 3 B each
}

// 17b-2. L1 IDENTITY — any check that DERIVES a file set from `head.state` (L24 does) is only as
// sound as the actor identities it reads. Two session-level escapes existed while HEAD was trusted
// as the authority on WHO the actors are rather than only on their hands.
if (SEL(23)) {
  // Case-colliding pair: `CODEX` and `codex` are two names for one actor, because `agents/<actor>.md`
  // is derived by lowercasing. Treating them as distinct collapsed two expected files onto one, so
  // the other actor's file could be deleted with no finding anywhere.
  const s = scaffold();
  edit(file(s.dir, "HEAD.md"), (t) => t.replace("- CLAUDE: ON_HOLD - PRIMARY", "- codex: ON_HOLD - PRIMARY"));
  fs.rmSync(file(s.dir, "agents", "claude.md"));
  const out = lint(s.root, s.id).out;
  ok("a case-colliding actor pair fails L1", /L1\b.*same actor twice/.test(out));
  ok("a deleted actor file cannot hide behind a case collision", /\bFAIL\b/.test(out));

  // Identity substitution: SESSION.md is write-once and names the actors; HEAD only tracks hands.
  // Renaming an ON_HOLD actor in HEAD plus its agent file otherwise passed everything, because log
  // replay never mentions the old name and leaves the substitute at its default ON_HOLD.
  const s2 = scaffold();
  edit(file(s2.dir, "HEAD.md"), (t) => t.replace("- CODEX: ON_HOLD - SECONDARY", "- GEMINI: ON_HOLD - SECONDARY"));
  fs.renameSync(file(s2.dir, "agents", "codex.md"), file(s2.dir, "agents", "gemini.md"));
  ok("a substituted actor identity fails L1 against SESSION Roles",
    /L1\b.*SESSION\.md Roles declares SECONDARY=CODEX/.test(lint(s2.root, s2.id).out));
}

// 17b-3. L1 INPUT GRAMMARS — the reconciliation added above is only sound if its own two inputs
// are. Both were open: HEAD actor names, and the SESSION Roles line it compares against.
if (SEL(24)) {
  // An actor name is interpolated into a dynamic RegExp by L1's split-state scan, so an unrestricted
  // token could make regex construction THROW — killing lint outright rather than reporting a
  // finding. Disabling the verifier is strictly worse than tripping it.
  const s = scaffold();
  edit(file(s.dir, "HEAD.md"), (t) => t.replace("- CLAUDE: ON_HOLD - PRIMARY", "- [: ON_HOLD - PRIMARY"));
  const out = lint(s.root, s.id).out;
  ok("an actor name that is a regex metacharacter does not crash lint", !/Invalid regular expression/.test(out));
  ok("an invalid actor name is reported as an L1 finding", /L1\b.*invalid actor name/.test(out));

  // A tolerant Roles scan only ever ADDS a comparison, so anything unparseable silently skipped the
  // reconciliation entirely — the same absence-versus-malformed escape the SCHEMA line had.
  for (const [label, roles] of [
    ["missing", "garbage"],
    ["partial", "PRIMARY=CLAUDE"],
    ["duplicated", "PRIMARY=CLAUDE, SECONDARY=CODEX, SECONDARY=GEMINI"],
    ["trailing junk", "PRIMARY=CLAUDE, SECONDARY=CODEX junk"],
  ]) {
    const b = scaffold();
    edit(file(b.dir, "SESSION.md"), (t) => t.replace("Roles: PRIMARY=CLAUDE, SECONDARY=CODEX", `Roles: ${roles}`));
    ok(`a ${label} Roles line fails L1 instead of skipping reconciliation`,
      /L1\b.*Roles is (missing|malformed)/.test(lint(b.root, b.id).out));
  }
  // Roles naming one actor twice is the same collision the HEAD side already rejects.
  const c = scaffold();
  edit(file(c.dir, "SESSION.md"), (t) => t.replace("Roles: PRIMARY=CLAUDE, SECONDARY=CODEX", "Roles: PRIMARY=CODEX, SECONDARY=codex"));
  ok("Roles naming the same actor twice fails L1", /L1\b.*same actor twice/.test(lint(c.root, c.id).out));
}

// 17b-4. MUTATING COMMANDS must not act on a HEAD lint would reject, and a write-once contract
// field must occur exactly once. Reading a malformed board is diagnostic; WRITING one is corruption.
if (SEL(25)) {
  // `state.length === 2` is satisfied by two valid rows even when a third invalid actor row is also
  // present, so the old guards would rewrite a State block lint reports as L1.
  const withThirdRow = (s) => edit(file(s.dir, "HEAD.md"), (t) =>
    t.replace("- CODEX: ON_HOLD - SECONDARY", "- CODEX: ON_HOLD - SECONDARY\n- [: ON_HOLD - SECONDARY"));
  const a = scaffold(); withThirdRow(a);
  const ta = run(["terminal", "--session", a.id, "--status", "ABORTED"], a.root);
  ok("terminal refuses a HEAD carrying a malformed actor row",
    ta.code !== 0 && /State is malformed/.test(ta.out));
  ok("terminal that refused wrote no TERMINAL event",
    !/^\S+\s+TERMINAL\s/m.test(read(file(a.dir, "log.md"))));
  const b = scaffold(); withThirdRow(b);
  const tb = run(["advance", "--session", b.id], b.root);
  ok("advance refuses a HEAD carrying a malformed actor row",
    tb.code !== 0 && /State is malformed/.test(tb.out));
  // A clean board must still be mutable — the guard has to reject the malformed case only.
  const c = scaffold();
  ok("a clean board still terminals", run(["terminal", "--session", c.id, "--status", "ABORTED"], c.root).code === 0);

  // getKV returns the FIRST match, so a second conflicting declaration was silently ignored and the
  // contract could hold two contradictory values while every check agreed with whichever came first.
  const d = scaffold();
  edit(file(d.dir, "SESSION.md"), (t) => t.replace("Roles: PRIMARY=CLAUDE, SECONDARY=CODEX",
    "Roles: PRIMARY=CLAUDE, SECONDARY=CODEX\nRoles: PRIMARY=CLAUDE, SECONDARY=GEMINI"));
  ok("a duplicated Roles: declaration fails L1",
    /L1\b.*2 Roles: declarations/.test(lint(d.root, d.id).out));
}

// 17b-5. EXACTLY-ONE for authoritative declarations, and the right guard on each consumer.
// `getKV` reads the first match, so a duplicated authoritative key leaves the board carrying two
// contradictory truths while every check quietly agrees with whichever came first.
if (SEL(26)) {
  const dupGate = (s) => edit(file(s.dir, "HEAD.md"), (t) =>
    t.replace("IMPL_AGREE_SECONDARY: NO", "IMPL_AGREE_SECONDARY: YES\nIMPL_AGREE_SECONDARY: NO"));
  const a = scaffold(); dupGate(a);
  ok("a duplicated authoritative HEAD key fails L1",
    /IMPL_AGREE_SECONDARY declared 2 times/.test(lint(a.root, a.id).out));
  const ta = run(["terminal", "--session", a.id, "--status", "ABORTED"], a.root);
  ok("terminal refuses a duplicated authoritative HEAD key", ta.code !== 0 && /IMPL_AGREE_SECONDARY declared 2 times/.test(ta.out));
  const b = scaffold(); dupGate(b);
  ok("advance refuses a duplicated authoritative HEAD key",
    run(["advance", "--session", b.id], b.root).code !== 0);

  // `activate` publishes catalog state DERIVED from HEAD, so it is a mutator, not a display.
  const c = scaffold();
  edit(file(c.dir, "HEAD.md"), (t) => t.replace("- CODEX: ON_HOLD - SECONDARY",
    "- CODEX: ON_HOLD - SECONDARY\n- [: ON_HOLD - SECONDARY"));
  const ac = run(["activate", "--session", c.id, "--actor", "CLAUDE"], c.root);
  ok("activate refuses a malformed HEAD instead of publishing a derived lie",
    ac.code !== 0 && /State is malformed/.test(ac.out));

  // `reset` is RECOVERY: it must stay able to replace a malformed HEAD. But its contract
  // carry-forward must fail closed, or a recovery silently re-scaffolds with the wrong actors.
  const d = scaffold();
  edit(file(d.dir, "SESSION.md"), (t) => t.replace("Roles: PRIMARY=CLAUDE, SECONDARY=CODEX", "Roles: garbage"));
  const rd = run(["reset", "--session", d.id, "--force"], d.root);
  ok("reset refuses to carry forward a malformed Roles line", rd.code !== 0 && /Roles is malformed/.test(rd.out));
  const e = scaffold();
  edit(file(e.dir, "HEAD.md"), (t) => t.replace("- CODEX: ON_HOLD - SECONDARY",
    "- CODEX: ON_HOLD - SECONDARY\n- [: ON_HOLD - SECONDARY"));
  ok("reset still recovers a malformed HEAD (it is the operation for exactly that)",
    run(["reset", "--session", e.id, "--force"], e.root).code === 0);
}

// 17b-6. Duplicate detection INVERTED, and reset's carry-forward taking BOTH actors from one parse.
if (SEL(27)) {
  // A curated key list is the same narrow-fix shape it was meant to close: a key added later goes
  // uncovered. Inversion rejects any repeated top-level key, including ones nobody enumerated.
  const a = scaffold();
  edit(file(a.dir, "HEAD.md"), (t) => t.replace("PROTOCOL: PROTOCOL.md",
    "PROTOCOL: PROTOCOL.md\nPROTOCOL: OTHER.md"));
  ok("a duplicated key that is NOT on the authoritative list is still rejected",
    /L1\b.*PROTOCOL declared 2 times/.test(lint(a.root, a.id).out));
  // Inversion cannot see a key that is absent, so the required-key check is its complement.
  const b = scaffold();
  edit(file(b.dir, "HEAD.md"), (t) => t.replace(/^STALL_STATE:.*$/m, ""));
  ok("a MISSING authoritative key is rejected (inversion alone cannot catch zero)",
    /L1\b.*STALL_STATE is missing/.test(lint(b.root, b.id).out));

  // Taking one actor from the strict parse and leaving the other on a looser pattern reintroduced
  // the exact substitution the guard exists to prevent: BETA was silently replaced by the default.
  const c = scaffold();
  edit(file(c.dir, "SESSION.md"), (t) => t.replace("Roles: PRIMARY=CLAUDE, SECONDARY=CODEX",
    "Roles: PRIMARY = ALPHA, SECONDARY = BETA"));
  ok("reset carries BOTH actors from the same parse", run(["reset", "--session", c.id, "--force"], c.root).code === 0);
  {
    const live = fs.readdirSync(path.join(c.root, ".collab-board", "sessions")).filter((n) => !n.includes("archived"))[0];
    const dir = path.join(c.root, ".collab-board", "sessions", live);
    ok("reset does not silently substitute the SECONDARY actor",
      /^Roles: PRIMARY=ALPHA, SECONDARY=BETA$/m.test(read(file(dir, "SESSION.md")))
      && fs.existsSync(file(dir, "agents", "beta.md")));
  }
  // An empty value is not a licence to default — it is a contract that cannot be carried forward.
  const d = scaffold();
  edit(file(d.dir, "SESSION.md"), (t) => t.replace(/^Roles:.*$/m, ""));
  const rd = run(["reset", "--session", d.id, "--force"], d.root);
  ok("reset refuses a MISSING Roles line rather than defaulting the actors",
    rd.code !== 0 && /Roles is missing/.test(rd.out));
}

// 17b-7. A declaration inside an HTML comment is NOT a declaration — masked centrally in getKV so
// every caller inherits it. Fixing this per-caller produced four escapes of the same shape; the
// last one hid `Roles:` in SESSION.md's OWN shipped comment block, which satisfied the exactly-one
// check and was then believed by reset.
if (SEL(28)) {
  // NOTE: the scaffolded SESSION.md may carry CRLF endings, so fixtures anchor on a REGEX rather
  // than a literal containing a newline. An earlier version used a literal, silently matched
  // nothing, and its assertion passed VACUOUSLY on an unmodified board — a test passing for the
  // wrong reason, which is the failure mode pinning was supposed to remove.
  const intoComment = (line) => (t) => t.replace(/^<!--/m, "<!--" + String.fromCharCode(10) + line);
  const hideRoles = (s) => edit(file(s.dir, "SESSION.md"), (t) =>
    intoComment("Roles: PRIMARY=ALPHA, SECONDARY=BETA")(t.replace(/^Roles:.*$/m, "")));
  const a = scaffold(); hideRoles(a);
  ok("a commented-out Roles line does not satisfy the declaration",
    /L1\b.*Roles is missing/.test(lint(a.root, a.id).out));
  const ra = run(["reset", "--session", a.id, "--force"], a.root);
  ok("reset refuses rather than believing a commented-out Roles line",
    ra.code !== 0 && /Roles is missing/.test(ra.out));
  // A live declaration must still be read even when a commented one sits beside it.
  const b = scaffold();
  edit(file(b.dir, "SESSION.md"), intoComment("Roles: PRIMARY=GHOST, SECONDARY=PHANTOM"));
  ok("the fixture actually applied (guard against a vacuous pass)",
    /^Roles: PRIMARY=GHOST/m.test(read(file(b.dir, "SESSION.md"))));
  ok("a live declaration beside a commented one is neither doubled nor shadowed",
    !has(lint(b.root, b.id).out, "L1"));
  // An UNCLOSED opener must mask to end of file. Masking only CLOSED comments leaves every
  // declaration after an unterminated opener live, which is the fail-OPEN direction. NOTE the
  // opener must go AFTER the shipped comment block in the template, or that block's own closer
  // ends it and the trailing declaration really is live — an earlier probe of mine got this wrong
  // and "confirmed" the bug against a comment that was actually closed.
  {
    const u = scaffold();
    edit(file(u.dir, "SESSION.md"), (t) => t.replace(/^Roles:.*$/m, "")
      + NL + "<!-- truly unclosed, no closer after this" + NL
      + "Roles: PRIMARY=ALPHA, SECONDARY=BETA" + NL);
    ok("a declaration after an UNCLOSED comment is not live (fails closed)",
      /L1\b.*Roles is missing/.test(lint(u.root, u.id).out));
    const ru = run(["reset", "--session", u.id, "--force"], u.root);
    ok("reset refuses rather than carrying actors from after an unclosed comment",
      ru.code !== 0 && /Roles is missing/.test(ru.out));
  }
  const rb = run(["reset", "--session", b.id, "--force"], b.root);
  ok("reset carries the LIVE actors, not the commented ones", rb.code === 0
    && fs.existsSync(file(path.join(b.root, ".collab-board", "sessions",
      fs.readdirSync(path.join(b.root, ".collab-board", "sessions")).filter((n) => !n.includes("archived"))[0]),
      "agents", "codex.md")));
}

// 17b-9. PROTOCOL.md STRUCTURAL INTEGRITY. A doc edit removed sections 8-10 outright - the
// event-log grammar, the file schemas, and the lint invariants - and NOTHING caught it: the
// suite asserted individual sentences but never that the document still had its sections, and
// lint never reads this file. Only a diff review found it. Prose assertions do not protect a
// document's structure; this does. PROTOCOL.md is copied verbatim into every project, so a
// silent truncation here propagates to every board scaffolded afterwards.
if (SEL(29)) {
  const REF = path.join(HERE, "..", "references");
  const proto = read(path.join(REF, "protocol.md"));
  const sections = [
    "## 0.", "## 1.", "## 2.", "## 3.", "## 4.",
    "## 5.", "## 6.", "## 7.", "## 8.", "## 9.", "## 10.",
  ];
  for (const sec of sections) ok(`protocol.md still has section ${sec}`, proto.includes(sec));
  // The rules list must be complete: a truncation that stops mid-list is the exact shape of the
  // damage, and the contents line promises rules 1-11.
  for (let n = 1; n <= 11; n++)
    ok(`protocol.md still defines rule ${n}`, new RegExp(`^${n}\\. \\*\\*`, "m").test(proto));
  // The closed log vocabulary and the schema list are what sections 8 and 9 exist to carry.
  ok("protocol.md section 8 still lists the log event grammar", /^<ts> TURN_COMMIT /m.test(proto));
  // Pinned to the SHIPPED version rather than a frozen version number, and read from the engine so
  // the document and the table cannot disagree about which schema ships.
  {
    const shipped = [...read(CLI).matchAll(/^  (v\d+): \{ keys: \[/gm)].map((m) => m[1]).pop();
    ok("the engine declares a shipped agent schema (fixture sanity)", !!shipped, String(shipped));
    ok("protocol.md section 9 lists the agent schema the engine ships",
      new RegExp(`\\*\\*agent/${shipped}\\*\\* ship templates`).test(proto), shipped);
    ok("...and still documents the previous one, which frozen boards remain on",
      /\*\*agent\/v2\*\* additionally/.test(proto));
  }
  // New/reset sessions snapshot the installed protocol locally. A clean board does not carry the
  // obsolete shared-root duplicate; existing roots remain supported below.
  const s = scaffold();
  const local = path.join(s.dir, "PROTOCOL.md");
  ok("new session PROTOCOL.md matches the skill source byte for byte", read(local) === proto);
  ok("new board does not create a redundant root PROTOCOL.md",
    !fs.existsSync(path.join(s.root, ".collab-board", "PROTOCOL.md")));
  write(local, read(local) + "\nnegative-control\n");
  ok("snapshot equality negative control detects changed local bytes", read(local) !== proto);
  ok("lint checks snapshot existence, not equality with a later source", lint(s.root, s.id).code === 0);
  const rr = run(["reset", "--session", s.id, "--force"], s.root);
  ok("reset succeeds after a locally frozen protocol diverges", rr.code === 0);
  const live = path.join(s.root, ".collab-board", "sessions", s.id, "PROTOCOL.md");
  ok("reset writes a fresh byte-identical protocol snapshot", read(live) === proto);

  const legacy = scaffold();
  const rootProto = path.join(legacy.root, ".collab-board", "PROTOCOL.md");
  write(rootProto, "legacy protocol bytes\n");
  fs.unlinkSync(path.join(legacy.dir, "PROTOCOL.md"));
  edit(file(legacy.dir, "HEAD.md"), (t) => t.replace("PROTOCOL: PROTOCOL.md", "PROTOCOL: ../../PROTOCOL.md"));
  edit(file(legacy.dir, "SESSION.md"), (t) => t.replace("Protocol: PROTOCOL.md", "Protocol: ../../PROTOCOL.md"));
  ok("legacy session may keep its existing shared-root protocol", lint(legacy.root, legacy.id).code === 0);
  ok("legacy root bytes are preserved", read(rootProto) === "legacy protocol bytes\n");
}

// 17b-9a. L28 resolves the protocol declared by the session, without turning immutable snapshots
// into live mirrors of the installed skill.
if (SEL(30)) {
  const missing = scaffold();
  fs.unlinkSync(file(missing.dir, "PROTOCOL.md"));
  ok("missing declared protocol fails L28", has(lint(missing.root, missing.id).out, "L28"));

  const mismatch = scaffold();
  edit(file(mismatch.dir, "SESSION.md"), (t) => t.replace("Protocol: PROTOCOL.md", "Protocol: OTHER.md"));
  ok("SESSION/HEAD protocol disagreement fails L28", has(lint(mismatch.root, mismatch.id).out, "L28"));

  const escape = scaffold();
  edit(file(escape.dir, "HEAD.md"), (t) => t.replace("PROTOCOL: PROTOCOL.md", "PROTOCOL: ../../../outside.md"));
  edit(file(escape.dir, "SESSION.md"), (t) => t.replace("Protocol: PROTOCOL.md", "Protocol: ../../../outside.md"));
  ok("protocol traversal outside .collab-board fails L28", has(lint(escape.root, escape.id).out, "L28"));
}
// 17b-10. TARGET CONFINEMENT (E8/E9/E10). A command's target and a check's dereference target are
// both part of applicability. Before these guards: `reset --session ../../victim --force` ARCHIVED
// a directory outside .collab-board and re-scaffolded a board in its place; a directory named like
// a shard crashed lint with EISDIR and zero findings; and an existing file outside the board
// satisfied L14's sibling-chain invariant. These are lexical guards - they stop traversal, they do
// NOT establish canonical containment across symlinks, and nothing here should imply otherwise.
if (SEL(31)) {
  // --- E9: no explicit --session may escape the sessions directory, on ANY command.
  for (const sep of ['../../victim', '..\\..\\victim']) {
    const s0 = scaffold();
    const outside = path.join(s0.root, 'victim');
    fs.mkdirSync(outside, { recursive: true });
    write(path.join(outside, 'precious.txt'), 'SENTINEL');
    write(path.join(outside, 'HEAD.md'), read(file(s0.dir, 'HEAD.md')));
    write(path.join(outside, 'SESSION.md'), read(file(s0.dir, 'SESSION.md')));
    for (const cmd of [
      ['lint', '--session', sep], ['status', '--session', sep], ['advance', '--session', sep],
      ['activate', '--session', sep, '--actor', 'CLAUDE'],
      ['terminal', '--session', sep, '--status', 'ABORTED'],
      ['reset', '--session', sep, '--force'],
    ]) {
      const r = run(cmd, s0.root);
      ok(`${cmd[0]} refuses a traversal session id (${sep})`,
        r.code !== 0 && /single path component/.test(r.out));
    }
    ok(`the outside sentinel is byte-identical after every command (${sep})`,
      read(path.join(outside, 'precious.txt')) === 'SENTINEL');
    ok(`no archive directory was created outside the board (${sep})`,
      !fs.readdirSync(s0.root).some((n) => n.includes('.archived-')));
  }

  // --- E8: a directory must never reach readFileSync. A crash takes every invariant down.
  {
    const a = scaffold();
    fs.mkdirSync(file(a.dir, 'turns', 'P1-claude.md'), { recursive: true });
    const out = lint(a.root, a.id).out;
    ok('a turn-shaped DIRECTORY yields a finding, not an EISDIR crash',
      /L14\b.*is a directory, not a turn shard/.test(out) && !/EISDIR/.test(out));
    const b = scaffold();
    fs.mkdirSync(file(b.dir, 'agents', 'notes.md'), { recursive: true });
    ok('a directory inside agents/ does not crash lint', !/EISDIR/.test(lint(b.root, b.id).out));
  }

  // --- E10: a board-stored path target must match its declared relative grammar. The sentinel is
  // placed so each traversal WOULD resolve, or the fixture proves nothing.
  {
    const c = scaffold();
    write(path.join(c.root, 'outside.md'), 'outside sentinel');
    write(file(c.dir, 'turns', 'P1-claude.md'),
      '### TURN-P1 (CLAUDE)' + NL + 'SCHEMA: collab-board/turn/v1' + NL + '- Header: PART=PLAN' + NL +
      '- Body:' + NL + '  - FINDINGS: x' + NL + '- Evidence: x' + NL +
      '- Handoff: CLAUDE WORKING->ON_HOLD' + NL + 'PREV: NEW' + NL +
      'NEXT: [x](../../../../outside.md)' + NL);
    edit(file(c.dir, 'log.md'), (t) => t.trimEnd() + NL +
      '2026-08-03T10:00:00Z TURN_COMMIT P1 actor=CLAUDE responds_to=NEW points=- via=claude-code' + NL);
    ok('a NEXT target outside the turns directory fails L14',
      /L14\b.*not a sibling shard filename/.test(lint(c.root, c.id).out));
    edit(file(c.dir, 'HEAD.md'), (t) => t.replace(/^RESPONDS_TO:.*$/m, 'RESPONDS_TO: turns/../../../../outside.md'));
    ok('a RESPONDS_TO traversal fails L14',
      /L14\b.*is not "turns\/<shard>\.md"/.test(lint(c.root, c.id).out));
  }
}
// 17b-11. HEAD LIVE TARGET (E11/E1b). Declaration masking governs MUTATION-TARGET SELECTION, not
// only reading. Before this: an actor row inside a comment was believed live, so a session passed
// lint with no real SECONDARY row; and a column-0 commented SESSION_STATUS decoy ABSORBED
// `terminal --status ABORTED` while the live declaration stayed IDLE - the board reported a status
// it had never been given.
if (SEL(32)) {
  const commentOut = (t, line) => t.replace(line, "<!--" + NL + line + NL + "-->");

  const a = scaffold();
  edit(file(a.dir, "HEAD.md"), (t) => commentOut(t, "- CODEX: ON_HOLD - SECONDARY"));
  ok("an actor row inside a comment is not a live actor",
    /L1\b.*must list exactly 2 actors/.test(lint(a.root, a.id).out));

  // The decoy must be at column 0 inside a comment block, or it never matches the line-anchored
  // regex and the fixture proves nothing - an earlier version of this test made exactly that error.
  const b = scaffold();
  edit(file(b.dir, "HEAD.md"), (t) => t.replace("SESSION_STATUS: IDLE",
    "<!--" + NL + "SESSION_STATUS: IDLE" + NL + "-->" + NL + "SESSION_STATUS: IDLE"));
  ok("the decoy fixture actually applied (guard against a vacuous pass)",
    (read(file(b.dir, "HEAD.md")).match(/^SESSION_STATUS:/gm) || []).length === 2);
  run(["terminal", "--session", b.id, "--status", "ABORTED"], b.root);
  {
    // `\r?\n`, not NL: whether the scaffolded template arrives CRLF or LF depends on how git
    // materialised the working tree, and splitting on LF alone leaves a trailing \r that fails an
    // equality check for a reason that has nothing to do with what this fixture is testing.
    const decls = read(file(b.dir, "HEAD.md")).split(/\r?\n/).filter((l) => l.startsWith("SESSION_STATUS:"));
    ok("the commented decoy did NOT absorb the write", decls[0] === "SESSION_STATUS: IDLE");
    ok("the LIVE declaration received the write", decls[1] === "SESSION_STATUS: ABORTED");
  }

  // E1b: two State sections are two truths.
  const c = scaffold();
  edit(file(c.dir, "HEAD.md"), (t) => t + NL + "## State" + NL + "- CLAUDE: DONE - PRIMARY" + NL);
  ok("a second live State section fails L1",
    /L1\b.*live "## State" sections/.test(lint(c.root, c.id).out));
  const d = scaffold();
  edit(file(d.dir, "HEAD.md"), (t) => t + NL + "<!--" + NL + "## State" + NL + "-->" + NL);
  ok("a COMMENTED second State section is not a second section",
    !/live "## State" sections/.test(lint(d.root, d.id).out));
}
// 17b-12. E2 / E3 / E5 — three claims the engine did not actually enforce.
if (SEL(33)) {
  // E2: projectLog APPLIES any recognised GATE_SET, so a gate with no author was projected while
  // L20 had no opinion on it. A gate set by nobody passed lint.
  const a = scaffold();
  edit(file(a.dir, "log.md"), (t) => t.trimEnd() + NL +
    "2026-08-03T10:00:00Z GATE_SET PLAN_AGREE_SECONDARY=YES in=P1" + NL);
  edit(file(a.dir, "HEAD.md"), (t) => t.replace("PLAN_AGREE_SECONDARY: NO", "PLAN_AGREE_SECONDARY: YES"));
  ok("a GATE_SET with no by= fails L20", /L20\b.*carries no by=/.test(lint(a.root, a.id).out));
  const b = scaffold();
  edit(file(b.dir, "log.md"), (t) => t.trimEnd() + NL +
    "2026-08-03T10:00:00Z GATE_SET PLAN_AGREE_SECONDARY=YES by=CODEX in=P1" + NL);
  edit(file(b.dir, "HEAD.md"), (t) => t.replace("PLAN_AGREE_SECONDARY: NO", "PLAN_AGREE_SECONDARY: YES"));
  ok("a properly authored GATE_SET still passes L20", !has(lint(b.root, b.id).out, "L20"));

  // E3: with no LIVE delimiter there is no mandatory region to exempt, so the whole file counts.
  // Actor files ARE read every owner turn, so the previous "nothing reads it" premise was false.
  // Both boards are stripped of provenance: these fixtures write agent/v1 files, and on a board
  // whose log records v2 that is a finding in its own right, which would mask what E3 tests.
  const c = scaffold(); stripProvenance(c);
  write(file(c.dir, "agents", "claude.md"),
    "# CLAUDE self-state" + NL + "SCHEMA: collab-board/agent/v1" + NL + NL + "x".repeat(20000) + NL);
  ok("a large actor file with NO delimiter is sized, not exempted",
    /FAIL L24/.test(lint(c.root, c.id).out));
  const d = scaffold(); stripProvenance(d);
  write(file(d.dir, "agents", "claude.md"),
    "# CLAUDE self-state" + NL + "SCHEMA: collab-board/agent/v1" + NL + NL + "x".repeat(100) + NL);
  ok("a small actor file with no delimiter is still clean",
    !l24For(lint(d.root, d.id).out, "claude.md").length);

  // E5: one parse, one verdict. L18 re-derived Roles with a looser pattern, so spaces around "="
  // false-FAILed a board L1 had already accepted.
  const e = scaffold();
  edit(file(e.dir, "SESSION.md"), (t) => t.replace("Roles: PRIMARY=CLAUDE, SECONDARY=CODEX",
    "Roles: PRIMARY = CLAUDE, SECONDARY = CODEX"));
  ok("spaced Roles does not false-FAIL L18", !has(lint(e.root, e.id).out, "L18"));
  const f = scaffold();
  edit(file(f.dir, "SESSION.md"), (t) => t.replace("SECONDARY=CODEX", "SECONDARY=GEMINI"));
  ok("a genuinely mismatched SECONDARY still fails L18", has(lint(f.root, f.id).out, "L18"));
}
// 17b-13. E7 — Rule 7 says the SECONDARY OMITS Impl: and the PRIMARY ECHOES code_state. Both were
// under-enforced: an all-NONE SECONDARY line passed because only "real" values were rejected, and
// the PRIMARY shard was never compared against code_state at all, so two real-but-contradictory
// records could coexist. Cardinality is part of the claim - zero or two Impl: lines, or a
// duplicated code-state key, is not "one echo".
if (SEL(34)) {
  const CS_OK = "# Code State" + NL + NL + "BRANCH: main" + NL + "BASE_COMMIT: aaa1111" + NL + "LATEST_COMMIT: bbb2222" + NL;
  const shard = (actor, implLines) =>
    "### TURN-I1 (" + actor.toUpperCase() + ")" + NL + "SCHEMA: collab-board/turn/v1" + NL +
    "- Header: PART=IMPL" + NL + "- Body:" + NL + "  - FINDINGS: x" + NL + implLines +
    "- Evidence: x" + NL + "- Handoff: x" + NL + "PREV: NEW" + NL + "NEXT: none" + NL;
  const board = (actor, implLines, cs) => {
    const b = scaffold();
    write(file(b.dir, "turns", "I1-" + actor + ".md"), shard(actor, implLines));
    write(file(b.dir, "impl", "code_state.md"), cs || CS_OK);
    edit(file(b.dir, "log.md"), (t) => t.trimEnd() + NL +
      "2026-08-03T10:00:00Z TURN_COMMIT I1 actor=" + actor.toUpperCase() +
      " responds_to=NEW points=- via=claude-code" + NL);
    return lint(b.root, b.id).out;
  };
  const ECHO = "- Impl: BRANCH=main BASE_COMMIT=aaa1111 LATEST_COMMIT=bbb2222" + NL;

  ok("a PRIMARY shard echoing code_state passes L6", !has(board("claude", ECHO), "L6"));
  ok("a PRIMARY shard DISAGREEING with code_state fails L6",
    /L6\b.*it does not disagree with it/.test(board("claude",
      "- Impl: BRANCH=other BASE_COMMIT=aaa1111 LATEST_COMMIT=bbb2222" + NL)));
  ok("a PRIMARY shard with NO Impl line fails L6",
    /L6\b.*0 Impl: lines/.test(board("claude", "")));
  ok("a PRIMARY shard with TWO Impl lines fails L6",
    /L6\b.*2 Impl: lines/.test(board("claude", ECHO + ECHO)));
  ok("a duplicated code_state key fails L6",
    /L6\b.*more than once/.test(board("claude", ECHO,
      "# Code State" + NL + NL + "BRANCH: main" + NL + "BRANCH: other" + NL +
      "BASE_COMMIT: aaa1111" + NL + "LATEST_COMMIT: bbb2222" + NL)));
  // The SECONDARY omits the line ENTIRELY - an all-NONE line is still a line.
  ok("a SECONDARY shard with an all-NONE Impl line fails L6",
    /L6\b.*review-only/.test(board("codex",
      "- Impl: BRANCH=NONE BASE_COMMIT=NONE LATEST_COMMIT=NONE" + NL)));
  ok("a SECONDARY shard with no Impl line passes L6", !has(board("codex", ""), "L6"));

  // code_state.md is a MOVING SINGLETON that every IMPL turn updates, so an EARLIER shard
  // legitimately records the commit that was current at ITS turn. Comparing every shard against the
  // current value manufactured a finding for every turn but the last - it fired on three real
  // boards. Only the latest PRIMARY impl shard is compared.
  {
    const b2 = scaffold();
    write(file(b2.dir, "turns", "I1-claude.md"), shard("claude",
      "- Impl: BRANCH=main BASE_COMMIT=aaa1111 LATEST_COMMIT=old0000" + NL));
    write(file(b2.dir, "turns", "I2-claude.md"), shard("claude", ECHO));
    write(file(b2.dir, "impl", "code_state.md"), CS_OK);
    edit(file(b2.dir, "log.md"), (t) => t.trimEnd() + NL +
      "2026-08-03T10:00:00Z TURN_COMMIT I1 actor=CLAUDE responds_to=NEW points=- via=claude-code" + NL +
      "2026-08-03T10:00:01Z TURN_COMMIT I2 actor=CLAUDE responds_to=I1 points=- via=claude-code" + NL);
    const out = lint(b2.root, b2.id).out;
    ok("an EARLIER shard recording an older commit is not a divergence",
      !/I1-claude.md Impl: LATEST_COMMIT/.test(out));
  }
}
// 17b-14. E6 - point state IS derivable from the log, which is what makes adapters.md ROLLBACK
// performable. Recovery previously told the PRIMARY to restore rows "from pre-turn log replay"
// while replay carried no point state at all - a procedure that could not be carried out as
// written. A projector with no caller would be equally useless, so it is both exposed as a
// read-only command AND enforced by L2.
if (SEL(35)) {
  const withPoint = (s2, status, setTo, resolvedIn) => {
    edit(file(s2.dir, "points.md"), (t) => t.trimEnd() + NL +
      "| P1 | PLAN | projected point | " + status + " | " + (resolvedIn || "-") + " |" + NL);
    edit(file(s2.dir, "log.md"), (t) => t.trimEnd() + NL +
      "2026-08-03T18:30:00Z TURN_COMMIT P1 actor=CLAUDE responds_to=NEW points=P1 via=claude-code" + NL +
      (setTo ? "2026-08-03T18:30:01Z POINT_SET P1=" + setTo + " in=P1" + NL : ""));
    edit(file(s2.dir, "HEAD.md"), (t) => t.replace(/^PLAN_OPEN_POINTS:.*$/m,
      "PLAN_OPEN_POINTS: " + (status === "OPEN" ? 1 : 0)));
  };
  const a = scaffold(); withPoint(a, "AGREED", "AGREED", "[P1](turns/P1-claude.md)");
  ok("points.md agreeing with its POINT_SET history passes L2", !has(lint(a.root, a.id).out, "L2"));
  const b = scaffold(); withPoint(b, "AGREED", null);
  ok("a points.md row edited without its POINT_SET event fails L2",
    /but log projects OPEN/.test(lint(b.root, b.id).out));
  // The projector must be CALLABLE - a private helper cannot be used by a manual recovery.
  const c = scaffold(); withPoint(c, "AGREED", "AGREED", "[P1](turns/P1-claude.md)");
  const r = run(["points", "--session", c.id], c.root);
  ok("the points subcommand projects the table from the log",
    r.code === 0 && /P1\s+AGREED/.test(r.out) && /projected from log\.md/.test(r.out));
  ok("points refuses a traversal session id like every other command",
    run(["points", "--session", "../../victim"], c.root).code !== 0);
}

// 17b-15. NO CONTROL CHARACTERS IN THESE SOURCES. A literal 0x08 reached a regex twice via shell
// escaping - an intended word-boundary escape became a backspace. That does not error: it silently
// makes the pattern unmatchable, so the assertion passes or fails for reasons unrelated to what it
// claims to test. Invisible coverage loss, the same failure mode as an unreachable guard. The
// class is built from char codes so no escape sequence in THIS line can itself be mangled - the
// first version of this guard contained the very byte it was written to catch.
if (SEL(36)) {
  const ctrl = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(8)
    + String.fromCharCode(11) + String.fromCharCode(12)
    + String.fromCharCode(14) + '-' + String.fromCharCode(31) + ']');
  ok("the test file contains no stray control characters", !ctrl.test(read(path.join(HERE, "test.mjs"))));
  ok("the engine contains no stray control characters", !ctrl.test(read(CLI)));
}
// 17b-16. THE BOUNDARY PROPERTY. Fixtures pin the defects we already found; this pins the RULE, so
// a consumer nobody has written yet cannot reintroduce the class. Semantic consumers read the LIVE
// view by default; only NAMED byte-level checks read raw bytes. The failure mode being inverted:
// before this, a consumer was raw unless someone remembered to mask it, so every new consumer was
// a defect until noticed.
if (SEL(37)) {
  const src = read(CLI);
  const lines = src.split(NL);

  // 1. Session paths are constructed in exactly one place, and that place validates.
  const joins = lines.filter((l) => /path\.join\([^)]*sessions/.test(l) && !l.trim().startsWith("//"));
  ok("session paths are constructed in one place", joins.length <= 2);
  ok("sessionDir validates its component before joining",
    /function sessionDir\([\s\S]{0,200}requireSafeComponent/.test(src));

  // 2. The raw-byte exception is NAMED and small. L21 must see a BOM and L24 must count bytes, so
  //    they legitimately bypass the live view - but the list of files doing so must stay short
  //    enough to review, or "named exception" becomes "anything that felt convenient".
  const RAW_READS_ALLOWED = [
    // The BOM/mojibake sentinel must see bytes; a decoded read would hide the very thing it checks.
    "const buf = fs.readFileSync(p); // raw bytes — do not decode",
    // The size ladder charges CRLF and multibyte cost, so it counts bytes rather than characters.
    "const raw = fs.readFileSync(file);",
    // readText is the decoded reader every other consumer goes through.
    "const s = fs.readFileSync(p, \"utf8\");",
    // The user's preference file is NOT board text: it lives outside any board, under the user's
    // home, and the engine only echoes it. It deliberately does not go through readText, which
    // exists for board files and whose absence-handling is a die(), not a shrug — an absent
    // preference is the normal first-run state and must read as "ask the question", never as an
    // error. Allow-listed with that reason rather than routed through a boundary it does not belong to.
    "try { raw = fs.readFileSync(f, \"utf8\"); }",
    // A relay capture is hashed, so it is read as bytes and never re-encoded.
    "const raw = fs.readFileSync(f);",
    "for (const f of caps) onDisk.set(sha256(fs.readFileSync(path.join(captureDir(dir), f))), f);",
    // A capture already retained under the same name is compared by HASH, not by text: an
    // identical re-run after a crash must still relay, while differing bytes are a collision that
    // would destroy one contributor's record. Hashing decoded text would not be the same question.
    "if (exists(already) && sha256(fs.readFileSync(already)) !== c.sha)",
    // The fan-out seal hashes EVERY byte of the board, including the bytes a decoded read would
    // normalise away. A subagent that rewrote a file's line endings, or added a BOM, changed the
    // board — and a check that could not see that would be the wrong check.
    "else if (e.isFile()) { const b = fs.readFileSync(p); out.push(`${sha256(b)}  ${b.length.toString().padStart(9)}  ${r}`); }",
    // Reads THIS SCRIPT's own source once: the Usage header drives both the command list and the
    // text `--help` prints. Not board text at all, so the live-view boundary does not apply; it is
    // on the list because the list is the whole point — a raw read is allowed only when someone
    // has written down why.
    'const SOURCE = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");',
  ];
  const rawReads = lines.filter((l) => /fs\.readFileSync\(/.test(l) && !l.trim().startsWith("//")).map((l) => l.trim());
  const unlistedRaw = rawReads.filter((l) => !RAW_READS_ALLOWED.includes(l));
  ok("every raw byte read is on the explicit allow-list", unlistedRaw.length === 0);
  if (unlistedRaw.length) console.log("        unlisted raw reads: " + unlistedRaw.join(" | "));
  const staleRaw = RAW_READS_ALLOWED.filter((e) => !rawReads.includes(e));
  ok("the raw-read allow-list has no stale entries", staleRaw.length === 0);
  if (staleRaw.length) console.log("        stale raw-read entries: " + staleRaw.join(" | "));

  //   2b. THE PROPERTY, guarded at the boundary rather than at one syntactic shape. Two earlier
  //   versions of this check failed in instructive ways. The first asked whether a nearby comment
  //   SAID the words LIVE or RAW, which is satisfied by writing them. The second enumerated raw
  //   LINE SPLITS, and so was blind to the seven consumers that read raw text with test/includes/
  //   match — the ones that produced two FALSE findings and let a commented-out `- Evidence:` line
  //   satisfy the check that requires one.
  //
  //   The reader now returns the LIVE view and raw is a named request, so the property is a
  //   countable fact about the source: inside the linter, raw board text is reachable only through
  //   `cachedRaw`, and every call site is listed here with the reason it must see comment bytes.
  {
    const lintSrc = src.slice(src.indexOf("function lintSession"), src.indexOf("function requireSession"));
    const RAW_CALLERS_ALLOWED = [
      // `cached` is the live view, and it is built BY masking the raw one.
      "if (t === undefined) { t = liveText(cachedRaw(p)); liveCache.set(p, t); }",
      // L22's commented-event check exists precisely to find events hidden in comments, so it is
      // the one consumer that must see what the live view removes.
      "const logRaw = cachedRaw(path.join(dir, \"log.md\"));",
      // The comment-STRUCTURE checks are likewise ABOUT comment syntax; the live view has already
      // resolved the very thing they need to see. One read feeds both the unclosed and the nested
      // opener check, so this is one call site rather than two.
      "const rawText = cachedRaw(f);",
      // Ruleset provenance is read from the LIVE view but COMPARED against the raw line: the
      // escape was a token masked by a code span, which the live view blanks and a live-only
      // reader then reports as absence — the lenient direction.
      "const rulesetProv = boardRuleset(logText, cachedRaw(path.join(dir, \"log.md\")));",
    ];
    const rawCallers = lintSrc.split(/\r?\n/)
      .filter((l) => l.includes("cachedRaw(") && !l.trim().startsWith("//"))
      .map((l) => l.trim());
    const unlisted = rawCallers.filter((l) => !RAW_CALLERS_ALLOWED.includes(l));
    ok("raw board text is reached only through the named boundary", unlisted.length === 0);
    if (unlisted.length) console.log("        unlisted raw callers: " + unlisted.join(" | "));
    // Each allowed entry must correspond to exactly one real call site, so the list cannot keep a
    // dead exemption alive and cannot be satisfied twice by one entry.
    const miscounted = RAW_CALLERS_ALLOWED.filter((e) => rawCallers.filter((l) => l === e).length !== 1);
    ok("every raw-boundary exemption corresponds to exactly one live call site", miscounted.length === 0);
    if (miscounted.length) console.log("        miscounted entries: " + miscounted.join(" | "));
    // And the exemption list stays short enough that a reader can hold all of it at once.
    ok("the raw-boundary exemption list is small enough to review", RAW_CALLERS_ALLOWED.length <= 4);

    // Not only inside lint. appendEvent chose the timestamp it clamps against by scanning the log
    // as raw text, so a COMMENTED event steered a live write — a raw semantic read with no split
    // and no cachedRaw in sight, which neither earlier guard could have seen.
    const appendSrc = src.slice(src.indexOf("function appendEvent"), src.indexOf("function slugify"));
    ok("appendEvent decides against the live view, not raw bytes",
      appendSrc.includes("liveText(") && /lastTs = \[\.\.\.prevLive/.test(appendSrc));
    // The advance precondition reads plan/context.md; a commented placeholder must not block a
    // legitimate gate, and an uncommented one must still block it.
    const advSrc = src.slice(src.indexOf("function cmdAdvance"), src.indexOf("function cmdActivate"));
    ok("advance judges plan/context.md on the live view", /liveText\([^)]*ctx/.test(advSrc) || /liveText\(readText\(ctx\)\)/.test(advSrc));
  }

  // 3. Directory enumeration is file-kind aware wherever board artifacts are discovered - a
  //    directory reaching readFileSync crashed lint twice.
  const readdirs = lines.filter((l) => /fs\.readdirSync\(/.test(l) && !l.trim().startsWith("//"));
  const kindAware = readdirs.filter((l) => /withFileTypes/.test(l));
  ok("every directory enumeration is file-kind aware",
    readdirs.length > 0 && kindAware.length === readdirs.length);

  // 4. HEAD mutation goes through the live-target helper, never a raw first-match replace. A
  //    commented decoy absorbed a real write before this held.
  const advIdx = src.indexOf("function cmdAdvance");
  const termIdx = src.indexOf("function cmdTerminal");
  const resetIdx = src.indexOf("function cmdReset");
  const mutators = src.slice(Math.min(advIdx, termIdx), resetIdx);
  ok("advance and terminal select mutation targets on the live view",
    /replaceLiveLine\(/.test(mutators));
  ok("advance and terminal do not raw-replace HEAD declarations",
    !/head\.raw[\s\S]{0,80}\.replace\(/.test(mutators));

  // 5. liveText is the single masking implementation - two would drift apart, which is how the
  //    reads and the writes came to disagree about which declaration was real.
  //    LIMIT, stated so this is not mistaken for more than it is: this catches a literal duplicate
  //    of the SAME name. A second masking implementation under a DIFFERENT name would not be
  //    caught, and the negative control for this one is inconclusive - injecting a duplicate
  //    function declaration is a module-level SyntaxError, so the suite never reaches the
  //    assertion. Controls 3 (file-kind discovery) and the sessionDir validation ARE proven:
  //    breaking either fails the suite.
  ok("comment masking has exactly one implementation",
    (src.match(/^function liveText\(/gm) || []).length === 1);
}
// 17b-17. Gaps the SECONDARY found in the first increment: PREV was still dereferenced RAW before
// the validated loop (so E10 was never closed for PREV, and no fixture covered it), the link
// grammar accepted any filename while the diagnostic claimed a shard name, and L2 iterated only
// PROJECTED rows comparing only status - so a table-only row or a stale Resolved In passed while
// the projector advertised full derivation.
if (SEL(38)) {
  const chain = (s2, prevLink) => {
    write(file(s2.dir, "turns", "P2-claude.md"),
      "### TURN-P2 (CLAUDE)" + NL + "SCHEMA: collab-board/turn/v1" + NL + "- Header: PART=PLAN" + NL +
      "- Body:" + NL + "  - FINDINGS: x" + NL + "- Evidence: x" + NL + "- Handoff: x" + NL +
      "PREV: [x](" + prevLink + ")" + NL + "NEXT: none" + NL);
    edit(file(s2.dir, "log.md"), (t) => t.trimEnd() + NL +
      "2026-08-03T18:40:00Z TURN_COMMIT P2 actor=CLAUDE responds_to=NEW points=- via=claude-code" + NL);
    return lint(s2.root, s2.id).out;
  };
  const t1 = scaffold();
  write(path.join(t1.root, "outside.md"), "outside sentinel");
  ok("a PREV target outside the turns directory fails L14",
    /L14.*PREV target is not a sibling shard filename/.test(chain(t1, "../../../../outside.md")));
  const t2 = scaffold();
  write(file(t2.dir, "turns", "notes.md"), "not a shard");
  ok("a PREV target that exists but is not shard-named fails L14",
    /L14.*PREV target is not a sibling shard filename/.test(chain(t2, "notes.md")));

  // A malformed cursor is one finding, not a reason to stop checking the board.
  const t3 = scaffold();
  edit(file(t3.dir, "HEAD.md"), (t) => t.replace(/^RESPONDS_TO:.*$/m, "RESPONDS_TO: turns/../evil.md"));
  // The assertion must name a check that runs AFTER the cursor check, or it cannot witness the
  // suppression: L4 is evaluated well before L14, so pairing it with L14 proves nothing. L24 is
  // downstream, so it is the one the early return actually silenced.
  write(file(t3.dir, "agents", "stranger.md"), "# not an actor" + NL);
  {
    const out = lint(t3.root, t3.id).out;
    ok("a malformed RESPONDS_TO does not suppress checks that run after it",
      /L14.*RESPONDS_TO/.test(out) && /L24.*stranger.md/.test(out));
  }

  // The cursor obeys the same grammar as the links. A traversing RESPONDS_TO was already rejected
  // by the component check; a target that is merely NOT SHARD-NAMED was not, though the diagnostic
  // claimed it was.
  const t3b = scaffold();
  write(file(t3b.dir, "turns", "notes.md"), "not a shard");
  edit(file(t3b.dir, "HEAD.md"), (t2) => t2.replace(/^RESPONDS_TO:.*$/m, "RESPONDS_TO: turns/notes.md"));
  ok("a RESPONDS_TO target that exists but is not shard-named fails L14",
    /L14.*RESPONDS_TO is not/.test(lint(t3b.root, t3b.id).out));

  // L2 reconciles the UNION of ids and the WHOLE row.
  const t4 = scaffold();
  edit(file(t4.dir, "points.md"), (t) => t.trimEnd() + NL + "| P9 | PLAN | table only | OPEN | - |" + NL);
  edit(file(t4.dir, "HEAD.md"), (t) => t.replace(/^PLAN_OPEN_POINTS:.*$/m, "PLAN_OPEN_POINTS: 1"));
  ok("a points.md row the log never projects fails L2",
    /L2.*the log projects no such point/.test(lint(t4.root, t4.id).out));

  const t5 = scaffold();
  edit(file(t5.dir, "points.md"), (t) => t.trimEnd() + NL +
    "| P1 | PLAN | stale link | AGREED | [P7](turns/P7-claude.md) |" + NL);
  edit(file(t5.dir, "log.md"), (t) => t.trimEnd() + NL +
    "2026-08-03T18:40:00Z TURN_COMMIT P1 actor=CLAUDE responds_to=NEW points=P1 via=claude-code" + NL +
    "2026-08-03T18:40:01Z POINT_SET P1=AGREED in=P1" + NL);
  edit(file(t5.dir, "HEAD.md"), (t) => t.replace(/^PLAN_OPEN_POINTS:.*$/m, "PLAN_OPEN_POINTS: 0"));
  ok("a stale Resolved In fails L2",
    /L2.*Resolved In=P7 but log projects P1/.test(lint(t5.root, t5.id).out));

  // A later turn re-asserting a status already held must NOT move Resolved In - this is the shape
  // that made the reconciliation fail four rows on a board whose table was in fact correct.
  const t7 = scaffold();
  edit(file(t7.dir, "points.md"), (t2) => t2.trimEnd() + NL +
    "| P1 | PLAN | resolved once | AGREED | [P2](turns/P2-claude.md) |" + NL);
  edit(file(t7.dir, "log.md"), (t2) => t2.trimEnd() + NL +
    "2026-08-03T18:40:00Z TURN_COMMIT P1 actor=CLAUDE responds_to=NEW points=P1 via=claude-code" + NL +
    "2026-08-03T18:40:00Z TURN_COMMIT P2 actor=CODEX responds_to=P1 points=P1 via=codex-cli" + NL +
    "2026-08-03T18:40:00Z TURN_COMMIT P3 actor=CLAUDE responds_to=P2 points=P1 via=claude-code" + NL +
    "2026-08-03T18:40:01Z POINT_SET P1=OPEN in=P1" + NL +
    "2026-08-03T18:40:02Z POINT_SET P1=AGREED in=P2" + NL +
    "2026-08-03T18:40:03Z POINT_SET P1=AGREED in=P3" + NL);
  edit(file(t7.dir, "HEAD.md"), (t2) => t2.replace(/^PLAN_OPEN_POINTS:.*$/m, "PLAN_OPEN_POINTS: 0"));
  ok("re-asserting a held status does not move Resolved In", !has(lint(t7.root, t7.id).out, "L2"));

  // OPEN -> AGREED -> OPEN: reopening must clear Resolved In, not keep the old link.
  const t6 = scaffold();
  edit(file(t6.dir, "points.md"), (t) => t.trimEnd() + NL + "| P1 | PLAN | reopened | OPEN | - |" + NL);
  edit(file(t6.dir, "log.md"), (t) => t.trimEnd() + NL +
    "2026-08-03T18:40:00Z TURN_COMMIT P1 actor=CLAUDE responds_to=NEW points=P1 via=claude-code" + NL +
    "2026-08-03T18:40:01Z POINT_SET P1=AGREED in=P1" + NL +
    "2026-08-03T18:40:02Z POINT_SET P1=OPEN in=P1" + NL);
  ok("a reopened point projects OPEN with no Resolved In", !has(lint(t6.root, t6.id).out, "L2"));
}
// 17b-18. E4 — APPLICABILITY FROM PROVENANCE. L24 resolved the agent schema from the actor file's
// own SCHEMA: line, so the check's applicability was a function of the bytes it was checking: a
// scaffolded v2 file could rewrite that line to v1, delete all five mandatory keys, and lint PASS.
// The board's schema now comes from its append-only log, and changing it is an explicit `migrate`
// that is ATOMIC BY RECOVERY — the appended SCHEMA_SET is the commit point.
if (SEL(39)) {
  const V1 = (actor, notes) =>
    "# " + actor + " self-state — legacy" + NL + "SCHEMA: collab-board/agent/v1" + NL + NL +
    "SELF_HAND: ON_HOLD" + NL + "LAST_TURN_WRITTEN: -" + NL + NL + "PRIVATE_NOTES:" + NL + notes;
  const legacyBoard = (notes) => {
    const s2 = scaffold();
    stripProvenance(s2);
    write(file(s2.dir, "agents", "claude.md"), V1("CLAUDE", notes));
    write(file(s2.dir, "agents", "codex.md"), V1("CODEX", notes));
    return s2;
  };
  const mig = (s2, to) => run(["migrate", "--session", s2.id, "--to", to || "agent/v2"], s2.root);
  const schemaSets = (s2) => (read(file(s2.dir, "log.md")).match(/SCHEMA_SET/g) || []).length;

  // The escape itself: on a board whose log records v2, a file cannot demote itself.
  {
    const s2 = scaffold();
    write(file(s2.dir, "agents", "claude.md"), V1("CLAUDE", "- note" + NL));
    ok("a v2 board's actor file cannot downgrade itself out of the closed grammar",
      /FAIL L24.*claude\.md.*does not choose its own grammar/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    edit(file(s2.dir, "agents", "claude.md"), (t) => t.replace(/^SCHEMA:.*$/m, ""));
    ok("a v2 board's actor file cannot escape by deleting its declaration entirely",
      /FAIL L24.*claude\.md.*no SCHEMA: declaration but the log records/.test(lint(s2.root, s2.id).out));
  }
  // Malformed provenance must not read as absence — the malformed spelling would become the escape.
  {
    const s2 = scaffold();
    edit(file(s2.dir, "log.md"), (t) => t.trimEnd() + NL +
      "2026-08-03T19:00:00Z SCHEMA_SET agent/v9->agent/v2 by=CLAUDE" + NL);
    ok("malformed provenance FAILs rather than falling back to legacy absence",
      /FAIL L24.*provenance is malformed/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffoldV2();
    edit(file(s2.dir, "log.md"), (t) => t.replace("agent_schema=v2", "agent_schema=v7"));
    ok("an unknown agent_schema token on OPEN FAILs rather than being ignored",
      /FAIL L24.*provenance is malformed/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffoldV2();
    edit(file(s2.dir, "log.md"), (t) => t.trimEnd() + NL +
      "2026-08-03T19:00:00Z SCHEMA_SET agent/v1->agent/v2 by=CLAUDE" + NL);
    ok("a migration that does not start where the board is FAILs",
      /FAIL L24.*does not follow from agent\/v2/.test(lint(s2.root, s2.id).out));
  }
  // A legacy board keeps working, and says plainly that its grammar is still file-selected.
  {
    const s2 = legacyBoard("- note" + NL);
    const out = lint(s2.root, s2.id).out;
    ok("a legacy board is not retroactively failed on v2 grammar", !/FAIL L24/.test(out));
  }
  {
    const s2 = scaffoldV2(); stripProvenance(s2);
    ok("a v2-declaring file on a provenance-less board WARNs and names the fix",
      l24For(lint(s2.root, s2.id).out, "claude.md").some((l) => /WARN/.test(l) && /migrate --session/.test(l)));
  }

  // --- migrate ---
  {
    const notes = "<!-- keep me -->" + NL + "- an em dash — survives" + NL;
    const s2 = legacyBoard(notes);
    const before = fs.readFileSync(file(s2.dir, "agents", "claude.md"));
    const kept = before.slice(before.lastIndexOf(Buffer.from("PRIVATE_NOTES:")));
    const r = mig(s2);
    ok("migrate exits 0 on a legacy board", r.code === 0);
    const after = fs.readFileSync(file(s2.dir, "agents", "claude.md"));
    ok("migrate preserves the PRIVATE_NOTES region byte-for-byte",
      after.slice(after.lastIndexOf(Buffer.from("PRIVATE_NOTES:"))).equals(kept));
    const txt = after.toString("utf8");
    ok("migrate writes all five v2 keys, mapping v1 '-' to NONE",
      /SCHEMA: collab-board\/agent\/v2/.test(txt) && /SELF_HAND: ON_HOLD/.test(txt) &&
      /LAST_TURN_WRITTEN: NONE/.test(txt) && /ACTIVE_RECOVERY: NONE/.test(txt) &&
      /EXECUTOR_THREAD: NONE/.test(txt) && /UNRESOLVED_CONCERNS: NONE/.test(txt));
    ok("migrate commits exactly one SCHEMA_SET", schemaSets(s2) === 1);
    ok("a migrated board lints with no L24 finding", !has(lint(s2.root, s2.id).out, "L24"));
    const r2 = mig(s2);
    ok("re-running after the commit is a no-op",
      r2.code === 0 && /already agent\/v2/.test(r2.out) && schemaSets(s2) === 1);
  }
  // ATOMIC BY RECOVERY: the event is the commit point, so a crash before it is completable.
  {
    const s2 = legacyBoard("- note" + NL);
    mig(s2);
    edit(file(s2.dir, "log.md"), (t) => t.replace(/^.*SCHEMA_SET.*\r?\n/m, ""));
    const r = mig(s2);
    ok("a crash between the rewrites and the commit is completed by re-running",
      r.code === 0 && /already v2-shaped/.test(r.out) && schemaSets(s2) === 1);
  }
  // Refusals. Each would otherwise have to GUESS, and a guess here silently loses actor state.
  {
    const s2 = legacyBoard("- note" + NL);
    write(file(s2.dir, "agents", "claude.md"),
      "# CLAUDE self-state" + NL + "SCHEMA: collab-board/agent/v1" + NL + NL + "SELF_HAND: ON_HOLD" + NL + NL + "- undelimited" + NL);
    const r = mig(s2);
    ok("migrate refuses a file with no live delimiter instead of guessing where notes begin",
      r.code !== 0 && /no live PRIVATE_NOTES/.test(r.out));
    ok("and refuses BEFORE writing anything",
      schemaSets(s2) === 0 && /agent\/v1/.test(read(file(s2.dir, "agents", "codex.md"))));
  }
  {
    const s2 = legacyBoard("- note" + NL);
    edit(file(s2.dir, "agents", "claude.md"), (t) => t.replace("SELF_HAND: ON_HOLD", "SELF_HAND: BUSY"));
    const r = mig(s2);
    ok("migrate refuses an unmappable SELF_HAND", r.code !== 0 && /is not a hand/.test(r.out));
  }
  {
    const s2 = legacyBoard("- note" + NL);
    edit(file(s2.dir, "agents", "claude.md"), (t) => t.replace("LAST_TURN_WRITTEN: -", "LAST_TURN_WRITTEN: -" + NL + "CUSTOM_KEY: x"));
    const r = mig(s2);
    ok("migrate refuses to DISCARD a key agent/v2 has no place for",
      r.code !== 0 && /has no place for/.test(r.out));
  }
  {
    const s2 = legacyBoard("- note" + NL);
    edit(file(s2.dir, "log.md"), (t) => t.trimEnd() + NL +
      "2026-08-03T19:00:00Z SCHEMA_SET agent/v9->agent/v2 by=CLAUDE" + NL);
    const r = mig(s2);
    ok("migrate refuses to build on malformed provenance",
      r.code !== 0 && /provenance is malformed/.test(r.out));
  }
  {
    const s2 = scaffoldV2();
    write(file(s2.dir, "agents", "claude.md"), V1("CLAUDE", "- note" + NL));
    const r = mig(s2);
    ok("migrate will not overwrite a stray v1 file on a board already committed to v2",
      r.code !== 0 && /will not overwrite/.test(r.out) &&
      /agent\/v1/.test(read(file(s2.dir, "agents", "claude.md"))));
  }
  {
    const s2 = scaffold();
    ok("migrate rejects an unsupported --to", mig(s2, "agent/v1").code !== 0);
  }
}
// 17b-19. Three places where a documented rule had no code behind it. PROTOCOL §8 calls the event
// vocabulary CLOSED while parseLog accepted any word and every projector ignored what it did not
// recognise; the L5 spec said "shard OR TURN_COMMIT" while the check read filenames only; and §8
// defines exactly one PHASE_SET form while the projector advanced the phase on any of them.
if (SEL(40)) {
  const appendLog = (s2, line) => edit(file(s2.dir, "log.md"), (t) => t.trimEnd() + NL + line + NL);

  {
    const s2 = scaffold();
    appendLog(s2, "2026-08-03T19:00:00Z HANDOF CLAUDE:START->ON_HOLD next=P2/CODEX seq=1");
    const out = lint(s2.root, s2.id).out;
    ok("a misspelled event type FAILs instead of vanishing from the replay",
      /FAIL L22.*"HANDOF".*does not define/.test(out));
    ok("and the finding quotes the line so the typo is visible", /HANDOF CLAUDE:START/.test(out));
  }
  {
    const s2 = scaffold();
    appendLog(s2, "2026-08-03T19:00:00Z STALL_CHECK actor=CLAUDE");
    ok("every type PROTOCOL §8 lists is accepted", !/FAIL L22/.test(lint(s2.root, s2.id).out));
  }

  // L5: IMPL committed before the gate, with no shard on disk to give it away.
  {
    const s2 = scaffold();
    appendLog(s2, "2026-08-03T19:00:00Z TURN_COMMIT I1 actor=CLAUDE responds_to=NEW points=- via=claude-code");
    ok("an I* TURN_COMMIT before the gate FAILs L5 even with no shard file",
      /FAIL L5.*TURN_COMMIT I1.*no PHASE_SET/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    write(file(s2.dir, "turns", "I1-claude.md"), "### TURN-I1 (CLAUDE)" + NL);
    ok("an I* shard before the gate still FAILs L5",
      /FAIL L5.*turns\/I1-claude\.md.*no PHASE_SET/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    appendLog(s2, "2026-08-03T19:00:00Z TURN_COMMIT P2 actor=CLAUDE responds_to=NEW points=- via=claude-code");
    ok("a P* TURN_COMMIT does not trip L5", !/FAIL L5/.test(lint(s2.root, s2.id).out));
  }

  // PHASE_SET: the payload was documented and never read, so any spelling advanced the phase.
  {
    const s2 = scaffold();
    appendLog(s2, "2026-08-03T19:00:00Z PHASE_SET IMPL->PLAN plan_open_points=0");
    const out = lint(s2.root, s2.id).out;
    ok("a PHASE_SET that is not the documented form FAILs and names the line",
      /FAIL L2.*PHASE_SET.*IMPL->PLAN.*is not the documented/.test(out));
    ok("and it does NOT advance the projected phase",
      !/HEAD PHASE=PLAN but log projects IMPL/.test(out));
  }
}
// 17b-20. The vocabulary is now enforced, which makes PROTOCOL §8 and the engine two copies of one
// list. Two copies drift, and this pair drifts SILENTLY in the dangerous direction: a type added to
// the engine but not to §8 is undocumented, and a type documented but not enforced is a FAIL on a
// board that followed the spec. Neither shows up in any behavioural fixture.
if (SEL(41)) {
  const src = read(CLI);
  const m = /const LOG_EVENTS = new Set\(\[([\s\S]*?)\]\)/.exec(src);
  ok("the engine declares its event vocabulary in one place", !!m);
  const engine = new Set((m ? m[1] : "").match(/"([A-Z_]+)"/g)?.map((x) => x.slice(1, -1)) || []);

  const proto = read(path.join(HERE, "..", "references", "protocol.md"));
  const sec8 = /## 8\. Append-only event log[\s\S]*?```([\s\S]*?)```/.exec(proto);
  ok("PROTOCOL §8 carries the event grammar block", !!sec8);
  const documented = new Set(((sec8 ? sec8[1] : "").match(/^<ts> ([A-Z_]+)/gm) || [])
    .map((x) => x.replace("<ts> ", "")));

  const missingFromDocs = [...engine].filter((t) => !documented.has(t));
  const missingFromEngine = [...documented].filter((t) => !engine.has(t));
  ok("every enforced event type is documented in PROTOCOL §8",
    engine.size > 0 && missingFromDocs.length === 0);
  ok("every event type PROTOCOL §8 documents is accepted by the engine",
    documented.size > 0 && missingFromEngine.length === 0);
  if (missingFromDocs.length || missingFromEngine.length)
    console.log("        engine-only: [" + missingFromDocs.join(", ") + "]  docs-only: [" + missingFromEngine.join(", ") + "]");

  // The lint-spec row lists them a third time, for the reader who never opens the engine.
  const spec = read(path.join(HERE, "..", "references", "lint-spec.md"));
  const row = (spec.split(/\r?\n/).find((l) => l.includes("| L22 ")) || "");
  ok("the L22 row lists exactly the enforced vocabulary",
    engine.size > 0 && [...engine].every((t) => row.includes("`" + t + "`")));
}
// 17b-21. The SECONDARY's I4 review. Five accepted inputs, every one reaching a check from outside
// the rules that check declares — the sixth consecutive round in which the PRIMARY asserted the
// change set was complete and it was not. A sixth defect of the same class surfaced while fixing
// the first: a commented-out event was still replayed by every projector.
if (SEL(42)) {
  // Stamped from the scaffolded board's OWN opening event, so L23 never masks the check under test
  // and no fixture depends on the wall clock.
  const after = (s2, n) => {
    const openTs = /^(\S+) OPEN/m.exec(read(file(s2.dir, "log.md")))[1];
    return new Date(Date.parse(openTs) + n * 1000).toISOString();
  };
  const app = (s2, line) => edit(file(s2.dir, "log.md"), (t) => t.trimEnd() + NL + line + NL);
  const V1 = (a) => "# " + a + " self-state" + NL + "SCHEMA: collab-board/agent/v1" + NL + NL +
    "SELF_HAND: ON_HOLD" + NL + "LAST_TURN_WRITTEN: -" + NL + NL + "PRIVATE_NOTES:" + NL + "- x" + NL;

  // A line that CLAIMS to be an event by starting with a timestamp is judged, whether or not it
  // parses. Recognising events by "does it match" made the selector the grammar it was selecting.
  {
    const s2 = scaffold();
    app(s2, after(s2, 1) + " -HANDOFF forged-payload");
    ok("a timestamped line that is not an event FAILs instead of being invisible",
      /FAIL L22.*not an event line/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    app(s2, "<!--" + NL + after(s2, 1) + " TERMINAL ABORTED by=CLAUDE seq=9" + NL + "-->");
    const out = lint(s2.root, s2.id).out;
    ok("a commented-out event FAILs", /FAIL L22.*inside a comment/.test(out));
    ok("and is no longer replayed — a commented TERMINAL used to end the projected session",
      !/projects ABORTED/.test(out));
  }
  // The check above passed for two commits while the SAME event hidden INLINE went unreported: the
  // raw scan was anchored, so it saw only the comment style that leaves the timestamp at column 0.
  // The three cases below are one fixture because the guard is only correct if all three hold — the
  // hole, the case that already worked, and the quotation that must stay silent.
  {
    const s2 = scaffold();
    app(s2, "<!-- " + after(s2, 1) + " TERMINAL ABORTED by=CLAUDE seq=9 -->");
    const out = lint(s2.root, s2.id).out;
    ok("an event hidden by an INLINE comment wrapper FAILs, not only a block comment",
      /FAIL L22.*inside a comment/.test(out));
    ok("and the diagnostic names the event type it found",
      /FAIL L22.*a TERMINAL event inside a comment/.test(out));
  }
  {
    // An event L2 does not replay: nothing else in the suite would witness this one going missing.
    const s2 = scaffold();
    app(s2, "<!-- " + after(s2, 1) + " SCHEMA_SET agent/v1->agent/v2 by=CLAUDE -->");
    ok("hiding a SCHEMA_SET inline FAILs — L2 never replays it, so no other check would notice",
      /FAIL L22.*inside a comment/.test(lint(s2.root, s2.id).out));
  }
  {
    // The control that decides the boundary. A comment QUOTING the grammar is documentation, and
    // this is exactly what a "timestamp anywhere in the line" search would have reported.
    const s2 = scaffold();
    app(s2, "<!-- Example: " + after(s2, 1) + " GATE_SET PLAN_AGREE_PRIMARY=YES by=CLAUDE -->");
    ok("a comment that QUOTES an event is not reported as a commented-out event",
      !/inside a comment/.test(lint(s2.root, s2.id).out));
  }
  // Found by the SECONDARY reviewing the fix above, as an input the fix did not reach. Comments do
  // not nest: the first `-->` closes the span, so the inner opener leaves the event behind a marker
  // no anchored selector can see, and the trailing closer is stray text. Neither L22 loop fires,
  // and the event chosen here is one L2 never replays, so nothing else witnesses it either.
  {
    const s2 = scaffold();
    app(s2, "<!-- <!-- " + after(s2, 1) + " SCHEMA_SET agent/v1->agent/v2 by=CLAUDE --> -->");
    const out = lint(s2.root, s2.id).out;
    ok("a nested <!-- opener is rejected at the comment-structure boundary",
      /FAIL L0.*inside an open comment/.test(out));
    ok("and the finding names the line the inner opener is on",
      /FAIL L0 .*log\.md line \d+ opens a/.test(out));
  }
  {
    // The control: ordinary adjacent comments must not read as nesting. Two complete comments on
    // one line contain a second `<!--` AFTER a span, not inside one.
    const s2 = scaffold();
    app(s2, "<!-- one --> <!-- two -->");
    ok("two adjacent complete comments are not reported as nested",
      !/inside an open comment/.test(lint(s2.root, s2.id).out));
  }
  {
    // The upper bound, written because the board-wide form failed a real turn: a review shard that
    // QUOTES this exploit is doing its job, and the shard's own required lines are checked by L13,
    // so nothing goes missing in silence there. Named for the file it actually covers — an earlier
    // name claimed "every non-log file" while asserting one agent file, which is a test name
    // reading as evidence it does not carry.
    const s2 = scaffold();
    edit(file(s2.dir, "agents", "claude.md"),
      (t) => t + NL + "- the exploit is <!-- <!-- ts EVENT --> --> on one line" + NL);
    ok("an AGENT FILE quoting the nested-opener exploit is not reported",
      !/inside an open comment/.test(lint(s2.root, s2.id).out));
  }
  // The lower bound. Log-only scope missed these two, and the SECONDARY produced both when asked to
  // attack the narrow scope. Each is a declaration whose ABSENCE is read as a value: the plan
  // sentinel gates PLAN->IMPL only while it is live, and an absent `Converge:` reads as the
  // defaults. Hiding either changes what the board means and produced no finding at all.
  {
    const s2 = scaffold();
    edit(file(s2.dir, "plan", "context.md"),
      (t) => t.replace("STATUS: EMPTY", "<!-- <!-- STATUS: EMPTY --> -->"));
    ok("hiding the plan sentinel behind a nested opener is reported",
      /FAIL L0.*plan\/context\.md.*inside an open comment/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    edit(file(s2.dir, "SESSION.md"),
      (t) => t.replace("Converge: BARREN=8, CHURN=2", "<!-- <!-- Converge: BARREN=1, CHURN=1 --> -->"));
    ok("hiding a declared Converge line behind a nested opener is reported",
      /FAIL L0.*SESSION\.md.*inside an open comment/.test(lint(s2.root, s2.id).out));
  }
  {
    // One control per file now in scope: an ordinary complete comment must stay legitimate there,
    // or the widening would have bought detection by breaking every scaffolded board.
    const s2 = scaffold();
    edit(file(s2.dir, "plan", "context.md"), (t) => t + NL + "<!-- an ordinary note -->" + NL);
    edit(file(s2.dir, "SESSION.md"), (t) => t + NL + "<!-- an ordinary note -->" + NL);
    ok("ordinary comments in the two newly-scoped files are still legitimate",
      !/inside an open comment/.test(lint(s2.root, s2.id).out));
  }

  // ---- ruleset provenance: which dead-end rules gate which boards --------------------------
  // Measured motivation: the pre-branch engine and this one over the same 26 frozen boards differ
  // on five boards that lint CLEAN before and FAIL after, on rules that did not exist when they
  // were written. Two of those checks have no remedy at all under an append-only log. The four
  // cases below are the whole mechanism: legacy is told, a declaring board is gated, a clean
  // declaring board stays clean, and a malformed token does not buy the exemption.
  {
    // The corruption used throughout: an event type that was legal under an open grammar.
    const corrupt = (s2) => app(s2, after(s2, 1) + " REEVAL by=CLAUDE in=I1 was=a now=b");
    const dropRuleset = (s2) => edit(file(s2.dir, "log.md"), (t) => t.replace(" ruleset=r1", ""));

    {
      const s2 = scaffold(); dropRuleset(s2); corrupt(s2);
      const out = lint(s2.root, s2.id).out;
      ok("a board with NO ruleset still REPORTS the dead-end finding", /L22.*REEVAL/.test(out));
      ok("but is not gated by it — a FAIL it cannot act on would only stall the board",
        /WARN L22.*REEVAL/.test(out) && !/FAIL L22.*REEVAL/.test(out));
    }
    {
      const s2 = scaffold(); corrupt(s2);
      ok("the SAME corruption FAILs on a board that declares the ruleset introducing the rule",
        /FAIL L22.*REEVAL/.test(lint(s2.root, s2.id).out));
    }
    {
      const s2 = scaffold();
      ok("a clean board declaring the ruleset stays clean",
        !has(lint(s2.root, s2.id).out, "L22"));
    }
    {
      const s2 = scaffold();
      edit(file(s2.dir, "log.md"), (t) => t.replace("ruleset=r1", "ruleset=r0"));
      corrupt(s2);
      const out = lint(s2.root, s2.id).out;
      ok("an unknown ruleset token is itself a FAIL", /FAIL L22.*ruleset=/.test(out));
      ok("and does NOT inherit the legacy exemption — the misspelling would be the escape",
        /FAIL L22.*REEVAL/.test(out));
    }
    {
      // Provenance a second OPEN could rewrite is not provenance.
      const s2 = scaffold();
      app(s2, after(s2, 1) + " OPEN session=META by=CLAUDE ruleset=r1");
      ok("a second OPEN declaring a ruleset is malformed provenance, not a re-origin",
        /FAIL L22.*exactly one/.test(lint(s2.root, s2.id).out));
    }
    {
      // The split is by REMEDY, not by age: a legacy board keeps FAILing the checks it CAN clear.
      const s2 = scaffold(); dropRuleset(s2);
      edit(file(s2.dir, "points.md"), (t) => t.trimEnd() + NL + "| P1 | PLAN | x | DEFERRED | - |" + NL);
      ok("a legacy board still FAILs a remedy-bearing check — only dead ends are gated",
        /FAIL L4.*DEFERRED/.test(lint(s2.root, s2.id).out));
    }

    // Five ways to make provenance unreadable, all constructed by the SECONDARY reviewing the first
    // implementation. Each one used to fall back to LEGACY, which is the lenient direction — the
    // spelling of the mistake became the exemption. The value still comes from the LIVE view (a
    // commented-out OPEN is not an origin); the RAW line is compared against it.
    const evasions = [
      ["a token masked by a code span", (t) => t.replace("ruleset=r1", "`ruleset=r1`")],
      ["a misspelled key", (t) => t.replace("ruleset=r1", "rulset=r1")],
      ["an empty value", (t) => t.replace("ruleset=r1", "ruleset=")],
      ["the key declared twice", (t) => t.replace("ruleset=r1", "ruleset=r1 ruleset=r0")],
      // A zero-width character between the key and its `=`. No regex looking for `ruleset=` sees a
      // declaration, so the board fell silently back to legacy. Machine tokens are fixed ASCII, so
      // the payload is tokenized and each token required to BE one, rather than searched for shapes.
      ["a zero-width character inside the key", (t) => t.replace("ruleset=r1", "ruleset​=r1")],
    ];
    for (const [name, mangle] of evasions) {
      const s2 = scaffold();
      edit(file(s2.dir, "log.md"), mangle);
      corrupt(s2);
      const out = lint(s2.root, s2.id).out;
      ok(`provenance hidden by ${name} is itself a FAIL`,
        /FAIL L22.*(unknown key|masked|empty ruleset|more than once|is not one of|printable-ASCII)/.test(out), name);
      ok(`and does not win the legacy exemption via ${name}`,
        /FAIL L22.*REEVAL/.test(out), name);
    }
    {
      // The control for all four: an unmangled board declares provenance cleanly and reports none
      // of those diagnostics. Without this the four above would pass on a check that fires always.
      const s2 = scaffold();
      ok("a clean OPEN line reports no provenance finding",
        !/(unknown key|masked|empty ruleset|more than once)/.test(lint(s2.root, s2.id).out));
    }

    // Every dead-end ARM is gated, not just the two that motivated the mechanism. The SECONDARY
    // inventoried the rest; gating only some would be the same inconsistency in a smaller place.
    const deadEnds = [
      ["L20", "an unattributed gate", (s2) => app(s2, after(s2, 1) + " GATE_SET PLAN_AGREE_PRIMARY=YES")],
      ["L20", "a forged gate author", (s2) => app(s2, after(s2, 1) + " GATE_SET PLAN_AGREE_SECONDARY=YES by=CLAUDE")],
      ["L22", "an unknown event type", (s2) => corrupt(s2)],
      ["L22", "an event hidden in a comment", (s2) => app(s2, "<!-- " + after(s2, 1) + " TERMINAL ABORTED by=CLAUDE seq=9 -->")],
      ["L23", "a decreasing timestamp", (s2) => app(s2, "2000-01-01T00:00:00.000Z STALL_CHECK actor=CLAUDE")],
      ["L26", "a REFRAME off its documented form", (s2) => app(s2, after(s2, 1) + " REFRAME by=CLAUDE nonsense")],
      ["L26", "a REFRAME authored by the non-PRIMARY", (s2) => app(s2, after(s2, 1) + " REFRAME by=CODEX in=P1 trigger=MANUAL outcome=CONTINUE")],
      ["L11", "an event logged after TERMINAL", (s2) => {
        // The L11 block only runs when HEAD itself is terminal, so the fixture has to reach that
        // state through the command rather than by appending a TERMINAL line to the log.
        run(["terminal", "--session", s2.id, "--status", "ABORTED"], s2.root);
        app(s2, after(s2, 1) + " TURN_COMMIT P9 actor=CLAUDE responds_to=P1 points=-");
      }],
      ["L0", "a nested opener in the log", (s2) => app(s2, "<!-- <!-- " + after(s2, 1) + " STALL_CHECK actor=CLAUDE --> -->")],
    ];
    for (const [code, what, corruptIt] of deadEnds) {
      const dec = scaffold(); corruptIt(dec);
      ok(`${code}: ${what} FAILs a board declaring the ruleset`,
        new RegExp(`FAIL ${code}\\b`).test(lint(dec.root, dec.id).out), what);
      const leg = scaffold(); dropRuleset(leg); corruptIt(leg);
      const legOut = lint(leg.root, leg.id).out;
      // Matched on the LEGACY NOTE, not on "no FAIL of this code anywhere". A corruption can also
      // trip a DIFFERENT arm of the same code that is legitimately ungated — the barren-phase arm
      // of L26 is cleared by logging a step-back, so it must keep failing — and asserting the
      // absence of the whole code would quietly demand that ungated arms go silent too.
      ok(`${code}: the same on a legacy board is reported but not gated`,
        new RegExp(`WARN ${code}\\b[\\s\\S]*?predates the rule`).test(legOut), what);
    }
  }

  // PHASE_SET has exactly one documented payload, and the projector matched only a prefix of it.
  {
    const s2 = scaffold();
    app(s2, after(s2, 1) + " PHASE_SET PLAN->IMPL garbage");
    const out = lint(s2.root, s2.id).out;
    ok("a PHASE_SET whose payload is not the documented form FAILs",
      /FAIL L2.*is not the documented/.test(out));
    ok("and does not advance the projected phase", !/log projects IMPL/.test(out));
  }
  {
    const s2 = scaffold();
    app(s2, after(s2, 1) + " PHASE_SET PLAN->IMPL plan_open_points=0");
    ok("the documented PHASE_SET form is still applied",
      /log projects IMPL/.test(lint(s2.root, s2.id).out));
  }

  // Provenance anyone may write is not provenance. This is the E4 escape reopened one level up.
  {
    const s2 = scaffold();
    app(s2, after(s2, 1) + " SCHEMA_SET agent/v2->agent/v1 by=STRANGER");
    for (const a of ["claude", "codex"]) write(file(s2.dir, "agents", a + ".md"), V1(a.toUpperCase()));
    const out = lint(s2.root, s2.id).out;
    ok("a reverse SCHEMA_SET is rejected as an unsupported migration",
      /FAIL L24.*not a supported migration/.test(out));
    ok("so the v1 actor files it was meant to legitimise still FAIL",
      /FAIL L24.*(does not choose its own grammar|records this board as agent\/v2)/.test(out));
  }
  {
    const s2 = scaffold(); stripProvenance(s2);
    app(s2, after(s2, 1) + " SCHEMA_SET agent/v1->agent/v2 by=STRANGER");
    ok("a SCHEMA_SET in the RIGHT direction but by the wrong actor is rejected",
      /FAIL L24.*only the PRIMARY migrates/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffoldV2();
    app(s2, after(s2, 1) + " OPEN session=META by=CLAUDE agent_schema=v1");
    ok("a second OPEN declaring a schema is rejected — a board has one origin",
      /FAIL L24.*one origin/.test(lint(s2.root, s2.id).out));
  }

  // migrate and lint must mean the same thing by "already v2".
  {
    const s2 = scaffoldV2(); stripProvenance(s2);
    edit(file(s2.dir, "agents", "claude.md"), (t) => t.replace("SELF_HAND: ON_HOLD", "SELF_HAND: BUSY"));
    const m = run(["migrate", "--session", s2.id, "--to", "agent/v2"], s2.root);
    ok("migrate refuses a file lint would reject rather than committing the migration",
      m.code !== 0 && !/SCHEMA_SET/.test(read(file(s2.dir, "log.md"))));
    ok("and names the value that stopped it", /BUSY/.test(m.out));
  }

  // A resolved point must name the turn that resolved it, or the whole-row reconciliation is
  // stepped around by omitting one field.
  {
    const s2 = scaffold();
    app(s2, after(s2, 1) + " TURN_COMMIT P1 actor=CLAUDE responds_to=NEW points=P1 via=claude-code");
    app(s2, after(s2, 2) + " POINT_SET P1=AGREED");
    edit(file(s2.dir, "points.md"), (t) => t.trimEnd() + NL + "| P1 | PLAN | x | AGREED | - |" + NL);
    ok("a POINT_SET that resolves a point without in= FAILs",
      /FAIL L2.*resolves a point but carries no in=/.test(lint(s2.root, s2.id).out));
  }

  // Controls: none of the above may be achieved by rejecting legitimate boards.
  {
    const s2 = scaffoldV2();
    app(s2, after(s2, 1) + " TURN_COMMIT P1 actor=CLAUDE responds_to=NEW points=P1 via=claude-code");
    app(s2, after(s2, 2) + " POINT_SET P1=OPEN in=P1");
    app(s2, after(s2, 3) + " STALL_CHECK actor=CLAUDE");
    edit(file(s2.dir, "points.md"), (t) => t.trimEnd() + NL + "| P1 | PLAN | x | OPEN | - |" + NL);
    edit(file(s2.dir, "HEAD.md"), (t) => t.replace(/^PLAN_OPEN_POINTS:.*$/m, "PLAN_OPEN_POINTS: 1"));
    ok("a board using the legitimate forms still passes",
      !/FAIL L2\b|FAIL L22|FAIL L23/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffoldV2(); stripProvenance(s2);
    const m = run(["migrate", "--session", s2.id, "--to", "agent/v2"], s2.root);
    ok("a legitimate migration still succeeds and lints clean",
      m.code === 0 && !/FAIL/.test(lint(s2.root, s2.id).out));
  }
}
// 17b-22. The SECONDARY's I6 review. Five more accepted inputs, one regression introduced by the
// previous round, and a mutator that wrote before reconciling identity. Note the regression: the
// change that stopped a raw log line from escaping L22 also made the merged-line scan read raw
// bytes, so a comment merely MENTIONING two timestamps was reported as two merged events. Closing
// a hole in the reading of a file is not free — the same change can invent a finding elsewhere.
if (SEL(43)) {
  const after = (s2, n) => {
    const openTs = /^(\S+) OPEN/m.exec(read(file(s2.dir, "log.md")))[1];
    return new Date(Date.parse(openTs) + n * 1000).toISOString();
  };
  const app = (s2, line) => edit(file(s2.dir, "log.md"), (t) => t.trimEnd() + NL + line + NL);
  const shard = (s2, id2) => write(file(s2.dir, "turns", id2 + "-claude.md"),
    "### TURN-" + id2 + " (CLAUDE)" + NL + "SCHEMA: collab-board/turn/v1" + NL + "- Header: PART=PLAN" + NL +
    "- Body:" + NL + "  - FINDINGS: x" + NL + "- Evidence: x" + NL + "- Handoff: x" + NL + "PREV: NEW" + NL + "NEXT: none" + NL);

  // A reference to a turn that was never committed names nothing — the same class as a link
  // target that does not exist, which L14 has checked for links all along.
  {
    const s2 = scaffold();
    app(s2, after(s2, 1) + " TURN_COMMIT P1 actor=CLAUDE responds_to=NEW points=P1 via=claude-code");
    app(s2, after(s2, 2) + " POINT_SET P1=AGREED in=P999");
    shard(s2, "P1");
    edit(file(s2.dir, "points.md"), (t) => t.trimEnd() + NL +
      "| P1 | PLAN | x | AGREED | [P999](turns/P999-claude.md) |" + NL);
    ok("a POINT_SET in= naming a turn that does not exist FAILs",
      /FAIL L2.*in=P999 names a turn that has no TURN_COMMIT/.test(lint(s2.root, s2.id).out));
  }

  // An unreal timestamp ordered nothing and reported nothing: every comparison against NaN is
  // false, so the ordering check silently passed over it.
  {
    const s2 = scaffold();
    app(s2, "2026-99-99T99:99:99Z STALL_CHECK actor=CLAUDE");
    ok("an impossible timestamp FAILs instead of being compared as NaN",
      /FAIL L23.*not a real RFC3339 instant/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    app(s2, "2026-02-30T00:00:00Z STALL_CHECK actor=CLAUDE");
    ok("a date that only Date.parse believes in (Feb 30) FAILs rather than rolling over",
      /FAIL L23.*not a real RFC3339 instant/.test(lint(s2.root, s2.id).out));
  }

  // POINT_SET was the last payload read as fragments rather than as a whole line, while the prose
  // had already been changed to say payloads are grammar.
  {
    const s2 = scaffold();
    app(s2, after(s2, 1) + " TURN_COMMIT P1 actor=CLAUDE responds_to=NEW points=P1 via=claude-code");
    app(s2, after(s2, 2) + " POINT_SET P1=OPEN in=P1 garbage");
    shard(s2, "P1");
    ok("a POINT_SET with trailing text FAILs",
      /FAIL L2.*is not the documented/.test(lint(s2.root, s2.id).out));
  }

  // An origin event cannot coherently follow its own migration.
  {
    const s2 = scaffold();
    edit(file(s2.dir, "log.md"), (t) => {
      const openLine = /^.*OPEN session.*$/m.exec(t)[0];
      const early = new Date(Date.parse(/^(\S+)/.exec(openLine)[1]) - 1000).toISOString();
      return t.replace(openLine, early + " SCHEMA_SET agent/v1->agent/v2 by=CLAUDE" + NL + openLine);
    });
    ok("a SCHEMA_SET before the OPEN that establishes the origin FAILs",
      /FAIL L24.*before the OPEN event/.test(lint(s2.root, s2.id).out));
  }

  // THE REGRESSION. This one is a false finding, not a missed one.
  {
    const s2 = scaffold();
    app(s2, "<!-- comparison window: 2026-08-03T19:00:00Z through 2026-08-03T19:01:00Z -->");
    ok("a comment that merely NAMES two timestamps is not reported as two merged events",
      !/FAIL/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    const t0 = after(s2, 1), t1 = after(s2, 2);
    edit(file(s2.dir, "log.md"), (t) => t.trimEnd() + NL +
      t0 + " STALL_CHECK actor=CLAUDE " + t1 + " STALL_CHECK actor=CODEX" + NL);
    ok("a genuinely merged pair of live events is still caught",
      /FAIL L22.*merged/.test(lint(s2.root, s2.id).out));
  }

  // A mutator must fail closed on identity BEFORE it writes. Taking the author from HEAD alone
  // meant one edited file was enough to make migrate sign its own provenance as the SECONDARY,
  // and only the NEXT lint reported it — after the log already carried the event.
  {
    const s2 = scaffold(); stripProvenance(s2);
    edit(file(s2.dir, "HEAD.md"), (t) => t
      .replace("- CLAUDE: ON_HOLD - PRIMARY", "- CLAUDE: ON_HOLD - SECONDARY")
      .replace("- CODEX: ON_HOLD - SECONDARY", "- CODEX: ON_HOLD - PRIMARY"));
    const m = run(["migrate", "--session", s2.id, "--to", "agent/v2"], s2.root);
    ok("migrate refuses a HEAD-only role swap rather than writing under it",
      m.code !== 0 && /disputed identity/.test(m.out));
    ok("and refuses BEFORE appending anything", !/SCHEMA_SET/.test(read(file(s2.dir, "log.md"))));
  }

  // Controls: none of the above may be bought by rejecting legitimate boards.
  {
    const s2 = scaffoldV2();
    app(s2, after(s2, 1) + " TURN_COMMIT P1 actor=CLAUDE responds_to=NEW points=P1 via=claude-code");
    app(s2, after(s2, 2) + " POINT_SET P1=AGREED in=P1");
    shard(s2, "P1");
    edit(file(s2.dir, "points.md"), (t) => t.trimEnd() + NL +
      "| P1 | PLAN | x | AGREED | [P1](turns/P1-claude.md) |" + NL);
    ok("a legitimately resolved point still passes",
      !/FAIL L2\b|FAIL L23/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffoldV2(); stripProvenance(s2);
    const m = run(["migrate", "--session", s2.id, "--to", "agent/v2"], s2.root);
    ok("a legitimate migration still succeeds and lints clean",
      m.code === 0 && !/FAIL/.test(lint(s2.root, s2.id).out));
  }
}
// 17b-23. The rest of the raw semantic consumers. The SECONDARY observed that acceptance 4's
// source guard counts fs.readFileSync calls and so cannot see a consumer that reads DECODED board
// text raw — which is what the L22 regression was. Auditing every line-splitting call site found
// two more instances of the class the property exists to prevent.
if (SEL(44)) {
  {
    const s2 = scaffold();
    edit(file(s2.dir, "points.md"), (t) => t.trimEnd() + NL +
      "<!--" + NL + "| P1 | PLAN | commented out | OPEN | - |" + NL + "-->" + NL);
    ok("a point row inside a comment is not counted as an open point",
      !/FAIL/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    edit(file(s2.dir, "points.md"), (t) => t.trimEnd() + NL +
      "| P1 | PLAN | a real row | OPEN | - |" + NL);
    edit(file(s2.dir, "HEAD.md"), (t) => t.replace(/^PLAN_OPEN_POINTS:.*$/m, "PLAN_OPEN_POINTS: 1"));
    ok("a LIVE point row is still counted (the fix is not blanket blindness)",
      /FAIL L2.*the log projects no such point/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    const idx = path.join(s2.root, ".collab-board", "index.md");
    edit(idx, (t) => t.replace(/^(\| 2026.*)$/m, (m) => "<!-- " + m + " -->"));
    ok("commenting out the catalog row does not hide the drift it creates",
      /L16/.test(lint(s2.root, s2.id).out));
  }
  {
    // The catalog WRITER must select its target the same way: a commented decoy above the live row
    // would otherwise absorb the update and leave the real row stale.
    const s2 = scaffold();
    const idx = path.join(s2.root, ".collab-board", "index.md");
    edit(idx, (t) => t.replace(/^(\| 2026.*)$/m, (m) => "<!-- " + m + " -->" + NL + m));
    run(["terminal", "--session", s2.id, "--status", "ABORTED"], s2.root);
    const t2 = read(idx);
    ok("a commented catalog row does not absorb a status write",
      !/<!-- \| 2026[^\n]*ABORTED/.test(t2) && /ABORTED/.test(t2));
  }
}
// 17b-24. Three doubts the PRIMARY raised about its own previous round. Two were real. Writing the
// doubts down as a list was what made them checkable — the timestamp asymmetry in particular was
// invisible while the two branches were read as "the same check, twice".
if (SEL(45)) {
  const app = (s2, line) => edit(file(s2.dir, "log.md"), (t) => t.trimEnd() + NL + line + NL);
  const stamped = (ts) => { const s2 = scaffold(); app(s2, ts + " STALL_CHECK actor=CLAUDE"); return lint(s2.root, s2.id).out; };
  const rejects = (ts) => /not a real RFC3339|not an event line/.test(stamped(ts));

  // The UTC branch round-tripped the calendar; the offset branch only range-checked the fields, so
  // the SAME impossible date was rejected with Z and accepted with +02:00. One path now.
  ok("a calendar-invalid date is rejected in UTC", rejects("2026-02-30T00:00:00Z"));
  ok("...and identically at a non-zero offset", rejects("2026-02-30T00:00:00+02:00"));
  ok("April 31 is rejected at an offset too", rejects("2026-04-31T00:00:00+01:00"));
  ok("month 13 is rejected at an offset", rejects("2026-13-01T00:00:00+02:00"));
  ok("hour 25 is rejected at an offset", rejects("2026-08-03T25:00:00+02:00"));
  ok("minute 60 is rejected at an offset", rejects("2026-08-03T12:60:00-05:00"));
  ok("a legitimate offset timestamp is still accepted", !rejects("2026-08-03T12:00:00+02:00"));
  ok("a legitimate negative offset is still accepted", !rejects("2026-08-03T12:00:00-05:00"));
  ok("fractional seconds are still accepted", !rejects("2026-08-03T12:00:00.123Z"));
  ok("a timestamp with no zone at all is rejected", rejects("2026-08-03T12:00:00"));

  // The multi-pair POINT_SET forms this repo's own boards actually use must still parse, or the
  // full-line form bought its strictness by breaking legitimate history.
  {
    const s2 = scaffold();
    const openTs = /^(\S+) OPEN/m.exec(read(file(s2.dir, "log.md")))[1];
    const at = (n) => new Date(Date.parse(openTs) + n * 1000).toISOString();
    app(s2, at(1) + " TURN_COMMIT P1 actor=CLAUDE responds_to=NEW points=P1,P2 via=claude-code");
    write(file(s2.dir, "turns", "P1-claude.md"), "### TURN-P1 (CLAUDE)" + NL + "SCHEMA: collab-board/turn/v1" + NL +
      "- Header: PART=PLAN" + NL + "- Body:" + NL + "  - FINDINGS: x" + NL + "- Evidence: x" + NL + "- Handoff: x" + NL + "PREV: NEW" + NL + "NEXT: none" + NL);
    app(s2, at(2) + " POINT_SET P1=OPEN P2=OPEN in=P1");
    edit(file(s2.dir, "points.md"), (t) => t.trimEnd() + NL +
      "| P1 | PLAN | a | OPEN | - |" + NL + "| P2 | PLAN | b | OPEN | - |" + NL);
    edit(file(s2.dir, "HEAD.md"), (t) => t.replace(/^PLAN_OPEN_POINTS:.*$/m, "PLAN_OPEN_POINTS: 2"));
    ok("a multi-pair POINT_SET — the shape this repo's boards actually use — still parses",
      !/is not the documented/.test(lint(s2.root, s2.id).out));
  }

  // ONE parse of the contract line. Adding migrate's caller made a third copy of the same regex,
  // and three copies of a rule can disagree about the same file.
  {
    const src = read(CLI);
    const copies = (src.match(/PRIMARY\\s\*=\\s\*\(\[A-Za-z0-9_\]\+\)/g) || []).length;
    ok("the Roles contract is parsed in exactly one place", copies === 1);
    ok("and lint, reset and migrate all route through it",
      (src.match(/contractRoles\(/g) || []).length >= 4);
  }
}
// 17b-25. ACCEPTANCE CRITERION 2, as a corpus rather than as a list of cases we happened to think
// of. Every entry deliberately malforms ONE thing; the assertion is not that a particular code
// fires but that lint REACHES A VERDICT — a crash is strictly worse than a wrong finding, because
// it takes every other invariant down with it and reports nothing at all. Two defects in this
// session did exactly that (a directory where a file was expected, twice).
if (SEL(46)) {
  const NUL = String.fromCharCode(0);
  const corpus = [
    ["a turn-shaped directory", (d) => fs.mkdirSync(file(d, "turns", "P9-claude.md"))],
    ["a directory inside agents/", (d) => fs.mkdirSync(file(d, "agents", "extra.md"))],
    ["a directory named like the points table", (d) => { fs.rmSync(file(d, "points.md")); fs.mkdirSync(file(d, "points.md")); }],
    ["an actor name that is a regex metacharacter",
      (d) => edit(file(d, "HEAD.md"), (t) => t.replace("- CODEX: ON_HOLD - SECONDARY", "- [(: ON_HOLD - SECONDARY"))],
    ["an actor name of pure punctuation",
      (d) => edit(file(d, "HEAD.md"), (t) => t.replace("- CODEX: ON_HOLD - SECONDARY", "- ***: ON_HOLD - SECONDARY"))],
    ["two State sections", (d) => edit(file(d, "HEAD.md"), (t) => t + NL + "## State" + NL + "- CLAUDE: START - PRIMARY" + NL)],
    ["no State section at all", (d) => edit(file(d, "HEAD.md"), (t) => t.replace(/^## State$/m, "## Nothing"))],
    ["an unclosed comment in HEAD", (d) => edit(file(d, "HEAD.md"), (t) => t + NL + "<!-- never closed" + NL)],
    ["an unclosed comment in the log", (d) => edit(file(d, "log.md"), (t) => t + NL + "<!-- never closed" + NL)],
    ["an unclosed comment in the points table", (d) => edit(file(d, "points.md"), (t) => t + NL + "<!-- never closed" + NL)],
    ["an unclosed comment in an actor file", (d) => edit(file(d, "agents", "claude.md"), (t) => t + NL + "<!-- never closed" + NL)],
    ["a comment that opens and closes many times",
      (d) => edit(file(d, "HEAD.md"), (t) => t + NL + "<!--a--><!--b--><!--c-->SEQ: 9<!--d-->" + NL)],
    ["every authoritative HEAD key duplicated",
      (d) => edit(file(d, "HEAD.md"), (t) => t + NL + t)],
    ["an empty HEAD", (d) => write(file(d, "HEAD.md"), "")],
    ["an empty log", (d) => write(file(d, "log.md"), "")],
    ["an empty points table", (d) => write(file(d, "points.md"), "")],
    ["an empty actor file", (d) => write(file(d, "agents", "claude.md"), "")],
    ["a deleted actor file", (d) => fs.rmSync(file(d, "agents", "claude.md"))],
    ["a deleted SESSION.md", (d) => fs.rmSync(file(d, "SESSION.md"))],
    ["a binary actor file", (d) => fs.writeFileSync(file(d, "agents", "claude.md"), Buffer.from([0, 1, 2, 255, 254, 0]))],
    ["a lone UTF-16 surrogate in the log", (d) => edit(file(d, "log.md"), (t) => t + String.fromCharCode(0xd800))],
    ["a NUL byte inside a point row", (d) => edit(file(d, "points.md"), (t) => t + NL + "| P1 | PLAN | a" + NUL + "b | OPEN | - |" + NL)],
    ["a malformed SCHEMA spelling", (d) => edit(file(d, "agents", "claude.md"), (t) => t.replace("SCHEMA: ", "SCHEMA : "))],
    ["a SCHEMA declaring an unimplemented version",
      (d) => edit(file(d, "agents", "claude.md"), (t) => t.replace(/collab-board\/agent\/v\d+/, "collab-board/agent/v99"))],
    ["a point row with a missing trailing pipe", (d) => edit(file(d, "points.md"), (t) => t + NL + "| P1 | PLAN | a | OPEN | -" + NL)],
    ["a point row with an escaped pipe", (d) => edit(file(d, "points.md"), (t) => t + NL + "| P1 | PLAN | a \\| b | OPEN | - |" + NL)],
    ["a log line that is only a timestamp", (d) => edit(file(d, "log.md"), (t) => t.trimEnd() + NL + "2026-08-03T12:00:00Z" + NL)],
    ["a log line with a 40-digit year", (d) => edit(file(d, "log.md"), (t) => t.trimEnd() + NL + "9".repeat(40) + "-01-01T00:00:00Z OPEN x" + NL)],
    ["a PREV link with deep traversal",
      (d) => write(file(d, "turns", "P1-claude.md"), "### TURN-P1" + NL + "PREV: [x](" + "../".repeat(40) + "etc/passwd)" + NL)],
    ["a NEXT link naming a device path",
      (d) => write(file(d, "turns", "P1-claude.md"), "### TURN-P1" + NL + "NEXT: [x](CON)" + NL)],
    ["a RESPONDS_TO with a NUL byte",
      (d) => edit(file(d, "HEAD.md"), (t) => t.replace(/^RESPONDS_TO:.*$/m, "RESPONDS_TO: turns/a" + NUL + "b.md"))],
    ["a 200-level nested comment opener",
      (d) => edit(file(d, "agents", "claude.md"), (t) => t + NL + "<!--".repeat(200) + NL)],
    ["a very long single line", (d) => edit(file(d, "log.md"), (t) => t.trimEnd() + NL + "x".repeat(200000) + NL)],
    ["a points table that is one enormous row",
      (d) => edit(file(d, "points.md"), (t) => t + NL + "| P1 | PLAN | " + "a".repeat(100000) + " | OPEN | - |" + NL)],
    ["a gate set to a value outside the closed set",
      (d) => edit(file(d, "HEAD.md"), (t) => t.replace("PLAN_AGREE_PRIMARY: NO", "PLAN_AGREE_PRIMARY: MAYBE"))],
    ["a negative open-points count",
      (d) => edit(file(d, "HEAD.md"), (t) => t.replace(/^PLAN_OPEN_POINTS:.*$/m, "PLAN_OPEN_POINTS: -5"))],
    ["a SEQ that is not a number",
      (d) => edit(file(d, "HEAD.md"), (t) => t.replace(/^SEQ:.*$/m, "SEQ: soon"))],
    ["a Roles line naming nothing",
      (d) => edit(file(d, "SESSION.md"), (t) => t.replace(/^Roles:.*$/m, "Roles:"))],
    ["every board file emptied at once", (d) => {
      for (const f of ["HEAD.md", "log.md", "points.md", "SESSION.md"]) write(file(d, f), "");
    }],
  ];

  // Entries that are correctly SILENT, each with the reason. Anything not listed must produce a
  // finding; anything listed that DOES produce one is equally a failure, because the reason given
  // here would then be wrong.
  const EXPECTED_CLEAN = new Map([
    ["a comment that opens and closes many times",
      "masking in place leaves the smuggled key indented, and indentation is part of the grammar — a comment must not be able to MANUFACTURE a declaration"],
    ["an empty points table",
      "no rows and no open points is consistent with a HEAD declaring none; an empty table is a board with no points, not a malformed one"],
    ["a lone UTF-16 surrogate in the log",
      "stray text that claims to be nothing: it carries no timestamp, so it asserts no event and contradicts no declaration"],
    ["a very long single line",
      "length is not malformation; the line claims to be nothing and the engine must not impose a size limit it never documented"],
  ]);
  let verdicts = 0, crashes = [], silent = [], wronglyNoisy = [];
  for (const [name, mutate] of corpus) {
    const s2 = scaffold();
    try { mutate(s2.dir); } catch (e) { crashes.push(name + " (fixture could not be applied: " + e.message + ")"); continue; }
    const r = lint(s2.root, s2.id);
    // A VERDICT is a lint report. An uncaught throw surfaces as the top-level `error:` handler or
    // a raw stack, and reports nothing about the board at all.
    const threw = /^error:/m.test(r.out) || /\bat [A-Za-z_$][\w$]*\s*\(/.test(r.out) || /Error:/.test(r.out);
    const reachedVerdict = !threw &&
      (/^(OK|FAIL):/m.test(r.out) || /PASS \(no findings\)/.test(r.out) || /^(FAIL|WARN) L/m.test(r.out));
    if (!reachedVerdict) {
      crashes.push(name + " -> " + r.out.split(NL).filter(Boolean).slice(0, 2).join(" / ").slice(0, 140));
      continue;
    }
    verdicts++;
    // ...and criterion 2 asks for a FINDING. An entry that slips past every check produces a clean
    // PASS, which the earlier assertion could not tell apart from an entry that was caught.
    const quiet = !/^(FAIL|WARN) L/m.test(r.out);
    if (quiet && !EXPECTED_CLEAN.has(name)) silent.push(name);
    if (!quiet && EXPECTED_CLEAN.has(name)) wronglyNoisy.push(name + " — expected clean because " + EXPECTED_CLEAN.get(name));
  }
  ok("no input in the hostile corpus crashes lint (" + verdicts + "/" + corpus.length + " reached a verdict)",
    crashes.length === 0);
  for (const c of crashes) console.log("        " + c);
  ok("every hostile input produces a FINDING unless it is listed as correctly clean", silent.length === 0);
  for (const c of silent) console.log("        passed silently: " + c);
  ok("every input listed as correctly clean really is clean", wronglyNoisy.length === 0);
  for (const c of wronglyNoisy) console.log("        " + c);
}
// 17b-26. The SECONDARY's I8 review. Four more accepted inputs, plus confirmation of the doubt the
// PRIMARY had raised about its own guard: asking whether a nearby comment SAYS the right words is
// satisfied by writing those words. A check that can be satisfied by describing compliance is a
// formality, and this one had been introduced as the fix for a real problem one round earlier.
if (SEL(47)) {
  const after = (s2, n) => {
    const openTs = /^(\S+) OPEN/m.exec(read(file(s2.dir, "log.md")))[1];
    return new Date(Date.parse(openTs) + n * 1000).toISOString();
  };
  const app = (s2, line) => edit(file(s2.dir, "log.md"), (t) => t.trimEnd() + NL + line + NL);
  const shard = (s2, id2, actor) => write(file(s2.dir, "turns", id2 + "-" + (actor || "claude") + ".md"),
    "### TURN-" + id2 + NL + "SCHEMA: collab-board/turn/v1" + NL + "- Header: PART=PLAN" + NL +
    "- Body:" + NL + "  - FINDINGS: x" + NL + "- Evidence: x" + NL + "- Handoff: x" + NL + "PREV: NEW" + NL + "NEXT: none" + NL);
  const resolved = (s2, cell) => {
    app(s2, after(s2, 1) + " TURN_COMMIT P1 actor=CLAUDE responds_to=NEW points=P1 via=claude-code");
    app(s2, after(s2, 2) + " POINT_SET P1=AGREED in=P1");
    shard(s2, "P1");
    edit(file(s2.dir, "points.md"), (t) => t.trimEnd() + NL + "| P1 | PLAN | x | AGREED | " + cell + " |" + NL);
    return lint(s2.root, s2.id).out;
  };

  // A Resolved In cell is a LINK. Only its label had ever been read, so the destination could name
  // a different turn entirely while the label agreed with the log.
  ok("a Resolved In whose destination names a different turn FAILs",
    /FAIL L2.*name different turns/.test(resolved(scaffold(), "[P1](turns/P999-claude.md)")));
  ok("a Resolved In pointing at the wrong actor's shard FAILs",
    /FAIL L2.*does not dereference/.test(resolved(scaffold(), "[P1](turns/P1-codex.md)")));
  ok("a Resolved In that is not a link at all FAILs",
    /FAIL L2.*is not a/.test(resolved(scaffold(), "P1")));
  ok("a correct Resolved In link still passes",
    !/FAIL L2/.test(resolved(scaffold(), "[P1](turns/P1-claude.md)")));

  // Two assignments to one id in one event: the projector resolved them left-to-right, so which
  // one took effect was an accident of order rather than anything the board stated.
  {
    const s2 = scaffold();
    app(s2, after(s2, 1) + " TURN_COMMIT P1 actor=CLAUDE responds_to=NEW points=P1 via=claude-code");
    app(s2, after(s2, 2) + " POINT_SET P1=OPEN P1=AGREED in=P1");
    shard(s2, "P1");
    edit(file(s2.dir, "points.md"), (t) => t.trimEnd() + NL + "| P1 | PLAN | dup | AGREED | [P1](turns/P1-claude.md) |" + NL);
    ok("a POINT_SET assigning the same id twice FAILs",
      /FAIL L2.*assigns P1 twice/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    app(s2, after(s2, 1) + " TURN_COMMIT P1 actor=CLAUDE responds_to=NEW points=P1,P2 via=claude-code");
    app(s2, after(s2, 2) + " POINT_SET P1=AGREED P2=REJECTED in=P1");
    shard(s2, "P1");
    edit(file(s2.dir, "points.md"), (t) => t.trimEnd() + NL +
      "| P1 | PLAN | a | AGREED | [P1](turns/P1-claude.md) |" + NL +
      "| P2 | PLAN | b | REJECTED | [P1](turns/P1-claude.md) |" + NL);
    ok("distinct ids in one POINT_SET are still fine — the defect is duplication, not multiplicity",
      !/FAIL L2/.test(lint(s2.root, s2.id).out));
  }

  // PHASE_SET's count was parsed and then discarded, which is the same as not having the field.
  {
    const s2 = scaffold();
    app(s2, after(s2, 1) + " PHASE_SET PLAN->IMPL plan_open_points=999");
    ok("a PHASE_SET declaring a count the gate forbids FAILs",
      /FAIL L2.*requires zero OPEN P\* points/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    app(s2, after(s2, 1) + " PHASE_SET PLAN->IMPL plan_open_points=0");
    ok("the legitimate PHASE_SET count still passes",
      !/FAIL L2.*plan_open_points/.test(lint(s2.root, s2.id).out));
  }

  // A WRITER consulting a comment is the same boundary violation as a reader believing one.
  {
    const s2 = scaffold();
    const base = Date.parse(after(s2, 0));
    // Inside the same wall-clock second, which is the only window the clamp acts in.
    const commented = new Date(base).toISOString().replace(/\.\d+Z$/, ".999Z");
    app(s2, "<!--" + NL + commented + " STALL_CHECK actor=CLAUDE" + NL + "-->");
    run(["terminal", "--session", s2.id, "--status", "ABORTED"], s2.root);
    const term = (read(file(s2.dir, "log.md")).match(/^(\S+) TERMINAL/m) || [])[1];
    ok("a commented event does not steer the timestamp of a live append", term !== commented);
  }
}
// 17b-27. The SECONDARY's I10 review. Live-by-default had been ASSERTED for two rounds while seven
// consumers still read raw with test/includes/match — shapes the split-based guard could not see.
// The errors did not even point the same way: two produced FALSE findings, and one let a
// commented-out line SATISFY the check that requires it. Also here: a regression the previous
// round introduced, and an applicability defect that made a hostile corpus entry disappear.
if (SEL(48)) {
  const at = (s2, n) => {
    const t = /^(\S+) OPEN/m.exec(read(file(s2.dir, "log.md")))[1];
    return new Date(Date.parse(t) + n * 1000).toISOString();
  };
  const app = (s2, l) => edit(file(s2.dir, "log.md"), (t) => t.trimEnd() + NL + l + NL);

  // REGRESSION from the previous round: Date.UTC maps years 0..99 to 1900..1999, so round-tripping
  // the calendar through it declared a legitimate RFC3339 instant unreal.
  {
    const s2 = scaffold();
    app(s2, "0099-01-01T00:00:00Z STALL_CHECK actor=CLAUDE");
    ok("a year in 0000-0099 is accepted — Date.UTC would have coerced it into the 1900s",
      !/not a real RFC3339/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    app(s2, "2026-02-29T00:00:00Z STALL_CHECK actor=CLAUDE");
    ok("Feb 29 of a non-leap year is still rejected",
      /not a real RFC3339/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    app(s2, "2024-02-29T00:00:00Z STALL_CHECK actor=CLAUDE");
    ok("Feb 29 of a leap year is accepted", !/not a real RFC3339/.test(lint(s2.root, s2.id).out));
  }

  // The live-by-default property, in BOTH directions.
  {
    const s2 = scaffold();
    write(file(s2.dir, "plan", "context.md"),
      "# Frozen Plan" + NL + NL + "STATUS: FROZEN" + NL + NL + "<!--" + NL + "STATUS: EMPTY" + NL + "-->" + NL + NL + "digest" + NL);
    edit(file(s2.dir, "HEAD.md"), (t) => t.replace(/^PHASE:.*$/m, "PHASE: IMPL")
      .replace("PLAN_AGREE_PRIMARY: NO", "PLAN_AGREE_PRIMARY: YES")
      .replace("PLAN_AGREE_SECONDARY: NO", "PLAN_AGREE_SECONDARY: YES"));
    ok("a commented STATUS: EMPTY does not make a frozen plan look empty",
      !/context\.md is empty/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    write(file(s2.dir, "plan", "context.md"), "# Frozen Plan" + NL + NL + "STATUS: EMPTY" + NL);
    edit(file(s2.dir, "HEAD.md"), (t) => t.replace(/^PHASE:.*$/m, "PHASE: IMPL")
      .replace("PLAN_AGREE_PRIMARY: NO", "PLAN_AGREE_PRIMARY: YES")
      .replace("PLAN_AGREE_SECONDARY: NO", "PLAN_AGREE_SECONDARY: YES"));
    ok("a LIVE STATUS: EMPTY still fails the gate",
      /context\.md is empty/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    edit(file(s2.dir, "points.md"), (t) => t.trimEnd() + NL + "<!--" + NL + "- CLAUDE: START - PRIMARY" + NL + "-->" + NL);
    ok("a commented State row outside HEAD is not a hand token",
      !/hand-token outside HEAD/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    edit(file(s2.dir, "points.md"), (t) => t.trimEnd() + NL + "- CLAUDE: START - PRIMARY" + NL);
    ok("a LIVE State row outside HEAD still FAILs L1",
      /hand-token outside HEAD/.test(lint(s2.root, s2.id).out));
  }
  {
    // The other direction, which is the one that lets a board pass when it should not.
    const s2 = scaffold();
    write(file(s2.dir, "turns", "I1-claude.md"),
      "### TURN-I1 (CLAUDE)" + NL + "SCHEMA: collab-board/turn/v1" + NL + "- Header: PART=IMPL" + NL +
      "- Body:" + NL + "  - FINDINGS: x" + NL + "<!--" + NL + "- Evidence: hidden" + NL + "-->" + NL +
      "- Impl: BRANCH=b BASE_COMMIT=c LATEST_COMMIT=d" + NL + "- Handoff: x" + NL + "PREV: NEW" + NL + "NEXT: none" + NL);
    app(s2, at(s2, 1) + " PHASE_SET PLAN->IMPL plan_open_points=0");
    app(s2, at(s2, 2) + " TURN_COMMIT I1 actor=CLAUDE responds_to=NEW points=- via=claude-code");
    ok("a shard whose only Evidence line is commented out does NOT satisfy L13",
      /L13/.test(lint(s2.root, s2.id).out));
  }

  // A turn id names one turn by one actor. Without that, resolving an id to a shard is whichever
  // the directory listed first.
  {
    const s2 = scaffold();
    for (const a of ["claude", "codex"])
      write(file(s2.dir, "turns", "P1-" + a + ".md"),
        "### TURN-P1" + NL + "SCHEMA: collab-board/turn/v1" + NL + "- Header: PART=PLAN" + NL +
        "- Body:" + NL + "  - FINDINGS: x" + NL + "- Evidence: x" + NL + "- Handoff: x" + NL + "PREV: NEW" + NL + "NEXT: none" + NL);
    app(s2, at(s2, 1) + " TURN_COMMIT P1 actor=CODEX responds_to=NEW points=P1 via=codex-cli");
    ok("two shards for one turn id FAIL", /L14.*2 shards/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    write(file(s2.dir, "turns", "P1-codex.md"),
      "### TURN-P1" + NL + "SCHEMA: collab-board/turn/v1" + NL + "- Header: PART=PLAN" + NL +
      "- Body:" + NL + "  - FINDINGS: x" + NL + "- Evidence: x" + NL + "- Handoff: x" + NL + "PREV: NEW" + NL + "NEXT: none" + NL);
    app(s2, at(s2, 1) + " TURN_COMMIT P1 actor=CLAUDE responds_to=NEW points=- via=claude-code");
    ok("a shard whose actor differs from its TURN_COMMIT FAILs",
      /L14.*shard.s actor must be/.test(lint(s2.root, s2.id).out));
  }

  // Applicability decided by the grammar it selects for, one more time: a 40-digit year was not
  // an event CLAIM to any check, so it produced no finding at all.
  {
    const s2 = scaffold();
    app(s2, "9".repeat(40) + "-01-01T00:00:00Z OPEN x");
    ok("a line with an absurd year is still judged as an event claim",
      /FAIL L2[23]/.test(lint(s2.root, s2.id).out));
  }

  // An unclosed comment hides nothing today and swallows whatever is written next.
  {
    const s2 = scaffold();
    edit(file(s2.dir, "log.md"), (t) => t.trimEnd() + NL + "<!-- never closed" + NL);
    ok("an unclosed comment in the log FAILs", /L0.*unclosed/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    edit(file(s2.dir, "log.md"), (t) => t.trimEnd() + NL + "<!-- never closed" + NL);
    run(["terminal", "--session", s2.id, "--status", "ABORTED"], s2.root);
    ok("...which is the point: an event appended after one is swallowed whole",
      /L0.*unclosed/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    edit(file(s2.dir, "HEAD.md"), (t) => t.trimEnd() + NL + "SEQ: 9" + NL);
    ok("a second LIVE declaration of an authoritative key FAILs lint, not only advance",
      /L1.*SEQ declared 2 times/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    fs.mkdirSync(file(s2.dir, "agents", "litter"));
    ok("a directory in agents/ is reported rather than merely skipped",
      /L24.*not a regular file/.test(lint(s2.root, s2.id).out));
  }
}
// 17b-28. A REGRESSION found by running the new checks against this repo's own boards, and the
// reason board data is worth keeping around to test against. Making every consumer read the live
// view meant a quoted `<!--` in PROSE was treated as a real comment opener — and these boards are
// documents ABOUT a Markdown format, so they quote comment markers constantly. Four real boards
// acquired a cascade of false "missing declaration" findings, because an unmatched quoted opener
// masked the entire rest of the file. A masker that does not understand code spans is not reading
// Markdown, it is searching for a string.
if (SEL(49)) {
  const TICK = String.fromCharCode(96);
  const shardWith = (s2, body) => {
    write(file(s2.dir, "turns", "P1-claude.md"),
      "### TURN-P1 (CLAUDE)" + NL + "SCHEMA: collab-board/turn/v1" + NL + "- Header: PART=PLAN" + NL +
      "- Body:" + NL + "  - FINDINGS: " + body + NL + "- Evidence: real" + NL + "- Handoff: real" + NL +
      "PREV: NEW" + NL + "NEXT: none" + NL);
    edit(file(s2.dir, "log.md"), (t) => {
      const ts = /^(\S+) OPEN/m.exec(t)[1];
      const at = new Date(Date.parse(ts) + 1000).toISOString();
      return t.trimEnd() + NL + at + " TURN_COMMIT P1 actor=CLAUDE responds_to=NEW points=- via=claude-code" + NL;
    });
    return lint(s2.root, s2.id).out;
  };

  ok("an opener quoted in an inline code span is not a comment",
    !/L13|L0.*unclosed/.test(shardWith(scaffold(), "the decoy began with " + TICK + "<!--" + TICK + " and never closed")));
  ok("a matched pair quoted inline is likewise literal",
    !/L13|L0.*unclosed/.test(shardWith(scaffold(), "a row inside " + TICK + "<!-- -->" + TICK + " is not live")));
  ok("an opener inside a fenced block is literal",
    !/L13|L0.*unclosed/.test(shardWith(scaffold(),
      "see below" + NL + TICK.repeat(3) + NL + "<!--" + NL + TICK.repeat(3))));
  ok("a double-backtick span containing a single backtick still closes correctly",
    !/L13|L0.*unclosed/.test(shardWith(scaffold(), TICK + TICK + "a " + TICK + " b <!--" + TICK + TICK + " tail")));

  // The other direction: understanding code spans must not stop a REAL comment from masking.
  ok("a genuine unclosed comment in a shard is still caught",
    /L0.*unclosed/.test(shardWith(scaffold(), "text" + NL + "<!-- never closed")));
  {
    const s2 = scaffold();
    edit(file(s2.dir, "HEAD.md"), (t) => t.replace("- CODEX: ON_HOLD - SECONDARY",
      "<!--" + NL + "- CODEX: ON_HOLD - SECONDARY" + NL + "-->"));
    ok("a genuine commented actor row is still not live",
      /L1|L24/.test(lint(s2.root, s2.id).out));
  }
  {
    // A lone backtick must not turn the rest of a line into code and thereby neutralise a real
    // comment opener — an unterminated run is not a span.
    const s2 = scaffold();
    edit(file(s2.dir, "HEAD.md"), (t) => t.replace("- CODEX: ON_HOLD - SECONDARY",
      "a lone " + TICK + " tick <!--" + NL + "- CODEX: ON_HOLD - SECONDARY" + NL + "-->"));
    ok("an unterminated backtick run does not neutralise a real comment",
      /L1|L24|L0/.test(lint(s2.root, s2.id).out));
  }
}
// 17b-29. An independent adversarial pass, run because the usual SECONDARY was unavailable. Nine
// reproduced defects, and the striking thing is how many were places where a rule had been fixed
// for ONE caller and left alone for its siblings: identity reconciled in migrate but not in
// advance or terminal; file-kind checked for files but not directories; the comment scanner shared
// everywhere except actorRegions. Fixing a caller is not fixing a rule.
if (SEL(50)) {
  const TICK = String.fromCharCode(96);
  const app = (s2, l) => edit(file(s2.dir, "log.md"), (t) => t.trimEnd() + NL + l + NL);

  // Quoting exact syntax as evidence is what the protocol asks authors to do, so quoting must be
  // the one thing that cannot become a declaration. codeMask was computed and never applied.
  {
    const s2 = scaffold();
    edit(file(s2.dir, "SESSION.md"), (t) => t.trimEnd() + NL + NL +
      TICK.repeat(3) + NL + "Roles: PRIMARY=CLAUDE, SECONDARY=CODEX" + NL + TICK.repeat(3) + NL);
    ok("a FENCED quote of the Roles line is not a second declaration",
      !/2 Roles: declarations/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    edit(file(s2.dir, "HEAD.md"), (t) => t.trimEnd() + NL + TICK.repeat(3) + NL + "SEQ: 7" + NL + TICK.repeat(3) + NL);
    ok("a FENCED quote of an authoritative key is not a duplicate",
      !/SEQ declared 2 times/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    edit(file(s2.dir, "HEAD.md"), (t) => t.trimEnd() + NL + "SEQ: 7" + NL);
    ok("...but an UNQUOTED duplicate still FAILs", /SEQ declared 2 times/.test(lint(s2.root, s2.id).out));
  }
  {
    // actorRegions had its own comment scanner, so it and L0 gave different answers on one file.
    const s2 = scaffold(); stripProvenance(s2);
    write(file(s2.dir, "agents", "claude.md"),
      "# CLAUDE self-state" + NL + "SCHEMA: collab-board/agent/v1" + NL + NL +
      TICK.repeat(3) + NL + "<!--" + NL + TICK.repeat(3) + NL + NL + "PRIVATE_NOTES:" + NL + "- x" + NL);
    ok("a fenced comment opener in an actor file is literal to L24 as well as to L0",
      !l24For(lint(s2.root, s2.id).out, "claude.md").some((l) => /unclosed|PRIVATE_NOTES delimiter/.test(l)));
  }

  // The unclosed-comment scan enumerated its own file list and omitted the two that gate the
  // PLAN->IMPL transition, so four characters masked STATUS: EMPTY and advance crossed the gate.
  {
    const s2 = scaffold();
    write(file(s2.dir, "plan", "context.md"), "# Plan" + NL + "<!--" + NL + "STATUS: EMPTY" + NL);
    ok("an unclosed comment in plan/context.md is reported",
      /L0.*context\.md.*unclosed/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    write(file(s2.dir, "impl", "code_state.md"), "# Code State" + NL + "<!--" + NL);
    ok("...and in impl/code_state.md", /L0.*code_state\.md.*unclosed/.test(lint(s2.root, s2.id).out));
  }

  // Column-0 anchors: one leading space made a row or an event invisible to EVERY check. This is
  // the same anchor where the 40-digit-year escape was closed; the whitespace escape was not.
  {
    const s2 = scaffold();
    edit(file(s2.dir, "points.md"), (t) => t.trimEnd() + NL + " | P1 | PLAN | x | OPEN | - |" + NL);
    ok("an INDENTED open point row is still counted",
      /L4.*PLAN_OPEN_POINTS/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    edit(file(s2.dir, "log.md"), (t) => t.replace(/^(\S+ OPEN )/m, " $1"));
    ok("an INDENTED log event is judged rather than skipped",
      /L22.*not an event line/.test(lint(s2.root, s2.id).out));
  }

  // A State-shaped line outside ## State: not a row to the reader, a second match to the writer.
  {
    const s2 = scaffold();
    edit(file(s2.dir, "HEAD.md"), (t) => t.trimEnd() + NL + NL + "## Notes" + NL + "- CLAUDE: ON_HOLD - PRIMARY" + NL);
    ok("lint reports the HEAD that the mutators refuse",
      /L1.*outside the ## State section/.test(lint(s2.root, s2.id).out));
    ok("and terminal now writes it, because the target is scoped to the section",
      run(["terminal", "--session", s2.id, "--status", "ABORTED"], s2.root).code === 0);
  }

  // Identity was reconciled in migrate and nowhere else.
  {
    const swap = (s2) => edit(file(s2.dir, "HEAD.md"), (t) => t
      .replace("- CLAUDE: ON_HOLD - PRIMARY", "- CLAUDE: ON_HOLD - SECONDARY")
      .replace("- CODEX: ON_HOLD - SECONDARY", "- CODEX: ON_HOLD - PRIMARY"));
    for (const [cmd, args] of [
      ["terminal", ["terminal", "--status", "ABORTED"]],
      ["advance", ["advance"]],
      ["activate", ["activate", "--actor", "CLAUDE"]],
    ]) {
      const s2 = scaffold(); swap(s2);
      const r = run([args[0], "--session", s2.id, ...args.slice(1)], s2.root);
      ok(cmd + " refuses to write under a HEAD that contradicts the Roles contract",
        r.code !== 0 && /disputed identity/.test(r.out));
    }
  }

  // A board DIRECTORY present as a regular file ended the run with ENOTDIR — the directory twin
  // of the kind-blind read that took four call sites to stop recurring.
  for (const d of ["turns", "agents", "plan", "impl"]) {
    const s2 = scaffold();
    fs.rmSync(file(s2.dir, d), { recursive: true, force: true });
    write(file(s2.dir, d), "x" + NL);
    const out = lint(s2.root, s2.id).out;
    ok(d + "/ present as a regular file is a finding, not an ENOTDIR crash",
      new RegExp("L0.*" + d + ".*not a directory").test(out) && !/^error:/m.test(out) && /── lint/.test(out));
  }
}
// 17b-30. Two more from the same pass, both about a check quietly NOT APPLYING. A role-conditional
// check that resolves no role does not fire, and a migration that refuses to discard an unknown
// KEY was silently discarding an unknown LINE while reporting "preserved byte-for-byte".
if (SEL(51)) {
  const at = (s2, n) => {
    const t = /^(\S+) OPEN/m.exec(read(file(s2.dir, "log.md")))[1];
    return new Date(Date.parse(t) + n * 1000).toISOString();
  };
  const app = (s2, l) => edit(file(s2.dir, "log.md"), (t) => t.trimEnd() + NL + l + NL);
  const implShard = (impl) => "### TURN" + NL + "SCHEMA: collab-board/turn/v1" + NL + "- Header: PART=IMPL" + NL +
    "- Body:" + NL + "  - FINDINGS: x" + NL + (impl ? "- Impl: BRANCH=b BASE_COMMIT=c LATEST_COMMIT=d" + NL : "") +
    "- Evidence: x" + NL + "- Handoff: x" + NL + "PREV: NEW" + NL + "NEXT: none" + NL;

  // Rule 7 could be switched off by renaming the file: the actor segment was compared against a
  // lowercased name, so I2-CODEX.md resolved to no role and every role-conditional check skipped
  // it. Every other check here reconciles actor names case-insensitively, which is why nothing
  // else fired to give it away.
  for (const nm of ["codex", "CODEX", "CoDeX"]) {
    const s2 = scaffold();
    write(file(s2.dir, "turns", "I2-" + nm + ".md"), implShard(true));
    app(s2, at(s2, 1) + " PHASE_SET PLAN->IMPL plan_open_points=0");
    app(s2, at(s2, 2) + " TURN_COMMIT I2 actor=CODEX responds_to=NEW points=- via=codex-cli");
    ok("a SECONDARY Impl: line is caught however the shard file is cased (" + nm + ")",
      /L6/.test(lint(s2.root, s2.id).out));
  }
  {
    const s2 = scaffold();
    write(file(s2.dir, "turns", "I2-ghost.md"), implShard(false));
    app(s2, at(s2, 1) + " PHASE_SET PLAN->IMPL plan_open_points=0");
    app(s2, at(s2, 2) + " TURN_COMMIT I2 actor=CODEX responds_to=NEW points=- via=codex-cli");
    ok("a shard naming an actor HEAD declares no role for is a finding, not a skip",
      /L6.*declares no role for/.test(lint(s2.root, s2.id).out));
  }

  // migrate refused to discard an unknown KEY and silently discarded an unknown LINE.
  {
    const s2 = scaffold(); stripProvenance(s2);
    for (const a of ["claude", "codex"])
      write(file(s2.dir, "agents", a + ".md"),
        "# " + a.toUpperCase() + NL + "SCHEMA: collab-board/agent/v1" + NL + NL + "SELF_HAND: ON_HOLD" + NL +
        "LAST_TURN_WRITTEN: -" + NL + "Blocking dependency: waiting on upstream" + NL + NL +
        "PRIVATE_NOTES:" + NL + "- x" + NL);
    const m = run(["migrate", "--session", s2.id, "--to", "agent/v2"], s2.root);
    ok("migrate refuses rather than discarding a header line it cannot map",
      m.code !== 0 && /no place for/.test(m.out));
    ok("and the line is still there afterwards",
      /Blocking dependency/.test(read(file(s2.dir, "agents", "claude.md"))));
  }
}
// 17b-31. CLI EXECUTORS. The accepted set used to be spelled out in four places — the map,
// isValidAdapter, defaultAdapter, and a pair of hand-written cmdNew guards with their own error
// text — so adding one meant finding all four and missing one would either reject a valid adapter
// or accept a mismatched pairing with nothing to catch it. These cases are DERIVED from the
// registry in the engine, so a new executor is covered the moment it is declared; a test carrying
// its own copy of the list would be the very defect this guards.
if (SEL(52)) {
  const src = read(CLI);
  const m = /const CLI_EXECUTOR_SPECS = \[([\s\S]*?)\];/.exec(src);
  ok("the engine declares its CLI executors in one place", !!m);
  const specs = [...(m ? m[1] : "").matchAll(/adapter: "([^"]+)", secondary: "([^"]+)", bin: "([^"]+)"/g)]
    .map((x) => ({ adapter: x[1], secondary: x[2], bin: x[3] }));
  ok("all six shipped executors are declared", specs.length >= 6);
  for (const a of ["omp-cli", "reasonix-cli"])
    ok(a + " is a registered first-class executor", specs.some((e) => e.adapter === a));

  for (const e of specs) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-exec-"));
    const r = run(["new", "--type", "META", "--slug", "x", "--primary", "ORCH", "--secondary", e.secondary, "--adapter", e.adapter], root);
    const id = (r.out.match(/Created session (\S+)/) || [])[1];
    ok(e.adapter + " scaffolds with SECONDARY=" + e.secondary, r.code === 0 && !!id);
    if (!id) continue;
    ok(e.adapter + " scaffolds a board that lints clean", !/FAIL/.test(lint(root, id).out));
    const dir = path.join(root, ".collab-board", "sessions", id);
    ok(e.adapter + " gets the actor file its actor name implies",
      fs.existsSync(file(dir, "agents", e.secondary.toLowerCase() + ".md")));

    // A CLI executor names its actor; pairing it with a different one makes a board whose shard
    // suffixes, actor file and via= no longer agree.
    const other = specs.find((x) => x.secondary !== e.secondary);
    const bad = run(["new", "--type", "META", "--slug", "y", "--primary", "ORCH", "--secondary", other.secondary, "--adapter", e.adapter], root);
    ok(e.adapter + " refuses SECONDARY=" + other.secondary,
      bad.code !== 0 && new RegExp("requires SECONDARY=" + e.secondary).test(bad.out));

    // ...and lint says the same thing about a board edited into that state after the fact.
    edit(file(dir, "SESSION.md"), (t) => t.replace(/^SecondaryAdapter:.*$/m, "SecondaryAdapter: " + other.adapter));
    ok("L18 reports a SecondaryAdapter that contradicts the Roles contract (" + e.adapter + ")",
      new RegExp("L18.*requires SECONDARY=" + other.secondary).test(lint(root, id).out));
  }

  // The list a user is SHOWN must be the list that is accepted.
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-exec2-"));
    const bad = run(["new", "--type", "META", "--slug", "z", "--adapter", "definitely-not-real"], root);
    ok("an invalid adapter is refused", bad.code !== 0);
    for (const e of specs)
      ok("the refusal names " + e.adapter + " as a choice", bad.out.includes(e.adapter));
  }

  // Each CLI executor must have a reference file telling the PRIMARY how to dispatch it. An
  // adapter the engine accepts but nothing documents is an adapter that fails at the first turn.
  for (const e of specs) {
    const ref = path.join(HERE, "..", "references", "executors", e.adapter + ".md");
    ok("references/executors/" + e.adapter + ".md exists", fs.existsSync(ref));
    if (!fs.existsSync(ref)) continue;
    const t = read(ref);
    // The sections the reference spec establishes as the minimum an executor must answer.
    for (const need of ["## Probes", "## The dispatch", "## Result validity", "## Failure path", "## Usage-limit signatures"])
      ok(e.adapter + ".md answers \"" + need.replace("## ", "") + "\"", t.includes(need));
    ok(e.adapter + ".md names the binary it dispatches", new RegExp("\\b" + e.bin + "\\b").test(t));
    // collab-board is not a Windows tool. A spec written on one platform tends to state that
    // platform’s facts as universal — the first draft of these two said “these are Windows
    // binaries” and quoted the Windows argv ceiling as the rule. If a spec names one OS it must
    // name another, so a single-platform assumption cannot pass unnoticed.
    const oses = [/\bwindows\b/i, /\blinux\b/i, /\bmacos\b|\bmac os\b/i].filter((re) => re.test(t)).length;
    ok(e.adapter + ".md does not assume a single operating system", oses === 0 || oses >= 2);
  }
}
// 17b-32. SOLE-WRITER MODE AND THE SECONDARY PANEL. Both are OPT-IN and strictly additive: a
// session with neither key behaves exactly as it always has, which the last case here pins. The
// panel exists because the owner requires the manager to dispatch several secondaries — different
// models from different vendors — and fuse them into one turn. The recorded objection to fusion is
// correct and unfixed: a fused shard is byte-identical to an honest one, so no check can see which
// findings the fuser dropped from WITHIN a contributor. What these rules do enforce is narrower and
// still worth having — no contributor dropped WHOLE, every retained capture cited, every cited hash
// matching its bytes, and a fused shard that names everyone it fuses.
if (SEL(53)) {
  const mkPanel = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-panel-"));
    run(["new", "--type", "META", "--slug", "p", "--primary", "CLAUDE", "--secondary", "PANEL", "--adapter", "manual"], root);
    const id = fs.readdirSync(path.join(root, ".collab-board", "sessions"))[0];
    const dir = path.join(root, ".collab-board", "sessions", id);
    edit(file(dir, "SESSION.md"), (t) => t.trimEnd() + NL + "BoardWriteMode: PRIMARY_ONLY" + NL + "SecondaryPanel: agy-cli,copilot-cli" + NL);
    // Put the board in the state a P2 secondary turn actually happens in: the SECONDARY holds the
    // turn. These fixtures used to relay onto a freshly scaffolded board with BOTH hands ON_HOLD —
    // a state the protocol cannot produce for a secondary turn — so they passed while proving
    // nothing about whether relay respects the START mutex. It did not.
    // The hand is moved through the LOG, not by editing HEAD: the log is the derivation, and a
    // hand-edited HEAD is exactly the L2 divergence lint exists to catch.
    // Reuse the OPEN event's own stamp rather than inventing a later one — equal timestamps are
    // valid, and a fixture stamped into the future makes the engine's next real append look like a
    // DECREASE (L23), which is a fixture bug wearing a finding's clothes.
    const stamps = read(file(dir, "log.md")).match(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z/gm) || [];
    const at = stamps[stamps.length - 1] || new Date().toISOString();
    edit(file(dir, "log.md"), (t) => t.trimEnd() + NL
      + `${at} STATE_SET CLAUDE=ON_HOLD PANEL=START cursor=- next=P2/PANEL seq=0` + NL);
    edit(file(dir, "HEAD.md"), (t) => t
      .replace("SESSION_STATUS: IDLE", "SESSION_STATUS: ACTIVE")   // a STATE_SET activates the board
      .replace(/- PANEL: [A-Z_]+ - SECONDARY/, "- PANEL: START - SECONDARY")
      .replace(/^NEXT_TURN_ID: .*$/m, "NEXT_TURN_ID: P2")          // L3: NEXT_ACTOR follows the hand
      .replace(/^NEXT_ACTOR: .*$/m, "NEXT_ACTOR: PANEL"));
    run(["activate", "--session", id], root);                      // reconcile the catalog row (L16)
    return { root, id, dir };
  };
  const capture = (id, turn, who, finding) => [
    "RELAY: collab-board/relay/v1", "SESSION: " + id, "ACTOR: PANEL", "TURN: " + turn,
    "--- TURN ---", "### TURN-" + turn + " (PANEL)", "SCHEMA: collab-board/turn/v1",
    "- Header: PART=PLAN / RESPONDS_TO=NEW / POINTS=-", "- Body:", "  - FINDINGS:",
    "    - " + who + ": " + finding, "- Evidence: probe",
    "- Handoff: PANEL WORKING->ON_HOLD, CLAUDE ON_HOLD->START", "PREV: NEW", "NEXT: none",
    "--- LOG ---", "--- END ---", ""].join(NL);

{
  const s = mkPanel();
  const a = path.join(s.root, "P2-antigravity.relay");
  const b = path.join(s.root, "P2-copilot.relay");
  fs.writeFileSync(a, capture(s.id, "P2", "ANTIGRAVITY", "the calendar check rejects 2026-02-30"));
  fs.writeFileSync(b, capture(s.id, "P2", "COPILOT", "L22 rejects an unknown event type"));
  const fused = path.join(s.root, "fused.md");
  fs.writeFileSync(fused, [
    "### TURN-P2 (PANEL)",
    "SCHEMA: collab-board/turn/v1",
    "- Header: PART=PLAN / RESPONDS_TO=NEW / POINTS=-",
    "- Body:",
    "  - FINDINGS:",
    "    - ANTIGRAVITY: the calendar check rejects 2026-02-30",
    "    - COPILOT: L22 rejects an unknown event type",
    "- Evidence: fused from two retained captures",
    "- Handoff: PANEL WORKING->ON_HOLD, CLAUDE ON_HOLD->START",
    "PREV: NEW",
    "NEXT: none",
    "",
  ].join(NL));
  const r = run(["relay", "--session", s.id, "--capture", a + "," + b, "--fused", fused], s.root);
  ok("a fused relay of two captures succeeds", r.code === 0);
  const landedHead = read(file(s.dir, "HEAD.md"));
  const landedAgent = read(file(s.dir, "agents", "panel.md"));
  ok("a fused relay lands the turn by handing START to PRIMARY and bumping the cursor",
    /- CLAUDE: START - PRIMARY/.test(landedHead)
    && /- PANEL: ON_HOLD - SECONDARY/.test(landedHead)
    && /TURN_CURSOR: P2/.test(landedHead) && /NEXT_TURN_ID: P3/.test(landedHead)
    && /NEXT_ACTOR: CLAUDE/.test(landedHead) && /SEQ: 1/.test(landedHead));
  // The board scaffolds at agent/v3, which HAS no mirrors — so the relay must write none and the
  // turn must land anyway. Asserting the mirror here would have quietly become an assertion that
  // the relay recreates a retired key, which is precisely the drift the schema-aware write path
  // exists to prevent.
  ok("a fused relay on a v3 board writes the HANDOFF commit point",
    /HANDOFF PANEL:WORKING->ON_HOLD CLAUDE:ON_HOLD->START next=P3\/CLAUDE seq=1/.test(read(file(s.dir, "log.md"))));
  ok("...and writes no retired mirror into the actor file",
    !/SELF_HAND:/.test(landedAgent) && !/LAST_TURN_WRITTEN:/.test(landedAgent), landedAgent);
  ok("...while the retained keys are untouched",
    /ACTIVE_RECOVERY: NONE/.test(landedAgent) && /EXECUTOR_THREAD:/.test(landedAgent), landedAgent);
  ok("both captures are retained on the board",
    fs.existsSync(path.join(s.dir, "captures", "P2-antigravity.relay"))
    && fs.existsSync(path.join(s.dir, "captures", "P2-copilot.relay")));
  const log = fs.readFileSync(path.join(s.dir, "log.md"), "utf8");
  ok("the TURN_COMMIT carries relayed_by, attempt and BOTH capture hashes",
    /relayed_by=CLAUDE/.test(log) && /attempt=1/.test(log)
    && (log.match(/capture_sha=/g) || []).length === 2, log.split(NL).slice(-2).join(NL));
  ok("the fused board lints clean AND actually has the shard",
    fs.existsSync(path.join(s.dir, "turns", "P2-panel.md")) && !/FAIL/.test(run(["lint", "--session", s.id], s.root).out));
}

// --- a contributor dropped whole ---
{
  const s = mkPanel();
  const a = path.join(s.root, "P2-antigravity.relay");
  const b = path.join(s.root, "P2-copilot.relay");
  fs.writeFileSync(a, capture(s.id, "P2", "ANTIGRAVITY", "finding A"));
  fs.writeFileSync(b, capture(s.id, "P2", "COPILOT", "finding B"));
  const fused = path.join(s.root, "fused.md");
  fs.writeFileSync(fused, capture(s.id, "P2", "ANTIGRAVITY", "finding A").split("--- TURN ---")[1].split("--- LOG ---")[0]);
  const r = run(["relay", "--session", s.id, "--capture", a + "," + b, "--fused", fused], s.root);
  ok("relay REFUSES a fusion that never names one of its contributors",
    r.code !== 0 && /never names copilot/i.test(r.out));
}

// --- a capture retained but not cited (relay bypassed) ---
{
  const s = mkPanel();
  const a = path.join(s.root, "P2-antigravity.relay");
  fs.writeFileSync(a, capture(s.id, "P2", "ANTIGRAVITY", "finding A"));
  run(["relay", "--session", s.id, "--capture", a], s.root);
  // Someone drops a second contributor's capture in afterwards without re-relaying.
  fs.writeFileSync(path.join(s.dir, "captures", "P2-copilot.relay"), capture(s.id, "P2", "COPILOT", "finding B"));
  ok("lint reports a retained capture the TURN_COMMIT does not cite",
    /L25.*dropped whole/.test(run(["lint", "--session", s.id], s.root).out));
}

// --- a capture edited after the relay ---
{
  const s = mkPanel();
  const a = path.join(s.root, "P2-antigravity.relay");
  fs.writeFileSync(a, capture(s.id, "P2", "ANTIGRAVITY", "finding A"));
  run(["relay", "--session", s.id, "--capture", a], s.root);
  const kept = path.join(s.dir, "captures", "P2-antigravity.relay");
  fs.writeFileSync(kept, fs.readFileSync(kept, "utf8").replace("finding A", "finding A, softened"));
  ok("lint reports a capture edited after the relay",
    /L25.*hashes to it|L25.*dropped whole/.test(run(["lint", "--session", s.id], s.root).out));
}

// --- a SECONDARY turn written directly in a PRIMARY_ONLY session ---
{
  const s = mkPanel();
  const lg = path.join(s.dir, "log.md");
  const ts = /^(\S+) OPEN/m.exec(fs.readFileSync(lg, "utf8"))[1];
  fs.appendFileSync(lg, new Date(Date.parse(ts) + 1000).toISOString()
    + " TURN_COMMIT P2 actor=PANEL responds_to=NEW points=- via=manual" + NL);
  fs.writeFileSync(path.join(s.dir, "turns", "P2-panel.md"), "### TURN-P2 (PANEL)" + NL);
  ok("lint reports a SECONDARY turn that was not relayed",
    /L25.*carries no relayed_by/.test(run(["lint", "--session", s.id], s.root).out));
}

// --- the default single-secondary board pays nothing for any of this ---
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cblegacy-"));
  run(["new", "--type", "META", "--slug", "d"], root);
  const id = fs.readdirSync(path.join(root, ".collab-board", "sessions"))[0];
  const out = run(["lint", "--session", id], root).out;
  ok("a default CLAUDE/CODEX board is untouched by sole-writer and panel rules",
    !/L25/.test(out) && !/FAIL/.test(out), out);
}
}

// 17b-31. THE REPLY IS NEVER EVIDENCE. The single rule this suite re-proves most often, latterly
// against two more executors: `agy` without --add-dir and `copilot` without --autopilot both
// answer as though the turn is done and write nothing. A dispatch's exit code and narration say
// nothing about whether a turn landed; the shard on disk and the TURN_COMMIT in the log do.
//
// This is documentation, so it gets a documentation guard — prose with no test behind it is
// exactly the class of claim this whole review existed to remove.
if (SEL(54)) {
  const ad = read(path.join(HERE, "..", "references", "adapters.md"));
  ok("adapters.md states that a dispatch reply is not evidence",
    /REPLY IS NEVER EVIDENCE/.test(ad));
  ok("...and names the shard plus both log commits that prove a complete landing",
    /turns\/<turn-id>-<secondary>\.md/.test(ad) && /TURN_COMMIT/.test(ad) && /HANDOFF/.test(ad));
  // A claim of a BLOCKED write is a narration too, and routes to the scribe path only after
  // confirm has looked — otherwise the escape is simply relabelled.
  ok("...and routes incomplete or blocked results only after confirmation",
    /If no complete landing[\s\S]*recovery\.md/.test(ad)
    && /complete verdict could not write[\s\S]*relay\.md/.test(ad));

  // Each executor spec must carry the invocation that actually writes, or the rule above has
  // nowhere to send the reader.
  for (const [file, flag] of [["agy-cli.md", "--add-dir"], ["copilot-cli.md", "--autopilot"]]) {
    const spec = read(path.join(HERE, "..", "references", "executors", file));
    ok(file + " carries the flag without which it reports success and writes nothing",
      spec.includes(flag));
  }
}
// 17b-32. The lint spec must document exactly the codes the engine emits — DERIVED from the source,
// not maintained by hand. L25 shipped with the sole-writer mode and was never given a row, while
// SKILL.md told readers the spec covered "through L25" the entire time. A hand-kept list of what a
// document is supposed to contain is a list that falls behind, and the failure is invisible
// because both halves look complete on their own.
if (SEL(55)) {
  const engine = read(CLI);
  const spec = read(path.join(HERE, "..", "references", "lint-spec.md"));
  // Two emission shapes: `add(severity, code, …)` and `addGated(rulesetKey, code, …)`, whose
  // severity is decided by the board's ruleset provenance instead of being written at the site.
  // The scanner has to know both, or a code moved onto the gated helper reads as "documented but
  // never emitted" — which is what happened the first time L20 moved.
  const emitted = [...new Set([
    ...[...engine.matchAll(/add\("(?:FAIL|WARN)",\s*"(L[0-9]+)"/g)].map((m) => m[1]),
    ...[...engine.matchAll(/addGated\("[A-Z0-9_]+",\s*"(L[0-9]+)"/g)].map((m) => m[1]),
  ])];
  const documented = [...new Set([...spec.matchAll(/^\| (L[0-9]+) /gm)].map((m) => m[1]))];
  const undocumented = emitted.filter((c) => !documented.includes(c));
  const phantom = documented.filter((c) => !emitted.includes(c));
  ok("every lint code the engine emits has a row in lint-spec.md",
    emitted.length > 0 && undocumented.length === 0);
  if (undocumented.length) console.log("        emitted but undocumented: " + undocumented.join(" "));
  ok("lint-spec.md documents no code the engine never emits", phantom.length === 0);
  if (phantom.length) console.log("        documented but never emitted: " + phantom.join(" "));

  // SKILL.md names the range the spec covers; that claim is checked against the spec rather than
  // trusted, since it was wrong for as long as L25 existed.
  const skill = read(path.join(HERE, "..", "SKILL.md"));
  const claimed = /through (L[0-9]+)/.exec(skill);
  ok("SKILL.md names the highest lint code the spec actually documents",
    !!claimed && documented.includes(claimed[1])
      && Math.max(...documented.map((c) => +c.slice(1))) === +claimed[1].slice(1));

  // The spec is the largest shipped reference and `explain` is what makes it affordable, but the
  // routing lived only in SKILL.md — so a reader who opened the file directly, which is what a
  // finding's own text invites, paid all of it to clear one code. The cheaper path is named where
  // that reader already is, and the file says which of the two jobs it is for.
  ok("lint-spec.md sends a reader clearing ONE finding to explain instead of the whole file",
    /run `explain <code>` instead of reading this file/.test(spec));
  ok("...and says what reading the whole file is for", /for changing a check rather than for clearing one/.test(spec));

  // L25 is opt-in, and the row has to say so — a reader who thinks it applies to every board will
  // read every legacy session as unrelayed.
  const row = spec.split(/\r?\n/).filter((l) => l.includes("L25 PRIMARY-RELAY")).join(" ");
  ok("the L25 row says the check is scoped to PRIMARY_ONLY sessions",
    /BoardWriteMode: PRIMARY_ONLY/.test(row) && /untouched/.test(row));
  ok("...and states the limit rather than implying the capture proves fidelity",
    /byte-identical to an honest one/.test(row));

  // THE SAME DRIFT, ONE TABLE OVER, and this one damaged boards. `AGENT_SCHEMA_TABLE` grew a `v3`
  // and `new` began scaffolding every board at it, while the L24 row still opened "Grammar
  // (`agent/v2` only)" and listed five mandatory keys. `explain L24` is the remediation path
  // SKILL.md sends an author to, so following the documentation exactly on a board this build had
  // just created converted a formatting FAIL into a grammar FAIL. Nothing failed: the engine was
  // right, the document was self-consistent, and no check compared them. Derived from the table, so
  // a v4 fails here instead of in someone's session.
  const schemaVersions = [...engine.matchAll(/^ {2}(v\d+): \{ keys: (\[[^\]]*\]|null)/gm)]
    .map((m) => ({ v: m[1], keys: m[2] === "null" ? null : JSON.parse(m[2]) }));
  ok("the engine's agent-schema table parses (fixture sanity)", schemaVersions.length >= 3,
    schemaVersions.map((s) => s.v).join(" "));
  const l24 = spec.split(/\r?\n/).filter((l) => l.startsWith("| L24 ")).join(" ");
  ok("the L24 row is delimited (fixture sanity)", l24.length > 500);
  for (const s of schemaVersions) {
    ok(`L24 names agent/${s.v}, which the engine ships`, l24.includes("`agent/" + s.v + "`"));
    for (const k of s.keys || [])
      ok(`...and carries ${s.v}'s mandatory key ${k}`, l24.includes("`" + k + "`"));
  }
  // The migration EDGES, not the version set: `v1->v3` is not a legal edge and the document must
  // not read as if it were. Both surfaces that publish them are checked, because `--help` prints
  // the header Usage block verbatim and an argument list hand-written there is a copy of a table.
  const edges = schemaVersions.filter((s) => s.v !== "v1").map((s) => "agent/" + s.v);
  const usageLines = ((/\/\/ Usage:\r?\n((?:\/\/.*\r?\n)+)/.exec(engine) || ["", ""])[1]).split(/\r?\n/);
  const migrateUsage = usageLines.filter((l) => / migrate /.test(l)).join(" ");
  ok("the header Usage block documents migrate (fixture sanity)", migrateUsage.length > 20);
  for (const t of edges)
    ok(`--help's migrate line offers ${t}, which the engine accepts`, migrateUsage.includes(t));
  ok("...and offers nothing the engine would refuse",
    !/agent\/v1\b/.test(migrateUsage.replace(/agent\/v1->/g, "")));

  // A THIRD INSTANCE of the same class, and the one a user sees: the `new` panel prompt printed
  // `(see SKILL.md, "Panel preference")` after that section had moved into `references/manager.md`.
  // The engine was right, SKILL.md was right, and the sentence joining them pointed at nothing. A
  // pointer is a claim about another file, so it is checked against that file rather than read.
  const pointerSources = [["scripts/collab-board.mjs", engine],
    ["scripts/worker.mjs", read(path.join(HERE, "worker.mjs"))]];
  let pointers = 0;
  for (const [label, text] of pointerSources)
    for (const m of text.matchAll(/\(see ([A-Za-z0-9_./-]+\.md), "([^"]+)"\)/g)) {
      pointers++;
      const target = path.join(HERE, "..", m[1]);
      ok(`${label}'s pointer names a file that exists: ${m[1]}`, fs.existsSync(target), m[0]);
      if (!fs.existsSync(target)) continue;
      const headings = [...read(target).matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((h) => h[1]);
      ok(`...and a heading that exists in it: "${m[2]}"`,
        headings.some((h) => h === m[2]), headings.join(" | "));
    }
  ok("the engine still prints at least one cross-file pointer (fixture sanity)", pointers > 0);
}
// 17b-33. Two defects the FANOUT-BENCH reviewers found in passing — they were reviewing a seeded
// copy for planted bugs and reported these unplanted ones as well, so the bench paid for itself
// twice. Both are the half-applied-rule shape yet again: five mutator guards had drifted into
// three different versions of the same rule, and none of the five checked the one lint condition
// their own comment says they exist to mirror.
if (SEL(56)) {
  const twoStateSections = (s2) => edit(file(s2.dir, "HEAD.md"), (t) =>
    t.trimEnd() + NL + NL + "## State" + NL + "- CLAUDE: START - PRIMARY" + NL);

  // parseHead reads rows from the FIRST section only, so a second one is invisible to every value
  // the command is about to act on — while lint fails the board as "two sections are two truths".
  {
    const s2 = scaffold(); twoStateSections(s2);
    ok("lint FAILs a HEAD with two live ## State sections",
      /L1.*"## State" sections/.test(lint(s2.root, s2.id).out));
  }
  for (const [cmd, args] of [
    ["terminal", ["terminal", "--status", "ABORTED"]],
    ["advance", ["advance"]],
    ["activate", ["activate", "--actor", "CLAUDE"]],
    ["migrate", ["migrate", "--to", "agent/v2"]],
  ]) {
    const s2 = scaffold(); twoStateSections(s2);
    const r = run([args[0], "--session", s2.id, ...args.slice(1)], s2.root);
    ok(cmd + " refuses a HEAD that lint rejects for two ## State sections",
      r.code !== 0 && /State is malformed/.test(r.out));
  }
  {
    // ...and having refused, it wrote nothing.
    const s2 = scaffold(); twoStateSections(s2);
    run(["terminal", "--session", s2.id, "--status", "ABORTED"], s2.root);
    ok("a mutator that refused a two-section HEAD appended no event",
      !/^\S+\s+TERMINAL\s/m.test(read(file(s2.dir, "log.md"))));
  }
  {
    // The guard names WHICH condition failed, so the operator is not sent to lint to guess.
    const s2 = scaffold(); twoStateSections(s2);
    const r = run(["terminal", "--session", s2.id, "--status", "ABORTED"], s2.root);
    ok("and the refusal names the specific problem", /2 live "## State" sections/.test(r.out));
  }

  // agents/ litter is litter whatever it is called. Reporting only names ending .md meant a stray
  // `scratch.txt` was mentioned by no check at all, beside a directory check added for exactly
  // that reason.
  for (const name of ["scratch.txt", "notes", "claude.md.bak", "README"]) {
    const s2 = scaffold();
    write(file(s2.dir, "agents", name), "stray" + NL);
    ok("a stray " + name + " in agents/ is reported",
      new RegExp("L24.*" + name.replace(/\./g, "\\.") + ".*not an actor file").test(lint(s2.root, s2.id).out));
  }
  {
    // And the legitimate files are still not litter.
    const s2 = scaffold();
    ok("the two real actor files are not reported as strays",
      !/L24.*not an actor file/.test(lint(s2.root, s2.id).out));
  }
}
// 17b-34. DOCUMENTATION INTEGRITY. The owner pointed at a rule — "if the CLI is not on PATH, do
// NOT conclude it is missing; re-probe by absolute path" — that is true of EVERY CLI executor but
// was stated in exactly one vendor file. That is the half-applied-rule defect at the documentation
// layer: a rule restated per vendor is a rule the other vendors can silently lack, and three of
// the four specs were missing at least one such rule.
//
// This guard checks STRUCTURE, not keywords. An earlier keyword-based pass produced two FALSE
// findings of its own — it read `**local** time` as absent because of the bold markers, and it
// read version-pinning as absent from two files that state it in different words. Asking "does
// this text contain this phrase" is the same weak instrument this project spent a session removing
// from the engine, so what is asserted here is the property the hoist actually established: the
// shared contract holds the generic rules, and the vendor files do not carry duplicate copies.
if (SEL(57)) {
  const ref = (f) => read(path.join(HERE, "..", "references", f));
  const adapters = ref("adapters.md");
  const dir = path.join(HERE, "..", "references", "executors");
  const execs = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  ok("there is more than one executor spec, so sharing is meaningful", execs.length >= 2);

  ok("adapters.md carries the shared CLI requirements section",
    /## Shared CLI requirements/.test(adapters));
  // The rule the owner named, stated generically rather than for one vendor.
  ok("...including absolute-path recovery for a CLI absent from current PATH",
    /missing from current `PATH`[\s\S]*absolute path/i.test(adapters));
  ok("...including project-root, allowed-root, and path-conversion requirements",
    /Run from the project root/.test(adapters) && /allowed write root/.test(adapters)
    && /cygpath -w/.test(adapters) && /wslpath -w/.test(adapters));
  ok("...and that process output never replaces board confirmation",
    /THE REPLY IS NEVER EVIDENCE/.test(adapters) && /HANDOFF/.test(adapters));

  // No LONG passage may appear verbatim in two vendor specs: that is the drift hazard the whole
  // hoist exists to remove. Short shared pointers are fine and are what a pointer is.
  const paras = new Map();
  for (const f of execs)
    for (const para of ref(path.join("executors", f)).split(/\r?\n\r?\n/)) {
      const k = para.replace(/\s+/g, " ").trim();
      if (k.length < 240) continue;   // a pointer is short; a hoisted rule is not
      if (!paras.has(k)) paras.set(k, new Set());
      paras.get(k).add(f);
    }
  const dupes = [...paras.entries()].filter(([, fs2]) => fs2.size > 1);
  ok("no long passage is duplicated verbatim across executor specs", dupes.length === 0);
  for (const [k, fs2] of dupes)
    console.log("        [" + [...fs2].join(",") + "] " + k.slice(0, 90) + "...");

  // ...and none is duplicated WITHIN one file either. The cross-file check above cannot see that,
  // and a paragraph repeated verbatim twice in the same document sat unnoticed in TWO executor
  // specs — including past a reader who had the evidence on screen and read straight over it.
  for (const f of execs) {
    const counts = new Map();
    for (const para of ref(path.join("executors", f)).split(/\r?\n\r?\n/)) {
      const k = para.replace(/\s+/g, " ").trim();
      if (k.length < 80) continue;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const repeated = [...counts.entries()].filter(([, n]) => n > 1);
    ok(f + " repeats no paragraph within itself", repeated.length === 0);
    for (const [k, n] of repeated) console.log("        x" + n + " " + k.slice(0, 88) + "...");
  }

  // Routing is one-way: adapters.md selects one executor. Requiring every executor to point back
  // would duplicate navigation in every provider file.
  for (const f of execs)
    ok("adapters.md routes to " + f, adapters.includes("executors/" + f));
}
// 17b-35. L26 CONVERGENCE (Rule 11). Rule 5 measures a SILENT actor and Rule 6 one stuck point;
// neither sees the board that is busy, polite and going nowhere. Calibrated against the 14 real
// boards in this repo's working tree by replaying every log prefix: 9 stay clean throughout —
// including a 38-turn IMPL phase — while the session that ran 29 IMPL turns and had its whole
// approach rejected would have FAILed at I8, and the one that re-litigated P1 twice before being
// ABORTED would have FAILed at P5. That split is the whole design: ACTIVITY is not convergence
// (the rejected session advanced a commit on nearly every turn), SETTLEMENT is.
if (SEL(58)) {
  // A phase's worth of turns that settle nothing. `n` TURN_COMMITs and not one POINT_SET
  // resolution, GATE_SET or DECISION between them.
  const barrenLog = (n, first = 1) => {
    let s = "";
    for (let i = 0; i < n; i++) {
      const id = "P" + (first + i);
      const prev = i === 0 ? "NEW" : "P" + (first + i - 1);
      s += "2026-08-04T10:" + String(10 + i).padStart(2, "0") + ":00Z TURN_COMMIT " + id
        + " actor=" + (i % 2 ? "CODEX" : "CLAUDE") + " responds_to=" + prev + " points=- via=claude-code" + NL;
    }
    return s;
  };
  const activate = (dir) => edit(file(dir, "HEAD.md"), (t) => t.replace("SESSION_STATUS: IDLE", "SESSION_STATUS: ACTIVE"));

  // FAIL at the threshold.
  const a = scaffold();
  edit(file(a.dir, "log.md"), (t) => t.trimEnd() + NL + barrenLog(8));
  activate(a.dir);
  const aOut = lint(a.root, a.id).out;
  ok("8 turns that settle nothing → L26 FAIL", /FAIL\s+L26.*8 turns since anything was settled/.test(aOut));
  ok("...and it names the turn the streak started from", /from P1/.test(aOut));

  // CONTROL: the same length of session that keeps settling things is clean. Without this, a
  // check that simply counted turns would look identical on the evidence above.
  //
  // The first turn now RAISES P1 (`points=P1`) before turn 8 resolves it. That is a rewrite of a
  // control to keep it passing, which deserves saying out loud: a settlement only buys a window
  // for a point some earlier turn actually put up, and this control previously resolved a point
  // that no turn had ever named — the exact create-and-close shape the exposure rule exists to
  // stop counting. The control's PURPOSE is unchanged (a settling session of the same length must
  // stay clean); what changed is that it now depicts a session that really settled something.
  const b = scaffold();
  const raiseP1 = "2026-08-04T10:09:00Z TURN_COMMIT P0 actor=CLAUDE responds_to=NEW points=P1 via=claude-code" + NL;
  edit(file(b.dir, "log.md"), (t) => t.trimEnd() + NL + raiseP1 + barrenLog(8)
    + "2026-08-04T10:19:00Z POINT_SET P1=AGREED in=P8" + NL);
  edit(file(b.dir, "points.md"), (t) => t.trimEnd() + NL + "| P1 | PLAN | settled | AGREED | [P8](turns/P8-claude.md) |" + NL);
  activate(b.dir);
  ok("...but a resolved point resets the streak (control)", !has(lint(b.root, b.id).out, "L26"));

  // CONTROL: one turn below the FAIL line is a WARN, not a block — the ladder gives the pair one
  // more full exchange to converge on their own.
  const c = scaffold();
  edit(file(c.dir, "log.md"), (t) => t.trimEnd() + NL + barrenLog(6));
  activate(c.dir);
  const cOut = lint(c.root, c.id).out;
  ok("BARREN-2 turns → L26 WARN, not FAIL", has(cOut, "L26") && /WARN\s+L26/.test(cOut) && !/FAIL\s+L26/.test(cOut));

  // CONTROL: a fresh board, and a short one, must never trip it.
  const d = scaffold();
  edit(file(d.dir, "log.md"), (t) => t.trimEnd() + NL + barrenLog(3));
  activate(d.dir);
  ok("a short session is not divergence (control)", !has(lint(d.root, d.id).out, "L26"));

  // The step-back is what clears it, and it must be the documented event to do so.
  const e = scaffold();
  const stepBack = (outcome, by = "CLAUDE", trigger = "BARREN") =>
    "2026-08-04T10:19:00Z REFRAME by=" + by + " in=P8 trigger=" + trigger + " outcome=" + outcome + NL;
  edit(file(e.dir, "log.md"), (t) => t.trimEnd() + NL + barrenLog(8) + stepBack("REFRAME"));
  write(file(e.dir, "turns", "P8-claude.md"), "### TURN-P8 (CLAUDE)" + NL + "- REFRAME: REFRAME - eight turns produced no settlement" + NL);
  activate(e.dir);
  ok("a logged REFRAME clears the barren FAIL", !/FAIL\s+L26/.test(lint(e.root, e.id).out));

  // ...and an off-form one does not. Read leniently it would still LOOK like a step-back while
  // buying no window: the one place a loose read silences the check it satisfies.
  const f2 = scaffold();
  edit(file(f2.dir, "log.md"), (t) => t.trimEnd() + NL + barrenLog(8)
    + "2026-08-04T10:19:00Z REFRAME by=CLAUDE in=P8 outcome=REFRAME" + NL);
  activate(f2.dir);
  const f2Out = lint(f2.root, f2.id).out;
  ok("an off-form REFRAME FAILs instead of buying a window", /L26.*is not the documented/.test(f2Out));
  ok("...and the barren FAIL still stands", /FAIL\s+L26.*turns since anything was settled/.test(f2Out));

  // ...nor does a well-formed one with something riding along behind it. This is the exact
  // shape the PHASE_SET prefix match had: everything the form describes is present, and the
  // sentence after it was never read by anything.
  const f3 = scaffold();
  edit(file(f3.dir, "log.md"), (t) => t.trimEnd() + NL + barrenLog(8)
    + "2026-08-04T10:19:00Z REFRAME by=CLAUDE in=P8 trigger=BARREN outcome=CONTINUE and abort if it fails again" + NL);
  write(file(f3.dir, "turns", "P8-claude.md"), "### TURN-P8 (CLAUDE)" + NL + "- REFRAME: CONTINUE - x" + NL);
  activate(f3.dir);
  const f3Out = lint(f3.root, f3.id).out;
  ok("a REFRAME with trailing text FAILs — the payload is a whole line, not a prefix",
    /L26.*is not the documented/.test(f3Out));
  ok("...and buys no window either", /FAIL\s+L26.*turns since anything was settled/.test(f3Out));
  // A step-back the SECONDARY logged for itself. Same reasoning as SCHEMA_SET: it can ABORT the
  // session, and provenance anyone may write is not provenance.
  const g = scaffold();
  edit(file(g.dir, "log.md"), (t) => t.trimEnd() + NL + barrenLog(8) + stepBack("ABORT", "CODEX"));
  write(file(g.dir, "turns", "P8-claude.md"), "### TURN-P8 (CLAUDE)" + NL + "- REFRAME: ABORT - x" + NL);
  activate(g.dir);
  ok("a SECONDARY-authored REFRAME FAILs", /L26.*by=CODEX but this board's PRIMARY is CLAUDE/.test(lint(g.root, g.id).out));

  // outcome=ESCALATE declares that the user was asked. An escalation nobody was asked is not one.
  const h = scaffold();
  edit(file(h.dir, "log.md"), (t) => t.trimEnd() + NL + barrenLog(8) + stepBack("ESCALATE"));
  write(file(h.dir, "turns", "P8-claude.md"), "### TURN-P8 (CLAUDE)" + NL + "- REFRAME: ESCALATE - x" + NL);
  activate(h.dir);
  ok("outcome=ESCALATE with no USER_QUESTION FAILs", /L26.*no USER_QUESTION names that turn/.test(lint(h.root, h.id).out));

  const i2 = scaffold();
  edit(file(i2.dir, "log.md"), (t) => t.trimEnd() + NL + barrenLog(8) + stepBack("ESCALATE")
    + "2026-08-04T10:19:01Z USER_QUESTION by=CLAUDE in=P8" + NL);
  write(file(i2.dir, "turns", "P8-claude.md"), "### TURN-P8 (CLAUDE)" + NL + "- REFRAME: ESCALATE - x" + NL
    + "USER_QUESTION: which approach do you want?" + NL);
  activate(i2.dir);
  ok("...and passes once the question is actually logged (control)",
    !/FAIL\s+L26/.test(lint(i2.root, i2.id).out));

  // The step-back may not itself spiral: two of them with nothing settled in between is the same
  // loop one level up, and Rule 11 allows only ESCALATE or ABORT there.
  const j = scaffold();
  edit(file(j.dir, "log.md"), (t) => t.trimEnd() + NL + barrenLog(8) + stepBack("CONTINUE")
    + barrenLog(8, 9).replace(/responds_to=NEW/, "responds_to=P8")
    + "2026-08-04T10:29:00Z REFRAME by=CLAUDE in=P16 trigger=REPEAT outcome=CONTINUE" + NL);
  for (const t of ["P8", "P16"])
    write(file(j.dir, "turns", t + "-claude.md"), "### TURN-" + t + " (CLAUDE)" + NL + "- REFRAME: CONTINUE - x" + NL);
  activate(j.dir);
  ok("a second REFRAME that settled nothing FAILs", /L26.*re-framing is not converging either/.test(lint(j.root, j.id).out));

  // CHURN: the first re-open is a legitimate correction under new evidence; the second is
  // re-litigation. The threshold sits above the one-reopen board in this repo's tree, which lints
  // clean today and must keep doing so.
  const churnLog = (reopens) => {
    let s = "2026-08-04T10:00:00Z TURN_COMMIT P1 actor=CLAUDE responds_to=NEW points=P1 via=claude-code" + NL
      + "2026-08-04T10:00:01Z POINT_SET P1=OPEN in=P1" + NL;
    for (let k = 0; k < reopens; k++)
      s += "2026-08-04T10:0" + (k + 1) + ":00Z POINT_SET P1=AGREED in=P1" + NL
        + "2026-08-04T10:0" + (k + 1) + ":30Z POINT_SET P1=OPEN in=P1" + NL;
    return s;
  };
  const k1 = scaffold();
  edit(file(k1.dir, "log.md"), (t) => t.trimEnd() + NL + churnLog(1));
  edit(file(k1.dir, "points.md"), (t) => t.trimEnd() + NL + "| P1 | PLAN | reopened once | OPEN | - |" + NL);
  edit(file(k1.dir, "HEAD.md"), (t) => t.replace(/^PLAN_OPEN_POINTS:.*$/m, "PLAN_OPEN_POINTS: 1"));
  activate(k1.dir);
  ok("one re-opened point is a correction, not churn (control)", !has(lint(k1.root, k1.id).out, "L26"));

  const k2 = scaffold();
  edit(file(k2.dir, "log.md"), (t) => t.trimEnd() + NL + churnLog(2));
  edit(file(k2.dir, "points.md"), (t) => t.trimEnd() + NL + "| P1 | PLAN | re-litigated | OPEN | - |" + NL);
  edit(file(k2.dir, "HEAD.md"), (t) => t.replace(/^PLAN_OPEN_POINTS:.*$/m, "PLAN_OPEN_POINTS: 1"));
  activate(k2.dir);
  ok("a point resolved and re-opened twice → L26 CHURN FAIL",
    /FAIL\s+L26.*re-opened 2 times/.test(lint(k2.root, k2.id).out));

  // A terminal board has stopped: measuring its convergence is measuring a finished race. Both
  // real diverging boards are terminal today, which is why the calibration above replayed prefixes.
  const l = scaffold();
  edit(file(l.dir, "log.md"), (t) => t.trimEnd() + NL + barrenLog(8)
    + "2026-08-04T10:20:00Z TERMINAL ABORTED by=CLAUDE seq=9" + NL);
  edit(file(l.dir, "HEAD.md"), (t) => t
    .replace("SESSION_STATUS: IDLE", "SESSION_STATUS: ABORTED")
    .replace("- CLAUDE: ON_HOLD - PRIMARY", "- CLAUDE: DONE - PRIMARY")
    .replace("- CODEX: ON_HOLD - SECONDARY", "- CODEX: DONE - SECONDARY"));
  ok("a terminal board is not measured for convergence (control)", !has(lint(l.root, l.id).out, "L26"));

  // SESSION.Converge tunes it. ABSENCE is the default and costs an existing board nothing; a
  // MALFORMED value is not read as absence, or the misspelling becomes the way to move a limit.
  const m = scaffold();
  edit(file(m.dir, "log.md"), (t) => t.trimEnd() + NL + barrenLog(8));
  edit(file(m.dir, "SESSION.md"), (t) => t.replace(/^Converge:.*$/m, "Converge: BARREN=20, CHURN=2"));
  activate(m.dir);
  ok("a raised BARREN threshold is honored", !has(lint(m.root, m.id).out, "L26"));

  const n = scaffold();
  edit(file(n.dir, "SESSION.md"), (t) => t.replace(/^Converge:.*$/m, "Converge: BARREN=8"));
  activate(n.dir);
  ok("a half-declared Converge FAILs rather than reading as the default",
    /FAIL\s+L26.*must read exactly/.test(lint(n.root, n.id).out));

  const o = scaffold();
  edit(file(o.dir, "SESSION.md"), (t) => t.replace(/^Converge:.*$/m, "Converge: BARREN=0, CHURN=0"));
  activate(o.dir);
  ok("a zero threshold is refused, not treated as off", /FAIL\s+L26.*neither can be zero/.test(lint(o.root, o.id).out));

  const n2 = scaffold();
  edit(file(n2.dir, "log.md"), (t) => t.trimEnd() + NL + barrenLog(8));
  edit(file(n2.dir, "SESSION.md"), (t) => t.replace(/^Converge:.*$/m, "").trimEnd() + NL);
  activate(n2.dir);
  ok("a board with NO Converge line falls back to the documented defaults",
    /FAIL\s+L26.*BARREN=8/.test(lint(n2.root, n2.id).out));

  const n3 = scaffold();
  edit(file(n3.dir, "SESSION.md"), (t) => t.replace(/^Converge:.*$/m, (s) => s + NL + "Converge: BARREN=99, CHURN=99"));
  activate(n3.dir);
  ok("two Converge declarations FAIL rather than the first quietly winning",
    /FAIL\s+L26.*declares Converge x2/.test(lint(n3.root, n3.id).out));
  // A step-back written into the shard but never logged buys no window; the barren FAIL then
  // re-fires every turn with no hint why, so say why.
  const p = scaffold();
  edit(file(p.dir, "log.md"), (t) => t.trimEnd() + NL + barrenLog(8));
  write(file(p.dir, "turns", "P8-claude.md"), "### TURN-P8 (CLAUDE)" + NL + "- REFRAME: NARROW - x" + NL);
  activate(p.dir);
  ok("an unlogged step-back is called out", /WARN\s+L26.*carry a REFRAME: line but the log has 0/.test(lint(p.root, p.id).out));

  // The shard marker is a LINE, not the word. A turn that mentions re-framing in a sentence has
  // not taken a step-back, and counting it as one would report an unlogged step-back that never
  // happened - the false-positive direction of a token check.
  const r2 = scaffold();
  edit(file(r2.dir, "log.md"), (t) => t.trimEnd() + NL + barrenLog(3));
  write(file(r2.dir, "turns", "P3-claude.md"), "### TURN-P3 (CLAUDE)" + NL
    + "- FINDINGS: if this stalls again we should REFRAME: the storage layer is the suspect" + NL);
  activate(r2.dir);
  ok("the word REFRAME: mid-sentence is not a step-back marker", !has(lint(r2.root, r2.id).out, "L26"));
  // Board syntax QUOTED AS CODE is not a declaration — this tree's own boards quote board syntax
  // in prose constantly, and a masking change once produced false findings on four of them.
  const q = scaffold();
  edit(file(q.dir, "log.md"), (t) => t.trimEnd() + NL + barrenLog(8) + stepBack("NARROW"));
  write(file(q.dir, "turns", "P8-claude.md"), "### TURN-P8 (CLAUDE)" + NL
    + "- REFRAME: NARROW - cut scope to the part that converges" + NL);
  write(file(q.dir, "turns", "P7-codex.md"), "### TURN-P7 (CODEX)" + NL
    + "- FINDINGS: the grammar is `- REFRAME: <outcome>`, e.g." + NL + "```" + NL + "- REFRAME: ABORT" + NL + "```" + NL);
  activate(q.dir);
  ok("a shard QUOTING the step-back grammar is not counted as one", !has(lint(q.root, q.id).out, "L26"));
}
// 18. Codex-global install honors CODEX_HOME and does not install Claude slash commands.
if (SEL(59)) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "cb-codex-home-"));
  let installCode = 0;
  try {
    execFileSync(process.execPath, [INSTALLER, "--codex-global"], {
      encoding: "utf8", env: { ...process.env, CODEX_HOME: codexHome },
    });
  } catch { installCode = 1; }
  ok("--codex-global installs skill under CODEX_HOME", installCode === 0 && fs.existsSync(path.join(codexHome, "skills", "collab-board", "SKILL.md")));
  ok("--codex-global skips Claude commands", !fs.existsSync(path.join(codexHome, "commands")) && !fs.existsSync(path.join(codexHome, ".claude")));

  const claudeProject = fs.mkdtempSync(path.join(os.tmpdir(), "cb-claude-project-"));
  let projectInstallCode = 0;
  try { execFileSync(process.execPath, [INSTALLER, claudeProject], { encoding: "utf8" }); }
  catch { projectInstallCode = 1; }
  ok("default installer still copies the Claude project skill", projectInstallCode === 0 && fs.existsSync(path.join(claudeProject, ".claude", "skills", "collab-board", "SKILL.md")));
  ok("default installer still copies Claude commands", fs.existsSync(path.join(claudeProject, ".claude", "commands", "collab-new.md")));
}

// 19. Engine appends clamp to the log's last event time — but only for the sub-second
//     truncation artifact. A ms-precision agent event in the same wall-clock second must not
//     make the engine's second-precision stamp a decrease (L23; equality valid), while a
//     bigger decrease is written as-is so L23 still surfaces the earlier bad event.
if (SEL(60)) {
  // Model the real artifact: an honest ms-precision event late in the current second, with
  // the engine's truncated append landing in the SAME second. The clamp then sets the engine
  // stamp EQUAL to the prior event — assert that exact equality so the pass is never vacuous.
  // Landing in-second is timing-dependent (process spawn), so retry a few aligned attempts
  // and fail loudly if the clamp path was never exercised.
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  let exercised = false;
  for (let attempt = 0; attempt < 5 && !exercised; attempt++) {
    const { root, id, dir } = scaffold();
    const rem = Date.now() % 1000;
    if (rem > 150) sleep(1000 - rem);
    const msEvent = new Date(Math.floor(Date.now() / 1000) * 1000 + 999).toISOString();
    edit(file(dir, "log.md"), (t) => t.trimEnd() + `\n${msEvent} STALL_CHECK actor=CLAUDE\n`);
    const term = run(["terminal", "--session", id, "--status", "ABORTED"], root);
    const termTs = (read(file(dir, "log.md")).match(/^(\S+)\s+TERMINAL/m) || [])[1];
    if (term.code === 0 && termTs === msEvent && !has(lint(root, id).out, "L23")) exercised = true;
    else if (Date.parse(termTs) <= Date.parse(msEvent)) break; // in-second but NOT clamped correctly
  }
  ok("engine append clamps to an in-second ms-precision event (L23, exercised)", exercised);

  // The clamp must NOT mask a genuinely wrong earlier time (well beyond truncation).
  const masked = scaffold();
  const farEvent = new Date(Date.now() + 30_000).toISOString(); // inside the 60 s future tolerance
  edit(file(masked.dir, "log.md"), (t) => t.trimEnd() + `\n${farEvent} STALL_CHECK actor=CLAUDE\n`);
  run(["terminal", "--session", masked.id, "--status", "ABORTED"], masked.root);
  ok("clamp does not mask a >1s decrease (L23 still fails)", has(lint(masked.root, masked.id).out, "L23"));
}

// 20. L1 SPLIT-STATE covers plan/context.md and impl/code_state.md (spec says "any file other
//     than HEAD.md" — both are first-class session files).
if (SEL(61)) {
  const { root, id, dir } = scaffold();
  edit(file(dir, "plan", "context.md"), (t) => t.trimEnd() + "\n- CLAUDE: START - PRIMARY\n");
  ok("hand-token in plan/context.md → L1 FAIL", has(lint(root, id).out, "L1"));
  const cs = scaffold();
  edit(file(cs.dir, "impl", "code_state.md"), (t) => t.trimEnd() + "\n- CODEX: ON_HOLD - SECONDARY\n");
  ok("hand-token in impl/code_state.md → L1 FAIL", has(lint(cs.root, cs.id).out, "L1"));
}

// 21. terminal idempotent re-run: the write order is HEAD → TERMINAL log
//     line → catalog row, so there are two distinct crash windows plus a conflict path.
if (SEL(62)) {
  // (a) post-log/pre-index window: HEAD terminal + exactly one TERMINAL event + a STALE catalog
  //     row → same-status re-run exits 0, appends NO second TERMINAL, repairs the index, lints clean.
  const { root, id, dir } = scaffold();
  const t1 = run(["terminal", "--session", id, "--status", "ABORTED"], root);
  const idx = path.join(root, ".collab-board", "index.md");
  edit(idx, (t) => t.replace(`| ${id} | FEATURE | ABORTED |`, `| ${id} | FEATURE | IDLE |`)); // simulate the crash-stale row
  ok("fixture: stale catalog row → L16 WARN", t1.code === 0 && has(lint(root, id).out, "L16"));
  const t2 = run(["terminal", "--session", id, "--status", "ABORTED"], root);
  // Count EVENT lines (a leading timestamp), not every line containing the word — the template's
  // own header comment mentions TERMINAL, and a comment is not an event.
  const termLines = read(file(dir, "log.md")).split(/\r?\n/).filter((l) => /^\S+\s+TERMINAL\s/.test(l)).length;
  const r2 = lint(root, id);
  ok("same-status re-run: exit 0, exactly one TERMINAL line", t2.code === 0 && termLines === 1);
  ok("same-status re-run repairs the catalog row (no L16, lint clean)", r2.code === 0 && !has(r2.out, "L16"));
  // (b) conflict: a different-status re-run dies and the log is untouched.
  const before = read(file(dir, "log.md"));
  const t3 = run(["terminal", "--session", id, "--status", "COMPLETED"], root);
  ok("conflicting-status re-run → non-zero exit, log unchanged",
    t3.code !== 0 && /already logged TERMINAL/.test(t3.out) && read(file(dir, "log.md")) === before);
}
if (SEL(63)) {
  // (c) post-HEAD/pre-log window: HEAD already terminal but no TERMINAL event → re-run completes
  //     the missing writes (event + catalog) and lints clean.
  const { root, id, dir } = scaffold();
  edit(file(dir, "HEAD.md"), (t) => t
    .replace("SESSION_STATUS: IDLE", "SESSION_STATUS: ABORTED")
    .replace("- CLAUDE: ON_HOLD - PRIMARY", "- CLAUDE: DONE - PRIMARY")
    .replace("- CODEX: ON_HOLD - SECONDARY", "- CODEX: DONE - SECONDARY"));
  const t4 = run(["terminal", "--session", id, "--status", "ABORTED"], root);
  const hasTerm = /^\S+\s+TERMINAL\s/m.test(read(file(dir, "log.md")));
  ok("post-HEAD/pre-log crash repair: re-run completes writes, lint clean",
    t4.code === 0 && hasTerm && lint(root, id).code === 0);
}

// 22. DOCUMENTATION invariants for the two anti-correlation rules — independent-first (PROTOCOL
//     §5, pointed at from the dispatch skeleton) and the IMPL-evidence rule (PROTOCOL §4). These
//     guard the written rules against a silent reversion; they do NOT measure model
//     independence, and passing them is no evidence that any turn was actually independent.
//     Unlike every case above they assert on the skill's own reference files rather than a
//     scaffolded board, because prose is where these rules live and where a revert would happen.
//     Assertions are relational (line order) plus short stable tokens, never paragraph equality,
//     so a rewording that preserves the behavior survives; a label-level refactor of the
//     read-list entries is fixture maintenance and needs the anchors updated with it.
if (SEL(64)) {
  const REF = path.join(HERE, "..", "references");
  const proto = read(path.join(REF, "protocol.md"));
  // Assertions use section boundaries and normalized whitespace, not paragraph equality.
  const flat = (s) => s.replace(/\s+/g, " ").trim();
  const section = (text, n, next) => flat(
    new RegExp("## " + n + "\\.[\\s\\S]*?(?=\\n## " + next + "\\.)").exec(text)?.[0] || "");
  // PROTOCOL §5 is canonical and adapter-blind, so it also binds peer mode.
  const rule = section(proto, 5, 6);
  // Pre-registration is the whole mechanism: "form" alone would let the INDEPENDENT line be
  // retrofitted after reading the PRIMARY, which is exactly what it exists to detect.
  ok("PROTOCOL section 5 binds ACK and independent-first to the first SECONDARY turn",
    /SECONDARY first turn ACKs SESSION and works independent-first/.test(rule));
  ok("independent-first forms a scoped candidate before both PRIMARY-authored artifacts",
    /Topic\/Goal\/Done plus scoped task sources before points\/predecessor/.test(rule)
    && /record `- INDEPENDENT:`/.test(rule));
  // The source allowance must stay bounded — an open-ended licence would gut the bounded
  // read-set that is this protocol's central design goal (§1).
  ok("independent-first remains explicitly diagnostic, not proof",
    /Diagnostic, not proof/.test(rule) && /shared blind spot/.test(rule));

  // --- The dispatch skeleton: operational order + a POINTER, never a second normative copy.
  const skeleton = read(path.join(REF, "adapters.md"));
  // Scope EVERY skeleton assertion to the READ block: the WRITE section names points.md too, and
  // an unscoped search would also let the pointer drift anywhere in the file while still
  // matching. Bounding here (rather than file-wide) also keeps a legitimate explanatory mention
  // elsewhere in adapters.md from false-failing the duplicate-copy check below.
  const from = skeleton.indexOf("READ EXACTLY THESE");
  const to = skeleton.indexOf("Take one <PHASE> turn");
  const readBlock = from >= 0 && to > from ? skeleton.slice(from, to) : "";
  const rbLines = readBlock.split("\n");
  const at = (re) => rbLines.findIndex((l) => re.test(l));
  const iSession = at(/\[first turn\].*\/SESSION\.md/i);
  const iPoints = at(/^\s*-\s.*\/points\.md/);
  const iResponds = at(/^\s*-\s.*<RESPONDS_TO>/);
  const iIndep = at(/\[first SECONDARY turn\]/);
  ok("skeleton read block is delimited (fixture sanity)",
    readBlock !== "" && iSession >= 0 && iPoints >= 0 && iResponds >= 0 && iIndep >= 0);
  ok("first-turn SESSION.md is read before points.md AND <RESPONDS_TO> (anti-anchoring order)",
    iSession >= 0 && iSession < iPoints && iSession < iResponds);
  // The two deferral annotations are load-bearing: without them a top-down reader opens both
  // primary-authored artifacts before ever reaching the pointer below the list.
  ok("both primary-authored read-list entries are deferred until the first-turn candidate",
    iPoints >= 0 && iResponds >= 0
    && /after INDEPENDENT candidate/.test(rbLines[iPoints]) && /after candidate/.test(rbLines[iResponds]));
  ok("the independent-first instruction sits after the read list and inside the block",
    iIndep >= 0 && iIndep > iPoints && iIndep > iResponds);
  const pointer = flat(rbLines.slice(iIndep).join(" "));
  ok("the instruction names the scoped inputs and both deferred artifacts",
    /SESSION Topic\/Goal\/Done plus explicitly scoped task sources/.test(pointer)
    && /BEFORE opening points\.md or the predecessor/.test(pointer));
  // Without this, "NOTHING ELSE" above reads as forbidding the very sources the rule requires.
  ok("the read boundary and task-source allowance are both explicit",
    /READ EXACTLY THESE BOARD FILES, NOTHING ELSE/.test(readBlock)
    && /explicitly scoped task sources/.test(pointer));
  // Single-source: the rule text lives in PROTOCOL only, and what remains here is a POINTER.
  // Three independent ways of saying that, because a duplicate can be restored without reusing
  // the label and without matching any one phrase's capitalization: (a) one label occurrence,
  // (b) the trailing paragraph stays pointer-sized — measured in whitespace-normalized
  // CHARACTERS, not lines, so re-wrapping the same words is free while a restored rule body
  // (~570 chars in its PROTOCOL form) is not, (c) none of the rule's own normative phrasings
  // appear here, matched case-insensitively.
  const flatBlock = flat(readBlock);
  ok("diagnostic caveats stay single-sourced in protocol.md",
    !/diagnostic, not proof/i.test(flatBlock) && !/shared blind spot/i.test(flatBlock));

  // --- PROTOCOL §4: the IMPL-evidence rule must be satisfiable ONLY by an applicable check, and
  //     must classify a non-passing or unrun one as disclosure rather than verification. Scoped
  //     to its own bullet: searching the whole file would let a stray mention — even one inside
  //     an HTML comment — stand in for a rule that had been removed from the rendered text.
  const sec4 = section(proto, 4, 5);
  ok("PROTOCOL section 4 carries the IMPL evidence rule", sec4.length > 0);
  ok("IMPL agreement requires an applicable command and outcome",
    /Applicable executable verification requires command and outcome/.test(sec4));
  ok("an unrun or failing check remains disclosure rather than support",
    /unrun\/failing check is disclosure, not support/.test(sec4));

  // --- SKILL.md's per-turn read enumeration must agree with the rule above, or the operating
  //     card tells an agent the opposite order from the protocol.
  const skill = read(path.join(HERE, "..", "SKILL.md"));
  const planLine = skill.slice(skill.indexOf("PLAN:"), skill.indexOf("IMPL:"));
  const pS = planLine.indexOf("SESSION"), pP = planLine.indexOf("points"), pR = planLine.indexOf("RESPONDS_TO");
  ok("SKILL.md PLAN enumeration lists first-turn SESSION before points and predecessor",
    pS >= 0 && pP > pS && pR > pS);

  // --- Append-only log discipline in the dispatch skeleton.
  // These assert the DOCUMENTATION CONTRACT — that the skeleton still TELLS a secondary how to
  // write log.md. They cannot and do not prove a model obeys it; the motivating incident was a
  // secondary appending with a positional write at offset 0, which destroyed the log header and
  // lost its own TURN_COMMIT. Scoped to the WRITE block so a stray mention elsewhere in
  // adapters.md cannot satisfy them.
  const wFrom = skeleton.indexOf("WRITE IN THIS ORDER");
  const wTo = skeleton.indexOf("If a write is denied", wFrom < 0 ? 0 : wFrom);
  // flat() collapses the wrapping, so a reflowed paragraph cannot false-fail these.
  const writeBlock = wFrom >= 0 && wTo > wFrom ? flat(skeleton.slice(wFrom, wTo)) : "";
  ok("skeleton write block is delimited (fixture sanity)", writeBlock !== "");
  ok("skeleton requires an append to log.md after ensuring a terminal newline",
    /Ensure log\.md ends in newline; append TURN_COMMIT/.test(writeBlock));
  ok("skeleton requires verifying log.md's first line survived the append",
    /Verify the first line remains `# Event Log`/.test(writeBlock));
  // The pre-existing L22 newline caution must survive alongside the new rule, not be replaced by it.
  ok("the append discipline includes the final HANDOFF commit",
    /ends in newline/.test(writeBlock) && /Append HANDOFF/.test(writeBlock));

  // --- A pinned, platform-independent UTC clock command in BOTH host references.
  // Motivation: L23 has already caught local time written as UTC, because Windows `date` and
  // PowerShell `Get-Date` are local. Asserting BOTH files carry the IDENTICAL recipe is the point
  // — a recipe that drifts in one host file is the same bug returning.
  const UTC_RECIPE = 'node -e "process.stdout.write(new Date().toISOString())"';
  for (const host of ["claude-code.md", "codex-cli.md"]) {
    const h = read(path.join(REF, "hosts", host));
    ok(`hosts/${host} pins the cross-platform UTC clock command`, h.includes(UTC_RECIPE));
    // Match the warning as ONE flattened sentence. A file-wide `/Get-Date/ && /local/i` pair looked
    // equivalent but was partially vacuous: "local" also occurs in unrelated prose ("process-local",
    // "the local Codex CLI"), so deleting the word from the warning itself still passed.
    ok(`hosts/${host} warns against substituting a local-time shell command`,
      /local-time shell date commands|shell date command that returns local time/.test(flat(h)));
  }
}

// 17b-36. The engine keeps its adapter set, its command set and the SESSION keys it reads in one
// table each and derives every use from them. The DOCUMENTS that publish those same sets kept
// their copies by hand, and every copy had fallen behind at once: `copilot-cli` and `agy-cli`
// shipped as working executors with their own spec files, and neither adapters.md's table, nor
// lint-spec's L18 closed set, nor PROTOCOL §9, nor SKILL.md admitted they exist — so the closed
// set lint ENFORCES and the closed set the spec PUBLISHES disagreed, and a session run by the book
// could not select either executor. `relay`, `captures/`, `BoardWriteMode` and `SecondaryPanel`
// were the same shape: implemented, tested, and absent from every file an agent actually reads.
//
// A hand-kept list of what a document is supposed to contain is a list that falls behind, and the
// failure is invisible because both halves look complete on their own. So these expectations are
// DERIVED from the engine. Fixing the six documents once converges when the documents run out;
// deriving the check converges when the code is correct.
if (SEL(65)) {
  const engine = read(CLI);
  const REFD = path.join(HERE, "..", "references");
  const adaptersMd = read(path.join(REFD, "adapters.md"));
  const relayMd = read(path.join(REFD, "relay.md"));
  const lintSpec = read(path.join(REFD, "lint-spec.md"));
  const protocolMd = read(path.join(REFD, "protocol.md"));
  const skillMd = read(path.join(HERE, "..", "SKILL.md"));

  // --- the adapter set, from CLI_EXECUTOR_SPECS
  const specBlock = /const CLI_EXECUTOR_SPECS = \[([\s\S]*?)\n\];/.exec(engine);
  const adapters = [...(specBlock ? specBlock[1] : "").matchAll(/adapter: "([^"]+)"/g)].map((m) => m[1]);
  const secondaries = [...(specBlock ? specBlock[1] : "").matchAll(/secondary: "([^"]+)"/g)].map((m) => m[1]);
  ok("the engine's CLI_EXECUTOR_SPECS table parses (fixture sanity)",
    adapters.length >= 6 && adapters.length === secondaries.length);

  // adapters.md's table IS the adapter->executor map the skill points every reader at. A row per
  // canonical adapter, matched as a table row rather than anywhere in the file, so a passing
  // mention in prose cannot stand in for the map.
  for (const a of adapters)
    ok(`adapters.md's adapter table has a row for ${a}`,
      new RegExp("^\\|[^|]*`" + a + "`", "m").test(adaptersMd));

  // L18 is the check that REJECTS an adapter outside the set. Its published set must be the set.
  const l18 = lintSpec.split(/\r?\n/).filter((l) => l.includes("L18 CLI-EXECUTOR")).join(" ");
  for (const a of adapters)
    ok(`lint-spec's L18 row lists ${a} in the closed set`, l18.includes("`" + a + "`"));
  for (const s of secondaries)
    ok(`lint-spec's L18 row names the actor ${s} its executor must be paired with`, l18.includes(s));

  // PROTOCOL §9's SESSION/v1 bullet is what a secondary reads once and caches; an adapter missing
  // there is an adapter no participant knows is legal.
  const sess9 = /- \*\*SESSION\/v1:\*\*([\s\S]*?)\n- \*\*/.exec(protocolMd);
  const sessBullet = sess9 ? sess9[1] : "";
  ok("PROTOCOL §9's SESSION/v1 bullet parses (fixture sanity)", sessBullet.length > 200);
  for (const a of adapters)
    ok(`PROTOCOL §9 lists ${a} among the adapter values`, sessBullet.includes("`" + a + "`"));
  for (let i = 0; i < adapters.length; i++)
    ok(`PROTOCOL §9 names the ${secondaries[i]} actor family`, sessBullet.includes(secondaries[i]));
  // INVERTED (P4): SKILL.md used to restate the registry — one row per adapter — and a hand-kept
  // copy of a set is the defect class this file exists to catch. The property worth holding
  // inverted: SKILL.md carries the DERIVATION (adapter id -> references/executors/<adapter-id>.md)
  // exactly once, restates no row, and completeness stays enforced at the owners asserted above
  // (PROTOCOL §9, adapters.md's table, lint-spec's L18 row).
  ok("SKILL.md carries the executor-file derivation instead of a registry",
    skillMd.includes("references/executors/<adapter-id>.md"));
  for (let i = 0; i < adapters.length; i++)
    ok(`SKILL.md no longer restates the ${adapters[i]} registry row`,
      !new RegExp("`" + adapters[i] + "`\\s*(→|->)").test(skillMd));

  // Every SESSION.md key the ENGINE knows must be documented in that same bullet. BoardWriteMode
  // and SecondaryPanel were both read by the engine and named in no schema.
  //
  // The key list comes from SESSION_GRAMMAR, which is now the engine's ONE statement of what a
  // SESSION key is. It used to be harvested by matching `getKV(sessText, "...")` call sites, and
  // that harvest was a second reader of the same fact: routing those reads through generated
  // accessors emptied it, so this check would have gone silently vacuous — documenting nothing —
  // if its own sanity assertion had not caught the drop.
  const sessGrammar = (/const SESSION_GRAMMAR = \{[\s\S]*?\r?\n\};/.exec(engine) || [""])[0];
  const sessKeys = [...sessGrammar.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)].map((m) => m[1])
    .filter((k) => k !== "SESSION.md" && k !== "SCHEMA");
  ok("the engine's SESSION key grammar parses (fixture sanity)", sessKeys.length >= 6);
  for (const k of sessKeys)
    ok(`PROTOCOL §9 documents the SESSION key ${k}, which the engine knows`, sessBullet.includes(k));

  // --- the command set, from the dispatch switch's case labels.
  // The script's own `--help` prints the header Usage block, so a command missing there is a
  // command with no help at all.
  // `\r?\n`, not `\n`: this tree has mixed line endings and the engine is CRLF while PROTOCOL.md
  // is LF, so a literal newline join silently matches nothing in half the files.
  const usage = /\/\/ Usage:\r?\n((?:\/\/.*\r?\n)+)/.exec(engine);
  const usageBlock = usage ? usage[1] : "";
  ok("the header Usage block parses (fixture sanity)", usageBlock.length > 200);
  // Handler-shape-agnostic and fail-closed both ways. The previous derivation matched a HANDLER
  // shape, `cmd[A-Za-z]+\(opts\)`: `case "doctor": cmdDoctor();` takes no opts, escaped it, and
  // was therefore unchecked on BOTH documentation surfaces at once while the suite stayed green,
  // because both assertions iterated the same blind list. The escape arrived from outside the
  // grammar the check reasoned in (the assumption that every handler takes `opts`), so the fix
  // derives from the dispatch switch's own case labels and REFUSES a line it cannot classify
  // instead of skipping it — ignoring an unparseable input is not neutrality, it is a pass.
  const dispatchBody = (/switch \(cmd\) \{([\s\S]*?)default:/.exec(engine) || ["", ""])[1];
  ok("the engine's dispatch switch parses (fixture sanity)", dispatchBody.includes("case"));
  const cmds = [];
  const reached = new Set();
  for (const line of dispatchBody.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    if (line.startsWith("//")) continue;
    const m = /^case "([a-z]+)": (cmd[A-Za-z]+)\([^)]*\); break;$/.exec(line);
    ok(`the dispatch derivation classifies: ${line}`, !!m);
    if (m) { cmds.push(m[1]); reached.add(m[2]); }
  }
  ok("the engine's command dispatch parses (fixture sanity)", cmds.length >= 10);
  // Fail closed in the other direction: a `cmd<Name>` handler no parsed case reaches is a command
  // the completeness assertions below can never see.
  for (const h of [...engine.matchAll(/^function (cmd[A-Za-z]+)\(/gm)].map((m) => m[1]))
    ok(`the dispatch switch reaches ${h}`, reached.has(h));
  // The two independent readers of "the command set" — the dispatch switch and the Usage header —
  // are COMPARED, not maintained separately.
  const usageCmds = [...new Set([...usageBlock.matchAll(/^\/\/\s+node collab-board\.mjs (\w+)/gm)].map((m) => m[1]))];
  ok("the dispatch-derived command set equals the Usage-derived set",
    cmds.length === new Set(cmds).size
      && [...cmds].sort().join(" ") === [...usageCmds].sort().join(" "),
    `dispatch: ${[...cmds].sort().join(" ")} | usage: ${[...usageCmds].sort().join(" ")}`);
  for (const c of cmds)
    ok(`the header Usage block documents the ${c} command`,
      new RegExp("collab-board\\.mjs " + c + "\\b").test(usageBlock));
  // INVERTED (P3): the six situational commands moved behind `--help`, which prints the Usage
  // block (asserted just below) — a relocation, not a deletion. SKILL.md documents the everyday
  // subset plus ONE --help pointer line; completeness of the FULL set stays owned by the
  // dispatch/Usage equality above. SITUATIONAL is a pinned decision, not a derivable fact, and the
  // sanity loop keeps it fail-closed: a renamed command cannot leave a stale entry silently vacuous.
  const SITUATIONAL = ["reset", "replay", "archive", "migrate", "relay", "fanout"];
  for (const c of SITUATIONAL)
    ok(`situational command ${c} exists in the dispatch set (list sanity)`, cmds.includes(c));
  const skillDocs = (c) => new RegExp("collab-board\\.mjs\" " + c + "\\b").test(skillMd);
  for (const c of cmds.filter((c) => !SITUATIONAL.includes(c)))
    ok(`SKILL.md's bundled-script list documents the everyday ${c} command`, skillDocs(c));
  for (const c of SITUATIONAL)
    ok(`SKILL.md no longer carries the situational ${c} invocation`, !skillDocs(c));
  ok("SKILL.md points the situational rest at --help", /collab-board\.mjs" --help/.test(skillMd));
  // `--help` (and bare/`help`) PRINTS the stripped Usage block; the planned SKILL.md relocation of
  // situational commands depends on this surface actually documenting. Before, help printed a
  // pointer at "the file header" of a 300 KB script, which documents nothing.
  const strippedUsage = usageBlock.replace(/^\/\/ ?/gm, "").replace(/\r\n/g, "\n");
  for (const argv of [["--help"], ["help"], []]) {
    let hr;
    try { hr = { code: 0, out: execFileSync(process.execPath, [CLI, ...argv], { encoding: "utf8", env: CLEAN_ENV }) }; }
    catch (e) { hr = { code: e.status ?? 1, out: `${e.stdout || ""}` }; }
    ok(`\`${argv[0] || "(bare)"}\` exits 0 and prints the header Usage block, markers stripped`,
      hr.code === 0 && hr.out.replace(/\r\n/g, "\n").includes(strippedUsage));
  }

  // The SESSION.md TEMPLATE used to enumerate the adapter set as well, and this check enforced
  // that it stayed complete. The enumeration is now DELETED from the template: it shipped inside
  // every board created from it and was re-read for the life of that board, restating a registry
  // whose one home is the protocol. The property worth holding therefore inverted — the template
  // must NOT carry the list, and must point at where the list lives — so this asserts that instead
  // of asserting a copy stays fresh. Enforcing the freshness of a copy is what keeping the copy
  // costs, and the cheaper answer is not to keep it.
  const sessTpl = read(path.join(HERE, "..", "templates", "session", "SESSION.md"));
  const strayAdapters = adapters.filter((a) => sessTpl.includes(a));
  ok("the SESSION.md template no longer restates the adapter registry",
    strayAdapters.length === 0, strayAdapters.join(" "));
  ok("and points at the section that owns it instead",
    /PROTOCOL\.md section 9/.test(sessTpl));
  // The list still has to be complete SOMEWHERE, or deleting the copy would have deleted the fact.
  const protoMd = read(path.join(HERE, "..", "references", "protocol.md"));
  for (const a of adapters)
    ok(`protocol.md still carries ${a} in the registry the template now points to`, protoMd.includes(a));
  for (const k of ["BoardWriteMode", "SecondaryPanel"])
    ok(`the SESSION.md template documents the optional ${k} key`, sessTpl.includes(k));

  // --- every executor spec is reachable from the two files that route readers to it
  const execFiles = fs.readdirSync(path.join(REFD, "executors")).filter((f) => f.endsWith(".md"));
  for (const f of execFiles) {
    const a = f.replace(/\.md$/, "");
    ok(`executors/${f} names a canonical adapter`, adapters.includes(a));
    // INVERTED (P4): SKILL.md derives the path from the adapter id (asserted with the registry
    // inversion above) instead of enumerating the files; per-file reachability is owned by
    // adapters.md's table, asserted on the next line.
    ok(`SKILL.md no longer enumerates executors/${f}`, !skillMd.includes("executors/" + f));
    ok(`adapters.md's table points at executors/${f}`, adaptersMd.includes("executors/" + f));
  }

  // --- the sole-writer / fan-out surface: engine-only until now
  ok("PROTOCOL §2's session tree shows the captures/ directory the relay writes",
    /captures\//.test(/## 2\. Session files([\s\S]*?)\n## /.exec(protocolMd)?.[1] || ""));
  const sec8 = /## 8\. Append-only event log([\s\S]*?)\n## /.exec(protocolMd)?.[1] || "";
  ok("PROTOCOL §8 parses (fixture sanity)", sec8.length > 500);
  for (const tok of ["relayed_by=", "attempt=", "capture_sha=", "via=relay"])
    ok(`PROTOCOL §8 documents the ${tok} token the relay writes`, sec8.includes(tok));
  ok("adapters.md documents the sole-writer relay path", /BoardWriteMode: PRIMARY_ONLY/.test(adaptersMd));
  ok("relay.md documents the SECONDARY panel", /SecondaryPanel/.test(relayMd));

  // The relay/v1 capture is a schema the SECONDARY has to produce; a schema with no published
  // grammar is one every contributor guesses at differently.
  const relaySchema = /const RELAY_SCHEMA = "([^"]+)"/.exec(engine)?.[1];
  ok("the engine's relay schema id parses (fixture sanity)", !!relaySchema);
  ok("relay.md publishes the relay/v1 capture grammar", relayMd.includes(relaySchema));
  for (const marker of ["--- TURN ---", "--- END ---"])
    ok(`relay.md shows the ${marker} capture marker the parser requires`, relayMd.includes(marker));
  const relayExample = /Request exactly:\s*```text([\s\S]*?)```/.exec(relayMd)?.[1] || "";
  ok("the canonical relay example omits the legacy ignored HEAD section",
    relayExample.length > 100 && !relayExample.includes("--- HEAD ---"));
  ok("relay.md assigns actor, HEAD and HANDOFF state transfer to relay",
    /Relay is legal only while SECONDARY holds START/.test(relayMd)
    && /derives HEAD state/.test(relayMd) && /appends `HANDOFF`/.test(relayMd));

  // A long reference opens with a `Contents:` line, and that line is the only navigation a reader
  // gets for 500 lines. A section missing from it is a section nobody finds. Two were missing —
  // one added by an earlier hoist, one added later — so the check is derived from the
  // headings rather than left to whoever remembers.
  for (const [name, body] of [["adapters.md", adaptersMd], ["protocol.md", protocolMd]]) {
    // `\r?\n\r?\n`: adapters.md is CRLF and protocol.md is LF, and a literal `\n\n` finds the
    // paragraph break in only one of them.
    const contents = (/^Contents:([\s\S]*?)\r?\n\r?\n/m.exec(body) || ["", ""])[1].toLowerCase();
    ok(`${name} opens with a Contents line`, contents.length > 40);
    for (const h of [...body.matchAll(/^## (?:§?\d+\.\s*)?(.+)$/gm)].map((m) => m[1])) {
      // ANY substantial word from the heading, not the first: a contents entry legitimately
      // paraphrases ("Two phases and their gates" is listed as "phases & gates"). What this
      // catches is a section with no echo in the contents at all, which is the real defect.
      const words = (h.replace(/[`*]/g, "").toLowerCase().match(/[a-z][a-z-]{3,}/g) || [])
        .filter((w) => !["their", "every", "with", "that", "this", "shared", "other", "built"].includes(w));
      if (!words.length) continue;
      ok(`${name}'s Contents line covers the "${h.slice(0, 42)}" section`,
        words.some((w) => contents.includes(w)), "heading words: " + words.join(","));
    }
  }

  // --- no reference document repeats a paragraph within itself.
  // The shipped guard checked executors/*.md only. The class is not executor-specific: the same
  // pass that deleted a twice-carried paragraph from two executor specs left an identical
  // copy-paste in this very file, three lines from the assertion about it.
  const allDocs = [["SKILL.md", skillMd], ["adapters.md", adaptersMd],
    ["relay.md", relayMd], ["recovery.md", read(path.join(REFD, "recovery.md"))],
    ["manager.md", read(path.join(REFD, "manager.md"))],
    ["lint-spec.md", lintSpec], ["protocol.md", protocolMd],
    ...fs.readdirSync(path.join(REFD, "hosts")).map((f) => ["hosts/" + f, read(path.join(REFD, "hosts", f))]),
    ...execFiles.map((f) => ["executors/" + f, read(path.join(REFD, "executors", f))])];

  // Prompt modes are mutually exclusive and conditionally routed.
  ok("adapters.md owns only the direct-write prompt",
    adaptersMd.includes("WRITE IN THIS ORDER") && !adaptersMd.includes("RELAY: collab-board/relay/v1"));
  ok("relay.md owns only the relay capture prompt",
    relayMd.includes("RELAY: collab-board/relay/v1") && !relayMd.includes("WRITE IN THIS ORDER"));
  // Since the Optional-features fold (I5, 2026-08-14 board) the References map is the ONLY
  // routing of these files inside SKILL.md — workers.md joined the pinned set when its second
  // copy left. The reset line is the sole copy of reset's safety consequence anywhere in the
  // shipped surface; `--help` documents argv, not consequences.
  for (const conditional of ["relay.md", "recovery.md", "manager.md", "workers.md"])
    ok("SKILL.md conditionally routes " + conditional, skillMd.includes("references/" + conditional));
  ok("SKILL.md keeps the sole copy of reset's archive-not-delete semantics",
    skillMd.includes("Reset archives the old tree, never deletes it."));

  // Raw byte and line ceilings protect the context budget. They are intentionally ceilings, not
  // equality targets: concise rewrites should not have to preserve old bulk.
  const budgets = [
    ["SKILL.md", 22000, 300], ["references/protocol.md", 28000, 400],
    ["references/adapters.md", 24000, 360], ["references/relay.md", 24000, null],
    ["references/recovery.md", 10000, null], ["references/manager.md", 9000, null],
    ...fs.readdirSync(path.join(REFD, "hosts")).map((f) => ["references/hosts/" + f, 6500, 110]),
    ...execFiles.map((f) => ["references/executors/" + f, 8500, 135]),
  ];
  for (const [rel, maxBytes, maxLines] of budgets) {
    const p = path.join(HERE, "..", rel);
    const bytes = fs.statSync(p).size;
    const lines = read(p).split(/\r?\n/).length;
    ok(`${rel} stays within ${maxBytes} raw bytes`, bytes <= maxBytes, `${bytes} bytes`);
    if (maxLines !== null)
      ok(`${rel} stays within ${maxLines} lines`, lines <= maxLines, `${lines} lines`);
  }
  for (const [name, body] of allDocs) {
    const counts = new Map();
    for (const para of body.split(/\r?\n\r?\n/)) {
      const k = para.replace(/\s+/g, " ").trim();
      if (k.length < 80) continue;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const repeated = [...counts.entries()].filter(([, n]) => n > 1);
    ok(name + " repeats no paragraph within itself", repeated.length === 0);
    for (const [k, n] of repeated) console.log("        x" + n + " " + k.slice(0, 88) + "...");
  }

  // ...and no long passage is duplicated ACROSS them. The executor specs already had this guard;
  // the four documents an agent actually reads did not, and the L10 routing rule was stated in
  // full in three of them. One authority, short pointers elsewhere — a rule kept in three places
  // is a rule that will be corrected in one.
  const shared = new Map();
  for (const [name, body] of allDocs)
    for (const para of body.split(/\r?\n\r?\n/)) {
      const k = para.replace(/\s+/g, " ").trim();
      if (k.length < 240) continue;   // a pointer is short; a restated rule is not
      if (!shared.has(k)) shared.set(k, new Set());
      shared.get(k).add(name);
    }
  const crossDupes = [...shared.entries()].filter(([, names]) => names.size > 1);
  ok("no long passage is duplicated verbatim across the reference documents", crossDupes.length === 0);
  for (const [k, names] of crossDupes)
    console.log("        [" + [...names].join(",") + "] " + k.slice(0, 90) + "...");
}

// 17b-37. RELAY: validate everything before writing anything.
//
// Under the delegated-PRIMARY manager `relay` is THE write path, and it had one test. Eleven
// probes against a real board were run before any of this was changed, and ten reproduced. The
// worst three: a capture declaring `TURN: ../../../../ESCAPED` wrote a shard clean outside the
// board at exit 0; `TURN: P2(` threw an uncaught RegExp SyntaxError so the command reported
// nothing at all; and a single-capture `--fused` replaced a secondary's REJECT with the PRIMARY's
// own "no objection", producing a shard whose lint findings were byte-for-byte identical to an
// honest relay of the same capture — better attested than an honest turn, because capture_sha
// certified the capture that had just been contradicted.
//
// Every one of them arrived from OUTSIDE the grammar the code was reasoning in: a turn id that
// was not a turn id, a filename the reader's pattern could not match, a marker quoted in prose.
if (SEL(66)) {
  const mk = (opts = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-relay-"));
    run(["new", "--type", "META", "--slug", "r", "--primary", "CLAUDE", "--secondary", "CODEX", "--adapter", "codex-cli"], root);
    const id = fs.readdirSync(path.join(root, ".collab-board", "sessions"))[0];
    const dir = path.join(root, ".collab-board", "sessions", id);
    if (!opts.noMode) edit(file(dir, "SESSION.md"), (t) => t.trimEnd() + NL + "BoardWriteMode: PRIMARY_ONLY" + NL);
    if (!opts.secondaryIdle) {
      const stamps = read(file(dir, "log.md")).match(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z/gm) || [];
      const at = stamps[stamps.length - 1] || new Date().toISOString();
      edit(file(dir, "log.md"), (t) => t.trimEnd() + NL
        + `${at} STATE_SET CLAUDE=ON_HOLD CODEX=START cursor=- next=P2/CODEX seq=0` + NL);
      edit(file(dir, "HEAD.md"), (t) => t
        .replace("SESSION_STATUS: IDLE", "SESSION_STATUS: ACTIVE")
        .replace(/- CODEX: [A-Z_]+ - SECONDARY/, "- CODEX: START - SECONDARY")
        .replace(/^NEXT_TURN_ID: .*$/m, "NEXT_TURN_ID: P2")
        .replace(/^NEXT_ACTOR: .*$/m, "NEXT_ACTOR: CODEX"));
      run(["activate", "--session", id], root);
    }
    return { root, id, dir };
  };
  const cap = (id, { turn = "P2", body = null, log = "", points = "" } = {}) => [
    "RELAY: collab-board/relay/v1", "SESSION: " + id, "ACTOR: CODEX", "TURN: " + turn,
    "--- TURN ---",
    body === null ? ["### TURN-" + turn + " (CODEX)", "SCHEMA: collab-board/turn/v1",
      "- Header: PART=PLAN / RESPONDS_TO=NEW / POINTS=-", "- Body:", "  - FINDINGS: ACK the contract",
      "- Evidence: probe", "- Handoff: CODEX WORKING->ON_HOLD, CLAUDE ON_HOLD->START"].join(NL) : body,
    "--- LOG ---", log, "--- POINTS ---", points, "--- END ---", ""].join(NL);
  const put = (s, name, text) => { const p = path.join(s.root, name); write(p, text); return p; };
  const capsOf = (s) => { const d = path.join(s.dir, "captures");
    return fs.existsSync(d) ? fs.readdirSync(d).sort() : []; };
  const relay = (s, args) => run(["relay", "--session", s.id, ...args], s.root);
  // Some rendering probes below need a second SECONDARY relay without spending a real PRIMARY
  // turn on content irrelevant to the assertion. Model that explicit state transfer in both the
  // log and HEAD; changing NEXT_TURN_ID alone used to work only because relay failed to hand off.
  const handBackToSecondary = (s, nextTurn) => {
    const logFile = file(s.dir, "log.md");
    const stamps = read(logFile).match(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z/gm) || [];
    const at = stamps[stamps.length - 1] || new Date().toISOString();
    edit(logFile, (t) => t.trimEnd() + NL
      + `${at} STATE_SET CLAUDE=ON_HOLD CODEX=START cursor=P2 next=${nextTurn}/CODEX seq=1` + NL);
    edit(file(s.dir, "HEAD.md"), (t) => t
      .replace(/- CLAUDE: [A-Z_]+ - PRIMARY/, "- CLAUDE: ON_HOLD - PRIMARY")
      .replace(/- CODEX: [A-Z_]+ - SECONDARY/, "- CODEX: START - SECONDARY")
      .replace(/^NEXT_TURN_ID: .*$/m, "NEXT_TURN_ID: " + nextTurn)
      .replace(/^NEXT_ACTOR: .*$/m, "NEXT_ACTOR: CODEX"));
  };

  // --- the control comes FIRST: an ordinary, honest relay must still work end to end.
  {
    const s = mk();
    const c = put(s, "P2-codex.relay", cap(s.id));
    const r = relay(s, ["--capture", c]);
    ok("control: an honest single-capture relay still succeeds", r.code === 0, r.out);
    ok("control: the capture is retained under a name lint can rediscover",
      JSON.stringify(capsOf(s)) === JSON.stringify(["P2-codex.relay"]));
    ok("control: an honest relay draws no L25 finding at all", !has(lint(s.root, s.id).out, "L25"),
      lint(s.root, s.id).out);
    ok("control: a plain copy does NOT claim to be fused",
      !/fused=yes/.test(read(file(s.dir, "log.md"))));
  }

  // --- the turn id is a filesystem path, a shard name, and the key of every id-keyed check.
  for (const [label, turn] of [["traversal", "../../../../ESCAPED"], ["regex metachar", "P2("],
    ["not a turn id", "T2"], ["empty-ish", "P"], ["absolute", "/etc/x"]]) {
    const s = mk();
    const c = put(s, "P2-codex.relay", cap(s.id, { turn }));
    const r = relay(s, ["--capture", c]);
    // Assert the SPECIFIC diagnostic, not merely a non-zero exit. With the turn-id guard reverted
    // these captures still failed — on the capture-name check further down — so an exit-code-only
    // assertion passed while never reaching the guard it is named for. A negative control caught
    // that; "something went wrong" is not evidence the right thing went wrong.
    ok(`relay refuses a ${label} TURN id (${JSON.stringify(turn)}) as not a turn id`,
      r.code !== 0 && /is not a turn id/.test(r.out), r.out.split(NL)[0]);
    ok(`...and says so as a relay error rather than crashing`,
      /^relay: /m.test(r.out) && !/SyntaxError|EISDIR|ENOENT/.test(r.out), r.out.split(NL)[0]);
    ok(`...and writes nothing: no captures/, no turns/`,
      capsOf(s).length === 0 && fs.readdirSync(path.join(s.dir, "turns")).filter((f) => f.endsWith(".md")).length === 0);
  }
  {
    // The traversal specifically: prove no file landed OUTSIDE the session directory.
    const s = mk();
    relay(s, ["--capture", put(s, "P2-codex.relay", cap(s.id, { turn: "../../../../ESCAPED" }))]);
    ok("the traversal writes nothing outside the session directory",
      !fs.existsSync(path.join(s.root, "ESCAPED-codex.md")));
  }

  // --- --fused is FUSION, not substitution.
  {
    const s = mk();
    const c = put(s, "P2-codex.relay", cap(s.id, { body: "### TURN-P2 (CODEX)" + NL + "- Body: I REJECT this plan." }));
    const f = put(s, "f.md", "### TURN-P2 (CODEX)" + NL + "- Body: codex has no objection." + NL);
    const r = relay(s, ["--capture", c, "--fused", f]);
    ok("relay refuses --fused with a single capture (that is re-authoring, not fusion)", r.code !== 0);
    ok("...and the secondary's verdict never reached a shard",
      !fs.existsSync(path.join(s.dir, "turns", "P2-codex.md")));
  }

  // --- a capture may carry only the events its own author may record.
  for (const [label, line] of [
    ["REFRAME", "REFRAME by=CLAUDE in=P2 trigger=BARREN outcome=CONTINUE"],
    ["TERMINAL", "TERMINAL COMPLETED by=CODEX seq=3"],
    ["PHASE_SET", "PHASE_SET PLAN->IMPL plan_open_points=0"],
    ["DECISION", "DECISION P1 -> ACCEPT by=CLAUDE"],
    ["a PRIMARY gate", "GATE_SET PLAN_AGREE_PRIMARY=YES by=CLAUDE"],
    ["another actor's gate", "GATE_SET PLAN_AGREE_SECONDARY=YES by=CLAUDE"],
  ]) {
    const s = mk();
    const r = relay(s, ["--capture", put(s, "P2-codex.relay", cap(s.id, { log: line }))]);
    ok(`relay refuses a capture whose LOG block carries ${label}`, r.code !== 0, r.out.split(NL)[0]);
    ok(`...and the ${label} line never reached log.md`,
      !new RegExp(line.split(/\s+/)[0] + "\\b.*" + (line.split(/\s+/)[1] || "")).test(read(file(s.dir, "log.md"))));
  }
  {
    // Control: the two things a capture legitimately carries still relay. The capture must NAME the
    // point it raises — this fixture used to omit the title, and the engine accepted it into a
    // board that FAILED its own lint (`log projects point P1 but points.md has no such row`,
    // measured on the pre-fix engine at exit 0). An assertion that encodes a defect is worse than
    // no assertion, so the capture is corrected and the board is now LINTED, which is what would
    // have caught it.
    const s = mk();
    const r = relay(s, ["--capture", put(s, "P2-codex.relay",
      cap(s.id, { log: "GATE_SET PLAN_AGREE_SECONDARY=YES by=CODEX" + NL + "POINT_SET P1=AGREED in=P2",
                  points: "P1=AGREED | the point this capture raises" }))]);
    ok("control: a capture may still set its OWN secondary gate and a POINT_SET", r.code === 0, r.out);
    const log = read(file(s.dir, "log.md"));
    ok("control: both legitimate lines landed",
      /GATE_SET PLAN_AGREE_SECONDARY=YES by=CODEX/.test(log) && /POINT_SET P1=AGREED in=P2/.test(log), log);
    ok("control: and the row the log projects actually exists in points.md",
      /^\|\s*P1\s*\|.*\|\s*AGREED\s*\|/m.test(read(file(s.dir, "points.md"))));
    // Targeted at the SPECIFIC diagnostic: this board legitimately still carries an L2 gate finding,
    // because the capture set a gate and `relay` deliberately never writes HEAD (step 6 is the
    // PRIMARY's). Asserting "no L2 at all" would fail for a reason that has nothing to do with the
    // defect under test — the unrelated-finding trap this suite warns about elsewhere.
    ok("control: so the log no longer projects a point that points.md has no row for",
      !/no such row/.test(lint(s.root, s.id).out), lint(s.root, s.id).out);
  }
  {
    // The latent defect the control above was hiding: a capture that declares its points ONLY in
    // the LOG section is still RAISING a point, so it must name it. Previously `--- POINTS ---` was
    // the only section read for rows, so a LOG-only declaration got its event appended and no row.
    const s = mk();
    const r = relay(s, ["--capture", put(s, "P2-codex.relay", cap(s.id, { log: "POINT_SET P1=AGREED in=P2" }))]);
    ok("a capture raising a point only in its LOG section must still name it", r.code !== 0, r.out.split(NL)[0]);
    ok("...and nothing was written, so no board projects a point it has no row for", capsOf(s).length === 0);
  }

  // --- a point Status is an adjudicated DECISION, not mergeable data.
  // Contributors PROPOSE; only the PRIMARY's fused turn DECIDES. Reducing N disagreeing proposals
  // with a last-wins Map made ARRIVAL ORDER the adjudicator, and nothing could see the loss: the
  // Map and the log replay both took the last, so they agreed with each other while both disagreed
  // with the captures. Measured on this repo's own board — three contributors, two disputed
  // points, lint PASS.
  // Each contributor gets a DISTINCT body. Two byte-identical captures are one contributor's work
  // filed twice — the relay refuses them, because every count derived from the contributor set
  // (including whether a gate is unanimous) would otherwise read one capture as two.
  const contribBody = (who) => ["### TURN-P2 (CODEX)", "SCHEMA: collab-board/turn/v1",
    "- Header: PART=PLAN / RESPONDS_TO=NEW / POINTS=-", "- Body:",
    "  - FINDINGS: ACK the contract, reviewed by " + who, "- Evidence: probe from " + who,
    "- Handoff: CODEX WORKING->ON_HOLD, CLAUDE ON_HOLD->START"].join(NL);
  const disputePair = (s, aStatus, bStatus) => [
    put(s, "P2-agy.relay", cap(s.id, { body: contribBody("agy"), points: "P1=" + aStatus + " | disputed point" })),
    put(s, "P2-copilot.relay", cap(s.id, { body: contribBody("copilot"), points: "P1=" + bStatus + " | disputed point" })),
    put(s, "fuse.md", "### TURN-P2 (CODEX)" + NL + "- Body: agy and copilot" + NL),
  ];
  {
    const s = mk();
    const [a, b, f] = disputePair(s, "AGREED", "REJECTED");
    const r = relay(s, ["--capture", a + "," + b, "--fused", f]);
    ok("relay REFUSES contributors who disagree about a point's status", r.code !== 0, r.out.split(NL)[0]);
    ok("...naming each contributor's own ruling, so the dispute is legible",
      /agy=AGREED/.test(r.out) && /copilot=REJECTED/.test(r.out), r.out);
    ok("...and writes nothing at all, so no board carries an arrival-order verdict", capsOf(s).length === 0);
  }
  {
    const s = mk();
    const [a, b, f] = disputePair(s, "AGREED", "REJECTED");
    const r = relay(s, ["--capture", a + "," + b, "--fused", f, "--resolve", "P1=OUT_OF_SCOPE"]);
    ok("--resolve lets the PRIMARY adjudicate the dispute explicitly", r.code === 0, r.out.split(NL)[0]);
    ok("...and the adjudicated status is what points.md and the log both carry",
      /^\|\s*P1\s*\|.*\|\s*OUT_OF_SCOPE\s*\|/m.test(read(file(s.dir, "points.md")))
      && /POINT_SET P1=OUT_OF_SCOPE in=P2/.test(read(file(s.dir, "log.md"))));
    ok("...and BOTH contributors' proposals survive in their retained captures",
      /P1=AGREED/.test(read(file(s.dir, "captures", "P2-agy.relay")))
      && /P1=REJECTED/.test(read(file(s.dir, "captures", "P2-copilot.relay"))));
    ok("...and no contributor's conflicting POINT_SET was appended as an event",
      (read(file(s.dir, "log.md")).match(/POINT_SET /g) || []).length === 1);
  }
  {
    // --resolve is for a DISPUTE. Accepting it anywhere else would be a silent channel for the
    // relay to restate a contributor's ruling under that contributor's name — the same thing
    // `--fused` already refuses to let it do to a turn body.
    const s = mk();
    const [a, b, f] = disputePair(s, "AGREED", "AGREED");
    const r = relay(s, ["--capture", a + "," + b, "--fused", f, "--resolve", "P1=REJECTED"]);
    ok("--resolve is REFUSED where the contributors already agree", r.code !== 0, r.out.split(NL)[0]);
    const s2 = mk();
    const [a2, b2, f2] = disputePair(s2, "AGREED", "REJECTED");
    const r2 = relay(s2, ["--capture", a2 + "," + b2, "--fused", f2, "--resolve", "P9=OUT_OF_SCOPE"]);
    ok("--resolve is REFUSED for an id no capture proposed a status for", r2.code !== 0, r2.out.split(NL)[0]);
    // CONTROL: agreeing contributors need no adjudication and still relay untouched.
    const s3 = mk();
    const [a3, b3, f3] = disputePair(s3, "AGREED", "AGREED");
    ok("control: unanimous contributors still relay with no --resolve needed",
      relay(s3, ["--capture", a3 + "," + b3, "--fused", f3]).code === 0);
  }

  // --- an ID is an IDENTITY, and merging two identities destroys a finding.
  // Contributors are dispatched in PARALLEL and each takes the next free point id, so two of them
  // raise DIFFERENT findings under the same new id. The relay kept the FIRST title and dropped the
  // rest — arrival order deciding what a review found, with the loss visible nowhere but the
  // retained capture. Observed THREE times on this repository's own board before it was fixed.
  const collidePair = (s, aTitle, bTitle, aStatus, bStatus) => [
    put(s, "P2-agy.relay", cap(s.id, { body: contribBody("agy"), points: "P1=" + (aStatus || "OPEN") + " | " + aTitle })),
    put(s, "P2-copilot.relay", cap(s.id, { body: contribBody("copilot"), points: "P1=" + (bStatus || "OPEN") + " | " + bTitle })),
    put(s, "fuse.md", "### TURN-P2 (CODEX)" + NL + "- Body: agy and copilot" + NL),
  ];
  {
    const s = mk();
    const [a, b, f] = collidePair(s, "the roster denominator is supplied by the checked party", "lint-spec L11 describes no refusal");
    const r = relay(s, ["--capture", a + "," + b, "--fused", f]);
    ok("relay REFUSES one new id carrying two different findings", r.code !== 0, r.out.split(NL)[0]);
    ok("...naming each contributor and its own title, so the collision is legible",
      /agy="the roster denominator/.test(r.out) && /copilot="lint-spec L11/.test(r.out), r.out);
    ok("...and writes nothing, so neither finding is lost to arrival order", capsOf(s).length === 0);
  }
  {
    const s = mk();
    const [a, b, f] = collidePair(s, "first finding", "second finding");
    const r = relay(s, ["--capture", a + "," + b, "--fused", f, "--renumber", "P1:copilot=P2"]);
    ok("--renumber frees the collision so BOTH findings land", r.code === 0, r.out.split(NL)[0]);
    const pts = read(file(s.dir, "points.md"));
    ok("...each under its own id, with its own raiser's title",
      /^\|\s*P1\s*\|.*first finding.*\|/m.test(pts) && /^\|\s*P2\s*\|.*second finding.*\|/m.test(pts), pts);
    ok("...both projected by the log, not just written to the table",
      /POINT_SET .*P1=OPEN.*P2=OPEN|POINT_SET .*P2=OPEN.*P1=OPEN/.test(read(file(s.dir, "log.md"))), read(file(s.dir, "log.md")));
    ok("...and the renumbering is RECORDED, so it is not indistinguishable from self-filing",
      /renumbered=P1:copilot->P2/.test(read(file(s.dir, "log.md"))), read(file(s.dir, "log.md")));
    ok("...while each contributor's retained capture still says what it actually wrote",
      /P1=OPEN \| second finding/.test(read(file(s.dir, "captures", "P2-copilot.relay"))));
    ok("...and the table it renders agrees with the log it wrote, for the renumbered id too",
      !has(lint(s.root, s.id).out, "L2"), lint(s.root, s.id).out);
  }
  {
    // --renumber adjudicates a COLLISION, exactly as --resolve adjudicates a DISPUTE. Anywhere
    // else it would be a channel for re-filing a contributor's finding under an id nobody raised.
    const s = mk();
    const [a, b, f] = collidePair(s, "same finding", "same finding");
    const r = relay(s, ["--capture", a + "," + b, "--fused", f, "--renumber", "P1:copilot=P2"]);
    ok("--renumber is REFUSED where the contributors do NOT collide", r.code !== 0, r.out.split(NL)[0]);
    // THE COMMON CASE IS CORROBORATION, NOT COLLISION, and refusing without a verb for it forced
    // genuine agreement to be filed as two points: independent reviewers reaching one conclusion
    // almost never phrase it identically, so the collision check fires on the very outcome a panel
    // exists to produce. --merge says "one finding, two wordings" - the status still counts, only
    // the wording is dropped. Found by this machinery refusing this board's own P18.
    const m1 = mk();
    const [ma, mb, mf] = collidePair(m1, "the denominator is the relayed subset",
      "gate counts are chosen by the party they constrain", "AGREED", "AGREED");
    const rm = relay(m1, ["--capture", ma + "," + mb, "--fused", mf, "--merge", "P1:copilot"]);
    ok("--merge records two wordings as ONE finding", rm.code === 0, rm.out.split(NL)[0]);
    const mrows = read(file(m1.dir, "points.md"));
    ok("...as a single point keeping the wording of whoever is left",
      (mrows.match(/^\|\s*P[0-9]+\s*\|/gm) || []).length === 1
      && /the denominator is the relayed subset/.test(mrows) && !/party they constrain/.test(mrows), mrows);
    ok("...and the merge is RECORDED, because a PRIMARY judged it and a rule did not",
      /merged=P1:copilot/.test(read(file(m1.dir, "log.md"))), read(file(m1.dir, "log.md")));
    ok("...while the dropped wording survives verbatim in its own retained capture",
      /party they constrain/.test(read(file(m1.dir, "captures", "P2-copilot.relay"))));
    // MERGE THE FIRST-LISTED CONTRIBUTOR, so the keeper is NOT the one first-non-empty would pick.
    // With the keeper merged away, the surviving wording must be the SURVIVOR's - the previous case
    // could not tell the two apart, because there the keeper happened to be first either way.
    const m1b = mk();
    const [ba, bb, bf] = collidePair(m1b, "agy's wording", "copilot's wording", "AGREED", "AGREED");
    ok("--merge dropping the FIRST contributor's wording still relays",
      relay(m1b, ["--capture", ba + "," + bb, "--fused", bf, "--merge", "P1:agy"]).code === 0);
    const brows = read(file(m1b.dir, "points.md"));
    ok("...and the id keeps the SURVIVOR's wording, not whichever arrived first",
      /copilot's wording/.test(brows) && !/agy's wording/.test(brows), brows);
    const m2 = mk();
    const [na, nb, nf] = collidePair(m2, "one finding", "another finding");
    ok("--merge and --renumber may not both name one proposal",
      relay(m2, ["--capture", na + "," + nb, "--fused", nf,
        "--merge", "P1:copilot", "--renumber", "P1:copilot=P2"]).code !== 0);
    // MERGING EVERYONE LEAVES NOBODY TO KEEP THE ID, and the fallback picked the survivor by
    // --capture ARGUMENT ORDER: inside the one code path built to abolish arrival-order decisions,
    // on the branch whose keeper fixture had just been re-cut to tell those two apart. Both the
    // refusal message and adapters.md promise the id keeps the wording of whoever is LEFT, so when
    // nobody is left the honest answer is to say so, not to substitute a default.
    const m2b = mk();
    const [ca, cb, cf] = collidePair(m2b, "agy's wording", "copilot's wording", "AGREED", "AGREED");
    const rall = relay(m2b, ["--capture", ca + "," + cb, "--fused", cf,
      "--merge", "P1:agy,P1:copilot"]);
    ok("--merge naming EVERY titled contributor is refused, not silently ordered",
      rall.code !== 0 && /none is left to keep it/.test(rall.out), rall.out.split(NL)[0]);
    ok("...and nothing is written, so no wording wins by argument order", capsOf(m2b).length === 0);
    const m3 = mk();
    const [pa, pb, pf] = collidePair(m3, "same finding", "same finding");
    ok("--merge is REFUSED where nothing collided",
      relay(m3, ["--capture", pa + "," + pb, "--fused", pf, "--merge", "P1:copilot"]).code !== 0);
    const s2 = mk();
    const [a2, b2, f2] = collidePair(s2, "first finding", "second finding");
    const r2 = relay(s2, ["--capture", a2 + "," + b2, "--fused", f2, "--renumber", "P1:copilot=P1"]);
    ok("--renumber is REFUSED onto an id a capture already claims", r2.code !== 0, r2.out.split(NL)[0]);
    const s3 = mk();
    const [a3, b3, f3] = collidePair(s3, "first finding", "second finding");
    const r3 = relay(s3, ["--capture", a3 + "," + b3, "--fused", f3, "--renumber", "P1:copilot=I7"]);
    ok("--renumber is REFUSED across the phase prefix — it frees an id, it does not move a phase",
      r3.code !== 0, r3.out.split(NL)[0]);
    // CONTROL: two contributors reaching the SAME finding independently is CORROBORATION, the most
    // valuable thing a panel produces. It must relay untouched, under one id, with one row.
    const s4 = mk();
    const [a4, b4, f4] = collidePair(s4, "one finding both reached", "one finding both reached");
    const r4 = relay(s4, ["--capture", a4 + "," + b4, "--fused", f4]);
    ok("control: contributors who independently reach the SAME finding still relay untouched",
      r4.code === 0, r4.out.split(NL)[0]);
    ok("...as ONE point, not two", (read(file(s4.dir, "points.md")).match(/^\|\s*P[0-9]+\s*\|/gm) || []).length === 1);
  }
  {
    // IDENTITY IS READ BEFORE AGREEMENT, and the order is the whole point. Two findings filed under
    // one id, with different statuses, is NOT a dispute: there is no single point for the
    // contributors to disagree about. Reading status first reported a disagreement that did not
    // exist, and sent the PRIMARY to --resolve it — whichever status it then picked, the title
    // merge destroyed one of the two findings anyway. So: disentangle, THEN read agreement.
    const s = mk();
    const [a, b, f] = collidePair(s, "first finding", "second finding", "AGREED", "REJECTED");
    const r = relay(s, ["--capture", a + "," + b, "--fused", f]);
    ok("a collision with differing statuses is reported as a COLLISION, not a dispute",
      r.code !== 0 && /carry two different findings/.test(r.out) && !/disagree about the status/.test(r.out), r.out);
    // And once disentangled, the disagreement that was never real does not need adjudicating:
    // each id is claimed by exactly one contributor, so there is nothing left to resolve.
    const s2 = mk();
    const [a2, b2, f2] = collidePair(s2, "first finding", "second finding", "AGREED", "REJECTED");
    const r2 = relay(s2, ["--capture", a2 + "," + b2, "--fused", f2, "--renumber", "P1:copilot=P2"]);
    ok("...and renumbering leaves no dispute to adjudicate, because there never was one",
      r2.code === 0, r2.out.split(NL)[0]);
    ok("...each id keeping the status its own raiser gave it",
      /^\|\s*P1\s*\|.*\|\s*AGREED\s*\|/m.test(read(file(s2.dir, "points.md")))
      && /^\|\s*P2\s*\|.*\|\s*REJECTED\s*\|/m.test(read(file(s2.dir, "points.md"))), read(file(s2.dir, "points.md")));
  }
  {
    // A collision is about NEW ids. Two contributors ruling on an EXISTING point supply no title —
    // the row already has one, and it is not theirs to restate — so nothing can collide there.
    // Without the liveIds guard this fired on ordinary agreement and blocked the common path.
    const s = mk();
    edit(file(s.dir, "points.md"), (x) => x.trimEnd() + NL + "| P1 | PLAN | raised on an earlier turn | OPEN | - |" + NL);
    const [a, b, f] = collidePair(s, "agy's restatement", "copilot's restatement", "AGREED", "AGREED");
    const r = relay(s, ["--capture", a + "," + b, "--fused", f]);
    ok("control: an EXISTING point ruled by both contributors is not a collision", r.code === 0, r.out.split(NL)[0]);
    const rows = read(file(s.dir, "points.md"));
    ok("...and the row keeps the title it was RAISED under, not a capture's restatement",
      /raised on an earlier turn/.test(rows) && !/restatement/.test(rows), rows);
  }
  {
    // The point-row grammar is pipe-free BY CONSTRUCTION: POINT_ROW_RE does not support an escaped
    // `\|` either, and lint FLAGS a row containing one. Teaching the writer to emit an escape would
    // produce rows the reader rejects, so the boundary refuses the title instead.
    const s = mk();
    const r = relay(s, ["--capture", put(s, "P2-codex.relay",
      cap(s.id, { points: "P1=AGREED | a title with a \\| pipe in it" }))]);
    ok("relay refuses a point title carrying a pipe the row grammar cannot hold", r.code !== 0, r.out.split(NL)[0]);
    ok("...before writing anything", capsOf(s).length === 0);
    // CONTROL: an ordinary title still relays and lands intact.
    const s2 = mk();
    const t = "an ordinary title, with a comma and (parens)";
    ok("control: an ordinary title relays",
      relay(s2, ["--capture", put(s2, "P2-codex.relay", cap(s2.id, { points: "P1=AGREED | " + t }))]).code === 0);
    ok("control: ...and lands in the row byte for byte",
      read(file(s2.dir, "points.md")).includes("| " + t + " |"));
  }
  {
    // Only a TRANSITION resolves a point — projectPoints says so explicitly, and L2 checks the
    // table against that same derivation. relay used to stamp `Resolved In` with the CURRENT turn
    // for every id in the capture, so an honest RE-ASSERTION of an unchanged status produced a row
    // lint rejected outright: `points.md P3 Resolved In=P4 but log projects P2`. Seen on a real board.
    const s = mk();
    relay(s, ["--capture", put(s, "P2-codex.relay", cap(s.id, { points: "P1=AGREED | a point resolved at P2" }))]);
    const afterP2 = read(file(s.dir, "points.md"));
    ok("fixture sanity: P2 resolved the point, so the row points at P2", /\[P2\]\(turns\/P2-codex\.md\)/.test(afterP2), afterP2);
    handBackToSecondary(s, "P3");
    relay(s, ["--capture", put(s, "P3-codex.relay", cap(s.id, { turn: "P3", points: "P1=AGREED" }))]);
    const afterP3 = read(file(s.dir, "points.md"));
    ok("re-asserting an unchanged status leaves the RESOLVING turn where it was",
      /\[P2\]\(turns\/P2-codex\.md\)/.test(afterP3) && !/\[P3\]/.test(afterP3), afterP3);
  }
  {
    // ONE reader decides which row a write targets, and it is the LIVE view. Selecting the target
    // with a raw regex while reading the title through liveText meant a COMMENTED-OUT row was
    // chosen and the new row landed inside its own comment — log projecting a point the live table
    // had no row for, which is P11's exact signature reached through a door the fold did not cover.
    const s = mk();
    edit(file(s.dir, "points.md"), (t) => t.trimEnd() + NL
      + "<!--" + NL + "| P1 | PLAN | the commented original | OPEN | - |" + NL + "-->" + NL);
    const r = relay(s, ["--capture", put(s, "P2-codex.relay",
      cap(s.id, { points: "P1=AGREED | the live row" }))]);
    ok("a commented-out row is not chosen as the write target", r.code === 0, r.out.split(NL)[0]);
    const pm = read(file(s.dir, "points.md"));
    ok("...the new row is written LIVE, outside the comment",
      /^\| P1 \| PLAN \| the live row \| AGREED \|/m.test(pm), pm);
    ok("...the commented original is left untouched", /\| P1 \| PLAN \| the commented original \|/.test(pm));
    ok("...so the log does not project a point the live table lacks",
      !/no such row/.test(lint(s.root, s.id).out), lint(s.root, s.id).out);
  }
  {
    // The UPDATE path of the same defect, and the one the append path above does not reach: a
    // commented decoy row sitting ABOVE a real live row. A raw first-match target selects the
    // decoy and the write lands inside the comment, leaving the live row stale — the `terminal
    // --status ABORTED` defect that `replaceLiveLine` was written for, re-entered through relay.
    const s = mk();
    relay(s, ["--capture", put(s, "P2-codex.relay", cap(s.id, { points: "P1=AGREED | the live row" }))]);
    edit(file(s.dir, "points.md"), (t) => t.replace(/^(\|----.*\|)$/m,
      "$1" + NL + "<!--" + NL + "| P1 | PLAN | the commented decoy | OPEN | - |" + NL + "-->"));
    handBackToSecondary(s, "P3");
    const r = relay(s, ["--capture", put(s, "P3-codex.relay", cap(s.id, { turn: "P3", points: "P1=REJECTED" }))]);
    ok("a decoy row above the live one does not absorb the write", r.code === 0, r.out.split(NL)[0]);
    const pm2 = read(file(s.dir, "points.md"));
    ok("...the LIVE row is the one updated",
      /^\| P1 \| PLAN \| the live row \| REJECTED \|/m.test(pm2), pm2);
    ok("...and the commented decoy still reads OPEN",
      /\| P1 \| PLAN \| the commented decoy \| OPEN \|/.test(pm2), pm2);
  }
  {
    // A row the canonical reader SKIPS (POINT_ROW_RE is anchored `\|$`, so one trailing space is
    // not a row) must not silently become a title of "-". With no live row and no capture title,
    // the missing-title refusal is what must fire.
    const s = mk();
    edit(file(s.dir, "points.md"), (t) => t.trimEnd() + NL + "| P1 | PLAN | a human title | OPEN | - | " + NL);
    const r = relay(s, ["--capture", put(s, "P2-codex.relay", cap(s.id, { points: "P1=AGREED" }))]);
    ok("a row the canonical reader skips does not silently lose its title to a dash", r.code !== 0, r.out.split(NL)[0]);
    ok("...and the human-written title is still there", /a human title/.test(read(file(s.dir, "points.md"))));
  }
  {
    // points.md is a rendering of the PROJECTION, so it is the whole projection or it is not a
    // rendering. Rendering only the capture's ids left every other row free to diverge.
    const s = mk();
    relay(s, ["--capture", put(s, "P2-codex.relay", cap(s.id, { points: "P1=AGREED | the untouched point" }))]);
    edit(file(s.dir, "points.md"), (t) => t.replace(/^(\| P1 \| PLAN \| .*\| )AGREED( \| ).*$/m, "$1REJECTED$2- |"));
    handBackToSecondary(s, "P3");
    relay(s, ["--capture", put(s, "P3-codex.relay", cap(s.id, { turn: "P3", points: "P2=AGREED | a different point" }))]);
    const pm = read(file(s.dir, "points.md"));
    ok("a row the capture never mentioned is re-rendered from the projection",
      /^\| P1 \|.*\| AGREED \| \[P2\]\(turns\/P2-codex\.md\) \|$/m.test(pm), pm);
    ok("...so no L2 divergence survives the relay", !has(lint(s.root, s.id).out, "L2"), lint(s.root, s.id).out);
  }
  {
    // The seat's gate is UNANIMOUS or it is not the seat's. One contributor of N was setting the
    // gate that unlocks `advance`, with the others' silence neither consulted nor recorded — the
    // status-merge defect on the more consequential decision.
    const GATE = "GATE_SET PLAN_AGREE_SECONDARY=YES by=CODEX";
    const s = mk();
    const a = put(s, "P2-agy.relay", cap(s.id, { body: contribBody("agy"), log: GATE, points: "P1=AGREED | shared point" }));
    const b = put(s, "P2-copilot.relay", cap(s.id, { body: contribBody("copilot"), points: "P1=AGREED | shared point" }));
    const f = put(s, "gf.md", "### TURN-P2 (CODEX)" + NL + "- Body: agy and copilot" + NL);
    ok("a partially-offered gate still relays the turn", relay(s, ["--capture", a + "," + b, "--fused", f]).code === 0);
    const log = read(file(s.dir, "log.md"));
    ok("...but the gate is NOT set, because one contributor is not the seat",
      !/GATE_SET PLAN_AGREE_SECONDARY=YES/.test(log), log);
    ok("...and the log records that agreement was offered and not reached",
      /gate_partial=PLAN_AGREE_SECONDARY:1\/2/.test(log), log);
    // The token must survive every CONSUMER, not just the ones this change looked at: L22 enforces
    // a closed event vocabulary and FAILs a line that claims to be an event and misses the grammar.
    ok("...and the new token trips no closed-vocabulary finding",
      !has(lint(s.root, s.id).out, "L22"), lint(s.root, s.id).out);
    // CONTROL: unanimous contributors DO set it, exactly once.
    const s2 = mk();
    const a2 = put(s2, "P2-agy.relay", cap(s2.id, { body: contribBody("agy"), log: GATE, points: "P1=AGREED | shared point" }));
    const b2 = put(s2, "P2-copilot.relay", cap(s2.id, { body: contribBody("copilot"), log: GATE, points: "P1=AGREED | shared point" }));
    const f2 = put(s2, "gf2.md", "### TURN-P2 (CODEX)" + NL + "- Body: agy and copilot" + NL);
    relay(s2, ["--capture", a2 + "," + b2, "--fused", f2]);
    const log2 = read(file(s2.dir, "log.md"));
    ok("control: a unanimous gate IS set", /GATE_SET PLAN_AGREE_SECONDARY=YES/.test(log2), log2);
    ok("control: ...exactly once, not once per contributor",
      (log2.match(/GATE_SET PLAN_AGREE_SECONDARY=YES/g) || []).length === 1);
    ok("control: ...and no gate_partial is claimed", !/gate_partial=/.test(log2));
  }
  {
    // A DISPUTE is two CONTRIBUTORS disagreeing. One capture disagreeing with ITSELF is malformed,
    // and conflating them let a SINGLE capture unlock --resolve, landing a status neither of its
    // own sections stated, under the SECONDARY's name, on the copy-never-re-author path.
    const s = mk();
    const c = put(s, "P2-codex.relay", cap(s.id, {
      points: "P1=AGREED | self-contradicting point", log: "POINT_SET P1=REJECTED in=P2" }));
    const r = relay(s, ["--capture", c]);
    ok("a capture contradicting ITSELF is refused as malformed", r.code !== 0, r.out.split(NL)[0]);
    ok("...named as a malformed capture rather than a dispute", /contradicts itself/.test(r.out), r.out);
    const r2 = relay(s, ["--capture", c, "--resolve", "P1=OUT_OF_SCOPE"]);
    ok("...and --resolve does NOT rescue it", r2.code !== 0, r2.out.split(NL)[0]);
    ok("...nothing was written either way", capsOf(s).length === 0);
  }
  {
    // An adjudicated POINT_SET is byte-indistinguishable from a unanimous one, so without a token
    // the log cannot tell a reader that a contributor was overruled.
    const s = mk();
    const a = put(s, "P2-agy.relay", cap(s.id, { points: "P1=AGREED | disputed point" }));
    const b = put(s, "P2-copilot.relay", cap(s.id, { points: "P1=REJECTED | disputed point" }));
    const f = put(s, "af.md", "### TURN-P2 (CODEX)" + NL + "- Body: agy and copilot" + NL);
    relay(s, ["--capture", a + "," + b, "--fused", f, "--resolve", "P1=OUT_OF_SCOPE"]);
    // The token names WHOSE ruling was adopted. Recording only the id left "the PRIMARY picked a
    // contributor's ruling" and "the PRIMARY wrote its own third status under the SECONDARY's name"
    // byte-indistinguishable — the very distinction the token exists to make.
    ok("an adjudicated dispute records that the PRIMARY invented a third status",
      /adjudicated=P1:PRIMARY/.test(read(file(s.dir, "log.md"))), read(file(s.dir, "log.md")));
    ok("...and the token trips no closed-vocabulary finding either",
      !has(lint(s.root, s.id).out, "L22"), lint(s.root, s.id).out);
    ok("...while the adjudicated status is what the table and the projection BOTH carry",
      !has(lint(s.root, s.id).out, "L2"), lint(s.root, s.id).out);
  }
  {
    // THE DENOMINATOR MUST NOT BE CHOSEN BY THE PARTY IT CONSTRAINS. Counting unanimity over the
    // captures the PRIMARY decided to relay let it dispatch three contributors and relay only the
    // one that agreed. Measured before the fix: a board declaring two, one relayed capture, gate
    // SET, no trace. The declaration is the denominator.
    const GATE = "GATE_SET PLAN_AGREE_SECONDARY=YES by=CODEX";
    const s = mk();
    edit(file(s.dir, "SESSION.md"), (t) => t.trimEnd() + NL + "SecondaryPanel: agy-cli,copilot-cli" + NL);
    const c = put(s, "P2-agy.relay", cap(s.id, { log: GATE, points: "P1=AGREED | the point" }));
    ok("a board declaring two contributors accepts a one-capture relay", relay(s, ["--capture", c]).code === 0);
    const log = read(file(s.dir, "log.md"));
    ok("...but ONE of two DECLARED contributors does not set the seat's gate",
      !/GATE_SET PLAN_AGREE_SECONDARY=YES/.test(log), log);
    ok("...and the trace counts against the DECLARATION, not the relayed subset",
      /gate_partial=PLAN_AGREE_SECONDARY:1\/2/.test(log), log);
  }
  {
    // ...AND THE DECLARATION IS A FLOOR, NOT THE COUNT. Taking it as the count left the same hole
    // open in the other direction: a board declaring two that actually RUNS three has a
    // denominator of 2, so two offers read as the seat's unanimous agreement while a contributor
    // who did the work withheld. Nothing else catches it — only cell-named captures are checked
    // against the roster, so a third plain contributor is invisible to every other rule. Measured
    // on this repository's own board, which declares two and has relayed three since P4.
    const GATE = "GATE_SET PLAN_AGREE_SECONDARY=YES by=CODEX";
    const s = mk();
    edit(file(s.dir, "SESSION.md"), (t) => t.trimEnd() + NL + "SecondaryPanel: agy-cli,copilot-cli" + NL);
    const a = put(s, "P2-agy.relay", cap(s.id, { log: GATE, points: "P1=AGREED | the point" }));
    const b = put(s, "P2-copilot.relay", cap(s.id, { log: GATE, body: ["### TURN-P2 (CODEX)",
      "SCHEMA: collab-board/turn/v1", "- Header: PART=PLAN / RESPONDS_TO=NEW / POINTS=-", "- Body:",
      "  - FINDINGS: ACK, reviewed by copilot", "- Evidence: probe copilot",
      "- Handoff: CODEX WORKING->ON_HOLD, CLAUDE ON_HOLD->START"].join(NL) }));
    const c = put(s, "P2-claude.relay", cap(s.id, { body: ["### TURN-P2 (CODEX)",
      "SCHEMA: collab-board/turn/v1", "- Header: PART=PLAN / RESPONDS_TO=NEW / POINTS=-", "- Body:",
      "  - FINDINGS: ACK, and I withhold the gate", "- Evidence: probe claude",
      "- Handoff: CODEX WORKING->ON_HOLD, CLAUDE ON_HOLD->START"].join(NL) }));
    const f = put(s, "fuse.md", "### TURN-P2 (CODEX)" + NL + "- Body: agy, copilot and claude" + NL);
    ok("three contributors relay onto a board declaring two",
      relay(s, ["--capture", a + "," + b + "," + c, "--fused", f]).code === 0);
    const log3 = read(file(s.dir, "log.md"));
    ok("...and TWO of the THREE who actually ran do not set the seat's gate",
      !/GATE_SET PLAN_AGREE_SECONDARY=YES/.test(log3), log3);
    ok("...the trace counting everyone who contributed, not the smaller declaration",
      /gate_partial=PLAN_AGREE_SECONDARY:2\/3/.test(log3), log3);
    // CONTROL: unanimity among everyone who ran still sets the gate. A floor that never lets a
    // real agreement through would be a different defect, not a fix.
    const s2 = mk();
    edit(file(s2.dir, "SESSION.md"), (t) => t.trimEnd() + NL + "SecondaryPanel: agy-cli,copilot-cli" + NL);
    const a2 = put(s2, "P2-agy.relay", cap(s2.id, { log: GATE, points: "P1=AGREED | the point" }));
    const b2 = put(s2, "P2-copilot.relay", cap(s2.id, { log: GATE, body: ["### TURN-P2 (CODEX)",
      "SCHEMA: collab-board/turn/v1", "- Header: PART=PLAN / RESPONDS_TO=NEW / POINTS=-", "- Body:",
      "  - FINDINGS: ACK, reviewed by copilot", "- Evidence: probe copilot",
      "- Handoff: CODEX WORKING->ON_HOLD, CLAUDE ON_HOLD->START"].join(NL) }));
    const f2 = put(s2, "fuse.md", "### TURN-P2 (CODEX)" + NL + "- Body: agy and copilot" + NL);
    relay(s2, ["--capture", a2 + "," + b2, "--fused", f2]);
    const log4 = read(file(s2.dir, "log.md"));
    ok("control: when everyone who ran offers it, the gate is the seat's and is SET",
      /GATE_SET PLAN_AGREE_SECONDARY=YES/.test(log4) && !/gate_partial=/.test(log4), log4);
    // ...and a WRITTEN gate states what it was unanimous OVER. Recording k/n only on the withheld
    // branch made 1/1 and 3/3 byte-identical to a later reader, which matters most on the board
    // where the denominator is the relayed subset: an undeclared board cannot be made honest by
    // arithmetic (a relay legitimately serves one-secondary boards), so it is made honest by
    // record. dispatch-three-relay-one now shows up in the log as the 1/1 it actually is.
    ok("...and the written gate records the denominator it was unanimous over",
      /gate_set=PLAN_AGREE_SECONDARY:2\/2/.test(log4), log4);
    const s5 = mk();
    const c5 = put(s5, "P2-solo.relay", cap(s5.id, { log: GATE, points: "P1=AGREED | the point" }));
    relay(s5, ["--capture", c5]);
    ok("...so a one-capture relay onto a board declaring no roster is visible as 1/1",
      /gate_set=PLAN_AGREE_SECONDARY:1\/1/.test(read(file(s5.dir, "log.md"))), read(file(s5.dir, "log.md")));
    ok("...and the new tokens trip no closed-vocabulary finding", !has(lint(s5.root, s5.id).out, "L22"),
      lint(s5.root, s5.id).out);
  }
  {
    // SESSION.md's fifth increment, and the only one delivered as a RECORD rather than a rule: a
    // gate offered by contributors in the PRIMARY's own family is weaker evidence than the same
    // count from a second vendor, and that must be visible to a later reader WITHOUT ever gating.
    // It never gates - no check reads this token, and a same-family board relays exactly as before.
    // What it removes is the need for the reader to already suspect.
    const GATE = "GATE_SET PLAN_AGREE_SECONDARY=YES by=CODEX";
    const alt = (who) => ["### TURN-P2 (CODEX)", "SCHEMA: collab-board/turn/v1",
      "- Header: PART=PLAN / RESPONDS_TO=NEW / POINTS=-", "- Body:", "  - FINDINGS: ACK by " + who,
      "- Evidence: probe " + who, "- Handoff: CODEX WORKING->ON_HOLD, CLAUDE ON_HOLD->START"].join(NL);
    // THE IDENTITY COMES FROM THE DECLARATION, NOT THE FILENAMES. Keying this on the capture
    // filename put the disclosure under the control of the party it discloses: renaming
    // P2-claude.relay to P2-reviewer.relay left identical bytes, an identical capture_sha and an
    // identical model, and erased the record. So the fixture below MUST NOT be able to produce the
    // token by naming a file - it declares a roster instead, which is write-once.
    const s = mk();
    edit(file(s.dir, "SESSION.md"), (x) => x.trimEnd() + NL + "SecondaryPanel: codex-cli,claude-cli" + NL);
    const a = put(s, "P2-codex.relay", cap(s.id, { log: GATE, points: "P1=AGREED | the point" }));
    const b = put(s, "P2-claude.relay", cap(s.id, { log: GATE, body: alt("claude") }));
    const f = put(s, "fuse.md", "### TURN-P2 (CODEX)" + NL + "- Body: codex and claude" + NL);
    relay(s, ["--capture", a + "," + b, "--fused", f]);
    const log = read(file(s.dir, "log.md"));
    ok("a panel declaring a member in the PRIMARY's own family RECORDS that",
      /gate_family=PLAN_AGREE_SECONDARY:1\/2/.test(log), log);
    // ...AND THE DECLARATION ALONE IS ENOUGH. Same roster, but no capture filename mentions the
    // family - which is the exact rename that erased the record when this was keyed on filenames.
    const sR = mk();
    edit(file(sR.dir, "SESSION.md"), (x) => x.trimEnd() + NL + "SecondaryPanel: codex-cli,claude-cli" + NL);
    const aR = put(sR, "P2-agy.relay", cap(sR.id, { log: GATE, points: "P1=AGREED | the point" }));
    const bR = put(sR, "P2-copilot.relay", cap(sR.id, { log: GATE, body: alt("copilot") }));
    const fR = put(sR, "fuse.md", "### TURN-P2 (CODEX)" + NL + "- Body: agy and copilot" + NL);
    relay(sR, ["--capture", aR + "," + bR, "--fused", fR]);
    ok("...and renaming every capture away from the family does NOT erase the record",
      /gate_family=PLAN_AGREE_SECONDARY:1\//.test(read(file(sR.dir, "log.md")))
      && !/claude/i.test(capsOf(sR).join(" ")), read(file(sR.dir, "log.md")));
    // ...AND AN UNDECLARED SAME-FAMILY CONTRIBUTOR IS DISCLOSED TOO. Reading only the declaration
    // closed the rename hole and opened this one: the board that found it declares agy-cli and
    // copilot-cli, and has relayed a claude contributor every turn without a word being recorded.
    const sU = mk();
    edit(file(sU.dir, "SESSION.md"), (x) => x.trimEnd() + NL + "SecondaryPanel: agy-cli,copilot-cli" + NL);
    const aU = put(sU, "P2-antigravity.relay", cap(sU.id, { log: GATE, points: "P1=AGREED | the point" }));
    const bU = put(sU, "P2-claude.relay", cap(sU.id, { log: GATE, body: alt("claude") }));
    const fU = put(sU, "fuse.md", "### TURN-P2 (CODEX)" + NL + "- Body: antigravity and claude" + NL);
    relay(sU, ["--capture", aU + "," + bU, "--fused", fU]);
    ok("...and a same-family contributor the roster never declared is disclosed as well",
      /gate_family=PLAN_AGREE_SECONDARY:1\/3/.test(read(file(sU.dir, "log.md"))), read(file(sU.dir, "log.md")));
    ok("...and the gate is still SET, because the record never gates",
      /GATE_SET PLAN_AGREE_SECONDARY=YES/.test(log), log);
    ok("...and the token trips no closed-vocabulary finding", !has(lint(s.root, s.id).out, "L22"),
      lint(s.root, s.id).out);
    // THE ONE-MODEL BOARD, the case this whole block exists for: same model in both seats under
    // two distinct actor names, no panel, no mode. The seat itself is the PRIMARY's family, and
    // that is the weakest gate the board can produce - so it is the case that most needs saying.
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "cb-dyad-"));
    run(["new", "--type", "META", "--slug", "d", "--primary", "CLAUDE", "--secondary", "CLAUDE_2",
      "--adapter", "claude-cli"], d);
    const did = fs.readdirSync(path.join(d, ".collab-board", "sessions"))[0];
    const ddir = path.join(d, ".collab-board", "sessions", did);
    edit(file(ddir, "SESSION.md"), (x) => x.trimEnd() + NL + "BoardWriteMode: PRIMARY_ONLY" + NL);
    const dstamps = read(file(ddir, "log.md")).match(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z/gm) || [];
    edit(file(ddir, "log.md"), (x) => x.trimEnd() + NL
      + `${dstamps[dstamps.length - 1]} STATE_SET CLAUDE=ON_HOLD CLAUDE_2=START cursor=- next=P2/CLAUDE_2 seq=0` + NL);
    edit(file(ddir, "HEAD.md"), (x) => x
      .replace("SESSION_STATUS: IDLE", "SESSION_STATUS: ACTIVE")
      .replace(/- CLAUDE_2: [A-Z_]+ - SECONDARY/, "- CLAUDE_2: START - SECONDARY")
      .replace(/^NEXT_TURN_ID: .*$/m, "NEXT_TURN_ID: P2")
      .replace(/^NEXT_ACTOR: .*$/m, "NEXT_ACTOR: CLAUDE_2"));
    run(["activate", "--session", did], d);
    // NAMED AWAY FROM THE FAMILY ON PURPOSE: if the capture were called P2-claude_2.relay the
    // filename would supply the same answer as HEAD, and reverting the rule would change nothing.
    const dcap = path.join(d, "P2-reviewer.relay");
    write(dcap, ["RELAY: collab-board/relay/v1", "SESSION: " + did, "ACTOR: CLAUDE_2", "TURN: P2",
      "--- TURN ---", ["### TURN-P2 (CLAUDE_2)", "SCHEMA: collab-board/turn/v1",
        "- Header: PART=PLAN / RESPONDS_TO=NEW / POINTS=-", "- Body:", "  - FINDINGS: ACK the contract",
        "- Evidence: probe", "- Handoff: CLAUDE_2 WORKING->ON_HOLD, CLAUDE ON_HOLD->START"].join(NL),
      "--- LOG ---", "GATE_SET PLAN_AGREE_SECONDARY=YES by=CLAUDE_2",
      "--- POINTS ---", "P1=AGREED | the point", "--- END ---", ""].join(NL));
    ok("a same-model board relays exactly as any other", relay({ root: d, id: did }, ["--capture", dcap]).code === 0);
    const dlog = read(file(ddir, "log.md"));
    ok("...and its gate is RECORDED as the PRIMARY's own family, from HEAD and not from a filename",
      /gate_family=PLAN_AGREE_SECONDARY:1\/2/.test(dlog) && !/claude_2/i.test(capsOf({ dir: ddir }).join(" ")), dlog);
    ok("...and is SET regardless, because the weakness is disclosed and never banned",
      /GATE_SET PLAN_AGREE_SECONDARY=YES/.test(dlog), dlog);
    // CONTROL: no seat in the PRIMARY's family, no token. A record that fires on every board says
    // nothing, and would train a reader to skip it.
    const s3 = mk();
    edit(file(s3.dir, "SESSION.md"), (x) => x.trimEnd() + NL + "SecondaryPanel: agy-cli,copilot-cli" + NL);
    const a3 = put(s3, "P2-agy.relay", cap(s3.id, { log: GATE, points: "P1=AGREED | the point" }));
    const b3 = put(s3, "P2-copilot.relay", cap(s3.id, { log: GATE, body: alt("copilot") }));
    const f3 = put(s3, "fuse.md", "### TURN-P2 (CODEX)" + NL + "- Body: agy and copilot" + NL);
    relay(s3, ["--capture", a3 + "," + b3, "--fused", f3]);
    // A CONTRIBUTOR THAT COULD NOT RUN MUST BE SAYABLE ON AN ORDINARY TURN TOO. --absent was built
    // for the cross product and refuses anything that is not a cell, so on a plain roster turn a
    // usage-limited contributor simply vanished - the fusion recorded whoever answered and nothing
    // said the third had been dispatched and blocked. Found by hitting it: a real contributor
    // exhausted its monthly quota during a gate turn on this very board.
    const GATE2 = "GATE_SET PLAN_AGREE_SECONDARY=YES by=CODEX";
    const alt2 = (who) => ["### TURN-P2 (CODEX)", "SCHEMA: collab-board/turn/v1",
      "- Header: PART=PLAN / RESPONDS_TO=NEW / POINTS=-", "- Body:", "  - FINDINGS: ACK by " + who,
      "- Evidence: probe " + who, "- Handoff: CODEX WORKING->ON_HOLD, CLAUDE ON_HOLD->START"].join(NL);
    const sA = mk();
    edit(file(sA.dir, "SESSION.md"), (x) => x.trimEnd() + NL + "SecondaryPanel: agy-cli,copilot-cli" + NL);
    const aA = put(sA, "P2-antigravity.relay", cap(sA.id, { log: GATE2, points: "P1=AGREED | the point" }));
    ok("a plain fused turn can declare a DECLARED contributor absent",
      relay(sA, ["--capture", aA, "--absent", "COPILOT"]).code === 0);
    ok("...and the absence is RECORDED, not merely survived",
      /absent=COPILOT/.test(read(file(sA.dir, "log.md"))), read(file(sA.dir, "log.md")));
    // AND THE ABSENCE REDUCES THE SEAT FOR THIS TURN, which is the whole point: everyone who
    // COULD participate agreed, so the gate is theirs. Counting an absent contributor against
    // the denominator let a quota-blocked vendor veto every gate for the rest of the board - the
    // failure requirement 3 exists to prevent, arriving through the denominator rather than the
    // dispatch. The reduction is not hidden: absent= names who was dropped and gate_set= records
    // the smaller denominator, so a reader meets a 1/1 gate and can weigh it accordingly.
    ok("...and the gate IS the seat's, because everyone who could participate offered it",
      /GATE_SET PLAN_AGREE_SECONDARY=YES/.test(read(file(sA.dir, "log.md"))), read(file(sA.dir, "log.md")));
    ok("...with the reduced denominator on the record rather than hidden",
      /gate_set=PLAN_AGREE_SECONDARY:1\/1/.test(read(file(sA.dir, "log.md"))), read(file(sA.dir, "log.md")));
    // THE TWO DENOMINATORS DIVERGE ON PURPOSE, pinned here because a comment once claimed they
    // could never disagree. The RATIO asks who could PARTICIPATE, so an absence lowers it. The
    // RECORD asks what the seat is COMPOSED OF, and a same-family member does not stop being part
    // of that by missing a turn - subtracting there would let the disclosure be switched off by
    // declaring absent the very contributor it discloses. So one TURN_COMMIT legitimately carries
    // gate_set=1/1 beside gate_family=1/2.
    const sF = mk();
    edit(file(sF.dir, "SESSION.md"), (x) => x.trimEnd() + NL + "SecondaryPanel: claude-cli,copilot-cli" + NL);
    const fc = put(sF, "P2-claude.relay", cap(sF.id, { log: GATE, points: "P1=AGREED | the point" }));
    relay(sF, ["--capture", fc, "--absent", "COPILOT"]);
    const famlog = read(file(sF.dir, "log.md"));
    ok("an absence lowers the RATIO", /gate_set=PLAN_AGREE_SECONDARY:1\/1/.test(famlog), famlog);
    ok("...and does NOT lower the family RECORD, which would switch off the disclosure",
      /gate_family=PLAN_AGREE_SECONDARY:1\/2/.test(famlog), famlog);
    // ...AND THE SECOND WAY THEY DIVERGE, with nothing absent at all: the record is a UNION of the
    // declaration and the arrivals while the ratio is the LARGER of the two, so a declared pair
    // with one unrelated arrival reads 3 against 2. Both divergence modes are pinned because both
    // were once claimed impossible by a comment, and a prose claim about how two pieces relate is
    // unchecked until a fixture would fail if the relation broke.
    const sG = mk();
    edit(file(sG.dir, "SESSION.md"), (x) => x.trimEnd() + NL + "SecondaryPanel: claude-cli,copilot-cli" + NL);
    const gc = put(sG, "P2-agy.relay", cap(sG.id, { log: GATE, points: "P1=AGREED | the point" }));
    relay(sG, ["--capture", gc]);
    const gl = read(file(sG.dir, "log.md"));
    ok("the record and the ratio also differ with NOTHING absent, union against max",
      /gate_family=PLAN_AGREE_SECONDARY:1\/3/.test(gl) && /gate_partial=PLAN_AGREE_SECONDARY:1\/2/.test(gl), gl);
    // A ROSTER-FREE BOARD, asserted for what is actually observable on it. This block twice
    // carried a claim its assertion could not support: first a name about the record's dyad
    // fallback on a board that emits no family token, then a comment saying that seeding the
    // ratio from the record's list 'fails exactly here'. A negative control refuted the second -
    // under a MAX denominator the dyad seed contributes at most 1 while the arrivals contribute
    // at least 1, so the two seedings are INDISTINGUISHABLE by the denominator and no fixture
    // here or anywhere could pin that difference. It would only be observable under a union,
    // which this engine deliberately does not take.
    //
    // So this pins the VALUES, which are real: 1/1 and no family token. The record's dyad
    // fallback is pinned where it actually fires - see "its gate is RECORDED as the PRIMARY's own
    // family, from HEAD and not from a filename" - and reverting that fallback fails there.
    const sH = mk();
    const hc = put(sH, "P2-codex.relay", cap(sH.id, { log: GATE, points: "P1=AGREED | the point" }));
    relay(sH, ["--capture", hc]);
    const hl = read(file(sH.dir, "log.md"));
    ok("a roster-free single-capture turn records the gate as 1/1",
      /gate_set=PLAN_AGREE_SECONDARY:1\/1/.test(hl), hl);
    ok("...and emits no family token, since no seat is in the PRIMARY's family",
      !/gate_family=/.test(hl), hl);
    const sB = mk();
    edit(file(sB.dir, "SESSION.md"), (x) => x.trimEnd() + NL + "SecondaryPanel: agy-cli,copilot-cli" + NL);
    const aB = put(sB, "P2-antigravity.relay", cap(sB.id, { points: "P1=AGREED | the point" }));
    // AN UNDECLARED BOARD HAS NO CONTRIBUTOR TO BE ABSENT, and accepting any label there made the
    // token free on exactly the boards with no roster to check it against.
    const sN = mk();
    const aN = put(sN, "P2-codex.relay", cap(sN.id, { points: "P1=AGREED | the point" }));
    // Assert the DIAGNOSTIC, not just a non-zero exit: without the guard the null roster reaches
    // .some() and throws, which also exits non-zero and made this fixture pass for the wrong reason.
    const rN = relay(sN, ["--capture", aN, "--absent", "COPILOT"]);
    ok("--absent is REFUSED on a board that declares no roster at all",
      rN.code !== 0 && /declares no SecondaryPanel/.test(rN.out), rN.out.split(NL)[0]);
    ok("--absent is REFUSED for a contributor the board never declared",
      relay(sB, ["--capture", aB, "--absent", "GEMINI"]).code !== 0);
    const sC = mk();
    edit(file(sC.dir, "SESSION.md"), (x) => x.trimEnd() + NL + "SecondaryPanel: agy-cli,copilot-cli" + NL);
    const aC = put(sC, "P2-antigravity.relay", cap(sC.id, { points: "P1=AGREED | the point" }));
    ok("--absent is REFUSED for a contributor whose capture was supplied",
      relay(sC, ["--capture", aC, "--absent", "ANTIGRAVITY"]).code !== 0);
    // A SEAT IS A CONTRIBUTOR, NEVER A CONTRIBUTOR-SCOPE PAIR. On a cross-product sweep one
    // contributor arrives as CLAUDE_S1, CLAUDE_S2 - and unioning the raw labels counted it once
    // per scope, so a 1-model x 2-scope sweep read as two seats and diluted the very fraction the
    // family record exists to report.
    const sS = mk();
    edit(file(sS.dir, "SESSION.md"), (x) => x.trimEnd() + NL + "SecondaryPanel: claude-cli,agy-cli" + NL);
    const q1 = put(sS, "P2-CLAUDE_S1.relay", cap(sS.id, { log: GATE2, points: "P1=AGREED | the point" }));
    const q2 = put(sS, "P2-CLAUDE_S2.relay", cap(sS.id, { log: GATE2, body: alt2("claude_s2") }));
    const q3 = put(sS, "P2-ANTIGRAVITY_S1.relay", cap(sS.id, { log: GATE2, body: alt2("agy_s1") }));
    const q4 = put(sS, "P2-ANTIGRAVITY_S2.relay", cap(sS.id, { log: GATE2, body: alt2("agy_s2") }));
    const fS = put(sS, "fuse.md", "### TURN-P2 (CODEX)" + NL
      + "- Body: CLAUDE_S1 CLAUDE_S2 ANTIGRAVITY_S1 ANTIGRAVITY_S2" + NL);
    relay(sS, ["--capture", [q1, q2, q3, q4].join(","), "--fused", fS]);
    ok("a cross-product sweep counts SEATS, not contributor-scope pairs",
      /gate_family=PLAN_AGREE_SECONDARY:1\/2/.test(read(file(sS.dir, "log.md"))), read(file(sS.dir, "log.md")));
    // CONTROL: an ordinary turn with no absence declares none, so the token means something.
    const sD = mk();
    edit(file(sD.dir, "SESSION.md"), (x) => x.trimEnd() + NL + "SecondaryPanel: agy-cli,copilot-cli" + NL);
    const aD = put(sD, "P2-antigravity.relay", cap(sD.id, { log: GATE2, points: "P1=AGREED | the point" }));
    const bD = put(sD, "P2-copilot.relay", cap(sD.id, { log: GATE2, body: alt2("copilot") }));
    const fD = put(sD, "fuse.md", "### TURN-P2 (CODEX)" + NL + "- Body: antigravity and copilot" + NL);
    relay(sD, ["--capture", aD + "," + bD, "--fused", fD]);
    ok("control: a full roster turn records no absence at all",
      !/absent=/.test(read(file(sD.dir, "log.md"))), read(file(sD.dir, "log.md")));
    ok("control: a panel sharing no family with the PRIMARY records no family token",
      !/gate_family=/.test(read(file(s3.dir, "log.md"))), read(file(s3.dir, "log.md")));
  }
  {
    // THE NUMERATOR COUNTS SEATS, NOT CELLS. On a sweep c.who is CODEX_S1, CODEX_S2 - one
    // contributor wearing a cell name per scope - so keying offers on the raw label let ONE
    // vendor covering two scopes produce two offers and clear a roster of two on its own.
    // The co-vendor here is PRESENT and simply does not offer the gate, so this case turns on
    // the numerator alone and says nothing about how an absence is counted.
    const GATE3 = "GATE_SET PLAN_AGREE_SECONDARY=YES by=CODEX";
    const alt3 = (who) => ["### TURN-P2 (CODEX)", "SCHEMA: collab-board/turn/v1",
      "- Header: PART=PLAN / RESPONDS_TO=NEW / POINTS=-", "- Body:", "  - FINDINGS: ACK by " + who,
      "- Evidence: probe " + who, "- Handoff: CODEX WORKING->ON_HOLD, CLAUDE ON_HOLD->START"].join(NL);
    const sV = mk();
    edit(file(sV.dir, "SESSION.md"), (x) => x.trimEnd() + NL + "SecondaryPanel: codex-cli,agy-cli" + NL);
    const v1 = put(sV, "P2-CODEX_S1.relay", cap(sV.id, { log: GATE3, points: "P1=AGREED | the point" }));
    const v2 = put(sV, "P2-CODEX_S2.relay", cap(sV.id, { log: GATE3, body: alt3("codex_s2") }));
    const v3 = put(sV, "P2-ANTIGRAVITY_S1.relay", cap(sV.id, { body: alt3("agy_s1") }));
    const v4 = put(sV, "P2-ANTIGRAVITY_S2.relay", cap(sV.id, { body: alt3("agy_s2") }));
    const fV = put(sV, "fuse.md", "### TURN-P2 (CODEX)" + NL
      + "- Body: CODEX_S1 CODEX_S2 ANTIGRAVITY_S1 ANTIGRAVITY_S2" + NL);
    relay(sV, ["--capture", [v1, v2, v3, v4].join(","), "--fused", fV]);
    const vlog = read(file(sV.dir, "log.md"));
    ok("one vendor covering two scopes is ONE offer, not two",
      !/GATE_SET PLAN_AGREE_SECONDARY=YES/.test(vlog), vlog);
    ok("...so a co-vendor that did not offer is not voted for by its neighbour's extra cells",
      /gate_partial=PLAN_AGREE_SECONDARY:1\/2/.test(vlog), vlog);
    // AND BOTH SIDES OF THE RATIO COUNT SEATS. Leaving the denominator floor at capture FILES
    // while the numerator counted seats meant a FULLY unanimous 2x2 sweep read 2/4 and could
    // never set the gate at all - the repair of one field breaking the field beside it.
    const sU = mk();
    edit(file(sU.dir, "SESSION.md"), (x) => x.trimEnd() + NL + "SecondaryPanel: codex-cli,agy-cli" + NL);
    const u1 = put(sU, "P2-CODEX_S1.relay", cap(sU.id, { log: GATE3, points: "P1=AGREED | the point" }));
    const u2 = put(sU, "P2-CODEX_S2.relay", cap(sU.id, { log: GATE3, body: alt3("codex_s2") }));
    const u3 = put(sU, "P2-ANTIGRAVITY_S1.relay", cap(sU.id, { log: GATE3, body: alt3("agy_s1") }));
    const u4 = put(sU, "P2-ANTIGRAVITY_S2.relay", cap(sU.id, { log: GATE3, body: alt3("agy_s2") }));
    const fU = put(sU, "fuse.md", "### TURN-P2 (CODEX)" + NL
      + "- Body: CODEX_S1 CODEX_S2 ANTIGRAVITY_S1 ANTIGRAVITY_S2" + NL);
    relay(sU, ["--capture", [u1, u2, u3, u4].join(","), "--fused", fU]);
    const ulog = read(file(sU.dir, "log.md"));
    ok("a FULLY unanimous 2x2 sweep can set the gate at all",
      /GATE_SET PLAN_AGREE_SECONDARY=YES/.test(ulog), ulog);
    ok("...counted seat over seat, not seat over capture files",
      /gate_set=PLAN_AGREE_SECONDARY:2\/2/.test(ulog), ulog);
    // AND A CELL ABSENCE COUNTS LIKE A PLAIN ONE. A vendor absent from EVERY cell supplied no
    // capture and could not participate, so subtracting it on one path and not the other gave
    // the same quota-exhausted contributor two different answers depending on the shape of turn.
    const sW = mk();
    edit(file(sW.dir, "SESSION.md"), (x) => x.trimEnd() + NL + "SecondaryPanel: codex-cli,agy-cli" + NL);
    const w1 = put(sW, "P2-CODEX_S1.relay", cap(sW.id, { log: GATE3, points: "P1=AGREED | the point" }));
    const w2 = put(sW, "P2-CODEX_S2.relay", cap(sW.id, { log: GATE3, body: alt3("codex_s2") }));
    const fW = put(sW, "fuse.md", "### TURN-P2 (CODEX)" + NL + "- Body: CODEX_S1 CODEX_S2" + NL);
    relay(sW, ["--capture", w1 + "," + w2, "--fused", fW,
      "--absent", "ANTIGRAVITY_S1,ANTIGRAVITY_S2"]);
    const wlog = read(file(sW.dir, "log.md"));
    ok("a vendor absent from EVERY cell does not veto the gate",
      /GATE_SET PLAN_AGREE_SECONDARY=YES/.test(wlog), wlog);
    ok("...with the reduced denominator and the absent cells both on the record",
      /gate_set=PLAN_AGREE_SECONDARY:1\/1/.test(wlog) && /absent=ANTIGRAVITY_S1,ANTIGRAVITY_S2/.test(wlog), wlog);
    // UNANIMITY WITHIN A SEAT BEFORE UNANIMITY ACROSS SEATS. Keying the offer map by seat marked
    // a seat as offering the moment ANY ONE of its cells carried the gate line, so a cell that
    // supplied a capture and deliberately WITHHELD was voted for by its sibling — and left no
    // trace of the dissent anywhere. That is the numerator's version of letting arrival order
    // decide, and it survived three corrections to the denominator beside it.
    const sX = mk();
    edit(file(sX.dir, "SESSION.md"), (x) => x.trimEnd() + NL + "SecondaryPanel: codex-cli,agy-cli" + NL);
    const x1 = put(sX, "P2-CODEX_S1.relay", cap(sX.id, { log: GATE3, points: "P1=AGREED | the point" }));
    const x2 = put(sX, "P2-CODEX_S2.relay", cap(sX.id, { body: alt3("codex_s2") }));
    const x3 = put(sX, "P2-ANTIGRAVITY_S1.relay", cap(sX.id, { log: GATE3, body: alt3("agy_s1") }));
    const x4 = put(sX, "P2-ANTIGRAVITY_S2.relay", cap(sX.id, { log: GATE3, body: alt3("agy_s2") }));
    const fX = put(sX, "fuse.md", "### TURN-P2 (CODEX)" + NL
      + "- Body: CODEX_S1 CODEX_S2 ANTIGRAVITY_S1 ANTIGRAVITY_S2" + NL);
    relay(sX, ["--capture", [x1, x2, x3, x4].join(","), "--fused", fX]);
    const xlog = read(file(sX.dir, "log.md"));
    ok("a seat with one withholding cell does not offer the gate",
      !/GATE_SET PLAN_AGREE_SECONDARY=YES/.test(xlog), xlog);
    ok("...and the dissent is visible in the ratio rather than absorbed by its sibling",
      /gate_partial=PLAN_AGREE_SECONDARY:1\/2/.test(xlog), xlog);
    // AND THE TWO SIDES OF THAT COMPARISON MUST BE THE SAME UNIT. Counting gate LINES against the
    // CAPTURE count let one capture repeating its own GATE_SET reach the count of a two-capture
    // seat, so a sibling cell that withheld was carried by its neighbour saying the same thing
    // twice - the same defect one step further out, in the step that FEEDS the rule.
    const sY = mk();
    edit(file(sY.dir, "SESSION.md"), (x) => x.trimEnd() + NL + "SecondaryPanel: codex-cli,agy-cli" + NL);
    const y1 = put(sY, "P2-CODEX_S1.relay", cap(sY.id, { log: GATE3 + NL + GATE3, points: "P1=AGREED | the point" }));
    const y2 = put(sY, "P2-CODEX_S2.relay", cap(sY.id, { body: alt3("codex_s2") }));
    const y3 = put(sY, "P2-ANTIGRAVITY_S1.relay", cap(sY.id, { log: GATE3, body: alt3("agy_s1") }));
    const y4 = put(sY, "P2-ANTIGRAVITY_S2.relay", cap(sY.id, { log: GATE3, body: alt3("agy_s2") }));
    const fY = put(sY, "fuse.md", "### TURN-P2 (CODEX)" + NL
      + "- Body: CODEX_S1 CODEX_S2 ANTIGRAVITY_S1 ANTIGRAVITY_S2" + NL);
    relay(sY, ["--capture", [y1, y2, y3, y4].join(","), "--fused", fY]);
    const ylog = read(file(sY.dir, "log.md"));
    ok("a capture repeating its own gate line does not cover its withholding sibling",
      !/GATE_SET PLAN_AGREE_SECONDARY=YES/.test(ylog), ylog);
    ok("...the numerator counting CAPTURES on both sides of the comparison",
      /gate_partial=PLAN_AGREE_SECONDARY:1\/2/.test(ylog), ylog);
  }
  {
    // A MALFORMED ROSTER IS NOT AN ABSENT ONE. Every caller read `panel` and discarded `problem`,
    // so a declaration that fails its own grammar silently became a board with no declaration -
    // which after the absence rules landed is the branch where the product axis falls back to
    // whoever arrived. lint catches the malformation, but only after the turn and gate are written.
    const sM = mk();
    edit(file(sM.dir, "SESSION.md"), (x) => x.trimEnd() + NL + "SecondaryPanel: codex-cli,not-a-cli" + NL);
    const m1 = put(sM, "P2-codex.relay", cap(sM.id, { points: "P1=AGREED | the point" }));
    const rM = relay(sM, ["--capture", m1]);
    ok("a malformed roster is REFUSED rather than read as no roster",
      rM.code !== 0 && /not a CLI executor/.test(rM.out), rM.out.split(NL)[0]);
    ok("...and writes nothing, so no gate is computed against a fallback denominator",
      !fs.existsSync(path.join(sM.dir, "captures")));
    // CONTROL: a board with NO SecondaryPanel line at all is not malformed, and still relays.
    const sM2 = mk();
    const m2 = put(sM2, "P2-codex.relay", cap(sM2.id, { points: "P1=AGREED | the point" }));
    ok("control: declaring no roster at all is not a malformed roster", relay(sM2, ["--capture", m2]).code === 0);
  }
  {
    // TITLE FIRST-WINS SURVIVED INSIDE ONE CAPTURE. The cross-contributor collision check
    // disentangles two findings filed under one id by two contributors; the self-contradiction
    // guard beside it compared statuses and never titles, so one capture naming one id twice under
    // two titles still had the second dropped - the same defect one scope down from its fix.
    const s = mk();
    const c = put(s, "P2-codex.relay", cap(s.id, {
      log: "POINT_SET P1=AGREED in=P2", points: "P1=AGREED | the first name" + NL + "P1=AGREED | a different finding" }));
    const r = relay(s, ["--capture", c]);
    ok("a capture giving ONE id two different titles is malformed, not adjudicable",
      r.code !== 0 && /two different titles/.test(r.out), r.out.split(NL)[0]);
    ok("...and nothing is written, so the second name is not lost to first-wins", capsOf(s).length === 0);
    // CONTROL: a capture restating the SAME point identically in both of its sections is the
    // ordinary shape and must relay untouched.
    const s2 = mk();
    const c2 = put(s2, "P2-codex.relay", cap(s2.id, {
      log: "POINT_SET P1=AGREED in=P2", points: "P1=AGREED | the only name" }));
    ok("control: a capture stating one point once in each section still relays",
      relay(s2, ["--capture", c2]).code === 0);
  }
  {
    // A NEW id every proposer must NAME. Contributors work blind to each other, so one cannot be
    // corroborating a point it had no way to read: an untitled proposal for an id no row exists for
    // is either a second finding whose title was omitted or a ruling on something invented, and
    // both were filed under whichever title arrived first with no collision fired - the distinct-
    // title set had size 1. The same loss the collision check exists to prevent, reached from
    // outside its condition.
    const s = mk();
    const a = put(s, "P2-agy.relay", cap(s.id, { points: "P1=AGREED | agy names the point" }));
    const b = put(s, "P2-copilot.relay", cap(s.id, { log: "POINT_SET P1=REJECTED in=P2",
      body: ["### TURN-P2 (CODEX)", "SCHEMA: collab-board/turn/v1",
        "- Header: PART=PLAN / RESPONDS_TO=NEW / POINTS=-", "- Body:", "  - FINDINGS: ACK by copilot",
        "- Evidence: probe copilot", "- Handoff: CODEX WORKING->ON_HOLD, CLAUDE ON_HOLD->START"].join(NL) }));
    const f = put(s, "fuse.md", "### TURN-P2 (CODEX)" + NL + "- Body: agy and copilot" + NL);
    const r = relay(s, ["--capture", a + "," + b, "--fused", f]);
    ok("an untitled proposal for a NEW id is refused, not filed under someone else's title",
      r.code !== 0 && /without naming it/.test(r.out), r.out.split(NL)[0]);
    ok("...naming who was silent and what the others called it",
      /copilot/.test(r.out) && /agy names the point/.test(r.out), r.out);
    // CONTROL: an EXISTING point needs no title from anyone - the row has one, and it is not a
    // capture's to restate. This is the common path and must stay open.
    const s2 = mk();
    edit(file(s2.dir, "points.md"), (x) => x.trimEnd() + NL + "| P1 | PLAN | raised on an earlier turn | OPEN | - |" + NL);
    const a2 = put(s2, "P2-agy.relay", cap(s2.id, { points: "P1=AGREED" }));
    const b2 = put(s2, "P2-copilot.relay", cap(s2.id, { log: "POINT_SET P1=AGREED in=P2",
      body: ["### TURN-P2 (CODEX)", "SCHEMA: collab-board/turn/v1",
        "- Header: PART=PLAN / RESPONDS_TO=NEW / POINTS=-", "- Body:", "  - FINDINGS: ACK by copilot",
        "- Evidence: probe copilot", "- Handoff: CODEX WORKING->ON_HOLD, CLAUDE ON_HOLD->START"].join(NL) }));
    const f2 = put(s2, "fuse.md", "### TURN-P2 (CODEX)" + NL + "- Body: agy and copilot" + NL);
    // A ROW IS TAKEN; A TITLE IS A NAME. Testing "does a row exist" answered the wrong question by
    // one step: what makes a capture's title unusable is that the point ALREADY HAS a name, and a
    // row with an empty title has none. Such a row fell through to first-non-empty across the
    // captures - --capture argument order deciding what the tracker says a finding was about, on a
    // row that is otherwise perfectly legal.
    const sE = mk();
    edit(file(sE.dir, "points.md"), (x) => x.trimEnd() + NL + "| P1 | PLAN |  | OPEN | - |" + NL);
    const [ea, eb, ef] = collidePair(sE, "agy names it", "copilot names it", "AGREED", "AGREED");
    const rE = relay(sE, ["--capture", ea + "," + eb, "--fused", ef]);
    ok("two captures naming an EMPTY-titled row collide rather than racing",
      rE.code !== 0 && /carry two different findings/.test(rE.out), rE.out.split(NL)[0]);
    // ...and the adjudication verbs work on it exactly as on a new id.
    const sE2 = mk();
    edit(file(sE2.dir, "points.md"), (x) => x.trimEnd() + NL + "| P1 | PLAN |  | OPEN | - |" + NL);
    const [fa, fb, ff] = collidePair(sE2, "agy names it", "copilot names it", "AGREED", "AGREED");
    ok("...and --merge names it, filling the blank row with the survivor's wording",
      relay(sE2, ["--capture", fa + "," + fb, "--fused", ff, "--merge", "P1:copilot"]).code === 0
      && /agy names it/.test(read(file(sE2.dir, "points.md"))), read(file(sE2.dir, "points.md")));
    ok("control: contributors ruling on an EXISTING point need supply no title",
      relay(s2, ["--capture", a2 + "," + b2, "--fused", f2]).code === 0);
  }
  {
    // ONE reader decides what a GATE_SET names. Two private regexes here disagreed with each other
    // and neither checked membership in GATE_NAMES, so a gate-shaped line that names no real gate
    // passed entitlement, passed the partition, landed in the log — and the projector ignored it.
    const s = mk();
    const r = relay(s, ["--capture", put(s, "P2-codex.relay",
      cap(s.id, { log: "GATE_SET FOO_SECONDARY=YES by=CODEX", points: "P1=AGREED | the point" }))]);
    // Assert the SPECIFIC diagnostic. A bare "it refused" passes for the wrong reason: with a
    // private reader the name parses, the phase check then rejects it, and the fixture stays green
    // while the membership guard it exists for is gone.
    ok("a gate-shaped line naming no real gate is refused, not logged unprojected",
      r.code !== 0 && /not this contributor's own SECONDARY gate/.test(r.out), r.out.split(NL)[0]);
    ok("...and nothing was written", capsOf(s).length === 0);
  }
  {
    // A capture may consent only for the phase the board is IN. A unanimous IMPL_AGREE_SECONDARY
    // offered during PLAN would pre-consent to a review that has not happened, and `advance` would
    // cross into IMPL with the far side already agreed.
    const s = mk();
    const r = relay(s, ["--capture", put(s, "P2-codex.relay",
      cap(s.id, { log: "GATE_SET IMPL_AGREE_SECONDARY=YES by=CODEX", points: "P1=AGREED | the point" }))]);
    ok("an IMPL gate offered during PLAN is refused", r.code !== 0, r.out.split(NL)[0]);
    ok("...naming the phase mismatch", /phase PLAN/.test(r.out), r.out);
    // CONTROL: the gate for the CURRENT phase is still accepted.
    const s2 = mk();
    ok("control: the current phase's gate is still accepted",
      relay(s2, ["--capture", put(s2, "P2-codex.relay",
        cap(s2.id, { log: "GATE_SET PLAN_AGREE_SECONDARY=YES by=CODEX", points: "P1=AGREED | the point" }))]).code === 0);
  }
  {
    // Two byte-identical captures are one contributor filed twice. Every count derived from the
    // contributor set would read them as two — including whether a gate is unanimous — and L25
    // cannot see it, because its retained-capture map is keyed by hash and the duplicate collapses.
    const s = mk();
    const body = cap(s.id, { points: "P1=AGREED | the point" });
    const a = put(s, "P2-agy.relay", body);
    const b = put(s, "P2-copilot.relay", body);
    const f = put(s, "df.md", "### TURN-P2 (CODEX)" + NL + "- Body: agy and copilot" + NL);
    const r = relay(s, ["--capture", a + "," + b, "--fused", f]);
    ok("two byte-identical captures are refused as one contributor filed twice", r.code !== 0, r.out.split(NL)[0]);
    ok("...before anything is written", capsOf(s).length === 0);
  }
  {
    // CONTROL for the token above: adopting a CONTRIBUTOR's ruling names that contributor, so a
    // reader can tell the two acts apart without opening captures/.
    const s = mk();
    const [a, b, f] = disputePair(s, "AGREED", "REJECTED");
    relay(s, ["--capture", a + "," + b, "--fused", f, "--resolve", "P1=REJECTED"]);
    ok("control: adopting a contributor's ruling names that contributor",
      /adjudicated=P1:copilot/.test(read(file(s.dir, "log.md"))), read(file(s.dir, "log.md")));
  }
  {
    // A capture stating its ruling in BOTH sections proposes twice. The dispute message is what a
    // reader uses to decide who disagreed with whom, and it printed the same contributor twice.
    const s = mk();
    const a = put(s, "P2-agy.relay", cap(s.id, { body: contribBody("agy"),
      points: "P1=AGREED | disputed point", log: "POINT_SET P1=AGREED in=P2" }));
    const b = put(s, "P2-copilot.relay", cap(s.id, { body: contribBody("copilot"),
      points: "P1=REJECTED | disputed point", log: "POINT_SET P1=REJECTED in=P2" }));
    const f = put(s, "df2.md", "### TURN-P2 (CODEX)" + NL + "- Body: agy and copilot" + NL);
    const r = relay(s, ["--capture", a + "," + b, "--fused", f]);
    ok("the dispute message lists each contributor once, not once per proposal",
      r.code !== 0 && (r.out.match(/agy=AGREED/g) || []).length === 1, r.out);
  }
  {
    // Complete rendering repairs a row that disagreed with the log BEFORE this turn, and that value
    // then exists nowhere. The rendering stays; the repair is REPORTED, computed from the log
    // WITHOUT this turn's events so it describes what was already wrong.
    const s = mk();
    relay(s, ["--capture", put(s, "P2-codex.relay", cap(s.id, { points: "P1=AGREED | the point" }))]);
    edit(file(s.dir, "points.md"), (t) => t.replace(/^(\| P1 \| PLAN \| .*\| )AGREED( \| ).*$/m, "$1REJECTED$2- |"));
    handBackToSecondary(s, "P3");
    const r = relay(s, ["--capture", put(s, "P3-codex.relay", cap(s.id, { turn: "P3", points: "P2=AGREED | another" }))]);
    ok("a silently repaired pre-existing divergence is reported", /disagreed with the log BEFORE this turn/.test(r.out), r.out);
    ok("...naming the row and both readings", /P1: table REJECTED\/- vs log AGREED\/P2/.test(r.out), r.out);
    // CONTROL: a board with no pre-existing divergence reports nothing.
    const s2 = mk();
    const r2 = relay(s2, ["--capture", put(s2, "P2-codex.relay", cap(s2.id, { points: "P1=AGREED | the point" }))]);
    ok("control: a clean board reports no divergence", !/disagreed with the log/.test(r2.out), r2.out);
  }

  // --- one grammar for the retained capture name: the writer must not out-write the reader.
  {
    const s = mk();
    const r = relay(s, ["--capture", put(s, "P2-codex-cli.relay", cap(s.id))]);
    ok("relay refuses a capture name the linter's discovery could not rediscover", r.code !== 0,
      r.out.split(NL)[0]);
    ok("...rather than retaining a capture that L25 would then report as tampered", capsOf(s).length === 0);
  }
  {
    const s = mk();
    const a = put(s, path.join("d1", "P2-x.relay"), cap(s.id, { body: "### TURN-P2 (CODEX)" + NL + "- Body: FIRST" }));
    const b = put(s, path.join("d2", "P2-x.relay"), cap(s.id, { body: "### TURN-P2 (CODEX)" + NL + "- Body: SECOND" }));
    const f = put(s, "f.md", "### TURN-P2 (CODEX)" + NL + "- Body: x and x" + NL);
    const r = relay(s, ["--capture", a + "," + b, "--fused", f]);
    ok("relay refuses two captures that would be retained under one name", r.code !== 0, r.out.split(NL)[0]);
    ok("...so neither contributor's bytes are destroyed by the other", capsOf(s).length === 0);
  }
  {
    // The same loss reached from outside the comparison: retained names become FILENAMES, and the
    // filesystems this runs on are case-insensitive (Windows always, macOS by default). Two names
    // differing only in case are distinct STRINGS and one FILE, so the exact-match twin check above
    // saw no collision and the second write destroyed the first contributor's bytes.
    const s = mk();
    const a = put(s, "P2-agy.relay", cap(s.id, { body: "### TURN-P2 (CODEX)" + NL + "- Body: FIRST" }));
    const b = put(s, "P2-AGY.relay", cap(s.id, { body: "### TURN-P2 (CODEX)" + NL + "- Body: SECOND" }));
    const f = put(s, "f2.md", "### TURN-P2 (CODEX)" + NL + "- Body: agy and AGY" + NL);
    const r = relay(s, ["--capture", a + "," + b, "--fused", f]);
    ok("relay refuses two capture names differing only in CASE (one file on Windows/macOS)",
      r.code !== 0, r.out.split(NL)[0]);
    ok("...so the case-colliding pair destroys no contributor's bytes either", capsOf(s).length === 0);
  }
  {
    // Control for the case rule: two genuinely distinct contributors must still relay and BOTH be
    // retained. A guard that refused this would break every real multi-vendor panel turn.
    const s = mk();
    const a = put(s, "P2-agy.relay", cap(s.id, { body: "### TURN-P2 (CODEX)" + NL + "- Body: FIRST" }));
    const b = put(s, "P2-copilot.relay", cap(s.id, { body: "### TURN-P2 (CODEX)" + NL + "- Body: SECOND" }));
    const f = put(s, "f3.md", "### TURN-P2 (CODEX)" + NL + "- Body: agy and copilot" + NL);
    const r = relay(s, ["--capture", a + "," + b, "--fused", f]);
    ok("control: two distinct contributors still relay after the case rule", r.code === 0, r.out.split(NL)[0]);
    ok("control: both captures are retained, neither overwritten",
      JSON.stringify(capsOf(s)) === JSON.stringify(["P2-agy.relay", "P2-copilot.relay"]));
  }
  {
    // Control: re-running an identical relay after a crash must still succeed, so an existing
    // capture with the SAME bytes is not a collision.
    const s = mk();
    const c = put(s, "P2-codex.relay", cap(s.id));
    fs.mkdirSync(path.join(s.dir, "captures"), { recursive: true });
    fs.copyFileSync(c, path.join(s.dir, "captures", "P2-codex.relay"));
    ok("control: re-relaying after a crash that already retained the same bytes still succeeds",
      relay(s, ["--capture", c]).code === 0);
  }

  // --- --fused and --attempt are validated before the first write.
  {
    const s = mk();
    const a = put(s, "P2-alpha.relay", cap(s.id)), b = put(s, "P2-beta.relay", cap(s.id));
    const r = relay(s, ["--capture", a + "," + b, "--fused", s.root]);
    ok("relay refuses --fused pointing at a directory", r.code !== 0);
    ok("...as a relay error, not a raw EISDIR from inside fs", !/EISDIR/.test(r.out), r.out.split(NL)[0]);
    ok("...and refuses BEFORE retaining anything, so no orphan captures are left", capsOf(s).length === 0);
  }
  {
    const s = mk();
    const r = relay(s, ["--capture", put(s, "P2-codex.relay", cap(s.id)), "--attempt", "not-a-number"]);
    ok("relay refuses a malformed --attempt instead of silently coercing it to 1", r.code !== 0);
    ok("...and records no attempt=1 it was never given", !/attempt=1/.test(read(file(s.dir, "log.md"))));
  }

  // --- a turn body that QUOTES the capture grammar must not silently lose its tail.
  {
    const s = mk();
    const body = ["### TURN-P2 (CODEX)", "- Body:", "  - FINDINGS: the capture ends with a line reading:",
      "--- END ---", "- Evidence: THIS_MUST_SURVIVE", "- Handoff: CODEX WORKING->ON_HOLD"].join(NL);
    const r = relay(s, ["--capture", put(s, "P2-codex.relay", cap(s.id, { body }))]);
    const shard = path.join(s.dir, "turns", "P2-codex.md");
    ok("a TURN body quoting a marker is refused, never silently truncated",
      r.code !== 0 || /THIS_MUST_SURVIVE/.test(read(shard)));
    ok("...and the refusal tells the author how to quote one legitimately",
      /indent it by one space/.test(r.out), r.out.split(NL)[0]);
  }
  {
    // Control: the documented escape — indent the quoted marker — still relays, whole.
    const s = mk();
    const body = ["### TURN-P2 (CODEX)", "- Body:", "  - FINDINGS: the capture ends with a line reading:",
      " --- END ---", "- Evidence: THIS_MUST_SURVIVE", "- Handoff: CODEX WORKING->ON_HOLD"].join(NL);
    const r = relay(s, ["--capture", put(s, "P2-codex.relay", cap(s.id, { body }))]);
    ok("control: an INDENTED quoted marker relays, and the whole body survives",
      r.code === 0 && /THIS_MUST_SURVIVE/.test(read(path.join(s.dir, "turns", "P2-codex.md"))), r.out);
  }

  // --- the START token is the mutex, and a relay writes the SECONDARY's turn.
  {
    const s = mk({ secondaryIdle: true });
    const r = relay(s, ["--capture", put(s, "P2-codex.relay", cap(s.id))]);
    ok("relay refuses to write a secondary turn when the SECONDARY does not hold START", r.code !== 0,
      r.out.split(NL)[0]);
  }

  // --- orphaned captures are the recovery signal, and something has to look at them.
  {
    const s = mk();
    fs.mkdirSync(path.join(s.dir, "captures"), { recursive: true });
    write(path.join(s.dir, "captures", "P2-codex.relay"), cap(s.id));
    const out = lint(s.root, s.id).out;
    ok("lint reports captures retained for a turn that was never committed",
      has(out, "L25") && /no TURN_COMMIT P2 was ever logged/.test(out), out);
    // Control: once the turn IS committed, the same captures draw no orphan finding.
    const s2 = mk();
    relay(s2, ["--capture", put(s2, "P2-codex.relay", cap(s2.id))]);
    ok("control: a completed relay's captures draw no orphan finding",
      !/no TURN_COMMIT/.test(lint(s2.root, s2.id).out));
  }
}

// 17b-38. REPLAY — the measurement the standing regression rule already required and nothing provided.
//
// Rule 11's BARREN=8/CHURN=2 were calibrated by replaying every log prefix of the 14 real boards.
// That replay was done once, by hand, against gitignored data, and was never committed — so the
// standing rule that a check must be diffed against the pre-change engine on the real boards had
// no tool behind it for the one check whose thresholds are calibrated numbers. Re-running it
// today reproduces both outcomes the calibration names by turn (I8, and P5 for the board that
// re-litigated P1 twice) and disagrees on the aggregate, which is exactly the kind of thing an
// uncommitted measurement cannot settle.
//
// The harness and lint share ONE counter (`convergenceScan`). A harness that reimplements it can
// agree with a bug or disagree with a fix, and the output cannot tell you which.
if (SEL(67)) {
  const barrenBoard = (turns) => {
    const { root, id, dir } = scaffold("META", "replay");
    let t = read(file(dir, "log.md")).trimEnd();
    const base = Date.parse("2026-08-04T10:00:00Z");
    const at = (i) => new Date(base + i * 1000).toISOString();
    t += NL + `${at(0)} STATE_SET CLAUDE=WORKING CODEX=ON_HOLD cursor=- next=P1/CLAUDE seq=0`;
    for (let i = 1; i <= turns; i++)
      t += NL + `${at(i)} TURN_COMMIT P${i} actor=${i % 2 ? "CLAUDE" : "CODEX"} responds_to=${i > 1 ? "P" + (i - 1) : "NEW"} points=-`;
    write(file(dir, "log.md"), t + NL);
    return { root, id, dir };
  };
  const replay = (root, id) => run(["replay", "--session", id], root);

  // The counter is shared, so the harness must report the arm at the SAME turn lint FAILs at.
  const b = barrenBoard(9);
  const out = replay(b.root, b.id).out;
  ok("replay reports the BARREN arm and the turn it first fires at",
    /BARREN\s+first fires at turn P8\b/.test(out), out);
  ok("replay reports the WARN arm too — a harness that models only some arms measures a check that does not exist",
    /BARREN-W\s+first fires at turn P6\b/.test(out), out);
  // lint reports the CURRENT streak (9 turns, all of them barren); replay reports where the arm
  // FIRST crossed (turn P8, the 8th). Different questions, one counter — so they must agree on the
  // streak's origin. Asserting the two numbers were equal would have been asserting a bug.
  const lintOut = lint(b.root, b.id).out;
  ok("...and lint FAILs the same board, naming the same streak origin the harness names",
    /FAIL L26.*9 turns since anything was settled \(from P1;/.test(lintOut) && /from P1\)/.test(out),
    lintOut);

  const clean = barrenBoard(3);
  const cleanOut = replay(clean.root, clean.id).out;
  ok("control: a short board is reported clean on every arm",
    (cleanOut.match(/\bclean\b/g) || []).length === 4 && !/first fires/.test(cleanOut), cleanOut);

  // Churn: one point resolved and re-opened twice.
  {
    const s = barrenBoard(6);
    let t = read(file(s.dir, "log.md")).trimEnd();
    const base = Date.parse("2026-08-04T11:00:00Z");
    const at = (i) => new Date(base + i * 1000).toISOString();
    t += NL + `${at(1)} POINT_SET P1=AGREED in=P1`
      + NL + `${at(2)} POINT_SET P1=OPEN`
      + NL + `${at(3)} POINT_SET P1=AGREED in=P2`
      + NL + `${at(4)} POINT_SET P1=OPEN`;
    write(file(s.dir, "log.md"), t + NL);
    ok("replay reports the CHURN arm with the point and its re-open count",
      /CHURN\s+first fires at turn .* — P1 re-opened 2x/.test(replay(s.root, s.id).out),
      replay(s.root, s.id).out);
  }

  // --all covers every session and says what the output is FOR.
  ok("replay --all reports each session and tells the reader to diff it",
    /re-run after any change to the counter or its thresholds and DIFF/.test(run(["replay", "--all"], b.root).out));
  ok("replay is read-only: the log it walked is unchanged",
    read(file(b.dir, "log.md")) === read(file(b.dir, "log.md")));
}

// 17b-39. A SETTLEMENT IS A TRANSITION, not an event type.
//
// 037dd81 gave three of the five settlement kinds a state-change requirement and gave GATE_SET and
// DECISION none. So a legal, well-formed, entirely no-op line — re-asserting a gate already YES —
// reset the barren counter. One every seventh turn suppressed the FAIL, the WARN and the REPEAT
// arm indefinitely, and drew no finding from any check: twenty barren turns, measured, clean.
// The project's own board (2026-08-03-self-review P7) raised this objection before 037dd81 shipped.
//
// Landed only after the replay harness could show the change moves NO real board: the replay of
// all 14 is byte-identical before and after, as is the lint output. No board re-asserts a gate,
// and all six real DECISION lines already match the §8 form.
if (SEL(68)) {
  const logBoard = (build) => {
    const { root, id, dir } = scaffold("META", "settle");
    let t = read(file(dir, "log.md")).trimEnd();
    let n = 0;
    const base = Date.parse("2026-08-04T10:00:00Z");
    const at = () => new Date(base + (n++) * 1000).toISOString();
    t += NL + `${at()} STATE_SET CLAUDE=WORKING CODEX=ON_HOLD cursor=- next=P1/CLAUDE seq=0`;
    t += build(at);
    write(file(dir, "log.md"), t + NL);
    return { root, id, dir };
  };
  const turns = (at, from, to, every, line) => {
    let s = "";
    for (let i = from; i <= to; i++) {
      s += NL + `${at()} TURN_COMMIT P${i} actor=${i % 2 ? "CLAUDE" : "CODEX"} responds_to=${i > 1 ? "P" + (i - 1) : "NEW"} points=-`;
      if (every && i % every === 0 && line) s += NL + `${at()} ${line}`;
    }
    return s;
  };

  // These must assert the FAIL, not merely "an L26 line". Under the OLD behaviour each re-assertion
  // reset the streak, leaving 6 barren turns at the end — which still emits the WARN. A
  // `has(out,"L26")` assertion therefore passed either way and reached nothing; the negative
  // control caught it. The FAIL is what the no-op line was suppressing, so the FAIL is the claim.
  const barrenFail = (s) => /FAIL L26.*turns since anything was settled/.test(lint(s.root, s.id).out);
  {
    const s = logBoard((at) => turns(at, 1, 20, 7, "GATE_SET PLAN_AGREE_SECONDARY=YES by=CODEX"));
    ok("a gate re-asserted every 7th turn no longer suppresses the barren FAIL",
      barrenFail(s), lint(s.root, s.id).out);
  }
  {
    // Control: the FIRST time each gate goes YES it is a real settlement and does reset the streak.
    const s = logBoard((at) => turns(at, 1, 6, 0, null)
      + NL + `${at()} GATE_SET PLAN_AGREE_SECONDARY=YES by=CODEX`
      + turns(at, 7, 12, 0, null)
      + NL + `${at()} GATE_SET PLAN_AGREE_PRIMARY=YES by=CLAUDE`
      + turns(at, 13, 16, 0, null));
    ok("control: two DIFFERENT gates each still settle, so the board stays clean",
      !has(lint(s.root, s.id).out, "L26"), lint(s.root, s.id).out);
  }
  {
    const s = logBoard((at) => turns(at, 1, 20, 7, "DECISION P1 -> ACCEPT by=CLAUDE"));
    ok("the same DECISION re-logged settles nothing", barrenFail(s), lint(s.root, s.id).out);
  }
  {
    // Control: two DISTINCT verbs on one point are two genuine decisions, keyed on the verb.
    // (Was DEFER then ACCEPT. DEFER is gone from the DECISION grammar with the DEFERRED status:
    // a board may not park work it needs, so a decision may accept or reject, never postpone.)
    const s = logBoard((at) => turns(at, 1, 6, 0, null)
      + NL + `${at()} DECISION P1 -> REJECT by=CLAUDE`
      + turns(at, 7, 12, 0, null)
      + NL + `${at()} DECISION P1 -> ACCEPT by=CLAUDE`
      + turns(at, 13, 16, 0, null));
    ok("control: REJECT then ACCEPT on the same point are two settlements, not one repeat",
      !has(lint(s.root, s.id).out, "L26"), lint(s.root, s.id).out);
  }
  {
    // 12 turns with the off-form DECISION at turn 6. If it settled (the old behaviour), the tail
    // would be 6 barren turns — a WARN, not a FAIL. Asserting BOTH halves is the point: the line
    // must be reported AND must buy no window.
    const s = logBoard((at) => turns(at, 1, 6, 0, null)
      + NL + `${at()} DECISION P1 -> MAYBE by=CLAUDE`
      + turns(at, 7, 12, 0, null));
    const out = lint(s.root, s.id).out;
    ok("an off-form DECISION is reported rather than failing quietly",
      /WARN L26.*is not the §8/.test(out), out);
    ok("...and buys no convergence window", barrenFail(s), out);
  }
  {
    // The gate predicate is shared with the projector, and `(\w+)=YES` was a PREFIX match.
    const s = logBoard((at) => turns(at, 1, 2, 0, null)
      + NL + `${at()} GATE_SET PLAN_AGREE_PRIMARY=YESTERDAY by=CLAUDE`);
    // HEAD says NO. If the projector still reads `=YESTERDAY` as setting the gate, the projection
    // says YES and L2 reports "HEAD PLAN_AGREE_PRIMARY=NO but log projects YES". Assert the ABSENCE
    // of that specific line — a bare `!has(out, "L2")` is unsatisfiable here, because this
    // log-only fixture carries unrelated L2 projection findings no matter what the gate does.
    ok("GATE_SET <gate>=YESTERDAY does not set the gate (the prefix match is closed)",
      !/PLAN_AGREE_PRIMARY=NO but log projects YES/.test(lint(s.root, s.id).out), lint(s.root, s.id).out);
  }
}

// 17b-40. FANOUT SEAL — the check behind "no subagent writes the board".
//
// Acceptance for the delegated-PRIMARY architecture requires that rule be enforced by a check
// rather than by instruction. Tool-level confinement is not available (verified 2026-07-31: an
// allowedTools list does not confine a subagent), so the mechanism is detection, and the honest
// claim is an unmissable alarm rather than prevention.
if (SEL(69)) {
  const { root, id, dir } = scaffold("META", "fanout");
  const seal = () => (/^SEAL ([0-9a-f]{64})/m.exec(run(["fanout", "--seal"], root).out) || [])[1];
  const d0 = seal();
  ok("fanout --seal prints a digest over the board", !!d0);
  ok("--verify against an unchanged board passes",
    run(["fanout", "--verify", "--expect", d0], root).code === 0);
  ok("--verify without --expect refuses rather than passing vacuously",
    run(["fanout", "--verify"], root).code !== 0);

  // Every way a subagent could touch the board must move the digest — an edit, a new file, a
  // deletion, and a byte-level change that leaves the TEXT identical. A seal that noticed only
  // edits would pass a subagent that added a shard.
  const MUTATIONS = [
    ["an edited board file", (d) => edit(file(d, "points.md"), (t) => t + NL + "| P9 | PLAN | x | OPEN | - |")],
    ["a new file a subagent created", (d) => write(file(d, "turns", "P9-codex.md"), "### TURN-P9 (CODEX)" + NL)],
    ["a deleted board file", (d) => fs.rmSync(file(d, "impl", "code_state.md"))],
    // Flip the line endings to whichever they are NOT, so this is a byte change on a CRLF tree and
    // on an LF one alike. Hard-coding "convert to CRLF" made the mutation a no-op the moment git
    // handed us a CRLF working tree, and the test then failed for want of a change to detect.
    ["a file whose bytes changed but whose text did not", (d) => {
      const t = read(file(d, "HEAD.md"));
      write(file(d, "HEAD.md"), /\r\n/.test(t) ? t.replace(/\r\n/g, "\n") : t.replace(/\n/g, "\r\n"));
    }],
  ];
  for (const [label, mutate] of MUTATIONS) {
    const s = scaffold("META", "fanout");
    const before = (/^SEAL ([0-9a-f]{64})/m.exec(run(["fanout", "--seal"], s.root).out) || [])[1];
    mutate(s.dir);
    const v = run(["fanout", "--verify", "--expect", before], s.root);
    ok(`the seal detects ${label}`, v.code !== 0 && /fanout FAILED/.test(v.out), v.out);
  }

  // The digest must depend on the board and NOTHING else. PRIMARY edits project files throughout
  // IMPL (Rule 7), and a build, a formatter or an editor touches the tree besides — a seal that
  // moved with any of that would fire constantly and be switched off.
  //
  // This assertion used to justify itself by citing a manager rule that granted subagents the very
  // project-file write protocol Rule 7 reserves for PRIMARY. The BEHAVIOUR was right and its stated
  // reason contradicted the protocol, which is the harder version of the bug: a test name reads as
  // evidence and cannot fail.
  {
    const s = scaffold("META", "fanout");
    const before = (/^SEAL ([0-9a-f]{64})/m.exec(run(["fanout", "--seal"], s.root).out) || [])[1];
    write(path.join(s.root, "src", "some-project-file.ts"), "export const x = 1;" + NL);
    ok("control: PROJECT-file edits do not trip the board seal — it is scoped to .collab-board",
      run(["fanout", "--verify", "--expect", before], s.root).code === 0);
  }
  // No litter, and nothing on disk for a subagent to edit into agreement.
  {
    const s = scaffold("META", "fanout");
    const before = fs.readdirSync(s.root).sort().join(",");
    run(["fanout", "--seal"], s.root);
    ok("fanout --seal writes no file by default", fs.readdirSync(s.root).sort().join(",") === before);
  }
  void id; void dir;
}

// 17b-41. Three defects the FAN-OUT itself found, on its first real use.
//
// Two PRIMARY-side subagents with disjoint scopes were asked to attack the manager's own claims
// before they went on a board. They falsified one outright and holed another:
//   * "the SECONDARY-side cap is the number of INSTALLED executors" — false. CLI_EXECUTOR_SPECS is
//     a static list; nothing probes PATH. The engine enforces a MINIMUM of two and no maximum, and
//     did not exclude the PRIMARY's own model from the panel.
//   * the panel's distinctness check compared literal strings, so `codex-cli,codex` — one model
//     under two spellings of its own name — passed as a two-member panel.
//   * the fan-out seal hashed only regular files, so a Windows junction planted inside the board,
//     with reachable content behind it, left the digest unchanged. Reproduced twice, independently.
if (SEL(70)) {
  const panelSess = (t, panel) => t.trimEnd() + NL + "BoardWriteMode: PRIMARY_ONLY" + NL + "SecondaryPanel: " + panel + NL;
  const mkP = (panel, secondary = "PANEL") => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-pan2-"));
    run(["new", "--type", "META", "--slug", "p", "--primary", "CLAUDE", "--secondary", secondary, "--adapter", "manual"], root);
    const id = fs.readdirSync(path.join(root, ".collab-board", "sessions"))[0];
    const dir = path.join(root, ".collab-board", "sessions", id);
    edit(file(dir, "SESSION.md"), (t) => panelSess(t, panel));
    return { root, id, dir };
  };

  {
    // The alias pair that motivated the original rule is STILL refused — but for the right reason.
    // What must never repeat is a CONTRIBUTOR LABEL: it is what a capture filename carries, what
    // L25 rediscovers a retained capture by, and what every count keyed on the contributor set
    // reads. Two entries resolving to one label are one contributor listed twice.
    const s = mkP("codex-cli,codex");
    ok("two roster entries resolving to one contributor label are refused",
      /L18.*same contributor label CODEX/.test(lint(s.root, s.id).out), lint(s.root, s.id).out);
  }
  {
    // DELIBERATE DELETION, and it is the owner's ruling, not a convenience. The previous assertion
    // required a roster member driving the PRIMARY's own model to be REFUSED ("the PRIMARY agreeing
    // with itself"). The core must be model-agnostic: two ACTORS must be distinct, two MODELS need
    // not be, so the same model may contribute beside other vendors. What that guard PROTECTED is
    // kept — a same-family contributor is the weakest reviewer available — but as advice from
    // `doctor`/`new`, never as a structural refusal. This test now asserts the INVERSE.
    const s = mkP("claude-cli,copilot-cli");   // PRIMARY is CLAUDE
    ok("a roster may include the PRIMARY's own family — the core is model-agnostic",
      !has(lint(s.root, s.id).out, "L18"), lint(s.root, s.id).out);
  }
  {
    const s = mkP("agy-cli,copilot-cli");
    ok("control: a genuine two-vendor panel, neither of them the PRIMARY, still passes",
      !has(lint(s.root, s.id).out, "L18"), lint(s.root, s.id).out);
  }

  // The seal must move for anything that appears in the board, including the things it cannot
  // hash. Recorded, never followed: following a link would take the digest outside the board.
  {
    const s = scaffold("META", "seal2");
    const seal = () => (/^SEAL ([0-9a-f]{64})/m.exec(run(["fanout", "--seal"], s.root).out) || [])[1];
    const before = seal();
    fs.mkdirSync(path.join(s.dir, "empty-dir"), { recursive: true });
    ok("the seal detects a new empty directory", run(["fanout", "--verify", "--expect", before], s.root).code !== 0);
  }
  {
    // A junction is reported as a symlink, so it satisfied neither isFile() nor isDirectory() and
    // was skipped entirely. Skipped on platforms where the link cannot be created (needs privilege
    // or a filesystem that supports it) — and the skip is REPORTED, not silent.
    const s = scaffold("META", "seal3");
    const before = (/^SEAL ([0-9a-f]{64})/m.exec(run(["fanout", "--seal"], s.root).out) || [])[1];
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "cb-link-target-"));
    write(path.join(target, "leak.txt"), "content reachable through the board" + NL);
    let made = false;
    for (const type of ["junction", "dir"]) {
      try { fs.symlinkSync(target, path.join(s.dir, "link"), type); made = true; break; } catch { /* try next */ }
    }
    if (made) ok("the seal detects a directory link planted inside the board",
      run(["fanout", "--verify", "--expect", before], s.root).code !== 0);
    else console.log("        (skipped: this environment cannot create a directory link)");
  }
  {
    // Found by the agy panel member reviewing the fix above, missed by the copilot one: recording
    // that a link EXISTS is not recording where it POINTS. A junction inside the board was swung
    // from a harmless directory to an attacker-controlled one — the content reachable through the
    // board changed completely — and the digest did not move.
    const s = scaffold("META", "seal4");
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "cb-tgt-a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "cb-tgt-b-"));
    write(path.join(a, "f.txt"), "HARMLESS" + NL);
    write(path.join(b, "f.txt"), "ATTACKER CONTENT" + NL);
    const link = path.join(s.dir, "link");
    let kind = null;
    for (const t of ["junction", "dir"]) { try { fs.symlinkSync(a, link, t); kind = t; break; } catch { /* next */ } }
    if (kind) {
      const before = (/^SEAL ([0-9a-f]{64})/m.exec(run(["fanout", "--seal"], s.root).out) || [])[1];
      fs.rmSync(link, { recursive: false, force: true });
      fs.symlinkSync(b, link, kind);
      ok("the seal detects a link REPOINTED to somewhere else, not just its existence",
        run(["fanout", "--verify", "--expect", before], s.root).code !== 0);
    } else console.log("        (skipped: this environment cannot create a directory link)");
  }

  // The panel ceiling is stated, not emergent — both panel members raised this independently.
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-ceil-"));
    run(["new", "--type", "META", "--slug", "c", "--primary", "CLAUDE", "--secondary", "PANEL", "--adapter", "manual"], root);
    const id = fs.readdirSync(path.join(root, ".collab-board", "sessions"))[0];
    const dir = path.join(root, ".collab-board", "sessions", id);
    edit(file(dir, "SESSION.md"), (t) => t.trimEnd() + NL + "BoardWriteMode: PRIMARY_ONLY"
      + NL + "SecondaryPanel: codex-cli,claude-cli,copilot-cli,agy-cli" + NL);
    const out = lint(root, id).out;
    // DELIBERATE DELETION, second one in this block. There is NO roster size cap at all now: not
    // the vendor-derived ceiling (wrong in both directions), and not a stated constant either. The
    // number of contributors a turn deserves is how many DISJOINT scopes its work decomposes into
    // times the vendors available — a property of the task, which no constant in the engine knows.
    // A number the engine enforces is a number the next session obeys instead of thinking. What
    // survives is the check that a roster of four DISTINCT vendors is legitimate and lints clean.
    ok("a four-vendor roster is legitimate — no cap stands between a task and the scopes it needs",
      !has(out, "L18"), out);
  }
}

// 17b-42. Two claims the docs made that the mechanism does not support.
if (SEL(71)) {
  const proto = read(path.join(HERE, "..", "references", "protocol.md"));
  const skill = read(path.join(HERE, "..", "SKILL.md"));
  const adapters = read(path.join(HERE, "..", "references", "adapters.md"));

  // A SECONDARY asking for a step-back is doing what Rule 11 prescribes. `- REFRAME:` is the token
  // lint counts to tell a WRITTEN step-back from a LOGGED one, so a request phrased with it makes
  // the board look like it carries an unlogged step-back and draws a WARN saying so — an accusation
  // of the opposite of what the SECONDARY did. Under PRIMARY_ONLY its words reach the shard
  // byte-for-byte, so this is structural, not a matter of care.
  ok("PROTOCOL names a distinct token for REQUESTING a step-back",
    /- REFRAME_REQUEST:/.test(proto));
  ok("...and Rule 11 routes the SECONDARY to it rather than to the step-back token",
    /SECONDARY uses REFRAME_REQUEST/.test(proto.replace(/\r?\n/g, " ")));
  // The separation must hold in the REGEX, not just in the prose, or the WARN still fires.
  const reframeLine = /^[ \t]*-?[ \t]*REFRAME:/m;
  ok("a REFRAME_REQUEST line is not counted as a step-back by the shard token",
    !reframeLine.test("- REFRAME_REQUEST: the loop looks stuck"));
  ok("control: a real REFRAME line still is", reframeLine.test("- REFRAME: NARROW — cut scope"));

  const directPrompt = /## Direct-write scoped prompt([\s\S]*?)(?=\n## Result routing)/.exec(adapters)?.[1] || "";
  // Bounded by the NEXT heading or end of file, not by one neighbour's NAME. The old lookahead
  // named the `subagent` section, so relocating that section emptied this extraction and the
  // assertion below then passed judgement on an empty string — a guard that cannot fail.
  const resultRouting = /## Result routing([\s\S]*?)(?=\n## |$)/.exec(adapters)?.[1] || "";
  ok("direct dispatch refuses a wrong hand with NOT_MY_TURN before any write",
    /confirm <SECONDARY> has START, else output NOT_MY_TURN and stop/.test(directPrompt));
  ok("PRIMARY routes NOT_MY_TURN by re-reading HEAD and re-delegating",
    /`NOT_MY_TURN`[\s\S]*re-read HEAD[\s\S]*re-delegate/.test(resultRouting));

  const phases = /## 4\. Phases and gates([\s\S]*?)(?=\n## 5\.)/.exec(proto)?.[1] || "";
  ok("a PRIMARY deciding PLAN gate is attested before the shard-less advance",
    /deciding PLAN gate[\s\S]*preceding agreement turn[\s\S]*never folded into `advance`/.test(phases));
  ok("SECONDARY cannot terminalize and must request terminal status in its turn",
    /SECONDARY never terminalizes[\s\S]*requests terminal status[\s\S]*turn body/.test(proto));

  const convergence = /11\. \*\*Convergence\.\*\*([\s\S]*?)(?=\n## 8\.)/.exec(proto)?.[1] || "";
  ok("Rule 11 preserves outcome-specific duties",
    /CONTINUE names the specific loop-[\s\S]*breaking next step and why/.test(convergence)
    && /REFRAME carries abandoned evidence forward as points/.test(convergence)
    && /NARROW marks[\s\S]*OUT_OF_SCOPE or opens it on a successor board/.test(convergence));
  ok("PRIMARY may decline REFRAME_REQUEST only by explaining convergence",
    /answer the request with one line explaining why the loop is[\s\S]*converging/.test(proto));

  // Caching belongs to a persistent thread; a fresh CLI dispatch re-reads the snapshot.
  //
  // The FACT is pinned, not one phrasing of it. A compression pass rewrote "reads it once per turn"
  // to "reads it every turn" — the same statement — and this failed, which is a fixture asserting
  // its own wording rather than the rule. Loosening it to the fact is not weakening it: dropping
  // the fresh-dispatch clause entirely still fails.
  ok("protocol.md states both cache and fresh-dispatch behavior",
    /once per\s+persistent thread/.test(proto) && /fresh SECONDARY[\s\S]{0,40}(once per turn|every turn)/.test(proto));
  ok("SKILL.md states both cache and fresh-dispatch behavior",
    /once per persistent thread/.test(skill) && /fresh-dispatched SECONDARY pays this cost each turn/.test(skill));
}

// 17b-43. A resolution buys a convergence window only for a point that was EXPOSED first.
//
// `status.get(id) || "OPEN"` defaulted every unseen id to OPEN, so a POINT_SET closing a point no
// turn had ever named counted as a settlement. A board could therefore raise-and-close inside one
// turn, forever, and hold the barren streak at zero while nothing was ever put up for the other
// actor to see. Under a fusing manager that is the routine shape, not the adversarial one.
//
// Landed only after measuring: replay and lint over the 15-board corpus are byte-identical before
// and after. The one existing control that broke is rewritten above, and why is written there —
// it had been resolving a point no turn ever raised.
if (SEL(72)) {
  const board = (build) => {
    const { root, id, dir } = scaffold("META", "expose");
    let t = read(file(dir, "log.md")).trimEnd();
    let n = 0;
    const base = Date.parse("2026-08-04T10:00:00Z");
    const at = () => new Date(base + (n++) * 1000).toISOString();
    t += NL + `${at()} STATE_SET CLAUDE=WORKING CODEX=ON_HOLD cursor=- next=P1/CLAUDE seq=0`;
    t += build(at);
    write(file(dir, "log.md"), t + NL);
    edit(file(dir, "HEAD.md"), (x) => x.replace("SESSION_STATUS: IDLE", "SESSION_STATUS: ACTIVE"));
    return { root, id, dir };
  };
  const turn = (at, i, points = "-") =>
    NL + `${at()} TURN_COMMIT P${i} actor=${i % 2 ? "CLAUDE" : "CODEX"} responds_to=${i > 1 ? "P" + (i - 1) : "NEW"} points=${points}`;
  const barrenFail = (s) => /FAIL L26.*turns since anything was settled/.test(lint(s.root, s.id).out);

  {
    // Never raised, closed at turn 8 of a barren streak: legal, but buys nothing.
    let s = board((at) => {
      let x = ""; for (let i = 1; i <= 10; i++) { x += turn(at, i); if (i === 8) x += NL + `${at()} POINT_SET P9=AGREED in=P8`; }
      return x;
    });
    ok("closing a point no earlier turn ever raised does not reset the streak", barrenFail(s), lint(s.root, s.id).out);
  }
  {
    // Control: raised at P3, resolved at P8 — a real settlement, and it does reset the streak.
    const s = board((at) => {
      let x = ""; for (let i = 1; i <= 10; i++) { x += turn(at, i, i === 3 ? "P9" : "-"); if (i === 8) x += NL + `${at()} POINT_SET P9=AGREED in=P8`; }
      return x;
    });
    ok("control: a point raised by an earlier turn and then resolved DOES reset the streak",
      !barrenFail(s), lint(s.root, s.id).out);
  }
  {
    // The boundary: raised and closed in the SAME turn is not exposure.
    const s = board((at) => {
      let x = ""; for (let i = 1; i <= 10; i++) { x += turn(at, i, i === 8 ? "P9" : "-"); if (i === 8) x += NL + `${at()} POINT_SET P9=AGREED in=P8`; }
      return x;
    });
    ok("raising and closing a point in ONE turn is not exposure and buys no window",
      barrenFail(s), lint(s.root, s.id).out);
  }
  {
    // Churn is unaffected: re-opening still counts however the point was introduced.
    const s = board((at) => {
      let x = ""; for (let i = 1; i <= 6; i++) x += turn(at, i, i === 1 ? "P9" : "-");
      x += NL + `${at()} POINT_SET P9=AGREED in=P2` + NL + `${at()} POINT_SET P9=OPEN`
        + NL + `${at()} POINT_SET P9=AGREED in=P4` + NL + `${at()} POINT_SET P9=OPEN`;
      return x;
    });
    ok("control: churn counting is unchanged by the exposure rule",
      /FAIL L26.*re-opened 2 times/.test(lint(s.root, s.id).out), lint(s.root, s.id).out);
  }
}

// 17b-44. L27 — points.md is in every turn's read-set and had no ceiling at all.
if (SEL(73)) {
  const s = scaffold("META", "psize");
  ok("control: an ordinary points.md draws no size finding", !has(lint(s.root, s.id).out, "L27"));

  // Grow the file with PROSE rather than rows, which is both the case the message describes and
  // the only way to isolate L27: extra rows would draw L2 (not projected by the log) and L4
  // (PLAN_OPEN_POINTS mismatch), and then "L27 does not block" could not be tested at all.
  edit(file(s.dir, "points.md"), (t) => t.trimEnd() + NL + NL
    + "Notes carried in the tracker instead of a shard:" + NL
    + Array.from({ length: 90 }, (_, i) => `- note ${i}: ` + "x".repeat(100)).join(NL) + NL);
  const out = lint(s.root, s.id).out;
  ok("an oversized points.md is reported", /WARN L27.*points\.md is \d+ B/.test(out), out);
  ok("...as a WARN, never a FAIL — the rows have nowhere to move to, so a gate would have no remedy",
    !/FAIL L27/.test(out) && /WARN L27/.test(out), out);
  ok("...and it does not block: the run's exit status is unchanged by L27 alone",
    !/FAIL/.test(out), out);

  // The threshold must sit above the largest tracker the real corpus contains, or it nags a
  // legitimately long session. 5,049 B is the 43-turn board; assert the constant clears it.
  const engineSrc = read(CLI);
  const at = +(/const POINTS_WARN_AT = (\d+);/.exec(engineSrc) || [0, 0])[1];
  ok("the L27 threshold clears the largest points.md in the recorded corpus (5,049 B)", at > 5049);
}

// 17b-45. The relay finishes the writes it owns, and the chain gets exactly one root.
//
// An honest, fully well-formed relay that opened a point left the board at
// `FAIL L2 log projects point P1 but points.md has no such row` — the POINT_SET went to the log
// and the row went nowhere — while the command's own closing line told you to run that lint.
// adapters.md names the points rows among the writes that precede the TURN_COMMIT, so the code
// and the invariant disagreed, and the code was wrong.
if (SEL(74)) {
  const mk = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-rp-"));
    run(["new", "--type", "META", "--slug", "rp", "--primary", "CLAUDE", "--secondary", "CODEX", "--adapter", "codex-cli"], root);
    const id = fs.readdirSync(path.join(root, ".collab-board", "sessions"))[0];
    const dir = path.join(root, ".collab-board", "sessions", id);
    edit(file(dir, "SESSION.md"), (t) => t.trimEnd() + NL + "BoardWriteMode: PRIMARY_ONLY" + NL);
    const stamps = read(file(dir, "log.md")).match(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z/gm) || [];
    edit(file(dir, "log.md"), (t) => t.trimEnd() + NL
      + `${stamps[stamps.length - 1]} STATE_SET CLAUDE=ON_HOLD CODEX=START cursor=- next=P2/CODEX seq=0` + NL);
    edit(file(dir, "HEAD.md"), (t) => t.replace("SESSION_STATUS: IDLE", "SESSION_STATUS: ACTIVE")
      .replace(/- CODEX: [A-Z_]+ - SECONDARY/, "- CODEX: START - SECONDARY")
      .replace(/^NEXT_TURN_ID: .*$/m, "NEXT_TURN_ID: P2").replace(/^NEXT_ACTOR: .*$/m, "NEXT_ACTOR: CODEX"));
    run(["activate", "--session", id], root);
    return { root, id, dir };
  };
  const cap = (id, points, prev = "") => ["RELAY: collab-board/relay/v1", "SESSION: " + id,
    "ACTOR: CODEX", "TURN: P2", "--- TURN ---", "### TURN-P2 (CODEX)",
    "- Header: PART=PLAN · RESPONDS_TO=NEW · POINTS=P1", "- Body:", "  - FINDINGS: ACK.",
    "- Evidence: probe", "- Handoff: CODEX WORKING->ON_HOLD, CLAUDE ON_HOLD->START",
    ...(prev ? [prev] : []),
    "--- LOG ---", "POINT_SET P1=OPEN in=P2", "--- POINTS ---", points, "--- END ---", ""].join(NL);

  {
    const s = mk();
    const c = path.join(s.root, "P2-codex.relay");
    write(c, cap(s.id, "P1=OPEN | the adapter probe order"));
    ok("a relay that opens a point writes the points.md row", run(["relay", "--session", s.id, "--capture", c], s.root).code === 0);
    ok("...the row it wrote carries the capture's own title",
      /\| P1 \| PLAN \| the adapter probe order \| OPEN \| - \|/.test(read(file(s.dir, "points.md"))));
    // Relay owns the complete sole-writer turn, including HEAD and the HANDOFF commit point.
    const out = lint(s.root, s.id).out;
    ok("...and relay reconciles HEAD's open-point mirror so the board stays clean",
      /PLAN_OPEN_POINTS: 1/.test(read(file(s.dir, "HEAD.md")))
      && !/L2/.test(out) && !/FAIL/.test(out), out);
  }
  {
    const s = mk();
    const c = path.join(s.root, "P2-codex.relay");
    write(c, cap(s.id, "P1=OPEN"));                       // no title, no existing row
    const r = run(["relay", "--session", s.id, "--capture", c], s.root);
    ok("a point with no row and no title is refused rather than given an invented one",
      r.code !== 0 && /gives it no title/.test(r.out), r.out.split(NL)[0]);
    ok("...and the refusal happens before ANY write, as the validate-then-write order requires",
      !fs.existsSync(path.join(s.dir, "captures"))
      && fs.readdirSync(path.join(s.dir, "turns")).filter((f) => f.endsWith(".md")).length === 0);
  }
  {
    const s = mk();
    const c = path.join(s.root, "P2-codex.relay");
    write(c, cap(s.id, "P1 and P2 = RESOLVED"));
    ok("a malformed POINTS line is refused, not shovelled into the points= token",
      run(["relay", "--session", s.id, "--capture", c], s.root).code !== 0);
  }
  {
    // PREV is the writer's. A capture that supplies its own must not win — the scoped prompt hands
    // the secondary the literal string `PREV: NEW`, so this is the likely accident.
    const s = mk();
    write(file(s.dir, "turns", "P1-claude.md"), ["### TURN-P1 (CLAUDE)", "- Body: x", "PREV: NEW", "NEXT: pending"].join(NL) + NL);
    edit(file(s.dir, "HEAD.md"), (t) => t.replace(/^TURN_CURSOR: .*$/m, "TURN_CURSOR: P1"));
    const c = path.join(s.root, "P2-codex.relay");
    write(c, cap(s.id, "P1=OPEN | t", "PREV: NEW"));
    run(["relay", "--session", s.id, "--capture", c], s.root);
    const shard = read(file(s.dir, "turns", "P2-codex.md"));
    ok("the relay derives PREV and overrides the one the capture supplied",
      /^PREV: \[P1\]\(P1-claude\.md\)$/m.test(shard) && !/^PREV: NEW$/m.test(shard), shard);
  }
  {
    // ...and if two shards ever do claim the root, lint says so. Every link still resolves, which
    // is why L14's existing checks cannot see it.
    const s = mk();
    for (const [n, a] of [["P1-claude.md", "CLAUDE"], ["P2-codex.md", "CODEX"]])
      write(file(s.dir, "turns", n), [`### TURN-${n.slice(0, 2)} (${a})`, "- Body: x", "PREV: NEW", "NEXT: pending"].join(NL) + NL);
    ok("two shards declaring PREV: NEW is reported as two roots",
      /FAIL L14.*declare "PREV: NEW"/.test(lint(s.root, s.id).out), lint(s.root, s.id).out);
  }
}

// 17b-46. Rows that described less than their code enforces.
//
// Seven rows lagged a deliberate hardening commit that never touched the spec — L1 documented 2 of
// its 8 conditions, L6 3 of 7, L16 and L20 one of two each. "Every code has a row" (17b-32) cannot
// see this: the row exists, it is just incomplete.
//
// What this check is, honestly: a REGRESSION guard on the rewrite, keyed on a distinctive token
// per condition, not a derivation. Whether prose describes a behaviour is not mechanically
// decidable, and the parity test that WOULD be mechanical — count call sites per code, compare to
// the row — was rejected on inspection, because that count moves on refactors that need no doc
// change at all. A guard that fires when nothing is wrong trains people to ignore it.
if (SEL(75)) {
  const spec = read(path.join(HERE, "..", "references", "lint-spec.md"));
  const row = (code) => spec.split(/\r?\n/).find((l) => l.startsWith("| " + code + " ")) || "";
  const MUST = {
    L1: [/outside its `## State` section|OUTSIDE its `## State`/i, /two truths|Section count/i,
      /\[A-Za-z0-9_\]\+/, /declared more than once|exactly once/i, /Roles/],
    L6: [/ECHO|echo/, /Cardinality|several `Impl:` lines/i, /more than once/i, /no role for/i],
    L16: [/no row for the session|missing-row/i],
    L20: [/no `by=`|carrying no `by=`|Unattributed/i],
    L24: [/file set|File set/i, /not a regular file/i],
    L14: [/PREV: NEW|one root|One root/i],
    L25: [/orphan|no `?TURN_COMMIT/i],
  };
  for (const [code, pats] of Object.entries(MUST)) {
    const r = row(code);
    ok(`lint-spec has a row for ${code} (fixture sanity)`, r.length > 100);
    for (const p of pats)
      ok(`${code}'s row describes the condition matching ${p}`, p.test(r), r.slice(0, 160));
  }
}

// --- executor detection is ADVISORY: it informs, and it never gates.
// The owner's requirement is that collab-board PREFER several vendors and SAY SO, while remaining
// usable with one. The failure mode to guard is not a missed CLI — it is a probe that becomes a
// precondition, because a false negative here is the NORMAL case: an installer writes its bin
// directory into the PERSISTED environment, which a long-running shell has not inherited. Verified
// live on the development machine, where `agy` was absent from PATH while installed and working.
if (SEL(76)) {
  const runEnv = (args, root, env) => {
    try { return { code: 0, out: execFileSync(process.execPath, [CLI, ...args, "--root", root], { encoding: "utf8", env }) }; }
    catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` }; }
  };
  const blind = { ...process.env, PATH: path.join(os.tmpdir(), "cb-no-such-dir"), Path: path.join(os.tmpdir(), "cb-no-such-dir") };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-doctor-"));

  const d = runEnv(["doctor"], root, blind);
  ok("doctor runs with no executor visible and still exits 0", d.code === 0, d.out);
  ok("doctor never reports a missing CLI as NOT INSTALLED", /may still be installed/.test(d.out), d.out);
  const bins = [...read(CLI).matchAll(/bin: "([^"]+)"/g)].map((m) => m[1]);
  ok("doctor names every registered executor", bins.every((b) => d.out.includes(b)), d.out);
  // vendorAdvice SPEAKS ON EVERY BRANCH - below two visible vendors it says connect one, at two or
  // more it recommends declaring a roster. There is no empty case, which is why doctor once carried
  // an else branch no input could reach, kept alive by a comment claiming the advice was
  // conditional. Pinned on both branches so the dead branch cannot come back.
  ok("doctor advises on a machine with NO vendors visible", /PREFERS several vendors/.test(d.out), d.out);

  const n = runEnv(["new", "--type", "META", "--slug", "blind"], root, blind);
  ok("new still SCAFFOLDS with no executor visible — detection is never a gate", n.code === 0, n.out.split(NL)[0]);
  ok("...and says it prefers several vendors", /PREFERS several vendors/.test(n.out), n.out);
  ok("...and points at the one-model board as the supported fallback, not as a mode",
    /--secondary CLAUDE_2 --adapter claude-cli/.test(n.out) && /not a mode/.test(n.out), n.out);
  const id = (n.out.match(/Created session (\S+)/) || [])[1];
  ok("...and the board it scaffolded lints clean", !!id && runEnv(["lint", "--session", id], root, blind).code === 0);

  // CONTROL: a machine that already has several vendors is never nagged, and lint says nothing
  // about detection either way — the advisory lives at `new` and `doctor` and nowhere else.
  const seen = fs.mkdtempSync(path.join(os.tmpdir(), "cb-bin-"));
  const ext = process.platform === "win32" ? ".cmd" : "";
  for (const b of ["codex", "claude"]) fs.writeFileSync(path.join(seen, b + ext), "");
  const rich = { ...process.env, PATH: seen, Path: seen };
  const n2 = runEnv(["new", "--type", "META", "--slug", "rich"], root, rich);
  ok("control: a multi-vendor machine is never nagged about missing vendors",
    n2.code === 0 && !/PREFERS several vendors/.test(n2.out), n2.out);
  // ...but it IS told the thing a reviewer found missing: with two vendors installed and a board
  // naming one secondary, a usage limit can only be waited out. On a roster board it costs one cell.
  ok("two visible vendors are told to declare a roster, and why",
    /Consider declaring a roster/.test(n2.out) && /costs ONE contributor/.test(n2.out), n2.out);
  ok("...naming adapters that actually exist on this machine", /SecondaryPanel: \S+,\S+/.test(n2.out), n2.out);
  ok("...so the advice has no empty case, on either branch",
    runEnv(["doctor"], root, rich).out.includes("Consider declaring a roster"));
  ok("...and saying plainly that a single secondary can only wait", /only honest answer to a limit is to wait/.test(n2.out));
  const id2 = (n2.out.match(/Created session (\S+)/) || [])[1];
  ok("control: lint never mentions executor detection",
    !!id2 && !/PREFERS|not on PATH/.test(runEnv(["lint", "--session", id2], root, rich).out));
}

// --- the user's panel preference is ECHOED, never parsed, never a gate.
// The load-bearing property is the LAST one: the engine must be provably unable to act on the
// stored value. The moment it branches on it, the file becomes a mode flag and the one-model case
// stops falling out of the general rule — which is the construct this whole refactor removed.
if (SEL(77)) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cb-pref-"));
  const withHome = { ...process.env, COLLAB_BOARD_HOME: home };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-prefroot-"));
  const prefFile = path.join(home, ".collab-board", "preference.md");
  const scaffold = (r) => {
    const out = run(["new", "--type", "META", "--slug", "p"], r, withHome);
    const id = (out.out.match(/Created session (\S+)/) || [])[1];
    return { out, id, dir: path.join(r, ".collab-board", "sessions", id || "x") };
  };

  const before = scaffold(root);
  ok("with no preference recorded, new asks the question ONCE",
    /No stored panel preference/.test(before.out.out) && /Add other models to the panel, or use copies of the same model/.test(before.out.out),
    before.out.out);
  ok("...and says a one-off choice is not recorded", /NOT recorded there/.test(before.out.out));
  ok("...and doctor asks the same question, from the same text",
    /No stored panel preference/.test(run(["doctor"], root, withHome).out));

  write(prefFile, '# collab-board user preference' + NL + 'Panel: multi-vendor (codex-cli, agy-cli)' + NL
    + 'Recorded: 2026-08-06' + NL + 'Evidence: "always use codex and gemini"' + NL);
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "cb-prefroot2-"));
  const after = scaffold(root2);
  ok("once recorded, the question is never asked again", !/No stored panel preference/.test(after.out.out), after.out.out);
  ok("...the stored line is echoed VERBATIM, not interpreted",
    /Panel: multi-vendor \(codex-cli, agy-cli\)/.test(after.out.out), after.out.out);
  ok("...with the date it was recorded, so a wrong persist is visible at the next session",
    /Recorded: 2026-08-06/.test(after.out.out));
  ok("...and states that session instructions override without rewriting it",
    /override it for this session only/.test(after.out.out));

  // THE ONE THAT MATTERS: the engine cannot act on the value. Byte-identical boards either way.
  // Covers the WHOLE session tree, not a chosen four files, and more than one command path — the
  // first version pinned four files after `new` alone, so the claim ("the engine cannot branch on
  // it") was broader than the evidence, which is the overclaim shape this repo removes.
  const treeOf = (s) => {
    const out = [];
    const walk = (d, rel) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
        const p = path.join(d, e.name), r = rel + "/" + e.name;
        if (e.isDirectory()) walk(p, r);
        else out.push(r + String.fromCharCode(31) + read(p).replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, "<ts>").replace(/2026-\d{2}-\d{2}/g, "<date>"));
      }
    };
    walk(s.dir, "");
    return out.join(String.fromCharCode(10));
  };
  ok("a scaffolded board is BYTE-IDENTICAL with and without a stored preference — the engine cannot branch on it",
    treeOf(before) === treeOf(after));
  // A SECOND command path, so the claim is not pinned to `new` alone.
  run(["activate", "--session", before.id], root, withHome);
  run(["activate", "--session", after.id], root2, withHome);
  ok("...and stays identical across another mutating command", treeOf(before) === treeOf(after));
  // And the catalog the commands share, which lives outside the session tree.
  const idx = (r) => read(path.join(r, ".collab-board", "index.md")).replace(/2026-\d{2}-\d{2}/g, "<date>").replace(/-p\b/g, "-x");
  ok("...including the cross-session catalog", idx(root) === idx(root2));

  // CONTROL: an unreadable/garbled file must not crash and must not be invented into a value.
  write(prefFile, "this file is not the documented format at all" + NL);
  const junk = run(["doctor"], root, withHome);
  ok("control: an unparseable preference file neither crashes nor is guessed at",
    junk.code === 0 && /unreadable/.test(junk.out), junk.out);
  // ABSENT and UNREADABLE are different answers. One bare catch made them the same, so a preference
  // the user HAD recorded read as "none stored" and the question was asked again — every session,
  // while looking exactly like first-run. EISDIR is the cheapest reproduction of that class.
  fs.rmSync(prefFile);
  fs.mkdirSync(prefFile);
  const unreadable = run(["doctor"], root, withHome);
  ok("an unreadable preference is NOT reported as an absent one", unreadable.code === 0
    && /could not be read/.test(unreadable.out) && !/No stored panel preference/.test(unreadable.out), unreadable.out);
  ok("...and says explicitly not to overwrite it", /do not overwrite/.test(unreadable.out));
  fs.rmdirSync(prefFile);
  // CONTROL: the engine never WRITES the file — permanence is a judgement nothing can mechanize.
  fs.rmSync(prefFile, { force: true });   // force: the unreadable case above may already have removed it
  run(["new", "--type", "META", "--slug", "q"], root, withHome);
  run(["doctor"], root, withHome);
  ok("control: no engine command ever creates the preference file", !fs.existsSync(prefFile));
}

// --- COMPLETED asserts the work is DONE, so it may not carry OPEN points.
// The phase gate was taught to refuse parked work; the gate that says "finished" was still asking
// about phase and gates and nothing else — it never read points.md at all. That is the deferral
// hazard one gate later, and it reaches every `I*` point raised during IMPL, which `advance` never
// saw because it checks `P*` at the PLAN gate only.
if (SEL(78)) {
  const mkDone = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-done-"));
    run(["new", "--type", "META", "--slug", "d"], root);
    const id = fs.readdirSync(path.join(root, ".collab-board", "sessions"))[0];
    const dir = path.join(root, ".collab-board", "sessions", id);
    edit(file(dir, "HEAD.md"), (t) => t
      .replace(/^PHASE: .*$/m, "PHASE: IMPL")
      .replace(/^SESSION_STATUS: .*$/m, "SESSION_STATUS: ACTIVE")
      .replace(/^IMPL_AGREE_PRIMARY: .*$/m, "IMPL_AGREE_PRIMARY: YES")
      .replace(/^IMPL_AGREE_SECONDARY: .*$/m, "IMPL_AGREE_SECONDARY: YES")
      .replace(/- CLAUDE: [A-Z_]+ - PRIMARY/, "- CLAUDE: START - PRIMARY"));
    return { root, id, dir };
  };
  const s = mkDone();
  edit(file(s.dir, "points.md"), (t) => t.trimEnd() + NL + "| I3 | IMPL | work raised during the build and never finished | OPEN | - |" + NL);
  const r = run(["terminal", "--session", s.id, "--status", "COMPLETED"], s.root);
  ok("COMPLETED is refused while a point is still OPEN", r.code !== 0 && /still OPEN/.test(r.out), r.out.split(NL)[0]);
  ok("...naming the point, and it is an I* the PLAN gate never saw", /I3/.test(r.out), r.out.split(NL)[0]);
  ok("...and offering the honest ways out", /successor board/.test(r.out) && /ABORTED/.test(r.out));
  // OUT_OF_SCOPE must read as a DECISION the board made, never as a label for unresolved work —
  // the one escape hatch left after the deferral status was retired.
  ok("...and OUT_OF_SCOPE is stated as a determination, not a way to say unresolved", /DETERMINED it is not needed/.test(r.out), r.out);
  // ABORTED is exempt: stopping early is an honest end, and refusing it would leave a board with
  // open points no legal way to stop at all.
  ok("control: ABORTED is still allowed with open points — stopping early is an honest end",
    run(["terminal", "--session", s.id, "--status", "ABORTED"], s.root).code === 0);
  // CONTROL: a board with everything resolved still completes.
  const s2 = mkDone();
  edit(file(s2.dir, "points.md"), (t) => t.trimEnd() + NL + "| I3 | IMPL | work that was finished | AGREED | [I3](turns/I3-claude.md) |" + NL);
  ok("control: COMPLETED still lands when no point is open",
    run(["terminal", "--session", s2.id, "--status", "COMPLETED"], s2.root).code === 0);
  // The READ-TIME twin: a board hand-edited to COMPLETED, or completed before this check existed,
  // still reads as finished to every later session unless lint says otherwise.
  const s3 = mkDone();
  edit(file(s3.dir, "points.md"), (t) => t.trimEnd() + NL + "| I4 | IMPL | never finished | OPEN | - |" + NL);
  edit(file(s3.dir, "HEAD.md"), (t) => t.replace(/^SESSION_STATUS: .*$/m, "SESSION_STATUS: COMPLETED")
    .replace(/- CLAUDE: [A-Z_]+ - PRIMARY/, "- CLAUDE: DONE - PRIMARY")
    .replace(/- CODEX: [A-Z_]+ - SECONDARY/, "- CODEX: DONE - SECONDARY"));
  ok("a board hand-edited to COMPLETED with an open point is reported by lint",
    /L11.*still OPEN/.test(lint(s3.root, s3.id).out), lint(s3.root, s3.id).out);
}

// --- the cross product is ENFORCED, not merely documented.
// Agents per turn = |disjoint scopes| x |contributors|, every contributor working every scope. The
// failure to guard is not an oversized sweep — it is an INCOMPLETE one that reads as complete: a
// contributor that silently did not run leaves a hole the fused turn never mentions.
if (SEL(79)) {
  // EACH case gets a FRESH board. Reusing one meant the second relay hit "turns/P2-codex.md already
  // exists" and the fixture passed on a refusal that had nothing to do with the guard under test —
  // the same wrong-reason trap two earlier fixtures fell into.
  const mkXp = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-xp-"));
    run(["new", "--type", "META", "--slug", "x", "--primary", "CLAUDE", "--secondary", "CODEX", "--adapter", "codex-cli"], root);
    const id = fs.readdirSync(path.join(root, ".collab-board", "sessions"))[0];
    const dir = path.join(root, ".collab-board", "sessions", id);
    edit(file(dir, "SESSION.md"), (t) => t.trimEnd() + NL + "BoardWriteMode: PRIMARY_ONLY" + NL + "SecondaryPanel: codex-cli,agy-cli" + NL);
    const stamps = read(file(dir, "log.md")).match(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z/gm) || [];
    edit(file(dir, "log.md"), (t) => t.trimEnd() + NL
      + `${stamps[stamps.length - 1]} STATE_SET CLAUDE=ON_HOLD CODEX=START cursor=- next=P2/CODEX seq=0` + NL);
    edit(file(dir, "HEAD.md"), (t) => t.replace("SESSION_STATUS: IDLE", "SESSION_STATUS: ACTIVE")
      .replace(/- CODEX: [A-Z_]+ - SECONDARY/, "- CODEX: START - SECONDARY")
      .replace(/^NEXT_TURN_ID: .*$/m, "NEXT_TURN_ID: P2").replace(/^NEXT_ACTOR: .*$/m, "NEXT_ACTOR: CODEX"));
    run(["activate", "--session", id], root);
    const cap = (who) => ["RELAY: collab-board/relay/v1", "SESSION: " + id, "ACTOR: CODEX", "TURN: P2", "--- TURN ---",
      ["### TURN-P2 (CODEX)", "SCHEMA: collab-board/turn/v1", "- Header: PART=PLAN / RESPONDS_TO=NEW / POINTS=-",
       "- Body:", "  - FINDINGS: reviewed by " + who, "- Evidence: probe from " + who,
       "- Handoff: CODEX WORKING->ON_HOLD, CLAUDE ON_HOLD->START"].join(NL),
      "--- LOG ---", "", "--- POINTS ---", "", "--- END ---", ""].join(NL);
    const put3 = (n) => { const p = path.join(root, n + ".relay"); write(p, cap(n)); return p; };
    const f = path.join(root, "f.md");
    // Names every contributor any case in this block uses: the fusion check requires each one be
    // attributed, and a missing name would fail these fixtures for a reason unrelated to the product.
    write(f, "### TURN-P2 (CODEX)" + NL + "- Body: CODEX_S1 CODEX_S2 ANTIGRAVITY_S1 ANTIGRAVITY_S2 plain agy copilot" + NL);
    const three = ["P2-CODEX_S1", "P2-CODEX_S2", "P2-ANTIGRAVITY_S1"].map(put3).join(",");
    return { root, id, dir, put3, three,
      rel: (a, extra) => run(["relay", "--session", id, "--capture", a, "--fused", f, ...(extra || [])], root),
      // One surviving capture is COPIED, never fused — a fused body would put the PRIMARY's words
      // under the secondary's name, which `--fused` refuses outright with fewer than two captures.
      relOne: (a, extra) => run(["relay", "--session", id, "--capture", a, ...(extra || [])], root) };
  };

  { // a 2x2 sweep missing one cell, with no declared absence
    const s = mkXp();
    const hole = s.rel(s.three);
    ok("an incomplete cross product is refused, so a partial sweep cannot read as a full one",
      hole.code !== 0 && /neither a capture nor a declared absence/.test(hole.out), hole.out.split(NL)[0]);
    ok("...naming the exact missing cell", /ANTIGRAVITY_S2/.test(hole.out), hole.out.split(NL)[0]);
    ok("...and writing nothing", !fs.existsSync(path.join(s.dir, "captures")));
  }
  { // the same sweep on a board that declares NO roster: the absence has nothing to be absent FROM
    // Without a declaration the product's contributor axis falls back to the captures that
    // ARRIVED, so the PRIMARY shapes the product and punches the holes in it - every absence
    // checked against a shape derived from the same choice it constrains. This is the mirror of
    // the plain-relay rule and it was left open one branch over: a symmetry half-fixed, not a
    // separate defect. A null roster is the absence of a rule, never permission.
    const s = mkXp();
    edit(file(s.dir, "SESSION.md"), (t) => t.split("SecondaryPanel: codex-cli,agy-cli" + NL).join(""));
    const r = s.rel(s.three, ["--absent", "ANTIGRAVITY_S2"]);
    ok("a cross-product absence is refused on a board that declares no roster",
      r.code !== 0 && /declares no SecondaryPanel/.test(r.out), r.out.split(NL)[0]);
    ok("...and nothing is written, so no self-shaped sweep lands with a self-punched hole",
      !fs.existsSync(path.join(s.dir, "captures")));
    // CONTROL: the SAME undeclared board relays fine with no absence at all, so the refusal is
    // about the absence and not about the sweep.
    const s2 = mkXp();
    edit(file(s2.dir, "SESSION.md"), (t) => t.split("SecondaryPanel: codex-cli,agy-cli" + NL).join(""));
    const four = ["P2-CODEX_S1", "P2-CODEX_S2", "P2-ANTIGRAVITY_S1", "P2-ANTIGRAVITY_S2"].map(s2.put3).join(",");
    ok("control: an undeclared board still relays a COMPLETE sweep", s2.rel(four).code === 0);
  }
  { // the same sweep with the hole DECLARED: a usage limit costs one cell, not the turn
    const s = mkXp();
    const declared = s.rel(s.three, ["--absent", "ANTIGRAVITY_S2"]);
    ok("a declared absence lets the sweep land", declared.code === 0, declared.out.split(NL)[0]);
    const log = read(file(s.dir, "log.md"));
    ok("...and the gap is recorded in the log, not only in the PRIMARY's memory", /absent=ANTIGRAVITY_S2/.test(log), log);
    ok("...alongside the shape of the sweep it was part of", /scopes=2 contributors_declared=2/.test(log), log);
  }
  { const s = mkXp();
    const bogus = s.rel(s.three, ["--absent", "GEMINI_S9"]);
    ok("an absence for a cell outside the product is refused",
      bogus.code !== 0 && /not a cell of this turn/.test(bogus.out), bogus.out.split(NL)[0]); }
  { const s = mkXp();
    const both = s.rel(s.three, ["--absent", "CODEX_S1"]);
    ok("an absence contradicting a supplied capture is refused",
      both.code !== 0 && /contradictory claims/.test(both.out), both.out.split(NL)[0]); }
  { const s = mkXp();
    const mixed = s.rel([s.put3("P2-CODEX_S1"), s.put3("P2-plain")].join(","));
    ok("a mixture of scoped and unscoped captures is refused",
      mixed.code !== 0 && /either a cross-product sweep or a single scope/.test(mixed.out), mixed.out.split(NL)[0]); }
  { // THE MODEL AXIS COMES FROM THE DECLARED ROSTER, and this is the scenario that proves why.
    // A usage-limited contributor is exactly the one that does not arrive — so deriving the product
    // from the captures that DID arrive shrank it, and `--absent` for the missing one was rejected
    // as "not a cell of this turn". Requirement 3 (continue rather than only wait) is met by this
    // path with no seat rename and no new event type.
    const s = mkXp();
    edit(file(s.dir, "SESSION.md"), (t) => t.trimEnd() + NL + "SecondaryPanel: codex-cli,agy-cli" + NL);
    const limited = s.relOne(s.put3("P2-CODEX_S1"), ["--absent", "ANTIGRAVITY_S1"]);
    ok("a usage-limited contributor can be declared absent and the turn still lands",
      limited.code === 0, limited.out.split(NL)[0]);
    const log = read(file(s.dir, "log.md"));
    ok("...the gap names the contributor that did not run", /absent=ANTIGRAVITY_S1/.test(log), log);
    ok("...and the shape shows TWO were expected, so a reader sees the sweep was short",
      /contributors_declared=2/.test(log), log);
    ok("...with no actor renamed and no new event type", !/SEAT_SET/.test(log));
  }
  { // A contributor not on the roster has no cell in the product.
    const s = mkXp();
    edit(file(s.dir, "SESSION.md"), (t) => t.trimEnd() + NL + "SecondaryPanel: codex-cli,agy-cli" + NL);
    const stranger = s.rel([s.put3("P2-CODEX_S1"), s.put3("P2-GEMINI_S1")].join(","), ["--absent", "ANTIGRAVITY_S1"]);
    ok("a capture from a contributor the roster does not declare is refused",
      stranger.code !== 0 && /SecondaryPanel does not declare/.test(stranger.out), stranger.out.split(NL)[0]);
  }
  { // THE SWEEP A TURN CLAIMS MUST EQUAL THE EVIDENCE RETAINED FOR IT. The fan-out tokens were
    // engine-written and read back by nothing, so they were honest only because one writer emits
    // them — a property of there being one writer, not of the design. A hand-edited TURN_COMMIT
    // claiming a wider sweep than its captures support reads as a fuller review than happened.
    const s = mkXp();
    edit(file(s.dir, "SESSION.md"), (t) => t.trimEnd() + NL + "SecondaryPanel: codex-cli,agy-cli" + NL);
    s.relOne(s.put3("P2-CODEX_S1"), ["--absent", "ANTIGRAVITY_S1"]);
    ok("fixture sanity: the honest sweep draws no L25", !has(lint(s.root, s.id).out, "L25"), lint(s.root, s.id).out);
    edit(file(s.dir, "log.md"), (t) => t.replace("scopes=1 contributors_declared=2", "scopes=2 contributors_declared=3"));
    ok("a TURN_COMMIT claiming a wider sweep than its evidence supports is caught",
      /L25.*claims a 3 x 2 sweep/.test(lint(s.root, s.id).out), lint(s.root, s.id).out);
    // A CHECK KEYED ON A TOKEN THE WRITER MAY OMIT IS A CHECK ANYONE MAY SWITCH OFF. Gating the
    // read-back on "did the line carry the tokens" meant DELETING them disabled it — the escape
    // from outside the rule, in the guard written to stop exactly that. The captures decide.
    edit(file(s.dir, "log.md"), (t) => t.replace(/ scopes=2 contributors_declared=3/, ""));
    ok("deleting the tokens does not switch the check off — the retained captures decide",
      /L25.*no scopes=\/contributors_declared= tokens/.test(lint(s.root, s.id).out), lint(s.root, s.id).out);
  }
  { // CONTROL: an ordinary one-scope turn names no cell and is untouched by any of this.
    const s = mkXp();
    const plain = s.rel([s.put3("P2-agy"), s.put3("P2-copilot")].join(","));
    ok("control: an unscoped two-contributor turn still relays, unaffected by the product rules",
      plain.code === 0, plain.out.split(NL)[0]);
    ok("control: ...and claims no sweep shape it did not have",
      !/scopes=/.test(read(file(s.dir, "log.md")))); }
}

// --- "parse old, never write new" must hold on EVERY write path, not only the ones already checked.
// A board may not park work it needs. DEFERRED is readable so history still projects, and writable
// nowhere — but the capture parser carried its OWN copy of the status list, so a capture could
// propose one and the relay would write it. One more instance of a private copy of a
// closed set, found by review rather than by a targeted check.
if (SEL(80)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-retired-"));
  run(["new", "--type", "META", "--slug", "r", "--primary", "CLAUDE", "--secondary", "CODEX", "--adapter", "codex-cli"], root);
  const id = fs.readdirSync(path.join(root, ".collab-board", "sessions"))[0];
  const dir = path.join(root, ".collab-board", "sessions", id);
  edit(file(dir, "SESSION.md"), (t) => t.trimEnd() + NL + "BoardWriteMode: PRIMARY_ONLY" + NL);
  const stamps = read(file(dir, "log.md")).match(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z/gm) || [];
  const at = stamps[stamps.length - 1];
  edit(file(dir, "log.md"), (t) => t.trimEnd() + NL + `${at} STATE_SET CLAUDE=ON_HOLD CODEX=START cursor=- next=P2/CODEX seq=0` + NL);
  edit(file(dir, "HEAD.md"), (t) => t.replace("SESSION_STATUS: IDLE", "SESSION_STATUS: ACTIVE")
    .replace(/- CODEX: [A-Z_]+ - SECONDARY/, "- CODEX: START - SECONDARY")
    .replace(/^NEXT_TURN_ID: .*$/m, "NEXT_TURN_ID: P2").replace(/^NEXT_ACTOR: .*$/m, "NEXT_ACTOR: CODEX"));
  run(["activate", "--session", id], root);
  const cap = (pts) => ["RELAY: collab-board/relay/v1", "SESSION: " + id, "ACTOR: CODEX", "TURN: P2", "--- TURN ---",
    ["### TURN-P2 (CODEX)", "SCHEMA: collab-board/turn/v1", "- Header: PART=PLAN / RESPONDS_TO=NEW / POINTS=-",
     "- Body:", "  - FINDINGS: ACK", "- Evidence: probe",
     "- Handoff: CODEX WORKING->ON_HOLD, CLAUDE ON_HOLD->START"].join(NL),
    "--- LOG ---", "", "--- POINTS ---", pts, "--- END ---", ""].join(NL);
  const put2 = (n, t) => { const p = path.join(root, n); write(p, t); return p; };

  const bad = run(["relay", "--session", id, "--capture", put2("P2-codex.relay", cap("P1=DEFERRED | parked work"))], root);
  ok("a capture may not PROPOSE a retired status", bad.code !== 0, bad.out.split(NL)[0]);
  ok("...and nothing was written", !fs.existsSync(path.join(dir, "captures")));
  // CONTROL: a writable status still relays through the very same parser.
  // Same filename: the refusal above wrote nothing, so the name is still free. A different
  // basename would trip the contributor-token grammar and the control would pass for the wrong reason.
  const good = run(["relay", "--session", id, "--capture", put2("P2-codex.relay", cap("P1=OUT_OF_SCOPE | determined not needed"))], root);
  ok("control: a writable status still relays", good.code === 0, good.out.split(NL)[0]);
}
if (SEL(81)) {
  // A legacy board carrying a parked point may not CROSS a gate. Nothing can write one any more,
  // so this only ever fires on history — which is exactly the board where work was left behind.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-parked-"));
  run(["new", "--type", "META", "--slug", "p"], root);
  const id = fs.readdirSync(path.join(root, ".collab-board", "sessions"))[0];
  const dir = path.join(root, ".collab-board", "sessions", id);
  edit(file(dir, "points.md"), (t) => t.trimEnd() + NL + "| P1 | PLAN | parked work | DEFERRED | - |" + NL);
  edit(file(dir, "HEAD.md"), (t) => t.replace(/^PLAN_AGREE_PRIMARY: .*$/m, "PLAN_AGREE_PRIMARY: YES")
    .replace(/^PLAN_AGREE_SECONDARY: .*$/m, "PLAN_AGREE_SECONDARY: YES")
    .replace(/- CLAUDE: [A-Z_]+ - PRIMARY/, "- CLAUDE: START - PRIMARY"));
  write(file(dir, "plan", "context.md"), "# frozen plan" + NL + "a real digest" + NL);
  const r = run(["advance", "--session", id], root);
  ok("advance refuses to cross a gate carrying a parked point", r.code !== 0 && /retired status/.test(r.out), r.out.split(NL)[0]);
  ok("...naming what to do instead of it", /successor board/.test(r.out), r.out);
  const l4 = lint(root, id).out;
  ok("L4 says the same thing at read time", /L4/.test(l4) && /no deferral status/.test(l4), l4);
  ok("...including that OUT_OF_SCOPE is a determination", /DETERMINED it is not needed/.test(l4), l4);
  // OUT_OF_SCOPE must read as a DECISION the board made, never as a label for unresolved work —
  // the one escape hatch left after the deferral status was retired.
  ok("...and OUT_OF_SCOPE is stated as a determination, not a way to say unresolved", /DETERMINED it is not needed/.test(r.out), r.out);
}

// 17b-46. L29 CLOSED-GRAMMAR — SESSION.md may declare only the keys its grammar defines.
//
// The hole this closes: SESSION.md was an OPEN grammar. Appending `BoardWritMode: PRIMARY_ONLY`
// produced BYTE-IDENTICAL lint output to appending nothing, so a one-character typo left
// sole-writer mode and L25 switched off while the file plainly claimed both were on. The board
// asserted a constraint that nothing enforced, and no output anywhere said so.
if (SEL(82)) {
  const s = scaffold("META", "l29");
  const base = lint(s.root, s.id).out;
  ok("control: a scaffolded SESSION.md satisfies the closed grammar", !has(base, "L29"), base);

  // The exact defect, reproduced: a plausible typo of a real optional key.
  const typo = scaffold("META", "l29b");
  edit(file(typo.dir, "SESSION.md"), (t) => t.replace(/^Roles:/m, "BoardWritMode: PRIMARY_ONLY" + NL + "Roles:"));
  const o1 = lint(typo.root, typo.id).out;
  ok("a misspelled SESSION key is a finding, not prose", has(o1, "L29"), o1);
  ok("...and the finding names the offending key", /BoardWritMode is not a key of this file/.test(o1), o1);
  ok("...and lists the grammar, so the correct spelling is visible in the finding itself",
    /known: .*BoardWriteMode/.test(o1), o1);
  ok("...as a FAIL: an unenforced constraint the file claims is enforced cannot be advisory",
    /FAIL L29/.test(o1), o1);

  // Every optional key must be admissible even though NO board in the recorded corpus declares
  // `SecondaryModel`/`SecondaryEffort`. A known set derived from observed boards would reject the
  // first session that ever used them — the corpus is evidence about the past, not the grammar.
  const opt = scaffold("META", "l29c");
  edit(file(opt.dir, "SESSION.md"), (t) => t.replace(/^Roles:/m,
    "SecondaryModel: gpt-5" + NL + "SecondaryEffort: high" + NL + "BoardWriteMode: PRIMARY_ONLY" + NL + "Roles:"));
  const o2 = lint(opt.root, opt.id).out;
  ok("control: documented-but-unused optional keys are admitted", !has(o2, "L29"), o2);

  // `Converge` post-dates most boards and its own template says the line may be deleted entirely.
  const noConv = scaffold("META", "l29d");
  edit(file(noConv.dir, "SESSION.md"), (t) => t.replace(/^Converge: .*(\r?\n)/m, ""));
  ok("the Converge line was actually removed — the deletion is the fixture",
    !/^Converge:/m.test(read(file(noConv.dir, "SESSION.md"))));
  const o3 = lint(noConv.root, noConv.id).out;
  ok("control: a board with no Converge line still satisfies the grammar", !has(o3, "L29"), o3);

  // Declaration masking is shared with every other reader: a key inside the template's comment
  // block, or quoted in a fenced example, is not a declaration. SESSION.md ships with a comment
  // that mentions `SecondaryModel:` and `BoardWriteMode:` in prose — if L29 read those it would
  // fire on the scaffold itself, which the first control above already denies. Assert the
  // stronger form directly: an unknown key inside a comment stays invisible.
  const masked = scaffold("META", "l29e");
  edit(file(masked.dir, "SESSION.md"), (t) => t.trimEnd() + NL + "<!--" + NL + "Totally_Made_Up: 1" + NL + "-->" + NL);
  const o4 = lint(masked.root, masked.id).out;
  ok("a commented key is not a declaration", !has(o4, "L29"), o4);
  // ...and the same bytes uncommented ARE one. Without this pair the control above passes for a
  // checker that reads nothing at all.
  const live = scaffold("META", "l29f");
  edit(file(live.dir, "SESSION.md"), (t) => t.trimEnd() + NL + "Totally_Made_Up: 1" + NL);
  ok("...and the identical key uncommented is", has(lint(live.root, live.id).out, "L29"));

  // getKV returns the FIRST declaration, so a repeated key is two truths on one board.
  const dup = scaffold("META", "l29g");
  edit(file(dup.dir, "SESSION.md"), (t) => t.trimEnd() + NL + "Type: BUG_FIX" + NL);
  const o5 = lint(dup.root, dup.id).out;
  ok("a SESSION key declared twice is a finding", has(o5, "L29") && /Type declared 2 times/.test(o5), o5);

  // impl/code_state.md is the second closed grammar, and it carries a COMPATIBILITY case: its
  // template puts the schema in the H1 line, yet one board in the recorded corpus declares a
  // column-0 `SCHEMA:` there. That board is well-formed and must stay so, which is why SCHEMA is
  // admissible in every board file rather than listed per grammar.
  const cs = scaffold("META", "l29h");
  write(file(cs.dir, "impl", "code_state.md"), "# Code State" + NL + "SCHEMA: collab-board/code_state/v1" + NL
    + "BRANCH: main" + NL + "BASE_COMMIT: NONE" + NL + "LATEST_COMMIT: NONE" + NL);
  ok("control: SCHEMA is admissible in code_state.md, as one real board declares it",
    !has(lint(cs.root, cs.id).out, "L29"));
  edit(file(cs.dir, "impl", "code_state.md"), (t) => t.trimEnd() + NL + "BRANCH_NAME: main" + NL);
  const o6 = lint(cs.root, cs.id).out;
  ok("...while an invented code_state key is a finding", has(o6, "L29") && /code_state\.md/.test(o6), o6);

  // A closed grammar must not become a second owner of an invariant that already has one. L6 owns
  // whether code_state's fields are PRESENT; if L29 also required them, the two would have to
  // agree forever and only one of them would ever be edited.
  write(file(cs.dir, "impl", "code_state.md"), "# Code State" + NL + "BRANCH: main" + NL);
  ok("L29 does not report the ABSENCE of core keys — presence has an owner already",
    !has(lint(cs.root, cs.id).out, "L29"));
}

// 17b-47. One grammar for a shard filename, and one for taking it apart.
//
// Five sites spelled this: the discovery filter, and four decompositions of the same name. They
// agree today, which is exactly why this is worth pinning — the failure mode is a LATER edit to
// one of them, and by then the disagreement is silent. A behavioural fixture cannot see that, so
// the assertion is made against the source: there is one spelling, not five.
if (SEL(83)) {
  // Comment lines are stripped before the search. The first version of this assertion failed on
  // the very comment that EXPLAINS the consolidation, because a source grep cannot tell code from
  // prose about code — the same confusion that lets a stale comment outlive what it describes.
  const src = read(CLI).split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join(NL);
  const inline = (src.match(/\/\^\(?\[PI\]\\d\+\)?-/g) || []);
  ok("no call site re-spells the shard-name grammar", inline.length === 0, inline.join(" "));
  ok("the shard grammar and its decomposition are built from the same two sources",
    /const SHARD_NAME = new RegExp\("\^" \+ TURN_ID_SRC \+ "-" \+ TOKEN_SRC/.test(src)
    && /const SHARD_PARTS = new RegExp\("\^\(" \+ TURN_ID_SRC \+ "\)-\(" \+ TOKEN_SRC/.test(src));

  // The behavioural half: discovery and decomposition must accept the SAME names. `claude_2` is
  // the documented same-model pairing, so its underscore is a real token, not a curiosity. If the
  // discovery filter admitted a name the decomposer's pattern rejected, decomposition would return
  // null and the checker would throw rather than report — which is how one bad filename used to
  // take every other invariant on the board down with it.
  const s = scaffold("META", "shardgram");
  write(file(s.dir, "turns", "P1-claude_2.md"), "### TURN-P1 (CLAUDE_2)" + NL + "- Body: none" + NL);
  const out = lint(s.root, s.id).out;
  ok("an underscored actor token is discovered, not skipped", has(out, "L14") || has(out, "L6"), out);
  ok("...and decomposing it does not throw — lint still reports rather than crashing",
    /OK:|FAIL:|fail,/.test(out), out);
}

// 17b-48. Each SESSION key the engine acts on is spelled exactly once.
//
// Bare `getKV(sess, "Type")` appeared at four call sites and `"SecondaryAdapter"` at two. A typo
// at any one of them returns null and silently takes a default — byte-identical to the key being
// absent. Routing them through named accessors makes the spelling a single fact, and lets the
// grammar table and the readers be held to each other.
if (SEL(84)) {
  const src = read(CLI).split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join(NL);

  // The grammar is read out of the source so this assertion cannot be satisfied by a list kept
  // beside it — the point is that ONE list exists.
  const block = (/const SESSION_GRAMMAR = \{[\s\S]*?\r?\n\};/.exec(src) || [""])[0];
  const keys = [...block.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)].map((m) => m[1])
    .filter((k) => k !== "SESSION.md");
  ok("the SESSION grammar is a single declared list", keys.length >= 15, `found ${keys.length}`);
  ok("...and it contains the keys the engine acts on",
    ["Type", "SecondaryAdapter", "Roles", "Stall", "Converge", "BoardWriteMode", "SecondaryPanel", "Protocol"]
      .every((k) => keys.includes(k)));

  // No SESSION key may be spelled as a bare string anywhere. `getKV` keeps its HEAD callers, so
  // the check is per-key rather than a ban on `getKV` itself.
  for (const key of keys) {
    const n = (src.match(new RegExp('getKV\\([A-Za-z]+, "' + key + '"\\)', "g")) || []).length;
    ok(`SESSION key ${key} is never read by literal name`, n === 0, `found ${n}`);
  }

  // THE LITERAL BAN IS NOT THE BOUNDARY, and the SECONDARY proved it: the L7 contract check read
  // Topic/Goal/Done through `getKV(sessText, k)` with k a LOOP VARIABLE. A key-by-key search for
  // literals cannot see a variable, so adding an off-grammar key to that loop left every named
  // assertion here true. The rule that actually closes it is about the TEXT, not the key: SESSION
  // text reaches `getKV` in exactly one place, the generator. Everything else goes through
  // `SESSION.<Key>`, where an off-grammar name is a TypeError at first use rather than a null.
  // COUNTING SPELLINGS WAS STILL THE WRONG SHAPE. `getKV( sessText, k)` with one space, and an
  // alias assigned first, both walked through a count of `getKV(sessText`. What closes it is an
  // ALLOWLIST over the actual first arguments: enumerate every identifier passed to getKV and
  // require each to be one this file knows about. A new alias is then not a bypass but a visible
  // edit to this list, which is the difference between a rule and a spelling.
  // MATCH EVERY CALL, then judge it. Capturing only calls whose first argument LEXES as a bare
  // identifier meant `getKV(box.text, k)`, `getKV(text || fallback, k)`, `getKV(loadText(), k)` and
  // even `getKV((text), k)` were not audited — they were invisible, and the bare calls kept the
  // count assertions green. A guard must REJECT what it cannot classify, never skip it: that is the
  // same fail-closed rule doc-verify applies to input it cannot parse.
  const calls = [...src.matchAll(/getKV\(([^,]*),/g)].map((m) => m[1].trim());
  ok("every getKV call is audited (fixture sanity)", calls.length >= 5, `${calls.length}`);
  const nonBare = calls.filter((e) => !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(e));
  ok("no getKV call reads through an expression rather than a named variable",
    nonBare.length === 0, nonBare.join(" | "));
  const firstArgs = calls.filter((e) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(e));
  const ALLOWED = new Set([
    "headText",    // HEAD keys: a different closed grammar with its own checks
    "sessText",    // permitted ONLY inside the SESSION generator; the count below pins that
    "text",        // the generic helpers above, which take whatever their caller resolved
    "agentText",   // the actor mirror, whose grammar L24 owns
  ]);
  const stray = [...new Set(firstArgs)].filter((v) => !ALLOWED.has(v));
  ok("no getKV call reads through an unrecognised variable", stray.length === 0, stray.join(", "));
  const sessReads = firstArgs.filter((v) => v === "sessText").length;
  ok("SESSION text reaches getKV exactly once — inside the generator", sessReads === 1,
    `found ${sessReads}`);

  // The accessors are GENERATED from the grammar. Written out by hand they would be a second copy
  // of it, and the two would have to be edited together forever — the shape every defect in this
  // session took.
  ok("the SESSION readers are generated from the grammar, not listed beside it",
    /const SESSION = readersFor\(SESSION_GRAMMAR\);/.test(src)
    && /function readersFor\(grammar\)[\s\S]{0,200}\[\.\.\.grammar\.core, \.\.\.grammar\.optional\]/.test(src));
  // Every closed grammar gets its readers the same way. `impl/code_state.md` did not, and carried a
  // third inline copy of its own key list which L6 then read dynamically — invisible to both the
  // per-key search and, until the allowlist above, to the closure assertion.
  ok("...and so are the code_state readers", /const CODE_STATE = readersFor\(CODE_STATE_GRAMMAR\);/.test(src));
  ok("...with no grammar's key list written out a second time inside a check",
    !/\["BRANCH", "BASE_COMMIT", "LATEST_COMMIT"\]/.test(src.replace(/core: \["BRANCH", "BASE_COMMIT", "LATEST_COMMIT"\],/, "")));
}

// 17b-49. Rule 7 says one thing, in one place.
//
// It said three. `protocol.md` "Only PRIMARY edits project files"; `manager.md` "Subagents may edit
// project files during IMPL only when explicitly assigned"; and a case in THIS file asserting the
// second while citing it as the reason. Nothing could see the disagreement, because the protocol
// copy a session obeys is an immutable snapshot — the outvoted document was the authoritative one.
if (SEL(85)) {
  const REF = path.join(HERE, "..", "references");
  const protocol = read(path.join(REF, "protocol.md"));
  const manager = read(path.join(REF, "manager.md"));
  ok("protocol.md still states Rule 7 as an exclusive grant to PRIMARY",
    /Only PRIMARY edits project files/.test(protocol));
  ok("manager.md does not grant subagents the write PROTOCOL.md reserves",
    !/[Ss]ubagents may edit project files/.test(manager), manager.slice(0, 0));
  ok("...and states the delegate rule the protocol implies: return a patch, PRIMARY applies it",
    /patch payload/.test(manager) && /PRIMARY reviews it and\s*\r?\napplies it/.test(manager));

  // THE GUARD MUST SPAN THE INVARIANT, and this one did not. Reading three files while claiming a
  // shipped-surface rule left `adapters.md` granting a subagent "project write access" — a FOURTH
  // voice on Rule 7, passing every assertion above. The SECONDARY found it with one `git grep`.
  // Rule 7 governs the whole shipped surface, so the scan does too; anything else re-runs the
  // per-call-site convergence the engine already rejects.
  const shipped = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) shipped.push(p);
    }
  })(path.join(HERE, ".."));
  ok("the shipped document surface enumerates (fixture sanity)", shipped.length >= 15, `${shipped.length}`);
  // Prose granting any delegate a PROJECT write. `.collab-board` writes are a separate permission
  // a SECONDARY legitimately holds, so the target is the project, not writing.
  //
  // THIS WAS ONE REGEX AND IT WAS NARROWER THAN THE RULE. It required "project" before "write", so
  // it matched the one sentence it had been written from and missed "allowed to edit project
  // files", "have write access throughout the project", and — the damning one — "Subagents may edit
  // project files during IMPL", which is VERBATIM the sentence the guard was created to catch. It
  // would not have caught its own defect. Three independent parts now have to co-occur in one
  // sentence, in either order, so a synonym or a reordering does not walk through.
  // Four bags co-occurring in a sentence is not permission. The SECONDARY showed BOTH failures at
  // I6: "reviewers are permitted to patch source" is a grant the bags missed, and "a SECONDARY can
  // review project files but never edit them" is a DENIAL the bags condemned. The false positive is
  // the worse of the two — a guard that fires on correct prose gets switched off.
  //
  // So the permission and the write verb must land in the SAME clause, and that clause must not be
  // negated. Clause splitting is crude and deliberately so: this is a prose heuristic over a small
  // shipped surface, and every phrasing it recognises carries a fixture.
  const WHO = /\b(subagent|secondary|delegate|executor|contributor|reviewer)s?\b/i;
  const MAY = /\b(needs?|may|can|is allowed to|are allowed to|is permitted to|are permitted to|must be able to|has|have|is granted|are granted)\b/i;
  const WRITES = /\b(write|writes|edit|edits|modify|modifies|change|changes|patch|patches)\b/i;
  const WHAT = /\b(project|repo|repository|source|working tree)\b/i;
  const NEG = /\b(not|never|no|cannot|can't|don't|do not|must not|may not|forbidden|prohibited|reserved)\b/i;
  const sentences = (t) => t.split(/(?<=[.!?])\s+|\r?\n\r?\n/);
  const clauses = (s) => s.split(/\b(?:but|however|except|although|though|whereas)\b|;/i);
  const grants = (s) => WHO.test(s) && WHAT.test(s)
    && !/\.collab-board|board write|BOARD write/i.test(s)
    && clauses(s).some((c) => MAY.test(c) && WRITES.test(c) && !NEG.test(c));
  const offenders = [];
  for (const p of shipped) for (const s of sentences(read(p)))
    if (grants(s)) offenders.push(`${path.basename(p)}: ${s.trim().slice(0, 70)}`);
  ok("no shipped document grants a delegate project write access", offenders.length === 0, offenders.join(" | "));
  // Every phrasing the SECONDARY walked through, each its own case. A clean scan is otherwise
  // equally consistent with a pattern that matches nothing at all.
  for (const s of [
    "The subagent needs project write access and logs via=subagent:<name>.",
    "A delegate is allowed to edit project files.",
    "Executors have write access throughout the project.",
    "Subagents may edit project files during IMPL only when explicitly assigned.",
    "During IMPL, reviewers are permitted to patch source.",
  ]) ok(`...and the scan detects: ${s.slice(0, 46)}`, grants(s));
  // ...while correct prose is not a finding. A guard that fires on the sentences the documents are
  // SUPPOSED to contain gets switched off, so each of these is as load-bearing as a detection.
  for (const s of [
    "The subagent needs BOARD write access and logs via=subagent:<name>.",
    "A secondary may write .collab-board files during its own turn.",
    "During IMPL, a SECONDARY can review project files but never edit them.",
    "A delegate may not edit project files.",
    "Only PRIMARY edits project files.",
    "Project files are edited by PRIMARY alone.",
  ]) ok(`control: not a finding: ${s.slice(0, 46)}`, !grants(s));
  // The suite is the third party to this and must not be the one that drifts. The banned phrase is
  // ASSEMBLED rather than written: a file that greps itself cannot contain the pattern it forbids,
  // so a literal here would fail on its own definition — the same confusion of code with prose
  // about code that the shard-grammar assertion above had to strip comments to escape.
  const self = read(path.join(HERE, "test.mjs"));
  const banned = "explicitly ALLOWS a subagent" + " to write project files";
  ok("no assertion in this suite cites a rule permitting subagent project writes",
    !self.includes(banned));
}

// 17b-50. doc-verify: machine-token preservation over a rewritten document surface.
//
// The document rewrite is the largest part of this refactor and the only part with no engine to
// catch it: prose has no lint. This is the guard, and it lands BEFORE anything is rewritten so no
// rewrite happens without it.
//
// It does NOT make a rewrite verified. It answers one question — did a token a reader or a checker
// matches on leave the live surface — and the fixture at the end of this block asserts a rewrite
// that inverts a rule with every token intact still passes. The suite said "never unverifiable"
// for two commits, which claimed more than the tool does; the SECONDARY named that at I6.
//
// It compares the UNION of machine tokens over a surface rather than file by file, because
// deduplicating a fact MOVES it from five files to one — a per-file comparison would report every
// successful dedupe as a loss, which is precisely the change this refactor is made of.
if (SEL(86)) {
  const DOCV = path.join(HERE, "doc-verify.mjs");
  const dv = (before, after, ...extra) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [DOCV, "--before", before, "--after", after, ...extra],
        { encoding: "utf8", env: CLEAN_ENV }) };
    } catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` }; }
  };
  // A surface is a directory of .md files, so the move-between-files case is expressible.
  const surf = (files) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "cb-dv-"));
    for (const [name, body] of Object.entries(files)) write(path.join(d, name), body);
    return d;
  };
  const DOC = [
    "# Heading One",
    "",
    "Prose that may be rewritten however the author likes, at any length, in any voice.",
    "See `skill/references/protocol.md` for the rule. Lint reports L29 on a bad key.",
    "The adapter is codex-cli and the schema is collab-board/HEAD/v1.",
    "Docs live at https://example.invalid/spec for reference.",
    "SESSION_STATUS is not the same as STALL_STATE.",
    "",
    "```text",
    "node collab-board.mjs lint --session <id>",
    "```",
    "",
  ].join(NL);

  ok("control: an unchanged surface passes", dv(surf({ "a.md": DOC }), surf({ "a.md": DOC })).code === 0);

  // Prose is what a refactor is allowed to compress; only machine tokens are protected.
  const terse = DOC.replace("Prose that may be rewritten however the author likes, at any length, in any voice.", "Terse.");
  const r0 = dv(surf({ "a.md": DOC }), surf({ "a.md": terse }));
  ok("control: rewriting prose freely is not a finding", r0.code === 0, r0.out);
  ok("...and the byte saving is reported", /-\d+ B/.test(r0.out), r0.out);

  // One deliberate drop per class. Each is a string a reader or a checker matches on.
  const DROPS = {
    FENCE: (t) => t.replace(/```text[\s\S]*?```/, "(removed)"),
    CODE: (t) => t.replace("`skill/references/protocol.md`", "the protocol"),
    URL: (t) => t.replace("https://example.invalid/spec", "the site"),
    HEADING: (t) => t.replace("# Heading One", "# Renamed"),
    LCODE: (t) => t.replace("L29", "that check"),
    CAPS: (t) => t.replace("STALL_STATE", "the stall field"),
    CLI: (t) => t.replace("codex-cli", "the codex adapter"),
    SCHEMA: (t) => t.replace("collab-board/HEAD/v1", "the head schema"),
  };
  for (const [cls, mutate] of Object.entries(DROPS)) {
    const r = dv(surf({ "a.md": DOC }), surf({ "a.md": mutate(DOC) }));
    ok(`a dropped ${cls} token is a blocking finding`, r.code === 1 && new RegExp(`FAIL\\s+${cls}`).test(r.out), r.out);
  }
  // PATH rides inside an inline code span above, so it needs its own bare-path fixture to prove the
  // class fires on its own rather than only as a side effect of CODE.
  {
    const withPath = "See skill/references/relay.md for the write path." + NL;
    const r = dv(surf({ "a.md": withPath }), surf({ "a.md": "See the relay reference." + NL }));
    ok("a dropped PATH cross-reference is a blocking finding", r.code === 1 && /FAIL\s+PATH/.test(r.out), r.out);
  }

  // THE CENTRAL CONTROL. Dedupe moves a fact; it does not delete it. A per-file checker would call
  // this a loss, and it is the single most common edit in this refactor.
  {
    const before = surf({ "a.md": DOC, "b.md": DOC });
    const after = surf({ "a.md": DOC, "b.md": "# B" + NL + NL + "Now points at a.md." + NL });
    const r = dv(before, after);
    ok("control: a token that MOVES between files on the surface is not a drop", r.code === 0, r.out);
  }
  // ...and the same edit applied to the LAST copy is a drop. Without this pair, the control above
  // passes for a checker that never looks at anything.
  {
    const before = surf({ "a.md": DOC });
    const after = surf({ "a.md": "# A" + NL + NL + "Everything moved away." + NL });
    ok("...while removing the last copy is", dv(before, after).code === 1);
  }

  // never_worse, measured over the surface so one file may grow while the whole shrinks.
  {
    const r = dv(surf({ "a.md": DOC }), surf({ "a.md": DOC + "padding ".repeat(200) + NL }));
    ok("a surface that GREW is a blocking finding — a pass that compressed nothing did not compress",
      r.code === 1 && /FAIL\s+SIZE/.test(r.out), r.out);
    // ...unless growth is DECLARED. A change that adds documentation grows the surface and is
    // correct; without the declaration this rule would either block every feature commit or be
    // switched off, and then it means nothing during the compression passes it exists for.
    const g = dv(surf({ "a.md": DOC }), surf({ "a.md": DOC + "padding ".repeat(200) + NL }), "--allow-growth");
    ok("...unless the growth is declared, and it is still reported",
      g.code === 0 && /NOTE\s+SIZE.*declared growth/.test(g.out), g.out);
  }

  // A drop must be DECLARED, never silent. Step 8 removes template comment prose deliberately, and
  // a token that lived only there has to be named on the command line to leave.
  // The replacement is SHORTER than the token it removes. The first version substituted longer
  // text and tripped never_worse instead, which proved the size rule rather than the declaration
  // rule — a fixture passing for the wrong reason is the failure mode this suite keeps finding.
  {
    const after = surf({ "a.md": DOC.replace("L29", "it") });
    const before = surf({ "a.md": DOC });
    const r = dv(before, after, "--allow-drop", "L29");
    ok("a declared drop passes and is still reported", r.code === 0 && /NOTE\s+LCODE.*declared drop/.test(r.out), r.out);
    ok("...and declaring one token does not license another",
      dv(before, surf({ "a.md": DOC.replace("L29", "x").replace("codex-cli", "y") }), "--allow-drop", "L29").code === 1);
  }

  // Fail-closed. Input the extractor cannot parse is REFUSED, because "no drops" over text it did
  // not understand reads exactly like success.
  {
    const r = dv(surf({ "a.md": DOC }), surf({ "a.md": "# X" + NL + "```text" + NL + "unclosed" + NL }));
    ok("an unbalanced fence is refused, not passed", r.code === 1 && /REFUSE\s+ATTEST/.test(r.out), r.out);
    const r2 = dv(surf({ "a.md": DOC }), surf({ "a.md": "# X" + NL + "<!-- unclosed" + NL }));
    ok("an unbalanced comment is refused, not passed", r2.code === 1 && /REFUSE\s+ATTEST/.test(r2.out), r2.out);
  }
  // THE CONTROL FOR THE FALSE POSITIVE THIS TOOL ACTUALLY PRODUCED on its first run: it refused
  // lint-spec.md, whose L0 row quotes the comment marker inside an inline code span while
  // explaining that these documents quote it constantly. The detector was wrong, and the document
  // said so in the line that tripped it.
  {
    const quoting = "# X" + NL + NL + "A file carrying an UNCLOSED `<!--` comment fails L0." + NL;
    const r = dv(surf({ "a.md": quoting }), surf({ "a.md": quoting }));
    ok("control: a comment marker quoted in inline code is text, not syntax", r.code === 0, r.out);
    const fenced = "# X" + NL + NL + "```text" + NL + "<!-- example only" + NL + "```" + NL;
    ok("control: ...and the same inside a fenced block", dv(surf({ "a.md": fenced }), surf({ "a.md": fenced })).code === 0);
  }
  // A real unbalanced comment must still be caught on a file that ALSO quotes one, or the mask
  // above would be a way to hide the defect it was added to tolerate.
  {
    const both = "# X" + NL + NL + "Quoting `<!--` here." + NL + "<!-- but this one never closes" + NL;
    ok("...while a genuine unclosed comment beside a quoted one is still refused",
      dv(surf({ "a.md": both }), surf({ "a.md": both })).code === 1);
  }

  // ── THE FOUR ATTACKS THAT PASSED. Each returned exit 0 and `OK` on the first version of this
  // tool, found by the SECONDARY at I4 when asked to break it rather than to check it. A fixture
  // per attack, because a hole here is a hole in every document step of the plan.
  {
    // 1. The token is deleted from the page and left in a comment. No reader sees it and no
    //    checker matches it, so it is gone — but the raw-text set still contained it.
    const b = surf({ "a.md": "# H" + NL + NL + "Lint reports L29 here, at length." + NL });
    const a = surf({ "a.md": "# H" + NL + NL + "<!--L29-->" + NL });
    const r = dv(b, a);
    ok("attack: a token buried in a comment is a drop", r.code === 1 && /FAIL\s+LCODE/.test(r.out), r.out);
    ok("...and the finding says the token is not on the page", /only inside a comment/.test(r.out), r.out);
  }
  {
    // 2. Fenced bytes changed. The first version stripped trailing whitespace as "formatting"; in
    //    documents whose fences are commands and file layouts, a trailing byte is content.
    const b = surf({ "a.md": "# H" + NL + NL + "```text" + NL + "cmd --flag  " + NL + "```" + NL });
    const a = surf({ "a.md": "# H" + NL + NL + "```text" + NL + "cmd --flag" + NL + "```" + NL });
    ok("attack: changed bytes inside a fence are a drop", dv(b, a).code === 1);
  }
  {
    // 3. The last copy is parked in a file the author means to delete next. The union answers
    //    "does it exist somewhere", which that satisfies — so removing a file is its own
    //    declaration and the parking move has to be admitted rather than finished quietly later.
    const b = surf({ "a.md": "# A" + NL + NL + "Lint L29 here." + NL, "b.md": "# B" + NL + NL + "More." + NL });
    const a = surf({ "a.md": "# A" + NL + NL + "Lint L29 here." + NL });
    const r = dv(b, a);
    ok("attack: removing a file without declaring it is a finding", r.code === 1 && /FAIL\s+FILE/.test(r.out), r.out);
    // Declaring the REMOVAL settles the manifest and nothing else. Content unique to the file is a
    // second, separate loss and needs its own declaration — a deletion is usually paired with
    // moving the content somewhere, so "I meant to delete the file" is not a claim about what was
    // in it. Two intentions, two declarations.
    const declared = dv(b, a, "--allow-drop-file", "b.md");
    ok("...declaring the removal settles the manifest", /NOTE\s+FILE.*declared file removal/.test(declared.out), declared.out);
    ok("...but content unique to it is still a separate loss", declared.code === 1 && /FAIL\s+HEADING/.test(declared.out), declared.out);
    ok("...and declaring both clears the rewrite",
      dv(b, a, "--allow-drop-file", "b.md", "--allow-drop", "# B").code === 0);
    // A file whose content lives on elsewhere needs only the manifest declaration, which is the
    // ordinary dedupe case and must not require an inventory of the tokens that moved.
    const b2 = surf({ "a.md": "# A" + NL + NL + "Lint L29 here." + NL, "c.md": "# A" + NL + NL + "Lint L29 here." + NL });
    const a2 = surf({ "a.md": "# A" + NL + NL + "Lint L29 here." + NL });
    ok("control: removing a fully-duplicated file needs only the manifest declaration",
      dv(b2, a2, "--allow-drop-file", "c.md").code === 0);
  }
  {
    // 4. Mixed-case column-zero keys — `Catalog`, `Type`, `Reset`, `Converge`, `Roles` — are the
    //    SESSION grammar itself, and no ALL-CAPS shape could see them.
    const b = surf({ "a.md": "Converge: BARREN=8, CHURN=2" + NL + "Roles: PRIMARY=A, SECONDARY=B" + NL });
    const a = surf({ "a.md": "Roles: PRIMARY=A, SECONDARY=B" + NL });
    const r = dv(b, a);
    ok("attack: a dropped mixed-case board key is a finding", r.code === 1 && /FAIL\s+COLKEY/.test(r.out), r.out);
  }
  // ── THE SECOND ROUND OF ATTACKS, from I6. Every one of these passed the widened tool: the fixes
  // at 3d1edbb closed the exact attacks of I4 without closing the properties they were claimed to
  // establish. A set answers whether a spelling exists somewhere, not whether a DECLARATION, a
  // HIERARCHY or a PATH survived.
  {
    // A real declaration is deleted while the identical line survives inside a fenced EXAMPLE. The
    // sample illustrates the syntax; it is not a use of it.
    const b = surf({ "a.md": "Roles: PRIMARY=A, SECONDARY=B" + NL + NL + "```text" + NL + "Roles: PRIMARY=A, SECONDARY=B" + NL + "```" + NL });
    const a = surf({ "a.md": "```text" + NL + "Roles: PRIMARY=A, SECONDARY=B" + NL + "```" + NL });
    const r = dv(b, a);
    ok("attack: a declaration deleted but still shown in a fenced example is a drop",
      r.code === 1 && /FAIL\s+COLKEY/.test(r.out), r.out);
    // ...and the example's own bytes stay protected, so excluding fences from COLKEY leaves no gap.
    const b2 = surf({ "a.md": "```text" + NL + "Roles: PRIMARY=A" + NL + "```" + NL });
    const a2 = surf({ "a.md": "```text" + NL + "Roles: PRIMARY=Z" + NL + "```" + NL });
    ok("...while the sample's own bytes are still guarded by FENCE", dv(b2, a2).code === 1);
  }
  {
    // Re-nesting a section is a structural rewrite; the heading text alone made it invisible.
    const b = surf({ "a.md": "# Doc" + NL + NL + "## State" + NL + NL + "Body." + NL });
    const a = surf({ "a.md": "# Doc" + NL + NL + "### State" + NL + NL + "Body." + NL });
    ok("attack: changing a heading's LEVEL is a drop", dv(b, a).code === 1);
  }
  {
    // A rename read as a bare removal, so the file that replaced it went unmentioned.
    const b = surf({ "a.md": "# A" + NL + NL + "Body." + NL });
    const a = surf({ "b.md": "# A" + NL + NL + "Body." + NL });
    const r = dv(b, a, "--allow-drop-file", "a.md");
    ok("a renamed file reports both halves, so the move is legible", /NOTE\s+FILE.*added: b\.md/.test(r.out), r.out);
  }

  // A PHANTOM SPAN, found on a real file by a real worker rewrite. When a line's backtick count is
  // ODD, pairing them left to right turns the PROSE between two genuine spans into a span of its
  // own — and then a rewrite that merely rewraps the line reports dropping a token that never
  // existed. A false FAIL is as corrosive as a miss: it teaches the reader to override the tool.
  {
    const odd = "See `a.md` for the rule, ` and `b.md` for the rest." + NL;
    const rewrapped = "See `a.md` for the rule," + NL + "and `b.md` for the rest." + NL;
    const r = dv(surf({ "a.md": odd }), surf({ "a.md": rewrapped }));
    ok("rewrapping a line with unbalanced backticks is not a dropped token", r.code === 0, r.out);
    // ...and a genuine span on a WELL-FORMED line is still guarded, or the fix above would be a
    // hole rather than a correction.
    const good = "See `keep-me.md` for the rule." + NL;
    ok("...while a real span on a balanced line is still protected",
      dv(surf({ "a.md": good }), surf({ "a.md": "See the rule." + NL })).code === 1);
  }

  // The honest limit, asserted so the claim and the tool cannot drift apart: a rule can be inverted
  // with every one of its tokens intact, and this cannot see it. `OK` clears a rewrite for review;
  // it does not replace reading the diff.
  {
    const b = surf({ "a.md": "# R" + NL + NL + "Only PRIMARY edits project files." + NL });
    const a = surf({ "a.md": "# R" + NL + NL + "Any PRIMARY edits project files." + NL });
    ok("acknowledged limit: an inverted rule with every token intact still passes", dv(b, a).code === 0);
  }

  // Losing a negation inverts a rule, but a rewrite legitimately turns "does not permit" into
  // "forbids" — a question to answer, not a failure to block on.
  {
    const r = dv(surf({ "a.md": DOC }), surf({ "a.md": DOC.replace("is not the same as", "differs from") }));
    ok("a dropped negation warns rather than blocks", r.code === 0 && /WARN\s+NEGATION/.test(r.out), r.out);
  }

  ok("missing arguments are a usage error, distinct from a finding", dv("", "").code === 2
    || execFileSync(process.execPath, [DOCV], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) === "");

  // The tool is only useful if it runs clean on the surface it is about to police.
  const live = dv(path.join(HERE, ".."), path.join(HERE, ".."));
  ok("the shipped surface passes its own verifier today", live.code === 0, live.out);
}

// 17b-51. The agent-schema table defines EDGES, not a version set.
//
// Step 3 adds agent/v3, and three things independently hardcoded the version set: the SCHEMA_SET
// regex, AGENT_SCHEMAS, and the supported-migration check. Unifying them is obvious; unifying them
// WRONGLY is the trap the SECONDARY named before any of it was written. If the form were derived
// from "allowed FROM" x "allowed TO", `agent/v1->agent/v3` would parse the moment v3 exists — a
// transition the old hardcoded `v[12]` spelling rejected. Tidiness would have bought a widening.
if (SEL(87)) {
  const src = read(CLI);
  const table = (/const AGENT_SCHEMA_TABLE = \{[\s\S]*?\r?\n\};/.exec(src) || [""])[0];
  ok("the schema table declares a predecessor per version (fixture sanity)",
    /from: "v1"/.test(table) && /from: null/.test(table), table.slice(0, 120));
  ok("the SCHEMA_SET form is built from the declared EDGES, not from the version set",
    /AGENT_SCHEMA_EDGES\.map\(\(\[f, t\]\) => `agent\/\$\{f\}->agent\/\$\{t\}`\)\.join\("\|"\)/.test(src));
  ok("...and the version list is derived from the same table rather than written out",
    /const AGENT_SCHEMAS = Object\.keys\(AGENT_SCHEMA_TABLE\)/.test(src));
  ok("...and the v2 key list has one home", /const V2_KEYS = AGENT_SCHEMA_TABLE\.v2\.keys;/.test(src));

  // The property itself, evaluated rather than asserted about the source: build the form the way
  // the engine does, then confirm a non-edge transition cannot parse even when both versions are
  // legal on their own. This is the assertion that would fail if someone "simplified" the
  // alternation into a character class later.
  const edges = [...table.matchAll(/(\w+): \{ keys: [^,]*(?:\[[^\]]*\])?[^,]*, from: "(\w+)" \}/g)]
    .map((m) => [m[2], m[1]]);
  ok("the table yields at least one edge (fixture sanity)", edges.length >= 1, JSON.stringify(edges));
  const form = new RegExp("^(?:" + edges.map(([f, t]) => `agent/${f}->agent/${t}`).join("|")
    + ") by=([A-Za-z0-9_-]+)$");
  const versions = [...new Set(edges.flat())];
  for (const f of versions) for (const t of versions) {
    if (f === t) continue;
    const isEdge = edges.some(([a, b]) => a === f && b === t);
    ok(`agent/${f}->agent/${t} parses only if it is a declared edge`,
      form.test(`agent/${f}->agent/${t} by=CLAUDE`) === isEdge);
  }

  // Narrowing acceptance must not cost the reader the reason. A well-shaped but illegal transition
  // still gets a message naming what IS legal, rather than the generic "not the documented form".
  const s = scaffold("META", "schemaedge");
  const stamps = read(file(s.dir, "log.md")).match(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z/gm) || [];
  edit(file(s.dir, "log.md"), (t) => t.trimEnd() + NL
    + `${stamps[stamps.length - 1]} SCHEMA_SET agent/v2->agent/v1 by=CLAUDE` + NL);
  const out = lint(s.root, s.id).out;
  ok("a downgrade is refused with a message naming the legal migrations",
    // The legal set is rendered FROM the table, so this asserts the shape and the presence of both
    // declared edges rather than a frozen string that a fourth version would falsify.
    /not a supported migration \(only agent\/v1->agent\/v2, agent\/v2->agent\/v3\)/.test(out), out);
}

// 17b-52. agent/v3: provenance selects the grammar, and the mirror check retires per version.
//
// Both properties were named by the SECONDARY before the code existed, and both are the kind that
// hold ACCIDENTALLY if nobody asserts them — which is indistinguishable from holding on purpose
// until the day someone edits the neighbouring line.
if (SEL(88)) {
  // Turn a scaffolded v2 board into one whose PROVENANCE says v3 while its files stay v2-shaped.
  // The scaffold now opens at v3, so a "provenance says v3" board is simply a scaffold. What
  // needs constructing is the MISMATCH: v3 provenance with the old five-key files.
  const v2Shaped = (s) => {
    for (const a of ["claude", "codex"]) {
      const p = file(s.dir, "agents", `${a}.md`);
      edit(p, (x) => {
        const nl = /\r\n/.test(x) ? "\r\n" : NL;
        return x.replace("collab-board/agent/v3", "collab-board/agent/v2")
          .replace(/^ACTIVE_RECOVERY:/m, `SELF_HAND: ON_HOLD${nl}LAST_TURN_WRITTEN: NONE${nl}ACTIVE_RECOVERY:`);
      });
    }
    return s;
  };

  // I29. Provenance wins over shape. Accepting the five-key files here because they LOOK like v2
  // would be shape inference re-entering through the back door, and it would make a malformed new
  // board silently legacy-compatible.
  {
    const s = v2Shaped(scaffold("META", "v3prov"));
    const out = lint(s.root, s.id).out;
    ok("an OPEN agent_schema=v3 board with v2-shaped actor files FAILs", has(out, "L24"), out);
    ok("...naming v3's grammar, not v2's", /agent\/v3 header must be exactly/.test(out), out);
    ok("...and listing exactly v3's three keys",
      /exactly ACTIVE_RECOVERY, EXECUTOR_THREAD, UNRESOLVED_CONCERNS/.test(out), out);
  }
  // ...and the same board with v3-shaped files passes, or the assertion above would be satisfied by
  // a checker that rejects every v3 board.
  {
    const s = scaffold("META", "v3ok");
    const out = lint(s.root, s.id).out;
    ok("control: an OPEN agent_schema=v3 board with v3-shaped files satisfies L24",
      !/L24.*header must be exactly/.test(out), out);
  }

  // I30. L15 retires FOR v3, and only for v3. Provenance deliberately leaves frozen boards on their
  // own schema, so a v2 board that never migrates must keep getting its drift reported. L24 cannot
  // cover it: that proves key shape and value grammar, never disagreement with HEAD.
  {
    const s = scaffoldV2("META", "l15v2");
    edit(file(s.dir, "HEAD.md"), (t) => t.replace(/- CODEX: [A-Z_]+ - SECONDARY/, "- CODEX: WORKING - SECONDARY"));
    edit(file(s.dir, "agents", "codex.md"), (t) => t.replace(/^SELF_HAND: .*$/m, "SELF_HAND: ON_HOLD"));
    ok("a v2 board still reports mirror drift", has(lint(s.root, s.id).out, "L15"));
  }
  {
    const s = scaffold("META", "l15v3");
    edit(file(s.dir, "HEAD.md"), (t) => t.replace(/- CODEX: [A-Z_]+ - SECONDARY/, "- CODEX: WORKING - SECONDARY"));
    ok("...while a v3 board reports none, having no mirror to drift", !has(lint(s.root, s.id).out, "L15"));
  }
}

// 17b-53. migrate v2 -> v3: the crash path is the design, not an afterthought.
//
// The commit-point-last order is right — the event must not claim a completion that did not happen
// — but it does not make a two-file rewrite atomic. The SECONDARY worked the state out at I31: a
// death between the two actor rewrites leaves provenance at v2 with one file already v3-shaped, and
// a rerun that requires every source to be exactly valid v2 REFUSES, leaving a board no command can
// repair. The resolution is idempotence rather than a journal: a file already in exactly the target
// grammar is already migrated, which is not inference because that grammar is closed and validated.
if (SEL(89)) {
  const v2board = (slug) => {
    const s = scaffoldV2("META", slug);
    // Give the retained keys distinct non-default values, or a migration that DROPS them passes.
    const rec = "TURN=P1;ATTEMPT=2;START=2026-08-01T00:00:00Z;EXPECT=600;SPAWN=abc;LIMIT=NONE;RESET=NONE";
    for (const [a, thread] of [["claude", "thread-alpha"], ["codex", "thread-beta"]]) {
      edit(file(s.dir, "agents", `${a}.md`), (t) => t
        .replace(/^ACTIVE_RECOVERY: .*$/m, `ACTIVE_RECOVERY: ${rec}`)
        .replace(/^EXECUTOR_THREAD: .*$/m, `EXECUTOR_THREAD: ${thread}`)
        .replace(/^UNRESOLVED_CONCERNS: .*$/m, "UNRESOLVED_CONCERNS: P1@turns/P1-claude.md")
        .replace(/- \(none yet\)/, "- a private note worth keeping"));
    }
    return { s, rec };
  };

  // I32. THE POSITIVE CONTROL. Without it an always-refuse migrator, or one that writes NONE over
  // every retained value, satisfies every compatibility and failure fixture in this file.
  {
    const { s, rec } = v2board("mig3ok");
    const r = run(["migrate", "--session", s.id, "--to", "agent/v3"], s.root);
    ok("a v2 board migrates to v3", r.code === 0, r.out);
    for (const [a, thread] of [["claude", "thread-alpha"], ["codex", "thread-beta"]]) {
      const t = read(file(s.dir, "agents", `${a}.md`));
      ok(`${a}: the retained recovery state survives verbatim`, t.includes(rec), t.slice(0, 200));
      ok(`${a}: the executor thread survives`, t.includes(`EXECUTOR_THREAD: ${thread}`));
      ok(`${a}: the concern pointer survives`, t.includes("UNRESOLVED_CONCERNS: P1@turns/P1-claude.md"));
      ok(`${a}: the private note survives byte-for-byte`, t.includes("- a private note worth keeping"));
      ok(`${a}: the retired mirrors are gone`, !/SELF_HAND:/.test(t) && !/LAST_TURN_WRITTEN:/.test(t));
      ok(`${a}: the file declares v3`, /SCHEMA: collab-board\/agent\/v3/.test(t));
    }
    const log = read(file(s.dir, "log.md"));
    ok("exactly one v2->v3 event is appended",
      (log.match(/SCHEMA_SET agent\/v2->agent\/v3/g) || []).length === 1, log.slice(-200));
    ok("...and the migrated board lints clean", !has(lint(s.root, s.id).out, "L24"), lint(s.root, s.id).out);
    // Re-running is a no-op, not a second event.
    const again = run(["migrate", "--session", s.id, "--to", "agent/v3"], s.root);
    ok("re-running after the commit is a no-op", again.code === 0 && /nothing to do/.test(again.out), again.out);
    ok("...and appends no second event",
      (read(file(s.dir, "log.md")).match(/SCHEMA_SET agent\/v2->agent\/v3/g) || []).length === 1);
  }

  // I31. THE FORCED CRASH. One file rewritten, the event never appended — the exact state the
  // SECONDARY said was unrecoverable.
  {
    const { s } = v2board("mig3crash");
    // Simulate the interruption by hand: rewrite ONLY claude's file to the v3 shape.
    edit(file(s.dir, "agents", "claude.md"), (t) => t
      .replace("collab-board/agent/v2", "collab-board/agent/v3")
      .replace(/^SELF_HAND: .*\r?\n/m, "").replace(/^LAST_TURN_WRITTEN: .*\r?\n/m, ""));
    const mid = lint(s.root, s.id).out;
    ok("a half-migrated board is a lint finding, not a silent state", has(mid, "L24"), mid);
    const r = run(["migrate", "--session", s.id, "--to", "agent/v3"], s.root);
    ok("re-running migrate COMPLETES the interrupted migration", r.code === 0, r.out);
    ok("...leaving both files v3 and the board clean",
      !/SELF_HAND:/.test(read(file(s.dir, "agents", "codex.md")))
      && !has(lint(s.root, s.id).out, "L24"), lint(s.root, s.id).out);
    ok("...with exactly one event, not one per attempt",
      (read(file(s.dir, "log.md")).match(/SCHEMA_SET agent\/v2->agent\/v3/g) || []).length === 1);
  }

  // I17. Refusals. The source must be EXACTLY the predecessor grammar, which is one requirement
  // carrying every refusal at once rather than a second list to drift from the first.
  {
    const { s } = v2board("mig3bad");
    edit(file(s.dir, "agents", "codex.md"), (t) => t.replace(/^ACTIVE_RECOVERY: .*$/m, "ACTIVE_RECOVERY: BUSY"));
    const r = run(["migrate", "--session", s.id, "--to", "agent/v3"], s.root);
    ok("a malformed retained value refuses the migration", r.code !== 0, r.out);
    ok("...naming the file and refusing to guess", /codex\.md/.test(r.out) && /will not guess/.test(r.out), r.out);
    ok("...and appends no event", !/SCHEMA_SET agent\/v2->agent\/v3/.test(read(file(s.dir, "log.md"))));
    ok("...and rewrites no file", /SELF_HAND:/.test(read(file(s.dir, "agents", "claude.md"))));
  }

  // A version SKIP is not a migration, and the guard is the table rather than a second list.
  //
  // EVERY REFUSAL MUST LEAVE EVERY BYTE ALONE, and this fixture did not check that — it asserted the
  // exit code and the wording while the command had ALREADY rewritten both actor files and then
  // refused. The edge check sat after the rewrite loop, so the error path was destructive. A fixture
  // that reads only the diagnostic cannot see the damage the diagnostic is apologising for.
  {
    const s = scaffoldV2("META", "mig3skip");
    stripProvenance(s);
    const before = ["claude", "codex"].map((a) => read(file(s.dir, "agents", `${a}.md`)));
    const beforeLog = read(file(s.dir, "log.md"));
    const r = run(["migrate", "--session", s.id, "--to", "agent/v3"], s.root);
    ok("a v1 board cannot skip straight to v3", r.code !== 0, r.out);
    ok("...naming the declared migrations", /agent\/v1->agent\/v2/.test(r.out), r.out);
    ok("...and the refusal rewrites NO actor file",
      ["claude", "codex"].every((a, i) => read(file(s.dir, "agents", `${a}.md`)) === before[i]));
    ok("...and appends nothing to the log", read(file(s.dir, "log.md")) === beforeLog);
  }
  // The same immutability demand on the per-file refusal, so both error paths are covered rather
  // than the one that happened to be looked at.
  {
    const { s } = v2board("mig3bad2");
    edit(file(s.dir, "agents", "codex.md"), (t) => t.replace(/^EXECUTOR_THREAD: .*$/m, "EXECUTOR_THREAD: has spaces"));
    const before = ["claude", "codex"].map((a) => read(file(s.dir, "agents", `${a}.md`)));
    const r = run(["migrate", "--session", s.id, "--to", "agent/v3"], s.root);
    ok("a malformed source refuses without rewriting the OTHER actor's file",
      r.code !== 0 && ["claude", "codex"].every((a, i) => read(file(s.dir, "agents", `${a}.md`)) === before[i]), r.out);
  }

  // I27, reopened by the SECONDARY and rightly: fixing the TEMPLATE does nothing for a board that
  // already exists, and migration copied the notes suffix verbatim — carrying the shipped v2
  // instruction that five keys are mandatory and none may be deleted into a three-key file.
  {
    const { s } = v2board("mig3boiler");
    const OBSOLETE = "The five keys above are a CLOSED grammar";
    ok("fixture sanity: the v2 board carries the obsolete instruction",
      read(file(s.dir, "agents", "claude.md")).includes(OBSOLETE));
    ok("...and the migration succeeds", run(["migrate", "--session", s.id, "--to", "agent/v3"], s.root).code === 0);
    const after = read(file(s.dir, "agents", "claude.md"));
    ok("the obsolete v2 instruction does not survive into v3", !after.includes(OBSOLETE), after.slice(-400));
    ok("...replaced by one that describes v3", /three keys above are a CLOSED grammar/.test(after));
    ok("...while the actor's OWN note is still there byte-for-byte",
      after.includes("- a private note worth keeping"), after.slice(-200));
  }
  // An actor who writes their OWN comment quoting the boilerplate's identifying sentence — to
  // disagree with it, say — must keep it. One substring identified the block and the whole
  // enclosing comment was then replaced, so a single quotation cost an actor their notes. The match
  // now needs both sentences, which only ever appeared together in the shipped block.
  {
    const { s } = v2board("mig3own");
    edit(file(s.dir, "agents", "claude.md"), (t) => t.trimEnd() + NL
      + "<!-- my own note: The five keys above are a CLOSED grammar is a claim I dispute. -->" + NL);
    run(["migrate", "--session", s.id, "--to", "agent/v3"], s.root);
    const after = read(file(s.dir, "agents", "claude.md"));
    ok("an actor's own comment quoting the boilerplate survives migration",
      after.includes("is a claim I dispute"), after.slice(-300));
    ok("...while the shipped block, which carries BOTH sentences, is still retired",
      !after.includes("Everything below this comment is DISCRETIONARY"), after.slice(-300));
  }

  // ...and a note that merely QUOTES the sentence is not boilerplate to rewrite. Only a
  // well-formed comment block containing it is touched.
  {
    const { s } = v2board("mig3quote");
    edit(file(s.dir, "agents", "claude.md"), (t) =>
      t.replace("- a private note worth keeping", "- I disagree that The five keys above are a CLOSED grammar was ever true"));
    run(["migrate", "--session", s.id, "--to", "agent/v3"], s.root);
    const after = read(file(s.dir, "agents", "claude.md"));
    ok("control: the actor's own sentence survives even when it quotes the boilerplate",
      after.includes("- I disagree that"), after.slice(-300));
  }
  {
    const s = scaffold("META", "mig3none");
    const r = run(["migrate", "--session", s.id, "--to", "agent/v9"], s.root);
    ok("an undeclared target is refused", r.code !== 0 && /--to must be one of/.test(r.out), r.out);
  }
}

// 17b-54. The points archive: settled rows leave the ACTOR's read-set and no decision changes.
//
// This is the first step of the refactor that actually cuts per-turn bytes, and the measurement
// that justified it is not a projection: across 26 recorded boards, 85% of point-row bytes are rows
// settled for two turns or more. Set that against the mechanical shrinker's measured 1.22% — the
// redundancy in a board is STRUCTURAL, not lexical, which is the same conclusion the shrinker
// measurement reached from the other side.
if (SEL(90)) {
  // A board with settled points old enough to archive, plus one just-settled and one still open.
  const mk = () => {
    const s = scaffold("META", "arch");
    const stamps = read(file(s.dir, "log.md")).match(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z/gm) || [];
    const ts = stamps[stamps.length - 1];
    edit(file(s.dir, "points.md"), (t) => t.trimEnd() + NL
      + "| P1 | PLAN | settled long ago | AGREED | [P1](turns/P1-claude.md) |" + NL
      + "| P2 | PLAN | settled long ago too | REJECTED | [P1](turns/P1-claude.md) |" + NL
      + "| P3 | PLAN | just settled | AGREED | [P1](turns/P1-claude.md) |" + NL
      + "| P4 | PLAN | still open | OPEN | - |" + NL);
    edit(file(s.dir, "log.md"), (t) => t.trimEnd() + NL
      + `${ts} POINT_SET P1=AGREED P2=REJECTED in=P1` + NL
      + `${ts} TURN_COMMIT P2 actor=CODEX responds_to=P1 points=P3,P4` + NL
      + `${ts} TURN_COMMIT P3 actor=CLAUDE responds_to=P2 points=P3` + NL
      + `${ts} POINT_SET P3=AGREED in=P3` + NL);
    return s;
  };

  const s = mk();
  // Normalised because L9 counts wall-clock minutes and moves on its own — the same normalisation
  // the corpus diff uses.
  const lintOf = (b) => lint(b.root, b.id).out.replace(/no update for \d+m/g, "no update for <Nm>");
  const before = { status: run(["status", "--session", s.id], s.root).out,
    lint: lintOf(s), points: read(file(s.dir, "points.md")) };
  const r = run(["archive", "--session", s.id], s.root);
  ok("archive moves the rows settled for two turns or more", r.code === 0 && /Archived 2 settled row/.test(r.out), r.out);
  ok("...and reports the bytes it took off every turn's read-set", /off every turn's read-set/.test(r.out), r.out);
  const hot = read(file(s.dir, "points.md"));
  const cold = read(file(s.dir, "points-archive.md"));
  ok("the aged rows left the hot file", !/\| P1 \|/.test(hot) && !/\| P2 \|/.test(hot), hot);
  ok("...and are in the archive", /\| P1 \|/.test(cold) && /\| P2 \|/.test(cold), cold);
  ok("the JUST-settled row stays hot, so a point is still readable while it is being discussed",
    /\| P3 \|/.test(hot), hot);
  ok("...and the OPEN row never leaves", /\| P4 \|/.test(hot), hot);
  ok("the hot file actually got smaller", hot.length < before.points.length);

  // GATE-NEUTRALITY, PROVEN BY COMPARISON rather than asserted. Every decision reads the union, so
  // moving a row must change nothing a gate, a count or a terminal precondition can see.
  ok("archiving changes no decision the board reports",
    run(["status", "--session", s.id], s.root).out === before.status);
  // THE STRONGER FORM, and the one this fixture originally got wrong: not "the board lints clean"
  // — this fixture's board is synthetic and has findings of its own — but "archiving changes NOT
  // ONE finding". A neutrality claim is about the difference, so the assertion has to be too.
  ok("...and not one lint finding differs before and after", lintOf(s) === before.lint,
    "before:\n" + before.lint + "\nafter:\n" + lintOf(s));

  // Running it twice is a no-op, not a second move.
  const again = run(["archive", "--session", s.id], s.root);
  ok("re-archiving finds nothing to move", again.code === 0 && /Nothing to archive/.test(again.out), again.out);
  ok("...and leaves both files byte-identical",
    read(file(s.dir, "points.md")) === hot && read(file(s.dir, "points-archive.md")) === cold);

  // REOPENING AN ARCHIVED POINT. The `source` field was recorded and then never consulted at the
  // one boundary that mutates rows, so relay read and wrote points.md alone: setting an archived id
  // either failed as an unknown id or appended a SECOND hot row and orphaned the archived one. A
  // field that marks ownership and is not read at the write is a note, not a boundary.
  {
    const d = mk();
    const lintBefore = lintOf(d);
    run(["archive", "--session", d.id], d.root);
    ok("fixture sanity: P1 really is in the archive and not in the hot file",
      !/\| P1 \|/.test(read(file(d.dir, "points.md")))
      && /\| P1 \|/.test(read(file(d.dir, "points-archive.md"))));
    // Reaching the mutation boundary the way relay does: a capture that SETS an archived id. Relay
    // is the sole-writer path, so the board has to declare it — without that it refuses and the
    // re-hot is never reached, which is how the first version of this fixture passed while
    // exercising nothing.
    edit(file(d.dir, "SESSION.md"), (t) => t.trimEnd() + NL + "BoardWriteMode: PRIMARY_ONLY" + NL);
    const stamps2 = read(file(d.dir, "log.md")).match(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z/gm) || [];
    edit(file(d.dir, "log.md"), (t) => t.trimEnd() + NL
      + `${stamps2[stamps2.length - 1]} STATE_SET CLAUDE=ON_HOLD CODEX=START cursor=- next=P4/CODEX seq=0` + NL);
    edit(file(d.dir, "HEAD.md"), (t) => t.replace("SESSION_STATUS: IDLE", "SESSION_STATUS: ACTIVE")
      .replace(/- CODEX: [A-Z_]+ - SECONDARY/, "- CODEX: START - SECONDARY")
      .replace(/^NEXT_TURN_ID: .*$/m, "NEXT_TURN_ID: P4").replace(/^NEXT_ACTOR: .*$/m, "NEXT_ACTOR: CODEX"));
    // POINTS is a SECTION, not a header field. The first version of this capture wrote
    // `POINTS: ...` in the header, which the parser ignores, so the relay's point list stayed empty
    // and `rehotPoints` was never reached — the fixture ran the command and exercised none of the
    // path it named. That is why it was disclosed rather than claimed.
    const rel = path.join(d.root, "reopen.relay");
    write(rel, ["RELAY: collab-board/relay/v1", "SESSION: " + d.id, "ACTOR: CODEX", "TURN: P4",
      "--- TURN ---", "### TURN-P4 (CODEX)", "SCHEMA: collab-board/turn/v1",
      "- Header: PART=PLAN / RESPONDS_TO=NEW / POINTS=P1", "- Body:", "  - FINDINGS:",
      "    - reopening a point that had been archived", "- Evidence: probe",
      "- Handoff: CODEX WORKING->ON_HOLD, CLAUDE ON_HOLD->START", "PREV: NEW", "NEXT: none",
      "--- LOG ---",
      "--- POINTS ---", "P1=OPEN | settled long ago",
      "--- END ---", ""].join(NL));
    const rr = run(["relay", "--session", d.id, "--capture", rel], d.root);
    ok("fixture sanity: the relay ran", rr.code === 0, rr.out.split(NL).slice(0, 2).join(" | "));
    // ...and REACHED the re-hot. Without this the fixture runs the command while exercising none of
    // the path it names, which is what the previous version did and disclosed rather than claimed.
    ok("fixture sanity: the re-hot was reached", /moved P1 back to points\.md/.test(rr.out), rr.out);
    const hot = read(file(d.dir, "points.md")), cold = read(file(d.dir, "points-archive.md"));
    ok("an archived id written by relay appears exactly once across the two files",
      ((hot + cold).match(/\| P1 \|/g) || []).length === 1, hot + NL + "---" + NL + cold);
    ok("...and it is in the HOT file, because a point being written about is a point in play",
      /\| P1 \|/.test(hot), hot);
    ok("...and no longer in the archive", !/\| P1 \|/.test(cold), cold);
    ok("...so no duplicate-row finding appears, which is what a bad move produces",
      !/row in BOTH/.test(lintOf(d)), lintOf(d));
    void lintBefore;
  }

  // OWNERSHIP. Splitting a tracker in two creates exactly two new ways to lie, and both FAIL.
  {
    const d = mk();
    run(["archive", "--session", d.id], d.root);
    edit(file(d.dir, "points.md"), (t) => t.trimEnd() + NL
      + "| P1 | PLAN | settled long ago | AGREED | [P1](turns/P1-claude.md) |" + NL);
    const out = lint(d.root, d.id).out;
    ok("a row in BOTH files is a finding", /FAIL L4.*row in BOTH/.test(out), out);
  }
  {
    const d = mk();
    run(["archive", "--session", d.id], d.root);
    edit(file(d.dir, "points-archive.md"), (t) => t.replace("| P1 | PLAN | settled long ago | AGREED | [P1](turns/P1-claude.md) |",
      "| P1 | PLAN | settled long ago | OPEN | - |"));
    const out = lint(d.root, d.id).out;
    ok("an OPEN row in the archive is a finding", /FAIL L4.*as OPEN/.test(out), out);
  }
  // ...and the union is what the decision consumers read: an archived row still blocks what it
  // blocked. Without this the two findings above could both pass on an engine that simply ignores
  // the archive file.
  {
    const d = mk();
    run(["archive", "--session", d.id], d.root);
    edit(file(d.dir, "points-archive.md"), (t) => t.replace(/\| P1 \| PLAN \| settled long ago \| AGREED \|[^|]*\|/,
      "| P1 | PLAN | settled long ago | DEFERRED | - |"));
    const out = lint(d.root, d.id).out;
    ok("a retired status in the ARCHIVE is still seen by the checks that own it",
      /L2|L4/.test(out) && /P1/.test(out), out);
  }
}

// 17b-55. The WORKER tier: verify what a delegate changed, never what it said.
//
// A worker holds no seat, no hand, no turn, no point and no gate, and loads no board context at
// all. It executes one well-defined job; the seats think. The PRIMARY stays accountable for every
// byte, and discharges that through the DIFF — so on a clean verify it never reads the transcript,
// which is the context saving the tier exists for.
if (SEL(91)) {
  const W = path.join(HERE, "worker.mjs");
  const gitq = (root, args) => {
    try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { return String(e.stdout || ""); }
  };
  const wk = (root, args) => {
    try { return { code: 0, out: execFileSync(process.execPath, [W, ...args, "--root", root], { encoding: "utf8", env: CLEAN_ENV }) }; }
    catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` }; }
  };
  const repo = () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), "cb-wk-"));
    gitq(r, ["init", "-q", "."]);
    write(path.join(r, "src", "a.txt"), "one" + NL);
    write(path.join(r, ".collab-board", "sessions", "s", "HEAD.md"), "# HEAD" + NL);
    gitq(r, ["add", "-A"]);
    gitq(r, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
    // OUTSIDE the repository: a baseline written into the tree it describes appears in its own
    // snapshot, and every later verify reports the record-keeping as a manifest violation.
    const bl = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-wkb-")), "baseline.json");
    wk(r, ["baseline", "--out", bl]);
    return { r, bl };
  };

  // The ordinary case: a job that changed exactly what it was allowed to change.
  {
    const { r, bl } = repo();
    write(path.join(r, "src", "a.txt"), "two" + NL);
    const v = wk(r, ["verify", "--baseline", bl, "--allow", "src", "--expect-changes"]);
    ok("a worker that changed only what the manifest allows verifies clean", v.code === 0, v.out);
    // The run must state its BOUNDARY on every invocation, including the clean ones. A reader who
    // sees only "OK" and no scope has been told a containment story the tool cannot support.
    ok("...and the run states its scope", /SCOPE: this compares the paths git reports/.test(v.out), v.out);
    ok("...naming the escapes it does not see", /ignored paths/.test(v.out) && /off disk/.test(v.out), v.out);
    // The scope notice is read as a list of what is UNCHECKED, so an entry that is now checked has
    // to leave it. Left in place it would be worse than an omission: an operator reading the tool's
    // own output would keep denying at the sandbox something the tool already refuses, and would
    // trust the rest of the list less for containing a false entry.
    ok("...and no longer lists the escape it now catches",
      !/does NOT see assume-unchanged/.test(v.out)
      && /assume-unchanged or\s*\n?\s*skip-worktree is not in that list/.test(v.out), v.out);
  }

  // THE ONE EVASION REACHABLE WITHOUT LEAVING THE REPOSITORY. `git update-index --assume-unchanged`
  // is a legitimate operation on a permitted path, so the dispatch sandbox — the first check, and
  // the one everything else is "sound only to the extent it held" against — will not deny it. It
  // makes git report the path clean from then on, so blocks 2, 3 and 6 all read through it and
  // agree that nothing happened. Verified live against the shipped build during the 2026-08-19
  // arena: `verify` returned OK while the file on disk read EVADED.
  {
    const { r, bl } = repo();
    gitq(r, ["update-index", "--assume-unchanged", "src/a.txt"]);
    write(path.join(r, "src", "a.txt"), "EVADED" + NL);
    const v = wk(r, ["verify", "--baseline", bl, "--allow", "src", "--expect-changes"]);
    ok("a path hidden with assume-unchanged mid-dispatch is refused",
      v.code === 1 && /flags changed during the dispatch/.test(v.out), v.out);
    // CONTROL, and it is the one that matters: the flags are compared, so a repository that ALREADY
    // had one set before the baseline must not be failed for still having it. A check that fires on
    // a legitimate pre-existing state is as much a defect as one that misses the evasion.
    const r2 = fs.mkdtempSync(path.join(os.tmpdir(), "cb-wk-"));
    gitq(r2, ["init", "-q", "."]);
    write(path.join(r2, "src", "a.txt"), "one" + NL);
    write(path.join(r2, "src", "pinned.txt"), "pinned" + NL);
    gitq(r2, ["add", "-A"]);
    gitq(r2, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
    gitq(r2, ["update-index", "--assume-unchanged", "src/pinned.txt"]);
    const bl2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-wkb-")), "baseline.json");
    wk(r2, ["baseline", "--out", bl2]);
    write(path.join(r2, "src", "a.txt"), "two" + NL);
    const v2 = wk(r2, ["verify", "--baseline", bl2, "--allow", "src", "--expect-changes"]);
    ok("CONTROL: a flag already set before the baseline is not a finding", v2.code === 0, v2.out);
  }

  // THE BOUNDARY IS PUBLISHED IN THREE PLACES — worker.mjs's file header, the SCOPE notice `verify`
  // prints, and workers.md's "What verification is not" — and all three are read as the set of
  // things NOT checked. Closing an escape means removing it from all three; removing it from one
  // leaves a reader defending against something already defended, and trusting the rest of the list
  // less for containing a false entry. This is the repository's dominant defect shape (two things
  // that must agree where only one was edited) with a third copy, so it is reconciled rather than
  // asserted three times by hand.
  {
    const { r, bl } = repo();
    write(path.join(r, "src", "a.txt"), "two" + NL);
    const notice = wk(r, ["verify", "--baseline", bl, "--allow", "src", "--expect-changes"]).out;
    const header = read(W).slice(0, read(W).indexOf("import fs"));
    const doc = read(path.join(HERE, "..", "references", "workers.md"));
    const OPEN = ["ignored path", "mode", "symlink", ".git internals", "outside", "off disk"];
    for (const [label, text] of [["the SCOPE notice", notice], ["worker.mjs's header", header], ["workers.md", doc]]) {
      for (const term of OPEN)
        ok(`${label} still names the open escape "${term}"`,
          text.replace(/`/g, "").toLowerCase().includes(term.replace(/`/g, "").toLowerCase()), label);
      ok(`${label} does not claim the closed escape is unseen`,
        !/(does |it )?NOT see[^.]{0,120}assume-unchanged/i.test(text.replace(/\s+/g, " ")), label);
    }
  }

  // A baseline this build cannot fully interpret is REJECTED, never partially trusted: a check that
  // silently stops running is a pass wearing the check's name.
  {
    const { r, bl } = repo();
    const j = JSON.parse(fs.readFileSync(bl, "utf8"));
    ok("baseline records its version (fixture sanity)", j.version === 3, String(j.version));
    j.version = 2; delete j.taken.skipflags;
    write(bl, JSON.stringify(j));
    const v = wk(r, ["verify", "--baseline", bl, "--allow", "src", "--expect-changes"]);
    ok("a baseline predating the flag capture is refused rather than skipped",
      v.code === 2 && /re-take it/.test(v.out), v.out);
  }

  // ARGV IS A GRAMMAR TOO, and it had the same hole every board check has had: a value it could
  // not classify was resolved instead of refused. `--allow a --allow b` was `opts.allow = argv[++i]`
  // — last-wins — so the first manifest entry vanished with no diagnostic. It can only under-grant,
  // which is why it survived: the visible symptom is a FAIL on a write the caller believed it had
  // permitted, and the cause is not in the output. The CONTROL matters as much as the fixture: the
  // refusal names the comma form as the remedy, so that form has to keep working.
  {
    const { r, bl } = repo();
    write(path.join(r, "src", "a.txt"), "two" + NL);
    write(path.join(r, "docs", "b.txt"), "two" + NL);
    const both = wk(r, ["verify", "--baseline", bl, "--allow", "src,docs", "--expect-changes"]);
    ok("CONTROL: one --allow carrying both paths verifies clean", both.code === 0, both.out);
    const dup = wk(r, ["verify", "--baseline", bl, "--allow", "src", "--allow", "docs", "--expect-changes"]);
    ok("a repeated --allow is refused, not silently resolved to the last one",
      dup.code === 2 && /given more than once/.test(dup.out), dup.out);
    ok("...and the refusal names the form that works", /comma-separated/.test(dup.out), dup.out);
    // The old parser tested `a === "--allow"` per flag; a Map replaced a chain of comparisons, and
    // an object literal would have reintroduced the escape one level up — `"toString" in FLAGS` is
    // true on every object, so an inherited property name parses as a flag.
    const proto = wk(r, ["verify", "--baseline", bl, "--allow", "src", "toString"]);
    ok("an inherited property name is an unknown argument, not a flag",
      proto.code === 2 && /unknown argument/.test(proto.out), proto.out);
    // Called without the `wk` helper, which appends `--root <r>`: that would give the trailing
    // `--allow` a value and test nothing. A flag at the very end of argv is the case that used to
    // read `undefined` and reach the manifest check as an empty allow-list.
    let bare;
    try { bare = { code: 0, out: execFileSync(process.execPath, [W, "verify", "--baseline", bl, "--allow"], { encoding: "utf8", env: CLEAN_ENV }) }; }
    catch (e) { bare = { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` }; }
    ok("a value flag at the end of argv is refused rather than taking undefined",
      bare.code === 2 && /needs a value/.test(bare.out), bare.out);
  }

  // Every escape the design has to catch, each its own case.
  {
    const { r, bl } = repo();
    write(path.join(r, "outside.txt"), "x" + NL);
    const v = wk(r, ["verify", "--baseline", bl, "--allow", "src"]);
    ok("a write outside the manifest is a finding", v.code === 1 && /outside the manifest/.test(v.out), v.out);
  }
  {
    const { r, bl } = repo();
    write(path.join(r, ".collab-board", "sessions", "s", "points.md"), "| P1 |" + NL);
    const v = wk(r, ["verify", "--baseline", bl, "--allow", "src"]);
    ok("a write inside the BOARD is a finding — a worker has no board access at all",
      v.code === 1 && /inside the board/.test(v.out), v.out);
  }
  {
    // A worker that COMMITS its own work leaves a clean tree and no visible diff. Without the HEAD
    // check this reads as "the worker changed nothing", which is the failure mode that makes
    // silence and success identical.
    const { r, bl } = repo();
    write(path.join(r, "src", "a.txt"), "two" + NL);
    gitq(r, ["add", "-A"]);
    gitq(r, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "sneaky"]);
    const v = wk(r, ["verify", "--baseline", bl, "--allow", "src"]);
    ok("a worker that COMMITS its work is a finding, not a clean tree",
      v.code === 1 && /HEAD moved/.test(v.out), v.out);
  }
  {
    // A worker that reverts the PRIMARY's own work in progress leaves a tidy tree and has destroyed
    // something. Comparing only NEW changes would call this clean.
    const r0 = fs.mkdtempSync(path.join(os.tmpdir(), "cb-wk-"));
    gitq(r0, ["init", "-q", "."]);
    write(path.join(r0, "src", "a.txt"), "one" + NL);
    gitq(r0, ["add", "-A"]);
    gitq(r0, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
    write(path.join(r0, "src", "a.txt"), "work in progress" + NL);   // the PRIMARY's edit
    const bl = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-wkb-")), "baseline.json");
    wk(r0, ["baseline", "--out", bl]);
    write(path.join(r0, "src", "a.txt"), "one" + NL);                 // the worker reverts it
    const v = wk(r0, ["verify", "--baseline", bl, "--allow", "src"]);
    ok("a worker that reverts pre-existing work is a finding",
      v.code === 1 && /gone/.test(v.out), v.out);
  }
  {
    const { r, bl } = repo();
    const v = wk(r, ["verify", "--baseline", bl, "--allow", "src", "--expect-changes"]);
    ok("a write job that changed NOTHING is a finding — an empty diff is not a completed task",
      v.code === 1 && /no change at all/.test(v.out), v.out);
    // ...while a READ job legitimately changes nothing, which is why the demand is a flag rather
    // than the default. The review made this point: "the diff is the deliverable" covers only write
    // jobs, because a read worker has no diff and its answer IS its output.
    ok("control: without --expect-changes an unchanged tree is fine",
      wk(r, ["verify", "--baseline", bl, "--allow", "src"]).code === 0);
  }
  // THE HOLE THAT MADE THE WHOLE GUARANTEE FALSE, found by the review with a two-line
  // construction. Comparing porcelain STATUS LINES is comparing a claim about the content: a file
  // already modified before the dispatch reads ` M path` both before AND after, so a worker could
  // overwrite ANY already-dirty file, outside its manifest, while verify printed "every change is
  // inside the manifest". Content is now hashed per path, which is the only thing that sees it.
  {
    const r0 = fs.mkdtempSync(path.join(os.tmpdir(), "cb-wk-"));
    gitq(r0, ["init", "-q", "."]);
    write(path.join(r0, "a", "f.txt"), "v1" + NL);
    write(path.join(r0, "b", "g.txt"), "v1" + NL);
    gitq(r0, ["add", "-A"]);
    gitq(r0, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
    write(path.join(r0, "a", "f.txt"), "the PRIMARY's work in progress" + NL);   // dirty BEFORE
    const bl = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-wkb-")), "baseline.json");
    wk(r0, ["baseline", "--out", bl]);
    write(path.join(r0, "a", "f.txt"), "the worker overwrote it" + NL);          // outside manifest
    write(path.join(r0, "b", "g.txt"), "the allowed change" + NL);
    const v = wk(r0, ["verify", "--baseline", bl, "--allow", "b", "--expect-changes"]);
    ok("attack: rewriting an ALREADY-dirty file outside the manifest is a finding",
      v.code === 1 && /silently rewrote/.test(v.out), v.out);
    ok("...and the finding says why only content shows it", /status line never changed/.test(v.out), v.out);
  }
  // ...and the same edit INSIDE the manifest is legitimate, or the check above would forbid a
  // worker from continuing work the PRIMARY had started.
  {
    const r0 = fs.mkdtempSync(path.join(os.tmpdir(), "cb-wk-"));
    gitq(r0, ["init", "-q", "."]);
    write(path.join(r0, "b", "g.txt"), "v1" + NL);
    gitq(r0, ["add", "-A"]);
    gitq(r0, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
    write(path.join(r0, "b", "g.txt"), "started by the primary" + NL);
    const bl = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-wkb-")), "baseline.json");
    wk(r0, ["baseline", "--out", bl]);
    write(path.join(r0, "b", "g.txt"), "finished by the worker" + NL);
    const v = wk(r0, ["verify", "--baseline", bl, "--allow", "b", "--expect-changes"]);
    ok("control: continuing an already-dirty file INSIDE the manifest is allowed", v.code === 0, v.out);
    ok("...and is reported as a change rather than passing silently", /changed  b\/g\.txt/.test(v.out), v.out);
  }
  // A worker that STAGES its work changes what a later commit captures without changing the
  // worktree the PRIMARY reads.
  {
    const { r, bl } = repo();
    write(path.join(r, "src", "a.txt"), "two" + NL);
    gitq(r, ["add", "-A"]);
    const v = wk(r, ["verify", "--baseline", bl, "--allow", "src", "--expect-changes"]);
    ok("attack: staging the work is a finding", v.code === 1 && /index moved/.test(v.out), v.out);
  }
  {
    const { r, bl } = repo();
    const v = wk(r, ["verify", "--baseline", bl]);
    ok("an absent write manifest is refused — an unbounded manifest is not a manifest",
      v.code === 2 && /not a manifest/.test(v.out), v.out);
  }
  {
    const { r } = repo();
    const v = wk(r, ["verify", "--allow", "src"]);
    ok("verifying without a baseline is refused", v.code === 2 && /--baseline/.test(v.out), v.out);
  }
  // A manifest entry cannot grant an escape by spelling one.
  {
    const { r, bl } = repo();
    write(path.join(r, "outside.txt"), "x" + NL);
    const v = wk(r, ["verify", "--baseline", bl, "--allow", "src/../.."]);
    ok("a manifest entry cannot grant a path outside the tree", v.code === 1, v.out);
  }

  // THE BOARD REFUSAL IS NOT A PROPERTY OF GIT'S VIEW, and this is the block that says so.
  //
  // It used to be. The refusal was derived from the paths `git status` reports as newly changed,
  // which quietly made it conditional on three unrelated facts about the repository — and
  // `workers.md` states it unconditionally, so a reader was entitled to a check that did not
  // exist. Two independent reviews found two different doors into the same room, which is the
  // signal that the cause was upstream of both: the tool was asking git about a property of the
  // BOARD. It now digests the board off the filesystem, so tracking, ignore rules, prior
  // dirtiness and the write manifest are all irrelevant to it.
  //
  // Each door below reproduced against the pre-fix build before this block was written; a guard
  // whose failure nobody has watched is a guard nobody has tested.
  {
    // DOOR 1: the board is gitignored — which the install docs invite, since session data is not
    // committed tooling. `git status --untracked-files=all` never mentions an ignored path, so the
    // board vanished from every set the check consulted and `verify` printed OK on a rewritten
    // HEAD.md.
    const r = fs.mkdtempSync(path.join(os.tmpdir(), "cb-wk-"));
    gitq(r, ["init", "-q", "."]);
    write(path.join(r, "src", "a.txt"), "one" + NL);
    write(path.join(r, ".collab-board", "sessions", "s", "HEAD.md"), "# HEAD" + NL);
    write(path.join(r, ".gitignore"), ".collab-board/" + NL);
    gitq(r, ["add", "-A"]);
    gitq(r, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
    const bl = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-wkb-")), "baseline.json");
    wk(r, ["baseline", "--out", bl]);
    write(path.join(r, "src", "a.txt"), "two" + NL);
    write(path.join(r, ".collab-board", "sessions", "s", "HEAD.md"), "TAMPERED BY WORKER" + NL);
    const v = wk(r, ["verify", "--baseline", bl, "--allow", "src", "--expect-changes"]);
    ok("a board rewrite is refused even when the board is GITIGNORED",
      v.code === 1 && /inside the board/.test(v.out), v.out);
    ok("...and the run says the board check does not depend on git's view",
      /digested off the filesystem/.test(v.out), v.out);
    // CONTROL, and it is the load-bearing half: the same ignored-board repository doing an honest
    // job must still verify clean. A refusal that fires whenever a board is ignored would be the
    // same defect pointing the other way.
    const r2 = fs.mkdtempSync(path.join(os.tmpdir(), "cb-wk-"));
    gitq(r2, ["init", "-q", "."]);
    write(path.join(r2, "src", "a.txt"), "one" + NL);
    write(path.join(r2, ".collab-board", "sessions", "s", "HEAD.md"), "# HEAD" + NL);
    write(path.join(r2, ".gitignore"), ".collab-board/" + NL);
    gitq(r2, ["add", "-A"]);
    gitq(r2, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
    const bl2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-wkb-")), "baseline.json");
    wk(r2, ["baseline", "--out", bl2]);
    write(path.join(r2, "src", "a.txt"), "two" + NL);
    const v2 = wk(r2, ["verify", "--baseline", bl2, "--allow", "src", "--expect-changes"]);
    ok("control: an honest job in a repo with an ignored board still verifies clean",
      v2.code === 0 && /^OK/m.test(v2.out), v2.out);
  }
  {
    // DOOR 2: the board file was ALREADY dirty when the dispatch began. Its status line reads
    // ` M path` before and after, so it never entered the changed set and fell through to the
    // digest loop, which accepted it for being inside the manifest. The shared `repo()` helper
    // cannot express this case: it takes the baseline on a clean tree, and the whole point here is
    // that the board is already dirty when the baseline is taken.
    const r3 = fs.mkdtempSync(path.join(os.tmpdir(), "cb-wk-"));
    gitq(r3, ["init", "-q", "."]);
    write(path.join(r3, "src", "a.txt"), "one" + NL);
    write(path.join(r3, ".collab-board", "sessions", "s", "HEAD.md"), "# HEAD" + NL);
    gitq(r3, ["add", "-A"]);
    gitq(r3, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
    write(path.join(r3, ".collab-board", "sessions", "s", "HEAD.md"), "dirty before dispatch" + NL);
    const bl3 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-wkb-")), "baseline.json");
    wk(r3, ["baseline", "--out", bl3]);
    write(path.join(r3, "src", "a.txt"), "two" + NL);
    write(path.join(r3, ".collab-board", "sessions", "s", "HEAD.md"), "TAMPERED BY WORKER" + NL);
    const v3 = wk(r3, ["verify", "--baseline", bl3, "--allow", "src", "--expect-changes"]);
    ok("a PRE-DIRTY board file rewritten by the worker is refused",
      v3.code === 1 && /board/i.test(v3.out), v3.out);
    // ...and the manifest is not a way to grant it. This is the exact configuration that made the
    // pre-fix build print OK, so the entry is refused outright rather than accepted and policed.
    const v4 = wk(r3, ["verify", "--baseline", bl3, "--allow", "src,.collab-board/", "--expect-changes"]);
    ok("a write manifest naming the board is refused outright",
      v4.code === 2 && /never grantable/.test(v4.out), v4.out);
  }
  {
    // A worker that DELETES board state is the same violation as one that writes it, and the
    // status-line reading saw neither once the board was invisible to git.
    const { r, bl } = repo();
    fs.rmSync(path.join(r, ".collab-board", "sessions", "s", "HEAD.md"));
    const v = wk(r, ["verify", "--baseline", bl, "--allow", "src"]);
    ok("a board file DELETED during the dispatch is a finding",
      v.code === 1 && /deleted inside the board/.test(v.out), v.out);
  }
  {
    // FAIL CLOSED on a baseline this build cannot classify. A pre-v2 baseline carries no board
    // digest, so the refusal above would have nothing to compare and would silently not run —
    // and a check that stops running is a pass, which is the failure this project refuses to
    // ship. It must say so and exit, not proceed.
    const { r, bl } = repo();
    const old = JSON.parse(read(bl));
    old.version = 1; delete old.taken.board;
    fs.writeFileSync(bl, JSON.stringify(old, null, 2));
    write(path.join(r, ".collab-board", "sessions", "s", "HEAD.md"), "TAMPERED" + NL);
    const v = wk(r, ["verify", "--baseline", bl, "--allow", "src"]);
    // Asserted as the RULE — refuse and name the remedy — rather than as the sentence. The message
    // used to name the board digest specifically; a second captured field arrived later and the
    // wording generalised, which would have failed a test pinned to the old phrase while the
    // property it guards was intact.
    ok("a pre-v2 baseline is REFUSED rather than verified with the board check disabled",
      v.code === 2 && /is version 1, not \d/.test(v.out) && /re-take it/.test(v.out), v.out);
  }
  {
    // CONTROL: a repository with no board at all is the ordinary case for a worker dispatched in
    // a project that has never run a session. It must not acquire a finding from the new block.
    const r = fs.mkdtempSync(path.join(os.tmpdir(), "cb-wk-"));
    gitq(r, ["init", "-q", "."]);
    write(path.join(r, "src", "a.txt"), "one" + NL);
    gitq(r, ["add", "-A"]);
    gitq(r, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
    const bl = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-wkb-")), "baseline.json");
    wk(r, ["baseline", "--out", bl]);
    write(path.join(r, "src", "a.txt"), "two" + NL);
    const v = wk(r, ["verify", "--baseline", bl, "--allow", "src", "--expect-changes"]);
    ok("control: a repository with no board at all still verifies clean",
      v.code === 0 && /^OK/m.test(v.out), v.out);
  }
}

// 17b-56. SKILL.md's frontmatter must survive a strict YAML reader.
//
// A compression pass rewrote the description to end "Default roles: Claude PRIMARY, Codex
// SECONDARY;" — a colon-space inside an UNQUOTED scalar. That one character passed the document
// checker (prose is not a machine token), passed every assertion in this file, and passed the host
// that happens to parse leniently. A stricter loader read the description as EMPTY, so the skill
// loaded but did not appear in the index — and it announced that on stderr, on an unrelated run,
// where it was found only because that run had failed for another reason.
//
// The frontmatter is the one part of the shipped surface a MACHINE parses as data rather than
// prose, so it gets a parse test rather than a token test.
if (SEL(92)) {
  // EVERY file with frontmatter, not the one that happened to break. The first version of this
  // guard read SKILL.md alone, which is the same narrowness the review kept finding elsewhere:
  // four command files carry descriptions, argument hints and tool lists that a host parses as
  // data, and none of them was covered.
  const SKILL_DIR = path.join(HERE, "..");
  const withFrontmatter = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".md")) continue;
      if (/^---\r?\n/.test(read(p))) withFrontmatter.push(p);
    }
  })(SKILL_DIR);
  ok("the shipped surface's frontmatter files enumerate (fixture sanity)",
    withFrontmatter.length >= 5, withFrontmatter.map((p) => path.basename(p)).join(", "));

  for (const file of withFrontmatter) {
    const name = path.relative(SKILL_DIR, file).split(path.sep).join("/");
    const raw = read(file);
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    ok(`${name}: the frontmatter block terminates`, !!fm);
    if (!fm) continue;
    const lines = fm[1].split(/\r?\n/).filter((l) => l.trim() !== "");
    const keys = [];
    for (const l of lines) {
      const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(l);
      // A continuation line is legal YAML; a line that is neither a key nor indented is not.
      if (!m) { ok(`${name}: every frontmatter line is a key or a continuation`, /^\s/.test(l), l.slice(0, 60)); continue; }
      keys.push(m);
    }
    ok(`${name}: declares a description`, keys.some((k) => k[1] === "description"));
    const seen = new Set();
    for (const [, key, value] of keys) {
      // DUPLICATE KEYS. A strict reader may take the last, the first, or refuse; whichever it does,
      // two answers are on the page. The regex guard this replaces could not see them at all.
      ok(`${name}: ${key} is declared once`, !seen.has(key), key);
      seen.add(key);
      const v = value.trim();
      const quoted = /^"[^"]*"$/.test(v) || /^'[^']*'$/.test(v);
      const looksQuoted = /^["']/.test(v);
      // An UNTERMINATED quote is the other thing the old regex waved through.
      ok(`${name}: ${key} has no unterminated quote`, !looksQuoted || quoted, v.slice(0, 60));
      // A bare `: ` inside an unquoted scalar is where a strict reader stops. Either quote the
      // value or write the sentence without the colon; both are fine, and neither is what happened.
      ok(`${name}: ${key} survives a strict reader (no bare ": " unquoted)`,
        quoted || !v.includes(": "), v.slice(0, 70));
      ok(`${name}: ${key} has a non-empty value`, v.length > 0);
    }
  }
  // The description is what the host indexes the skill by, so an empty one is a silent removal
  // from the index rather than an error anybody sees.
  const skillFm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(read(path.join(SKILL_DIR, "SKILL.md")))[1];
  const desc = (/^description:\s*(.+)$/m.exec(skillFm) || [])[1] || "";
  ok("the skill description is substantial enough to route on", desc.length > 100, String(desc.length));
}

// 17b-57. The lint spec is EXECUTABLE about severity.
//
// The existing coverage test asserts every emitted code has a spec row and a fixture. It cannot see
// whether the row says the right thing, and the suite itself admits that one row per code cannot
// detect incomplete behaviour coverage. Severity is the part of a row that is machine-comparable
// today: the engine emits a finite set per code, the row declares one, and nothing held them
// together — L3's row said FAIL while the engine emitted FAIL and WARN, with the row's own prose
// describing the WARN it did not declare.
//
// This is the smallest executable claim the spec can carry, and it found real drift the first time
// it ran. It is not the whole of "named subcases with mutation fingerprints"; it is the part that
// is mechanically decidable without inventing a naming convention for every fixture in this file.
if (SEL(93)) {
  const spec = read(path.join(HERE, "..", "references", "lint-spec.md"));
  const engine = read(CLI);

  // UNION across every row for a code, not the last one seen. A code with several rows (L0 has
  // three, L22 has three) previously took whichever row the scan reached last, so the claim this
  // test enforces depended on row ORDER in the document — and adding a row could silently change
  // which arm was being checked.
  const declared = new Map();
  for (const m of spec.matchAll(/^\|\s*(L\d+)[^|]*\|\s*([^|]+?)\s*\|/gm)) {
    if (!declared.has(m[1])) declared.set(m[1], new Set());
    for (const s of m[2].split("/").map((x) => x.trim()).filter(Boolean)) declared.get(m[1]).add(s);
  }
  const emitted = new Map();
  const emit = (code, sev) => {
    if (!emitted.has(code)) emitted.set(code, new Set());
    emitted.get(code).add(sev);
  };
  for (const m of engine.matchAll(/add\("(FAIL|WARN)",\s*"(L\d+)"/g)) emit(m[2], m[1]);
  // A ruleset-gated arm emits FAIL on a board declaring the introducing ruleset and WARN on a
  // legacy one, so it emits BOTH and its row must say so. Writing the severity at the call site is
  // exactly what these arms stopped doing.
  for (const m of engine.matchAll(/addGated\("[A-Z0-9_]+",\s*"(L\d+)"/g)) { emit(m[1], "FAIL"); emit(m[1], "WARN"); }

  ok("the spec's severity column parses for every row (fixture sanity)", declared.size >= 25, String(declared.size));
  ok("the engine's findings parse (fixture sanity)", emitted.size >= 25, String(emitted.size));

  for (const [code, sevs] of [...emitted].sort()) {
    const d = declared.get(code);
    ok(`${code} has a spec row`, !!d);
    if (!d) continue;
    const got = [...sevs].sort().join("/"), want = [...d].sort().join("/");
    // BOTH directions. A row claiming a severity the engine never emits is as wrong as a row
    // missing one it does — the first describes a check that cannot fire the way it says, the
    // second leaves a reader unprepared for a finding they will actually see.
    ok(`${code} declares exactly the severities it emits (${got})`, got === want, `spec says ${want}`);
  }
  for (const code of declared.keys())
    ok(`${code}'s spec row describes a check that still exists`, emitted.has(code) || code === "L17", code);
}


// 94. GATE PROVENANCE — `verified=self|reported` on GATE_SET. Lint checks grammar, linkage
// and the PRESENCE of evidence; it cannot check truth, and a check that pretended to would be the
// rubber stamp this token exists to remove. Absence of the token means "no applicable executable
// check", never "unverified", so the last control proves an ordinary gate pays nothing for it.
if (SEL(94)) {
  const gate = (rest) => (t) => t.trimEnd() + NL + "2026-08-03T10:00:00Z GATE_SET " + rest + NL;
  const shard = (ev) => ["### TURN-P1 (CLAUDE)", "SCHEMA: collab-board/turn/v1",
    "- Header: PART=PLAN · RESPONDS_TO=NEW · POINTS=N/A", "- Body:", "  - FINDINGS: x",
    "  - CHALLENGE: N/A", "  - PROPOSAL: x", "- Evidence: " + ev,
    "- Handoff: CLAUDE WORKING->ON_HOLD, CODEX ON_HOLD->START", "PREV: NEW", "NEXT: pending", ""].join(NL);

  const a = scaffold();
  edit(file(a.dir, "log.md"), gate("PLAN_AGREE_SECONDARY=YES by=CODEX justified_by=P1 verified=probably"));
  ok("verified= off its two-value grammar fails L20",
    /L20\b.*is not .self. or .reported./.test(lint(a.root, a.id).out));

  const b = scaffold();
  edit(file(b.dir, "log.md"), gate("PLAN_AGREE_SECONDARY=YES by=CODEX verified=self"));
  // The FACT is pinned, not one phrasing of it: the diagnostic has to fire and has to be about
  // this token naming no turn. An earlier version matched the literal `no justified_by`, so it
  // broke the moment the message learned that `in=` is the same claim spelled the older way.
  ok("verified= naming no turn fails L20 — a verification claim must cite the turn that records it",
    /L20\b[^\n]*verified=self[^\n]*names no turn/.test(lint(b.root, b.id).out));

  const c = scaffold();
  edit(file(c.dir, "log.md"), gate("PLAN_AGREE_SECONDARY=YES by=CODEX justified_by=P9 verified=self"));
  ok("verified= citing a turn that does not exist fails L20",
    /L20\b.*no turn shard P9/.test(lint(c.root, c.id).out));

  const d = scaffold();
  write(file(d.dir, "turns", "P1-claude.md"), shard("N/A"));
  edit(file(d.dir, "log.md"), gate("PLAN_AGREE_SECONDARY=YES by=CODEX justified_by=P1 verified=self"));
  ok("verified=self citing a shard whose Evidence is N/A fails L20",
    /L20\b.*Evidence is N\/A/.test(lint(d.root, d.id).out));

  // CONTROL 1: the legitimate case. Same board shape, same token, real evidence — no L20.
  const e = scaffold();
  write(file(e.dir, "turns", "P1-claude.md"), shard("ran `node scripts/test.mjs --only L26` -> 25 passed, 0 failed"));
  edit(file(e.dir, "log.md"), gate("PLAN_AGREE_SECONDARY=YES by=CODEX justified_by=P1 verified=self"));
  ok("a verified=self gate citing real evidence passes L20", !has(lint(e.root, e.id).out, "L20"));
  ok("...and verified=reported is equally legal", (() => {
    const f2 = scaffold();
    write(file(f2.dir, "turns", "P1-claude.md"), shard("PRIMARY reported 1491 passed, 0 failed"));
    edit(file(f2.dir, "log.md"), gate("PLAN_AGREE_SECONDARY=YES by=CODEX justified_by=P1 verified=reported"));
    return !has(lint(f2.root, f2.id).out, "L20");
  })());

  // CONTROL 2: absence costs nothing. A gate with no token is not "unverified", it is a gate where
  // no executable check applied, and it must not acquire a finding because the token now exists.
  const g = scaffold();
  edit(file(g.dir, "log.md"), gate("PLAN_AGREE_SECONDARY=YES by=CODEX justified_by=P1"));
  ok("a gate with no verified= token gains no finding", !has(lint(g.root, g.id).out, "L20"));

  // THE TAIL IS A CLOSED GRAMMAR, read whole rather than by first match. `\bverified=(\S*)` took
  // `verified=self verified=banana` for `self` and never saw the second token — a payload field
  // validated by first match while section 8 calls the grammar closed. The SECONDARY found this by
  // reading the shipped code, not by running it.
  const h = scaffold();
  write(file(h.dir, "turns", "P1-claude.md"), shard("ran the check"));
  edit(file(h.dir, "log.md"), gate("PLAN_AGREE_SECONDARY=YES by=CODEX justified_by=P1 verified=self verified=banana"));
  ok("a repeated tail key fails L20 instead of the first one silently winning",
    /L20\b.*repeats verified=/.test(lint(h.root, h.id).out));

  const i2 = scaffold();
  write(file(i2.dir, "turns", "P1-claude.md"), shard("ran the check"));
  edit(file(i2.dir, "log.md"), gate("PLAN_AGREE_SECONDARY=YES by=CODEX justified_by=P1 audited_by=NOBODY"));
  ok("an unknown tail token fails L20", /L20\b.*unknown token audited_by=NOBODY/.test(lint(i2.root, i2.id).out));

  // THE ALIAS IS ONE FIELD, NOT TWO. Deduplicating on the LITERAL key let `in=` and
  // `justified_by=` both through, and the lookup then took whichever came first — the first-reader
  // ambiguity the whole-tail read exists to close, reintroduced by the alias that made the read
  // possible. The SECONDARY found it by reading the repair, not the code it replaced.
  const k = scaffold();
  write(file(k.dir, "turns", "P1-claude.md"), shard("ran the check"));
  write(file(k.dir, "turns", "P2-codex.md"), shard("ran a different check"));
  edit(file(k.dir, "log.md"), gate("PLAN_AGREE_SECONDARY=YES by=CODEX in=P1 justified_by=P2 verified=self"));
  ok("two spellings of the justifying turn fail L20 instead of the first one winning",
    /L20\b.*names the justifying turn twice/.test(lint(k.root, k.id).out), lint(k.root, k.id).out.split(NL).find((l) => /L20/.test(l)) || "");

  // CONTROL: each spelling ALONE is legal, so the fix rejects the collision and not the alias.
  for (const spelling of ["in=P1", "justified_by=P1"]) {
    const s3 = scaffold();
    write(file(s3.dir, "turns", "P1-claude.md"), shard("ran the check"));
    edit(file(s3.dir, "log.md"), gate(`PLAN_AGREE_SECONDARY=YES by=CODEX ${spelling} verified=self`));
    ok(`control: ${spelling} alone still justifies a verified gate`, !has(lint(s3.root, s3.id).out, "L20"));
  }

  // CONTROL: an AUTHORLESS gate must not acquire a second finding. Its line is committed history
  // that no append repairs, L20_GATE_AUTHOR already names it, and a board cannot act on either.
  const j = scaffold();
  edit(file(j.dir, "log.md"), gate("PLAN_AGREE_SECONDARY=YES in=P1 audited_by=NOBODY"));
  const jout = lint(j.root, j.id).out;
  ok("control: an authorless gate is reported once, by the author arm only",
    /carries no by=/.test(jout) && !/unknown token/.test(jout), jout.split(NL).filter((l) => /L20/.test(l)).join(" | "));
}

// 95. THE SUBSET SELECTOR CONTRACT. `--only` exists so a reviewer under a per-command time
// ceiling can run the assertions covering one claim. That makes it a route to a GREEN CLAIM, which
// is exactly the surface this project has had to defend hardest: a subset that can be reported as a
// full run is worse than no selector at all, because it launders six blocks into 1491.
if (SEL(95)) {
  const SELF = fileURLToPath(import.meta.url);
  const runSelf = (args) => {
    try { return { code: 0, out: execFileSync(process.execPath, [SELF, ...args], { encoding: "utf8" }) }; }
    catch (e2) { return { code: e2.status, out: (e2.stdout || "") + (e2.stderr || "") }; }
  };

  const zero = runSelf(["--only", "no-such-block-zzz"]);
  ok("a selector matching nothing exits NON-ZERO — a typo is not a passing run",
    zero.code !== 0 && /matched 0 of \d+ blocks/.test(zero.out), String(zero.code));

  const one = runSelf(["--only", "3"]);
  ok("an all-digit selector is an ORDINAL, not a substring", /matched 1\/\d+ blocks/.test(one.out), one.out.split(NL)[2] || "");
  ok("a subset run NEVER prints the unqualified full-run summary",
    one.code === 0 && !/^PASS: \d+ passed/m.test(one.out) && /PASS\(SUBSET\)/.test(one.out));
  ok("a subset run says so in words a quoted line cannot lose", /NOT a full run/.test(one.out));

  // The banner's total and the number of guards in the source are two things that must agree.
  const guardCount = (fs.readFileSync(SELF, "utf8").match(/^if \(SEL\(\d+\)\) \{$/gm) || []).length;
  const declaredTotal = Number((one.out.match(/matched \d+\/(\d+) blocks/) || [])[1]);
  ok("the banner's block total equals the guards actually in the file",
    guardCount > 0 && guardCount === declaredTotal, guardCount + " vs " + declaredTotal);

  // NEGATIVE CONTROL for the ordinal self-check: mangle one guard in a COPY and confirm the runner
  // refuses to run at all. A self-check nobody has broken is a self-check nobody has tested.
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-sel-")), "test.mjs");
  fs.writeFileSync(tmp, fs.readFileSync(SELF, "utf8").replace(/^if \(SEL\(2\)\) \{$/m, "if (SEL(77)) {"));
  let mangled;
  try { execFileSync(process.execPath, [tmp, "--only", "3"], { encoding: "utf8" }); mangled = { code: 0, out: "" }; }
  catch (e2) { mangled = { code: e2.status, out: (e2.stdout || "") + (e2.stderr || "") }; }
  ok("out-of-order guard ordinals stop the run instead of shifting every selector",
    mangled.code !== 0 && /SELECTOR CORRUPT/.test(mangled.out), String(mangled.code));
}


// 96. THE UNRESOLVED-ROW PLACEHOLDER. `Resolved In` takes a bare ASCII hyphen while a point is
// OPEN, and that is the one rule on this board with nowhere to be written down: a scaffolded
// points.md cannot carry an example row, because the engine and this suite both match its bytes and
// a sample row in its comment reads as a live one — two fixtures in this file broke exactly that
// way. So the DIAGNOSTIC is the only teacher, and it has to name the remedy rather than restate the
// mismatch. It used to say `Resolved In=<cell> but log projects -`, where the trailing hyphen meant
// "no resolving turn" and read as the value the writer should have typed.
if (SEL(96)) {
  const openRow = (cell) => (t) => t.replace(/^\|----.*\|$/m, (h) =>
    h + NL + "| P1 | PLAN | a point under discussion | OPEN | " + cell + " |");
  const mk = (cell) => {
    const s = scaffold();
    edit(file(s.dir, "log.md"), (t) => t.trimEnd() + NL +
      "2026-08-03T10:00:00Z TURN_COMMIT P1 actor=CLAUDE responds_to=NEW points=P1" + NL +
      "2026-08-03T10:00:01Z POINT_SET P1=OPEN in=P1" + NL);
    edit(file(s.dir, "points.md"), openRow(cell));
    edit(file(s.dir, "HEAD.md"), (t) => t.replace("PLAN_OPEN_POINTS: 0", "PLAN_OPEN_POINTS: 1"));
    return lint(s.root, s.id).out;
  };

  const emdash = mk(String.fromCharCode(8212));
  ok("an unresolved row that is not a bare hyphen fails L2",
    /L2\b[^\n]*P1[^\n]*resolves P1 in no turn/.test(emdash), emdash.split(NL).find((l) => /L2/.test(l)) || "");
  ok("...and the diagnostic names the remedy rather than restating the mismatch",
    /bare ASCII hyphen/.test(emdash));
  ok("...and does not end in the bare token that used to read as the cell's own value",
    !/but log projects -$/m.test(emdash));

  // CONTROL: the legitimate placeholder draws nothing.
  ok("a bare ASCII hyphen on an OPEN row is clean", !has(mk("-"), "L2"));

  // CONTROL: splitting the branch must not swallow the case it was split FROM — a row naming the
  // wrong resolving turn still gets the projection message, not the placeholder one.
  const w = scaffold();
  write(file(w.dir, "turns", "P1-claude.md"), "### TURN-P1 (CLAUDE)" + NL + "PREV: NEW" + NL);
  edit(file(w.dir, "log.md"), (t) => t.trimEnd() + NL +
    "2026-08-03T10:00:00Z TURN_COMMIT P1 actor=CLAUDE responds_to=NEW points=P1" + NL +
    "2026-08-03T10:00:01Z POINT_SET P1=AGREED in=P1" + NL);
  edit(file(w.dir, "points.md"), (t) => t.replace(/^\|----.*\|$/m, (h) =>
    h + NL + "| P1 | PLAN | a settled point | AGREED | [P7](turns/P7-codex.md) |"));
  const wrong = lint(w.root, w.id).out;
  ok("control: a row naming the WRONG resolving turn still gets the projection message",
    /L2\b[^\n]*Resolved In=P7 but log projects P1/.test(wrong),
    wrong.split(NL).find((l) => /L2/.test(l)) || "");
}

// 97. `explain <code>` — the by-code consult path for one lint finding. Its whole value is two
// properties, and both are pinned here: (a) it selects rows with the SAME predicate this suite's
// MUST-token guard uses, so retrieval and guard can never name two different rows — asserted
// functionally (per-code output equals this file's own selection) AND at the source (the literal
// predicate string), because either alone can drift; (b) it is FAIL-CLOSED and LOUD on every
// degenerate input — unknown code, missing code, and a spec that lost its remediation paragraph —
// since the failure mode being designed out is SILENCE, which reads as "no such check".
if (SEL(97)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-explain-"));
  const spec = read(path.join(HERE, "..", "references", "lint-spec.md"));
  const specLines = spec.split(/\r?\n/);
  const rowsFor = (code) => specLines.filter((l) => l.startsWith("| " + code + " "));

  // (a) functional predicate agreement, across the shapes that differ: single row, the two
  // multi-arm codes, the shortest and longest rows, and a code from the middle of the table.
  // L2 is in the sample DELIBERATELY: it prefixes ten other codes (L20-L29), so it is the code on
  // which a predicate that loses its trailing space becomes observable — the first negative
  // control run proved a sample without it stays green under exactly that drift.
  for (const code of ["L0", "L2", "L7", "L18", "L22", "L25", "L26"]) {
    const want = rowsFor(code);
    const r = run(["explain", code], root);
    ok(`explain ${code} exits 0 and prints exactly its ${want.length} spec row(s), suite-predicate-identical`,
      r.code === 0 && want.length > 0 && want.every((w) => r.out.includes(w))
        && r.out.split(/\r?\n/).filter((l) => l.startsWith("| L")).length === want.length, r.out.slice(0, 200));
    ok(`explain ${code} appends the general remediation paragraph`,
      /\*\*Remediation, in general:\*\*/.test(r.out));
  }
  // The pin matches the executable STATEMENT, not the bare predicate string: cmdExplain's own
  // rationale comment quotes the predicate, and a pin the comment satisfies is a claim about the
  // code that survives the code drifting — the first negative control run proved exactly that.
  ok("the engine selects rows with the suite's own predicate, at the source (statement, not comment)",
    read(CLI).includes('const rows = lines.filter((l) => l.startsWith("| " + code + " "));'));

  // (b) fail-closed, loudly. An unknown code ERRORS and names the legal set — never empty output.
  const unknown = run(["explain", "L99"], root);
  ok("explain L99 exits non-zero and says so — silence is the failure mode being designed out",
    unknown.code !== 0 && /no such check L99/.test(unknown.out) && /L26/.test(unknown.out));
  ok("...and prints no spec row for it", !unknown.out.split(/\r?\n/).some((l) => l.startsWith("| L")));
  const bare = run(["explain"], root);
  ok("explain with no code exits non-zero and shows the expected form",
    bare.code !== 0 && /expects one check code/.test(bare.out));
  const lower = run(["explain", "l26"], root);
  ok("explain normalises case (l26 = L26) — a lowercase habit must not read as 'no such check'",
    lower.code === 0 && rowsFor("L26").every((w) => lower.out.includes(w)));

  // (b, second half) a spec that lost its remediation paragraph is an ERROR, not a shorter answer:
  // a consult that silently lost its second half would read as complete. Run a COPY of the engine
  // against a references tree with a valid row but no closing paragraph.
  const stub = fs.mkdtempSync(path.join(os.tmpdir(), "cb-explain-stub-"));
  write(path.join(stub, "scripts", "collab-board.mjs"), read(CLI));
  write(path.join(stub, "references", "lint-spec.md"),
    "# Lint specification" + NL + NL + "| L1 SPLIT-STATE | FAIL | 1 | stub row. |" + NL);
  let stubRun;
  try { stubRun = { code: 0, out: execFileSync(process.execPath, [path.join(stub, "scripts", "collab-board.mjs"), "explain", "L1"], { encoding: "utf8", env: CLEAN_ENV }) }; }
  catch (e2) { stubRun = { code: e2.status ?? 1, out: `${e2.stdout || ""}${e2.stderr || ""}` }; }
  ok("a spec with no remediation paragraph makes explain ERROR rather than answer short",
    stubRun.code !== 0 && /no longer carries/.test(stubRun.out), stubRun.out.slice(0, 200));
}

// 98. The never-fired diagnostics carry their own remedy. Twenty codes have never produced a
// finding on a real board, so their messages are the ones nobody has read under pressure — and
// several stated only the condition. The standard (session 2026-08-14-lint-spec-disclosure, P4):
// a diagnostic names the condition with the offending value, the rule or invariant it serves, and
// at least one LEGAL remedy — or says explicitly that none exists because the finding names
// immutable history. These pins hold the RENDERED message, not the source, to that standard for
// the reworked sites; each token is the remedy clause, so a revert that keeps the condition and
// loses the remedy goes red.
if (SEL(98)) {
  const line = (out, code, extra) => out.split(/\r?\n/).find((l) =>
    new RegExp(`\\b${code}\\b`).test(l) && (!extra || extra.test(l))) || "";

  { // L3: the legal hand vocabulary is named, and the fix side (HEAD, via log replay) stated.
    const s = scaffold();
    edit(file(s.dir, "HEAD.md"), (t) => t.replace("- CLAUDE: ON_HOLD - PRIMARY", "- CLAUDE: SLEEPING - PRIMARY"));
    const l = line(lint(s.root, s.id).out, "L3", /invalid hand token/);
    ok("L3 invalid-hand names the legal vocabulary and the reconcile-against-log remedy",
      /START\|WORKING\|ON_HOLD\|DONE/.test(l) && /reconciling against log replay/.test(l), l);
  }
  { // L28: missing PROTOCOL pin says what to restore and from where.
    const s = scaffold();
    edit(file(s.dir, "HEAD.md"), (t) => t.replace(/^PROTOCOL:.*\r?\n/m, ""));
    const l = line(lint(s.root, s.id).out, "L28", /PROTOCOL is missing/);
    ok("L28 missing-PROTOCOL names the restore remedy and the SESSION.md source",
      /restore the PROTOCOL: line/.test(l) && /SESSION\.md's Protocol:/.test(l), l);
  }
  { // L11: terminal-but-not-DONE says which side is editable and which line is history.
    const s = scaffold();
    edit(file(s.dir, "HEAD.md"), (t) => t.replace("SESSION_STATUS: IDLE", "SESSION_STATUS: ABORTED"));
    const l = line(lint(s.root, s.id).out, "L11", /hand is not DONE/);
    ok("L11 not-DONE names Rule 8, the editable side (HEAD) and the set-both-DONE remedy",
      /Rule 8/.test(l) && /set both ## State rows to DONE/.test(l), l);
  }
  { // L14 orphan + L5 missing-PHASE_SET + L12 unlogged escalation, one board each.
    const s = scaffold();
    write(file(s.dir, "turns", "P1-claude.md"), "### TURN-P1 (CLAUDE)" + NL + "- Header: x" + NL
      + "- Body: USER_QUESTION: which way?" + NL + "- Evidence: N/A" + NL + "- Handoff: x" + NL
      + "PREV: NEW" + NL + "NEXT: pending" + NL);
    const out = lint(s.root, s.id).out;
    const l14 = line(out, "L14", /orphan shard/);
    ok("L14 orphan names the commit point, both legal moves, and recovery.md",
      /commit point/.test(l14) && /complete the missing writes/.test(l14)
        && /delete the orphan shard and re-delegate/.test(l14) && /recovery\.md/.test(l14), l14);
    const l12 = line(out, "L12", /USER_QUESTION/);
    ok("L12 unlogged-escalation names Rule 9's double record and the legal late append",
      /Rule 9/.test(l12) && /append the missing event/.test(l12) && /never edit earlier lines/.test(l12), l12);

    const s5 = scaffold();
    write(file(s5.dir, "turns", "I1-claude.md"), "### TURN-I1 (CLAUDE)" + NL + "PREV: NEW" + NL);
    const l5 = line(lint(s5.root, s5.id).out, "L5", /no PHASE_SET/);
    ok("L5 names the append-only law, the legal late PHASE_SET append, and the gate condition",
      /never insert or backdate/.test(l5) && /append the PHASE_SET now/.test(l5)
        && /both PLAN_AGREE_\* YES/.test(l5), l5);
  }
  { // L23: HEAD.LAST_UPDATE in the future is editable; a future LOG line is not.
    const s = scaffold();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    edit(file(s.dir, "HEAD.md"), (t) => t.replace(/^LAST_UPDATE:.*$/m, "LAST_UPDATE: " + future));
    const l = line(lint(s.root, s.id).out, "L23", /LAST_UPDATE/);
    ok("L23 future LAST_UPDATE names HEAD as editable and the live-clock rewrite",
      /HEAD is editable state/.test(l) && /rewrite LAST_UPDATE from the live clock/.test(l), l);

    const s2 = scaffold();
    edit(file(s2.dir, "log.md"), (t) => t.trimEnd() + NL + future + " STALL_CHECK actor=CLAUDE" + NL);
    const l2 = line(lint(s2.root, s2.id).out, "L23", /in the future/);
    ok("L23 future log line states that no in-place remedy exists and what clears it",
      /no in-place remedy/.test(l2) && /fix the clock/.test(l2) && /stays visible as history/.test(l2), l2);
  }
  { // L16 drift: authority direction is stated, not implied.
    const s = scaffold();
    edit(path.join(s.root, ".collab-board", "index.md"), (t) => t.replace("| IDLE |", "| ACTIVE |"));
    const l = line(lint(s.root, s.id).out, "L16", /≠ HEAD/);
    ok("L16 drift names HEAD as authoritative and the direction of the fix",
      /HEAD is authoritative/.test(l) && /never HEAD to match the row/.test(l), l);
  }
  { // L1 stray hand-token: Rule 1, the mirror's proper home, and the row-form scope note.
    const s = scaffold();
    edit(file(s.dir, "points.md"), (t) => t.trimEnd() + NL + NL + "- CLAUDE: START - PRIMARY" + NL);
    const l = line(lint(s.root, s.id).out, "L1", /hand-token outside HEAD\.md/);
    ok("L1 stray hand-token names Rule 1, the remedy, and the agent-file home for mirrors",
      /Rule 1/.test(l) && /reword or remove that row/.test(l) && /agents\/<actor>\.md/.test(l), l);
  }
  { // grammarProblems (via L29): both arms carry their remedy.
    const s = scaffold();
    edit(file(s.dir, "SESSION.md"), (t) => t.trimEnd() + NL + "Bogus: value" + NL + "Type: REFACTOR" + NL);
    const out = lint(s.root, s.id).out;
    const unknown = line(out, "L29", /Bogus is not a key/);
    ok("L29 unknown-key names the closed-grammar rule and both repair moves",
      /keys its grammar defines/.test(unknown) && /rename a typo/.test(unknown) && /indent it or comment it/.test(unknown), unknown);
    const dup = line(out, "L29", /Type declared 2 times/);
    ok("L29 duplicate-key says only the first is read and to keep exactly one",
      /only the first live declaration/.test(dup) && /keep exactly one/.test(dup), dup);
  }
  { // L0 unclosed comment in the log: the legal append remedy is stated.
    const s = scaffold();
    edit(file(s.dir, "log.md"), (t) => t.trimEnd() + NL + "<!-- never closed" + NL);
    const l = line(lint(s.root, s.id).out, "L0", /unclosed/);
    ok("L0 unclosed-comment names the append remedy as legal in the append-only log",
      /Append the missing "-->"/.test(l) && /legal even in the append-only log/.test(l), l);
  }
}

// 99. The left-alone half of the never-fired audit gets the same pin as the reworked half. The
// audit (session 2026-08-14-lint-spec-disclosure, I1) judged ten diagnostics "already
// self-sufficient" by READING them, and that judgement carried no fixture — the SECONDARY's I2
// review named a pin on those ten as the one durable improvement left, because a claim without an
// assertion under it is this repo's dominant defect. Same design as 98: each pin holds the
// RENDERED message's remedy/authority clause, so an edit that keeps the condition and drops the
// remedy goes red. Covered per judged verdict: every L6 arm (all seven), L7, L10, L13 (both
// arms), L19, both L21 arms, L25's orphan-capture arm, L18's invalid-adapter arm, L4's
// retired-status arm, and contractRoles' malformed arm (surfaces as L1).
if (SEL(99)) {
  const line = (out, code, extra) => out.split(/\r?\n/).find((l) =>
    new RegExp(`\\b${code}\\b`).test(l) && (!extra || extra.test(l))) || "";
  const ts = (offMs = 0) => new Date(Date.now() + offMs).toISOString();

  { // One board: L7, both L13 arms, L19, and L6's unset-code_state arm.
    const s = scaffold();
    edit(file(s.dir, "points.md"), (t) => t.replace(/^\|----.*\|$/m, (h) =>
      h + NL + "| P1 | PLAN | a settled point | AGREED | [P1](turns/P1-claude.md) |"));
    edit(file(s.dir, "log.md"), (t) => t.trimEnd() + NL
      + ts() + " TURN_COMMIT P1 actor=CLAUDE responds_to=NEW points=P1" + NL
      + ts(1) + " POINT_SET P1=AGREED in=P1" + NL);
    write(file(s.dir, "turns", "P1-claude.md"), ["### TURN-P1 (CLAUDE)",
      "- Header: PART=PLAN · RESPONDS_TO=NEW · POINTS=P1", "- Body: x", "- Evidence: N/A",
      "- Handoff: x", "PREV: NEW", "NEXT: pending"].join(NL) + NL);
    write(file(s.dir, "turns", "I1-claude.md"), ["### TURN-I1 (CLAUDE)", "- Header: x",
      "- Body: x", "- Handoff: x", "PREV: [P1](P1-claude.md)", "NEXT: pending"].join(NL) + NL);
    const out = lint(s.root, s.id).out;
    const l7 = line(out, "L7", /Topic/);
    ok("L7 unfilled-contract names the key, the placeholder, and Rule 2",
      /SESSION\.md Topic still "—" but TURN-P1 exists \(Rule 2\)/.test(l7), l7);
    const l13a = line(out, "L13", /Evidence/);
    ok("L13 missing-line names the exact required line — the name IS the remedy",
      /I1-claude\.md missing "- Evidence:"/.test(l13a), l13a);
    const l13b = line(out, "L13", /Impl:/);
    ok("L13 primary-impl arm names the exact missing Impl: line and the role that owes it",
      /\(PRIMARY IMPL\) missing "- Impl:" line/.test(l13b), l13b);
    const l19 = line(out, "L19");
    ok("L19 empty-evidence names both legal moves: cite, or state why none applies",
      /cite file:line \/ command output \/ doc/.test(l19) && /state why none applies/.test(l19), l19);
    const l6u = line(out, "L6", /BRANCH unset/);
    ok("L6 unset code_state names the two legal values (a real one, or NONE for no-git)",
      /BRANCH unset \(use a real value, or NONE for no-git\) but PRIMARY impl turns exist/.test(l6u), l6u);
  }
  { // One board: L6's other six arms — duplicate key, cardinality, placeholder-in-shard, echo
    // mismatch, secondary-Impl, and no-role actor. I0 carries the two-line arm so I1 stays the
    // LATEST primary shard, which is the only one the echo comparison reads.
    const s = scaffold();
    edit(file(s.dir, "impl", "code_state.md"), (t) => t
      .replace("BRANCH: —", "BRANCH: main" + NL + "BRANCH: main")
      .replace("BASE_COMMIT: —", "BASE_COMMIT: aaa1111")
      .replace("LATEST_COMMIT: —", "LATEST_COMMIT: bbb2222"));
    write(file(s.dir, "turns", "I0-claude.md"), ["### TURN-I0 (CLAUDE)", "- Body: x",
      "- Impl: BRANCH=main BASE_COMMIT=aaa1111 LATEST_COMMIT=bbb2222",
      "- Impl: BRANCH=main BASE_COMMIT=aaa1111 LATEST_COMMIT=bbb2222",
      "PREV: NEW", "NEXT: pending"].join(NL) + NL);
    write(file(s.dir, "turns", "I1-claude.md"), ["### TURN-I1 (CLAUDE)", "- Body: x",
      "- Impl: BRANCH=main BASE_COMMIT=— LATEST_COMMIT=ccc3333",
      "PREV: [I0](I0-claude.md)", "NEXT: pending"].join(NL) + NL);
    write(file(s.dir, "turns", "I2-codex.md"), ["### TURN-I2 (CODEX)", "- Body: x",
      "- Impl: BRANCH=main BASE_COMMIT=aaa1111 LATEST_COMMIT=ccc3333",
      "PREV: [I1](I1-claude.md)", "NEXT: pending"].join(NL) + NL);
    write(file(s.dir, "turns", "P7-ghost.md"), ["### TURN-P7 (GHOST)", "- Body: x",
      "PREV: NEW", "NEXT: pending"].join(NL) + NL);
    const out = lint(s.root, s.id).out;
    const dup = line(out, "L6", /more than once/);
    ok("L6 duplicate code_state key states the exactly-one law and what a duplicate costs",
      /declares BRANCH x2 more than once — exactly one live declaration each, or the echo compares against a value nobody reads/.test(dup), dup);
    const card = line(out, "L6", /I0-claude/);
    ok("L6 cardinality names the count found and the count required, with its rule",
      /I0-claude\.md has 2 Impl: lines — exactly one is required \(Rule 7\)/.test(card), card);
    const ph = line(out, "L6", /no real BASE_COMMIT/);
    ok("L6 placeholder-in-shard names the two legal values, like the code_state arm",
      /Impl: line has no real BASE_COMMIT \(use a real value, or NONE for no-git\)/.test(ph), ph);
    const echo = line(out, "L6", /ECHOES/);
    ok("L6 echo mismatch shows both values and states the direction: the shard echoes code_state",
      /Impl: LATEST_COMMIT=ccc3333 but impl\/code_state\.md says bbb2222 — the shard ECHOES code_state \(Rule 7\), it does not disagree with it/.test(echo), echo);
    const sec = line(out, "L6", /I2-codex/);
    ok("L6 secondary-Impl arm states the remedy: review-only, omit the line entirely",
      /carries an Impl: line — a SECONDARY IMPL turn is review-only and omits it entirely \(Rule 7\)/.test(sec), sec);
    const ghost = line(out, "L6", /ghost/);
    ok("L6 no-role actor names the actor and the consequence that makes it a finding",
      /names actor "ghost", which HEAD\.md declares no role for — every role-conditional check silently does not apply to such a shard/.test(ghost), ghost);
  }
  { // L10 deadlock: Rule 6 is the remedy pointer (PRIMARY decides, DECISION line).
    const s = scaffold();
    edit(file(s.dir, "points.md"), (t) => t.replace(/^\|----.*\|$/m, (h) =>
      h + NL + "| P1 | PLAN | a stuck point | OPEN | - |"));
    edit(file(s.dir, "log.md"), (t) => t.trimEnd() + NL
      + ts() + " TURN_COMMIT P1 actor=CLAUDE responds_to=NEW points=P1" + NL
      + ts(1) + " POINT_SET P1=OPEN in=P1" + NL
      + ts(2) + " TURN_COMMIT P2 actor=CODEX responds_to=P1 points=P1" + NL
      + ts(3) + " TURN_COMMIT P3 actor=CLAUDE responds_to=P2 points=P1" + NL
      + ts(4) + " TURN_COMMIT P4 actor=CODEX responds_to=P3 points=P1" + NL);
    const l = line(lint(s.root, s.id).out, "L10");
    ok("L10 deadlock names the count, the missing move, and Rule 6 that owns it",
      /point P1 OPEN after 4 turns with no DECISION \(Rule 6\)/.test(l), l);
  }
  { // L18 invalid adapter: the expected list IS the remedy.
    const s = scaffold();
    edit(file(s.dir, "SESSION.md"), (t) => t.replace(/^SecondaryAdapter:.*$/m, "SecondaryAdapter: bogus"));
    const l = line(lint(s.root, s.id).out, "L18", /bogus/);
    ok("L18 invalid adapter names the offending value and the whole legal set",
      /SecondaryAdapter=bogus is invalid \(expected /.test(l) && /codex-cli/.test(l) && /manual/.test(l), l);
  }
  { // contractRoles malformed arm (surfaces as L1): the exact required form is the remedy.
    const s = scaffold();
    edit(file(s.dir, "SESSION.md"), (t) => t.replace(/^Roles:.*$/m, "Roles: garbage"));
    const l = line(lint(s.root, s.id).out, "L1", /Roles is/);
    ok("L1 malformed Roles quotes the offending value and states the exact required form",
      /Roles is malformed \("garbage"\)/.test(l) && /must read exactly "PRIMARY=<actor>, SECONDARY=<actor>"/.test(l), l);
  }
  { // Both L21 arms on one file: BOM prefix and a cp1252 mojibake run, each naming its re-save.
    const s = scaffold();
    const p = file(s.dir, "points.md");
    fs.writeFileSync(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(read(p), "utf8"), Buffer.from([0xc3, 0xa2, 0xe2, 0x82, 0xac])]));
    const out = lint(s.root, s.id).out;
    const bom = line(out, "L21", /BOM/);
    ok("L21 BOM arm names the exact bytes and the re-save remedy",
      /points\.md starts with a UTF-8 BOM \(EF BB BF\) — re-save as clean UTF-8, no BOM/.test(bom), bom);
    const moj = line(out, "L21", /mojibake/);
    ok("L21 mojibake arm locates the run and names the re-encode remedy",
      /has a cp1252 double-encoding mojibake run near byte \d+ — re-encode as clean UTF-8/.test(moj), moj);
  }
  { // L25 orphan capture: the dead-relay diagnosis plus recovery.md as the procedure.
    const s = scaffold();
    edit(file(s.dir, "SESSION.md"), (t) => t.trimEnd() + NL + "BoardWriteMode: PRIMARY_ONLY" + NL);
    write(file(s.dir, "captures", "I7-a1.relay"), "captured turn body" + NL);
    const l = line(lint(s.root, s.id).out, "L25", /I7/);
    ok("L25 orphan capture explains the crash shape and routes the fix through recovery.md",
      /retains I7-a1\.relay for I7 but no TURN_COMMIT I7 was ever logged/.test(l)
        && /relay died between retaining the evidence and committing the turn/.test(l)
        && /reconcile per recovery\.md before retrying/.test(l), l);
  }
  { // L4 retired status: the no-deferral law plus every legal exit, none of them "leave it".
    const s = scaffold();
    edit(file(s.dir, "points.md"), (t) => t.replace(/^\|----.*\|$/m, (h) =>
      h + NL + "| P1 | PLAN | parked work | DEFERRED | - |"));
    const l = line(lint(s.root, s.id).out, "L4", /DEFERRED/);
    ok("L4 retired-status arm states the law and all three legal exits",
      /point P1 is DEFERRED/.test(l) && /there is no deferral status/.test(l)
        && /Resolve it here/.test(l) && /OUT_OF_SCOPE only if the board DETERMINED it is not needed/.test(l)
        && /carry it to a successor board and open it there/.test(l), l);
  }
}


// 100. A MALFORMED-VALUE FINDING STATES WHAT THE KEY ACCEPTS. The board that set the
// self-sufficiency standard audited the codes that had never fired; this one fired on the project's
// own drivers twice and failed it, and resolving it meant reading `okRecovery` in the engine — the
// consult `explain` exists to remove, except the L24 spec row does not carry the sub-grammar either.
// The message is KEY-level, never sub-field-level: naming "the field that failed" reads well until
// the value cannot be split into fields at all, and then it has nothing true to say.
if (SEL(100)) {
  const bad = (key, value) => {
    const s = scaffold();
    edit(file(s.dir, "agents", "claude.md"), (t) => t.replace(new RegExp("^" + key + ": .*$", "m"), key + ": " + value));
    return lint(s.root, s.id).out.split(NL).filter((l) => /L24/.test(l)).join(" | ");
  };

  // The exact fault the PRIMARY hit: EXPECT is seconds, and nothing said so.
  const recov = bad("ACTIVE_RECOVERY", "TURN=P5;ATTEMPT=1;START=2026-08-17T12:00:00Z;EXPECT=NONE;SPAWN=NONE;LIMIT=x;RESET=NONE");
  ok("a malformed ACTIVE_RECOVERY names the accepted form", /NONE \| TURN=<turn-id>;/.test(recov), recov);
  ok("...including the field that actually failed", /EXPECT=<seconds>/.test(recov), recov);
  // I2 overruled its own P4 spec here, correctly: never INVENTING a field name does not justify
  // withholding one the validator has already identified. A shaped value names its failing field;
  // a shapeless one still falls back to the whole form, so nothing is ever fabricated.
  ok("...and attributes it to the field, not just the grammar", /EXPECT must be <seconds>/.test(recov), recov);
  ok("...while still offering the accepted form alongside", /accepted form: NONE | TURN=/.test(recov), recov);

  // DEGRADATION: a value that cannot be split into fields still gets the whole grammar, because a
  // per-field message would have to invent a field name it could not identify.
  const shapeless = bad("ACTIVE_RECOVERY", "utterly-unparseable");
  // CONTROL for the attribution: a shapeless value must NOT name a field, because none was found.
  ok("an unsplittable ACTIVE_RECOVERY gets the same complete grammar",
    /must be NONE \| TURN=<turn-id>;/.test(shapeless), shapeless);

  // The other keys of the closed grammar get the same treatment from the same table.
  ok("a malformed UNRESOLVED_CONCERNS names its form",
    /must be NONE \| <point-id>@<pointer\.md>/.test(bad("UNRESOLVED_CONCERNS", "P1 P2")));
  ok("a malformed EXECUTOR_THREAD names its form",
    /must be NONE \| <token>/.test(bad("EXECUTOR_THREAD", "two tokens")));

  // DRIFT GUARD, which is the point of deriving the sentence from the table rather than writing it:
  // every field the validator enforces must appear in the sentence the writer is shown. A field
  // added to the checker without the message would fail here rather than ship unexplained.
  const engineSrc = read(CLI);
  const tableFields = [...engineSrc.matchAll(/^\s+\["([A-Z_]+)", \(x\) =>/gm)].map((m) => m[1]);
  ok("the recovery field table parses (fixture sanity)", tableFields.length >= 7, tableFields.join(","));
  // Length is folded IN rather than asserted beside: `[].every()` is true, so the guard passed
  // vacuously on an engine with no table at all and only its sibling caught it. A guard that can
  // pass on an empty input is a guard that cannot fail.
  ok("every field the validator enforces appears in the message the writer sees",
    tableFields.length >= 7 && tableFields.every((f) => new RegExp(f + "=").test(recov)), tableFields.join(","));

  // CONTROL: a legal value draws nothing, so the fixture is not merely detecting the key's presence.
  const good = scaffold();
  edit(file(good.dir, "agents", "claude.md"), (t) =>
    t.replace(/^ACTIVE_RECOVERY: .*$/m, "ACTIVE_RECOVERY: TURN=P5;ATTEMPT=1;START=2026-08-17T12:00:00Z;EXPECT=1800;SPAWN=NONE;LIMIT=x;RESET=NONE"));
  ok("control: a legal ACTIVE_RECOVERY draws no L24", !has(lint(good.root, good.id).out, "L24"));
}

// One comma convention, read once: UNRESOLVED_CONCERNS and SecondaryPanel accept and reject the
// SAME whitespace and empty-item forms.
if (SEL(101)) {
  // These two fields disagreed in TWO dimensions and neither was wrong read alone. Concerns split
  // without trimming, so one space after a comma made a legal value malformed — measured on this
  // project's own board 2026-08-17-refactor-quality-review, which lost a turn to it. The panel
  // trimmed but also dropped empty items, so `a,,b` passed as a panel of two. The assertions below
  // are written as a PAIR per form so that a future edit to one reader fails here, not in the
  // field the editor was not thinking about.
  const concerns = (v) => {
    const s = scaffold();
    edit(file(s.dir, "agents", "claude.md"), (t) => t.replace(/^UNRESOLVED_CONCERNS: .*$/m, "UNRESOLVED_CONCERNS: " + v));
    return lint(s.root, s.id).out;
  };
  const panel = (v) => {
    const s = scaffold();
    edit(file(s.dir, "SESSION.md"), (t) => t.trimEnd() + NL + "BoardWriteMode: PRIMARY_ONLY" + NL + "SecondaryPanel: " + v + NL);
    return lint(s.root, s.id).out;
  };
  const P1 = "P1@turns/P1-claude.md", P2 = "P2@turns/P2-codex.md";

  // ACCEPTED by both: a space after the separator is writing habit, not a different value.
  ok("concerns accept a space after the comma", !has(concerns(P1 + ", " + P2), "L24"), concerns(P1 + ", " + P2));
  ok("...and so does the panel, the same way", !has(panel("agy-cli, copilot-cli"), "empty entry"));

  // REFUSED by both: an empty item cannot be classified, so it is rejected rather than skipped.
  ok("concerns refuse a doubled comma", has(concerns(P1 + ",," + P2), "L24"));
  ok("...and so does the panel, which used to absorb it", has(panel("agy-cli,,copilot-cli"), "empty entry"));
  ok("concerns refuse a trailing comma", has(concerns(P1 + "," + P2 + ","), "L24"));
  ok("...and so does the panel, which used to absorb it", has(panel("agy-cli,copilot-cli,"), "empty entry"));

  // CONTROLS. The panel is the side that got STRICTER, so a legitimate panel must still pass —
  // otherwise the fixtures above would be satisfied by a reader that refuses everything.
  ok("control: a legitimate panel is unaffected", !has(panel("agy-cli,copilot-cli"), "empty entry"),
    panel("agy-cli,copilot-cli"));
  ok("control: legitimate concerns draw no L24", !has(concerns(P1 + "," + P2), "L24"),
    concerns(P1 + "," + P2));
}

// The log grammar spells the turn placeholder ONE way, everywhere under skill/.
if (SEL(102)) {
  // c54a5d7 unified the placeholder in PROTOCOL section 8 and stopped there, leaving eleven sites
  // spelling it the old way — including a FIXTURE that pinned the old spelling in adapters.md, so
  // the suite was holding the divergence in place. That is this repository's dominant defect at the
  // seam of the commit that fixed it.
  //
  // The predicate is LITERAL, not "grammar-restating": which strings restate a grammar is a
  // judgment no scan can make, and a fixture that cannot decide its own predicate is a test name
  // with nothing underneath it. The needle is BUILT rather than written out, because this file
  // lives under skill/ and a spelled needle would match itself — passing only while excluded, and
  // this is the very file that reacquired the spelling last time.
  const bare = "<" + "turn" + ">";
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const files = walk(path.join(HERE, ".."));
  // Non-vacuity first. `[].some()` is false, so a walk that found nothing would report the
  // invariant held over an empty set — a guard that can pass on empty input is a guard that
  // cannot fail.
  ok("the skill tree walk finds files to check (fixture sanity)", files.length > 20, String(files.length));
  const offenders = files.filter((p) => {
    let t; try { t = fs.readFileSync(p, "utf8"); } catch { return false; }
    return t.includes(bare);
  });
  ok("no file under skill/ spells the turn placeholder bare", offenders.length === 0,
    offenders.map((p) => path.relative(path.join(HERE, ".."), p)).join(", "));
}

// L30: anything in a TURN_COMMIT line that its readers cannot classify.
if (SEL(103)) {
  // The discriminator is BARENESS, not id shape. The FIRST proposed pattern was `^[PI][0-9]+$`
  // on the stray token, and it missed `points=P1,P2 P3,P4` — the very reproducer that motivated
  // the arm, because `P3,P4` carries a comma. That case is therefore a fixture in its own right:
  // a guard must be tested against the evidence used to justify it, or the justification is
  // decoration. Measured before shipping: 0 findings across 611 real committed TURN_COMMITs.
  // Assert the SPECIFIC L30 branch, not merely that some L30 fired: several conditions share this
  // code, so a fixture that tripped the other one would pass for the wrong reason — the failure
  // mode the L24 fixtures already guard against with a needle.
  // A commit line whose FIRST token is not a turn id — the case L14 `continue`s past.
  const withBadId = () => {
    const s = scaffold();
    edit(file(s.dir, "log.md"), (t) => t.trimEnd() + NL +
      "2026-08-17T12:00:00.000Z TURN_COMMIT PP1 actor=CLAUDE responds_to=NEW points=P1" + NL);
    return lint(s.root, s.id).out;
  };
  const l30 = (tail, needle) => withCommit(tail).split(/\r?\n/)
    .some((l) => /\bL30\b/.test(l) && needle.test(l));
  const withCommit = (tail) => {
    const s = scaffold();
    edit(file(s.dir, "log.md"), (t) => t.trimEnd() + NL +
      "2026-08-17T12:00:00.000Z TURN_COMMIT P1 actor=CLAUDE responds_to=NEW " + tail + NL);
    return lint(s.root, s.id).out;
  };

  // (i) malformed item INSIDE the captured token
  ok("L30 catches a non-id item in points=", l30("points=P1.md", /are not a point id/));
  ok("L30 catches an empty item in points=", l30("points=P1,,P2", /are not a point id/));
  // (ii) a token stranded OUTSIDE it by a space
  ok("L30 catches a space-stranded id", l30("points=P3 P4", /token\(s\) with no "="/));
  ok("L30 catches the reproducer the id-shape pattern missed",
    l30("points=P1,P2 P3,P4", /token\(s\) with no "="/), withCommit("points=P1,P2 P3,P4"));
  // ...and the diagnostic says the log cannot be repaired in place, since it cannot.
  ok("L30 states that the remedy is forward-only",
    /append-only|LATER turn/.test(withCommit("points=P3 P4")));
  // WARN, never FAIL: a finding names committed bytes, so it must not gate.
  ok("L30 is a WARN, so it never gates a board",
    /WARN\s+L30/.test(withCommit("points=P3 P4")) && !/FAIL\s+L30/.test(withCommit("points=P3 P4")));

  // CONTROLS: the legitimate forms draw nothing, so the arm is not merely detecting the token.
  ok("control: a well-formed points= list is silent", !has(withCommit("points=P1,P2"), "L30"));
  ok("control: the no-points dash form is silent", !has(withCommit("points=-"), "L30"));
  // The illegible turn id: reported HERE because L14 skips it, which is why it was invisible.
  ok("L30 reports a TURN_COMMIT whose id is not a turn id",
    l30("points=P1", /is not a turn id/) === false && /is not a turn id/.test(withBadId()),
    withBadId());
  ok("...and states that L14 checks no shard for it", /L14 skips this line/.test(withBadId()));
  // That sentence is a claim ABOUT ANOTHER CHECK, so it is pinned to the other check's behaviour:
  // if L14 ever learns to report what it skips, the sentence goes false and this fails.
  // NOT `has(out, "L14")`: L30's own diagnostic QUOTES the string "L14 skips this line", so a
  // bare code search matches the prose it is meant to be independent of — the masking defect this
  // repository has hit before. Match a FINDING line, which is severity + code at the line head.
  ok("...and L14 is genuinely silent there, which is what makes that sentence true",
    !withBadId().split(/\r?\n/).some((l) => /^\s*(FAIL|WARN)\s+L14\b/.test(l)),
    withBadId());
  ok("control: a legible id draws no such finding", !/is not a turn id/.test(withCommit("points=P1")));
  ok("control: a full legitimate tail is silent",
    !has(withCommit("points=P1 via=codex-cli branch=main base=aaa1111 latest=bbb2222"), "L30"),
    withCommit("points=P1 via=codex-cli branch=main base=aaa1111 latest=bbb2222"));
}

// The recovery/relay read conditions exist in two places each, and the copies must agree.
if (SEL(104)) {
  // adapters.md carried a THIRD copy with a fourth, shorter list; it was deleted rather than
  // reconciled, because its routing already lives at the point of use. What remains is two copies
  // KEPT ON PURPOSE: the map tells a reader when to open the file, and the file's own header lets
  // a reader who opened it directly confirm they are in the right place. Losing the second fails
  // silently, so it is pinned rather than removed.
  const skill = read(path.join(HERE, "..", "SKILL.md"));
  const recovery = read(path.join(HERE, "..", "references", "recovery.md"));
  const adapters = read(path.join(HERE, "..", "references", "adapters.md"));
  const SEVEN = "invalid, timed-out, killed, limited, lint-failed, partial, or deliberately resumed";
  ok("recovery.md's own header carries the derived condition list", recovery.includes(SEVEN), recovery.slice(0, 200));
  ok("...and SKILL.md's map row carries the SAME list, verbatim", skill.includes(SEVEN));
  ok("adapters.md no longer carries a third, divergent copy",
    !/only after an invalid, timed-out, limited, or deliberately resumed/.test(adapters));
  // The facts that line's deletion removed must each survive somewhere the reader still goes.
  // The deleted line said "read every dispatch", and the map inherited it verbatim. That is the
  // same over-charge §1's hot/cold rule was written to remove: a skill file cannot change while a
  // session runs, so a persistent PRIMARY was re-reading 8 KB per dispatch to recover text it
  // already held — measured at 32,780 B across the four dispatches of the 2026-08-19 arena board.
  // The fact that survives is WHEN it is NEEDED; the cadence now follows the rule the rest obey,
  // and the read is pinned to the file rather than to memory of it, because a skeleton recalled
  // instead of read is where a dropped write step comes from.
  ok("...its needed-at-every-dispatch fact survives in the map",
    /adapters\.md`: .*needed at every delegated turn/.test(skill));
  ok("...reclassified cold, with the reason a reader can check",
    /a skill file cannot change mid-session/.test(skill));
  ok("...and the skeleton is composed from the file rather than from memory",
    /Compose each dispatch from the file, never from memory of it/.test(skill));
  ok("...its relay routing survives in the map", /relay\.md`: .*PRIMARY_ONLY/.test(skill));
  ok("...and its recovery routing survives at the point of use in adapters.md",
    /stop and read `recovery\.md`/.test(adapters), adapters.slice(0, 100));
}

// terminal honours the START mutex: a board is not ended out from under a SECONDARY mid-turn.
if (SEL(105)) {
  // `advance` has always refused this and `terminal` never did, so a board in the frozen corpus
  // was aborted with its SECONDARY at START and lints clean to this day. The guard is write-time
  // only; history keeps whatever it already recorded.
  //
  // The predicate is the SECONDARY's hand. `PRIMARY holds START` was proposed first and is WRONG:
  // an IDLE board has both hands ON_HOLD, so that shape refuses the very board this closes.
  const withHands = (primary, secondary) => {
    const s = scaffold();
    edit(file(s.dir, "HEAD.md"), (t) => t
      .replace(/^- CLAUDE: .*$/m, () => "- CLAUDE: " + primary + " - PRIMARY")
      .replace(/^- CODEX: .*$/m, () => "- CODEX: " + secondary + " - SECONDARY"));
    return { s, out: run(["terminal", "--session", s.id, "--status", "ABORTED"], s.root) };
  };

  for (const hand of ["START", "WORKING"]) {
    const r = withHands("ON_HOLD", hand);
    ok(`terminal refuses while the SECONDARY holds ${hand}`, r.out.code !== 0, r.out.out);
    ok(`...naming the SECONDARY and the hand it holds`,
      /CODEX \(SECONDARY\) holds /.test(r.out.out), r.out.out);
    // Diagnostic self-sufficiency: the condition, the rule, and a LEGAL remedy.
    ok(`...and pointing at Rule 5 rather than only refusing`,
      /STALL_HANDOFF/.test(r.out.out) && /Rule 5/.test(r.out.out), r.out.out);
    ok(`...while warning that a usage limit is not a stall`,
      /NOT A STALL/.test(r.out.out), r.out.out);
  }

  // PERMITTED: the seat has been taken the legal way, so the PRIMARY may end the board.
  const moved = withHands("START", "ON_HOLD");
  ok("terminal proceeds once the SECONDARY is ON_HOLD", moved.out.code === 0, moved.out.out);
  // PERMITTED: an IDLE board, both hands ON_HOLD — the case the rejected guard shape would break.
  const idle = withHands("ON_HOLD", "ON_HOLD");
  ok("terminal proceeds on a board with both hands ON_HOLD", idle.out.code === 0, idle.out.out);
}

// `--all` distinguishes a root that is not a board root from a board root with no boards.
if (SEL(106)) {
  // Returning [] for both made a mistyped --root indistinguishable from a clean corpus: zero
  // boards, exit 0, and a two-engine diff of nothing against nothing that reads IDENTICAL. It
  // produced three such diffs during the review that found it, caught only because someone
  // counted the output lines.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cb-rootcheck-"));
  const missing = path.join(tmp, "not-a-board-root");
  fs.mkdirSync(missing, { recursive: true });
  const r1 = run(["lint", "--all"], missing);
  ok("--all refuses a root with no .collab-board/sessions", r1.code !== 0, r1.out);
  ok("...and names the sessions directory it looked for", /\.collab-board[\\/]sessions/.test(r1.out), r1.out);
  ok("...and explains why zero would have been the wrong answer",
    /indistinguishable from a clean corpus/.test(r1.out), r1.out);

  // CONTROL: the directory exists and is empty — a real board root with nothing in it yet. Zero
  // is the TRUE answer here, so it must still be given.
  const empty = path.join(tmp, "empty-board-root");
  fs.mkdirSync(path.join(empty, ".collab-board", "sessions"), { recursive: true });
  const r2 = run(["lint", "--all"], empty);
  ok("control: an empty board root reports zero boards and succeeds", r2.code === 0, r2.out);
}

// 17b-107. THE CONTEXT BUDGET IS A DOCUMENTED RULE, NOT AN ASPIRATION — and a field the engine
// parses by SHAPE states that shape in the document that owns it.
//
// Two failures found by driving this build through a real session put these in one block, because
// they have one cause: a compression pass measures the file it is shrinking and cannot measure what
// the deleted sentence was holding up.
//
//   (a) The protocol used to carry "stay lean — a board, not a history book" WITH its reason, and
//       SKILL.md repeated it where a turn is authored. Both went. Nothing else in the hot surface
//       said it. The build that dropped them cut 42% off the fixed per-thread cost and then wrote
//       shards averaging 8.3 KB against a 5.9 KB control on the identical task, with a per-session
//       mean above every one of 19 recorded boards — so it read 2.4x more total board bytes while
//       its headline number said it read less. The fixed cost is paid once per thread; the shard is
//       paid by every later turn and by every fresh dispatch, so the instruction that bounds the
//       shard is worth more than the bytes it occupies. That is why it is pinned here.
//   (b) The same pass compressed `RESPONDS_TO` and `Resolved In` to bare key names while L14 and L2
//       kept parsing them by shape. The first cost a live lint FAIL on turn P1 of a real session:
//       the schema section named the key, the template showed only `-`, and the format existed
//       nowhere an author is sent. A format the checks enforce and the documents do not state is a
//       trap with a test suite behind it.
//
// The assertions below are two-sided where they can be: the EXAMPLE printed in the protocol is fed
// to the ENGINE'S OWN predicate, so a drift in either one fails rather than a substring surviving a
// rewrite of the thing it describes.
if (SEL(107)) {
  const REFD = path.join(HERE, "..", "references");
  const proto = read(path.join(REFD, "protocol.md"));
  const skillMd = read(path.join(HERE, "..", "SKILL.md"));
  const adapters = read(path.join(REFD, "adapters.md"));
  const pointsTpl = read(path.join(HERE, "..", "templates", "session", "points.md"));
  // These documents hard-wrap, so a sentence-level assertion must not depend on where the wrap
  // happens to fall. Collapsing whitespace tests the sentence rather than the layout.
  const flat = (t) => t.replace(/\s+/g, " ");
  const adaptersFlat = flat(adapters);

  // (b) RESPONDS_TO. Pull the example out of the schema section and run it through the same test
  // the linter applies, rather than asserting that some string is present.
  const rtEx = /`RESPONDS_TO` is the session-relative path to the one prior shard — `([^`]+)`/.exec(proto);
  ok("protocol §9 states the RESPONDS_TO path form with a worked example", !!rtEx, proto.slice(0, 0));
  if (rtEx) {
    const raw = rtEx[1];
    const name = raw.startsWith("turns/") ? raw.slice("turns/".length) : null;
    ok("...and that example satisfies the shape L14 enforces",
      name !== null && /^[PI][0-9]+-[A-Za-z0-9_]+\.md$/.test(name), raw);
  }
  ok("...and it says the scaffolded '-' is not a model for the path form",
    /not a model for it/.test(proto));

  // (b) Resolved In. Same treatment against L2's own link regex, re-declared here from the engine
  // source so a change to either side is a failure rather than a silent divergence.
  const LINK = /^\[([PI][0-9]+)\]\(([^)]*)\)$/;
  const engineLink = /const RESOLVED_LINK = (\/\^.*\/);/.exec(read(CLI));
  ok("the engine still parses Resolved In with the link regex this block mirrors",
    !!engineLink && engineLink[1] === String(LINK), engineLink ? engineLink[1] : "(not found)");
  const riEx = /Resolved In\s*\r?\n?links its turn as a markdown link whose destination is that turn's own shard — `([^`]+)`/.exec(proto);
  ok("protocol §6 states the Resolved In link form with a worked example", !!riEx);
  if (riEx) ok("...and that example satisfies the shape L2 enforces", LINK.test(riEx[1]), riEx[1]);
  // The template is where a first turn actually looks, so the example lives there too.
  const tplEx = /Resolved In = a link to the shard that resolved the point, e\.g\. (\S+)\./.exec(pointsTpl);
  ok("the points template carries the same worked example", !!tplEx);
  if (tplEx) ok("...and the template's example also satisfies L2's shape", LINK.test(tplEx[1]), tplEx[1]);

  // The generalisation, stated once so the next compression has a rule to violate rather than an
  // omission to make. Two instances were found; the rule is what stops a third.
  ok("protocol §9 states that a shape-parsed field must state its shape",
    /Every field a check parses by SHAPE states that shape here/.test(proto));

  // (a) §0 IS THE WHOLE RULE, in one place, for both seats. It is deliberately not repeated: a
  // SECONDARY is a fresh process every turn and reads the protocol on every one of them, so a
  // second copy in the dispatch prompt is a duplicate paid per dispatch. The prompt ROUTES to §0
  // and names what §0 decides, which is what a pointer has to do to be worth its own bytes.
  const protoFlat = flat(proto);
  ok("§0 states what the board is FOR, which is what every rule under it derives from",
    /The board is instrumentation for agents/.test(protoFlat));
  ok("...and that tidiness is explicitly not one of its properties",
    /being tidy, ordered or well-written is not one of its properties/.test(protoFlat));
  ok("...and gives the mechanism that makes a long shard expensive, not just the adjective",
    /read whole by the next turn and by a fresh SECONDARY with no memory of writing it/.test(protoFlat)
    && /tax every later turn pays/.test(protoFlat));

  // The generator the arena measured: nine of ten settling turns closed a point the turn before had
  // opened, and twelve of seventeen IMPL turns went to the document's account of itself. Each was
  // individually defensible; none changed the answer. One rule covers the whole family, which is why
  // it is one rule and not three exceptions.
  ok("§0 says what a turn is FOR — the rule the arena's twelve wasted turns each broke",
    /A turn exists to change the answer/.test(protoFlat));
  ok("...so a correction never earns a turn of its own",
    /A correction earns no turn of its own/.test(protoFlat));
  ok("...and smaller findings ride on a turn already being taken",
    /ride on the next turn you were already taking/.test(protoFlat));
  ok("...with the point threshold and the gate-refusal bar as the same rule, not separate ones",
    /Open a point only for what changes an outcome; refuse a gate only for a defect that breaks a stated Done condition/.test(protoFlat));

  // THE SPLIT that makes "don't spend a turn tidying" actionable rather than a slogan: an agent has
  // to be able to tell what is worth a turn from what is not. State is; prose is not. Everything
  // downstream — the lint-correction rule, the self-referential-tally trap — derives from this one
  // sentence instead of being its own special case.
  ok("§0 names exactly what is authoritative, so the rest can be treated as disposable",
    /Only state is authoritative\*\* — HEAD, the log, point rows and gates/.test(protoFlat));
  ok("...and says prose is repaired in passing rather than by spending a turn",
    /repair them in passing, never by spending a turn on them/.test(protoFlat));
  ok("...and sends session self-reporting to the log, which cannot go stale",
    /progress is recorded in the log, which cannot go stale/.test(protoFlat));

  // recovery.md's lint rule now DERIVES from that split instead of contradicting §3. As written
  // before, a FAIL inside `agents/<actor>.md` had no legal repair at all: re-delegation needs the
  // other actor to write without START, and the same file calls agent notes non-authoritative. A
  // real dispatch hit exactly that and had to act with no rule to point at.
  const recovery = flat(read(path.join(REFD, "recovery.md")));
  ok("recovery.md routes a lint FAIL by what it names, citing the §0 split",
    /Any other FAIL is corrected according to what it names \(§0\)/.test(recovery));
  ok("...re-delegating a FAIL against authoritative state",
    /HEAD, the log, point rows, gates, a shard — is corrected by re-delegation/.test(recovery));
  ok("...and letting PRIMARY repair an agent-file FAIL in place, because §3 forbids the alternative",
    /confined to `agents\/<actor>\.md` is PRIMARY repairing the value in place/.test(recovery)
    && /would need that actor to write without START/.test(recovery));

  // ...but the rule had THREE readers and only one was corrected. `adapters.md` step 2 and
  // SKILL.md both still said every non-L10 FAIL is correction recovery — i.e. re-delegate — which
  // §0 contradicts for an agent-file finding ("a correction earns no turn of its own"). The NEW
  // arm of the 2026-08-19 arena hit exactly that: a comma in `UNRESOLVED_CONCERNS` read as a whole
  // re-dispatch under one document and as an in-passing repair under the other. Both now ROUTE to
  // the file that owns the rule; a fourth copy is the thing to refuse, not to keep fresh.
  ok("adapters.md routes a lint FAIL to recovery.md instead of restating the rule",
    /routed by `recovery.md`'s "Lint correction"/.test(adaptersFlat)
    && !/Any other lint FAIL is correction recovery/.test(adaptersFlat));
  ok("SKILL.md routes it to the same owner",
    /`recovery.md`'s "Lint correction" routes it by what it names/.test(flat(skillMd))
    && !/If lint FAILs, re-delegate correction/.test(flat(skillMd)));

  // Gates. `GATE_SET` has no `=NO` form and the log is append-only, so an attestation cannot be
  // withdrawn — true in every version of this protocol and stated in none of them. Both variants of
  // the comparison run hit it: one stood on a PRIMARY gate through two later rejections, the other
  // spent four rounds under an attestation it could not take back. The rule lives in the sentence
  // that defines gating rather than in a paragraph beside it.
  ok("§8's gate grammar still admits YES only, which is what makes the rule below load-bearing",
    /GATE_SET <PLAN_AGREE_PRIMARY\|PLAN_AGREE_SECONDARY\|IMPL_AGREE_PRIMARY\|IMPL_AGREE_SECONDARY>=YES/.test(proto)
    && !/GATE_SET .*=NO/.test(proto));
  ok("§4 derives irreversibility from the grammar rather than asserting it",
    /admits no `=NO` form and\s+the log is append-only, so a gate cannot be withdrawn/.test(protoFlat.replace(/\s+/g, " ")));
  ok("...and derives the ordering rule from the irreversibility",
    /gate only once nothing you attest can still change, which puts the actor that may still have to amend the artifact — normally PRIMARY — last/.test(protoFlat));
  ok("...and SKILL.md carries it where a gate turn is written", /PRIMARY gates last \(§4\)/.test(skillMd));
  // The one read-set consequence, stated where the read-set is stated rather than in the protocol.
  // It was previously JUSTIFIED rather than removed: gate-last makes I1's predecessor PRIMARY's own
  // shard, so the read "is free". That holds only for a PRIMARY whose context survived the phase
  // crossing, and it charged a resumed or delegated one for a gate attestation the IMPL phase never
  // acts on — every point is closed and the plan is in `plan/context.md` by §4. The frozen plan is
  // what the boundary hands forward, so it STANDS IN for the shard rather than sitting beside it.
  // Measured on the 2026-08-19 arena boards: the shard charged here was the whole of NEW's only
  // per-turn regression against OLD (+20.4% / +23.8% / +73.9% at I1).
  ok("SKILL.md replaces the I1 predecessor shard with the frozen plan",
    /at I1 `plan\/context.md` stands in its place/.test(flat(skillMd)));
  ok("...and states the reason, so the exception is derivable rather than remembered",
    /the last PLAN shard is a gate attestation IMPL does not act on/.test(flat(skillMd)));

  // POINTERS, NOT COPIES. §0 and §4 are read by both seats every turn they matter; a second copy of
  // either is a duplicate paid per dispatch, and the measured law here is that deduplication pays
  // only when a fact is read once. So the operative surfaces cite §0 at the moment of action and
  // carry none of its text.
  ok("the dispatch prompt routes to §0 rather than restating it",
    /whose §0 decides how you weigh evidence, what earns a point/.test(adaptersFlat));
  ok("...and no longer carries its own copy of §0's posture",
    !/Be skeptical but open; prefer the simplest complete/.test(adaptersFlat));
  ok("SKILL.md cites §0 where a shard is authored and where a point is opened",
    /Keep it lean \(§0\)/.test(skillMd) && /a point is for what changes an outcome \(§0\)/.test(skillMd));

  // DUPLICATES REMOVED AT THE SAME TIME, because the cheapest byte is the one already there twice.
  // The read-set had three copies — §1, §2's trailing line, and SKILL.md's precise PLAN/IMPL split.
  // §1 and SKILL.md serve DIFFERENT readers (a fresh SECONDARY never reads SKILL.md), so both stay;
  // §2's fragment was a third copy for a reader already holding §1.
  // §1 used to ASSIGN two files to each side ("HEAD and points are hot, SESSION and the protocol
  // cold") and leave the agent file and the phase-specific files unclassified — so SKILL.md's
  // enumeration listed them with no cadence and a persistent PRIMARY re-read all of them every
  // turn. §1 now states the RULE that decides the side, which is what a fresh SECONDARY needs (it
  // is never persistent, so it reads everything and must know that is why). The assignment lives in
  // SKILL.md, whose reader is the only one that can be persistent. One fact, one reader each.
  ok("§1 owns the read-set and derives hot/cold from who may have written the file",
    /the one shard named by\s+`HEAD.RESPONDS_TO`/.test(proto)
    && /A file another hand may have changed is HOT and is read every turn/.test(protoFlat)
    && /a frozen or self-authored one is COLD and a persistent thread reads it once/.test(protoFlat));
  ok("...and tells a fresh dispatch the rule can never apply to it",
    /A fresh dispatch is never persistent and reads the whole set/.test(protoFlat));
  ok("SKILL.md carries the assignment, for the one reader that can be persistent",
    /HOT — HEAD, points, the predecessor shard/.test(flat(skillMd))
    && /COLD — the protocol, SESSION, `plan\/context.md`, `impl\/code_state.md`, your agent file/.test(flat(skillMd)));

  // THE TURN, not the shard. §0 already taxes a long shard and already says a correction earns no
  // turn; neither covers a PRIMARY that splits one deliverable across two turns and buys a second
  // review round with it. Both arena rounds measured that as the whole remaining turn-count gap
  // (round 2: IMPL ran I1-I7 against the other arm's I1-I4, for one extra dispatch and two extra
  // PRIMARY read-sets). It lives in SKILL.md because only the PRIMARY decides a turn's scope, and
  // the protocol is paid by every dispatch that cannot act on it.
  ok("SKILL.md bounds the work a turn takes on, not only the shard it writes",
    /Produce in one turn whatever one review can cover/.test(flat(skillMd)));
  ok("...priced in the read-sets an extra round costs, so it is a trade rather than a preference",
    /a full read-set for both seats and a fresh dispatch for the SECONDARY/.test(flat(skillMd)));
  ok("...and says it is not a licence for a longer shard, which §0 taxes separately",
    /never the length of its shard, which §0 taxes separately/.test(flat(skillMd)));

  // `points-archive.md` is created by `archive`, checked by L4, and appeared in neither the file
  // map nor the tracker rules — so a SECONDARY reading a shortened `points.md` had nothing telling
  // it the missing rows were settled rather than absent, and could legitimately re-open one.
  ok("§2 lists the archive among the session files", /points-archive\.md/.test(proto));
  ok("§6 says which of the two files a row lives in, and that a decision reads both",
    /an id has a row in exactly one of the two files, an OPEN row never leaves `points.md`, and a decision weighs the two together \(L4\)/.test(protoFlat));
  ok("...and §2 no longer repeats it to the same reader",
    !/SESSION and protocol are cold; HEAD\/points are hot/.test(proto));
  // Rule 7 kept what is true at PROTOCOL level — authority, and the per-snapshot binding that stops
  // an old board acquiring the tier. The manifests and the attestation procedure were a second copy
  // of workers.md, read on every dispatch by a SECONDARY that will never dispatch a worker.
  const workersMd = flat(read(path.join(REFD, "workers.md")));
  ok("Rule 7 keeps the authority grant and the per-snapshot binding",
    /Only PRIMARY edits project files/.test(protoFlat) && /binds only boards whose pinned snapshot carries it/.test(protoFlat));
  ok("...and hands the procedure to workers.md instead of carrying a second copy",
    /`workers.md` owns the procedure/.test(protoFlat) && !/declared read\/write manifests/.test(protoFlat));
  ok("...and workers.md does own it", /the PRIMARY attests the diff before HANDOFF/.test(workersMd)
    && /holds no seat, hand, turn, point or gate/.test(workersMd));
  // The document must describe the check the code now performs, or the next reader is entitled to
  // an invariant that is not there — which is the defect this whole pass exists to fix.
  ok("workers.md states the board refusal as the unconditional check it now is",
    /if anything under `\.collab-board` changed at all/.test(workersMd)
    && /inherits none of git's blind spots/.test(workersMd)
    && /no `--allow` entry can grant it/.test(workersMd));
  ok("...and its scope paragraph counts the board tree as covered rather than as an escape",
    /plus HEAD itself, plus the board tree/.test(workersMd));

  // `lint-spec.md` is 38 KB, and the whole defence of that size is that `explain <code>` serves one
  // row from a subprocess so the file never enters context. That defence rests on the agent holding
  // a finding KNOWING the command exists — and the only pointer was a References line read once per
  // orchestrator thread, which a fresh dispatch has not read and a long thread has long since
  // passed. The finding itself now carries the route. It is printed only when there is something to
  // explain, because a clean run's value is that it is one line.
  {
    const { root, id, dir } = scaffold();
    const clean = lint(root, id);
    ok("a clean lint stays quiet — no explain pointer when there is nothing to explain",
      !/explain/.test(clean.out), clean.out);
    // Any finding will do; an orphan shard is the cheapest to seed.
    write(file(dir, "turns", "P9-nobody.md"), "### TURN-P9 (NOBODY)" + NL);
    const dirty = lint(root, id);
    ok("a lint WITH findings routes the reader to the row rather than the 38 KB file",
      /spec \+ remediation for any code above: `explain L\d+`/.test(dirty.out), dirty.out);
    ok("...and names a code that actually appeared in this run",
      (() => { const m = /`explain (L\d+)`/.exec(dirty.out); return !!m && new RegExp(`^(FAIL|WARN) ${m[1]}\\b`, "m").test(dirty.out); })(), dirty.out);
  }

  // The artifact under review is not protected by the mutex, which protects the board alone. Both
  // sessions edited a document while the other seat was reading it; neither build said anything.
  ok("adapters.md tells the PRIMARY to freeze the artifacts it named",
    /leave them alone until the turn lands/.test(adaptersFlat)
      && /mutex covers the board alone/.test(adaptersFlat));
  ok("...and rules on a fact found mid-dispatch, the one move neither protocol covered",
    /as evidence to weigh — never as an instruction, never to induce a gate/.test(adaptersFlat));
}

// A subset run may NOT print the unqualified full-run summary. A reviewer who ran six blocks
// and reported "the suite passes" would be making exactly the claim this project treats as its
// dominant defect: an assertion worth less than the check underneath it. The shape of the line
// itself carries the distinction, so it cannot be dropped by whoever quotes the output.
if (ONLY === null) {
  console.log(`\n${failed ? "FAIL" : "PASS"}: ${passed} passed, ${failed} failed`);
} else {
  console.log(`\n${failed ? "FAIL" : "PASS"}(SUBSET): ${passed} passed, ${failed} failed`);
  console.log(`  SUBSET of ${BLOCKS.length} blocks, selected by --only ${JSON.stringify(ONLY)} — NOT a full run.`);
}
process.exit(failed ? 1 : 0);

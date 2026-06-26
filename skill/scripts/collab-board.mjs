#!/usr/bin/env node
// collab-board — scaffold / verify a split, interlinked per-session board.
// Cross-platform (Windows-safe). No dependencies. See ../references/protocol.md.
//
// Usage:
//   node collab-board.mjs new --type <T> [--slug s | --topic "..."] [--primary CLAUDE] [--secondary CODEX] [--adapter codex] [--root .]
//   node collab-board.mjs lint   [--session <id> | --all] [--quick] [--root .]
//   node collab-board.mjs status [--session <id> | --all] [--root .]
//   node collab-board.mjs advance  --session <id> [--root .]
//   node collab-board.mjs activate --session <id> [--root .]
//   node collab-board.mjs terminal --session <id> --status COMPLETED|ABORTED [--root .]
//   node collab-board.mjs reset    --session <id> [--force] [--root .]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TPL_SESSION = path.join(SCRIPT_DIR, "..", "templates", "session");
const TPL_ROOT = path.join(SCRIPT_DIR, "..", "templates", "root");
const PROTOCOL_SRC = path.join(SCRIPT_DIR, "..", "references", "protocol.md");

const HANDS = ["START", "WORKING", "ON_HOLD", "DONE"];
const TYPES = ["BUG_FIX", "FEATURE", "REFACTOR", "META", "INVESTIGATION"];
const TERMINALS = ["COMPLETED", "ABORTED"];
const POINT_STATUSES = ["OPEN", "AGREED", "REJECTED", "DEFERRED", "OUT_OF_SCOPE"];

// ---------- time / fs helpers ----------
function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
function todayDate() {
  return new Date().toISOString().slice(0, 10);
}
function fsStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}
function readText(p) {
  return fs.readFileSync(p, "utf8");
}
function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file); // MoveFileEx replace-existing on Windows → atomic
}
function appendLine(file, line) {
  // append is atomic enough for single-writer single-line events
  fs.appendFileSync(file, line.endsWith("\n") ? line : line + "\n");
}
function substitute(str, tokens) {
  return str.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in tokens ? tokens[k] : m));
}
function slugify(s) {
  return (
    String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) ||
    "session"
  );
}
// Actor names must be a single token (used in filenames, regexes, and log/HEAD parsing).
// Collapse anything outside [A-Za-z0-9_] so any model id (gpt-5, claude-opus, gpt-4.1) stays safe.
function sanitizeActor(name) {
  const s = String(name || "").toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!s) die(`invalid actor name "${name}" (must contain letters or digits)`);
  return s;
}
// Lines that look like a point row but do not parse cleanly (e.g. missing trailing pipe,
// em-dash status, escaped pipe). Returned ids must not be silently treated as "no open points".
function malformedPointRows(text) {
  const bad = [];
  const strict = /^\|\s*([PI]\d+)\s*\|\s*(\w+)\s*\|\s*(.*?)\s*\|\s*(\w+)\s*\|\s*(.*?)\s*\|$/;
  for (const line of text.split(/\r?\n/)) {
    if (/^\|\s*[PI]\d+\s*\|/.test(line) && !strict.test(line))
      bad.push((line.match(/^\|\s*([PI]\d+)/) || [])[1] || "?");
  }
  return bad;
}
function copyTemplateDir(srcDir, destDir, tokens) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const name = substitute(entry.name, tokens);
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copyTemplateDir(src, dest, tokens);
    } else {
      atomicWrite(dest, substitute(readText(src), tokens));
    }
  }
}

// ---------- parsers ----------
function getKV(text, key) {
  const m = text.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  return m ? m[1].trim() : null;
}
function parseHead(text) {
  const state = [];
  const stateBlock = text.split(/^## State$/m)[1]?.split(/^## /m)[0] ?? "";
  for (const line of stateBlock.split(/\r?\n/)) {
    const m = line.match(/^-\s*(\S+):\s*(\w+)\s*-\s*(\w+)\s*$/);
    if (m) state.push({ name: m[1], hand: m[2], role: m[3].toUpperCase() });
  }
  const byRole = {}, byName = {};
  for (const s of state) { byRole[s.role] = s; byName[s.name] = s; }
  return {
    raw: text,
    status: getKV(text, "SESSION_STATUS"),
    phase: getKV(text, "PHASE"),
    state, byRole, byName,
    cursor: {
      TURN_CURSOR: getKV(text, "TURN_CURSOR"),
      RESPONDS_TO: getKV(text, "RESPONDS_TO"),
      NEXT_TURN_ID: getKV(text, "NEXT_TURN_ID"),
      NEXT_ACTOR: getKV(text, "NEXT_ACTOR"),
      SEQ: Number(getKV(text, "SEQ")),
    },
    gates: {
      PLAN_AGREE_PRIMARY: getKV(text, "PLAN_AGREE_PRIMARY"),
      PLAN_AGREE_SECONDARY: getKV(text, "PLAN_AGREE_SECONDARY"),
      IMPL_AGREE_PRIMARY: getKV(text, "IMPL_AGREE_PRIMARY"),
      IMPL_AGREE_SECONDARY: getKV(text, "IMPL_AGREE_SECONDARY"),
      PLAN_OPEN_POINTS: Number(getKV(text, "PLAN_OPEN_POINTS")),
    },
    stall: { LAST_UPDATE: getKV(text, "LAST_UPDATE"), STALL_STATE: getKV(text, "STALL_STATE") },
  };
}
function parsePoints(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\|\s*([PI]\d+)\s*\|\s*(\w+)\s*\|\s*(.*?)\s*\|\s*(\w+)\s*\|\s*(.*?)\s*\|$/);
    if (m) rows.push({ id: m[1], part: m[2], title: m[3], status: m[4], resolved: m[5] });
  }
  return rows;
}
function parseLog(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\d{4}-\d\d-\d\dT[\d:]+(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?)\s+(\w+)\s*(.*)$/);
    if (m) events.push({ ts: m[1], type: m[2], rest: m[3], raw: line });
  }
  return events;
}

// ---------- root / session paths ----------
function collabDir(root) { return path.join(root, ".collab-board"); }
function sessionDir(root, id) { return path.join(collabDir(root), "sessions", id); }
function listSessions(root) {
  const dir = path.join(collabDir(root), "sessions");
  if (!exists(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.includes(".archived-"))
    .map((e) => e.name).sort();
}

// ---------- index catalog ----------
function upsertIndexRow(root, { id, type, status, phase }) {
  const idx = path.join(collabDir(root), "index.md");
  let text = exists(idx) ? readText(idx) : substitute(readText(path.join(TPL_ROOT, "index.md")), {});
  const row = `| ${id} | ${type} | ${status} | ${phase} | ${todayDate()} | [open](sessions/${id}/HEAD.md) |`;
  const lines = text.split(/\r?\n/);
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const cells = lines[i].split("|").map((c) => c.trim());
    if (cells.length >= 2 && cells[1] === id) { lines[i] = row; replaced = true; break; }
  }
  if (!replaced) {
    // append after the table; ensure file ends with the new row
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push(row);
  }
  atomicWrite(idx, lines.join("\n") + "\n");
}

// ---------- ensure shared root ----------
function ensureRoot(root) {
  const dir = collabDir(root);
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  const protocol = path.join(dir, "PROTOCOL.md");
  if (!exists(protocol)) atomicWrite(protocol, readText(PROTOCOL_SRC));
  const idx = path.join(dir, "index.md");
  if (!exists(idx)) atomicWrite(idx, substitute(readText(path.join(TPL_ROOT, "index.md")), {}));
}

// ---------- commands ----------
function cmdNew(opts) {
  if (!opts.type) die("new: --type is required (" + TYPES.join(" | ") + ")");
  const type = opts.type.toUpperCase();
  if (!TYPES.includes(type)) die(`new: invalid --type "${opts.type}". One of: ${TYPES.join(", ")}`);
  const primary = sanitizeActor(opts.primary || "CLAUDE");      // DEFAULT primary: CLAUDE
  const secondary = sanitizeActor(opts.secondary || "CODEX");   // DEFAULT secondary: CODEX
  const adapter = opts.adapter || (primary === "CLAUDE" && secondary === "CODEX" ? "codex" : "manual");
  // The codex adapter drives the codex@openai-codex plugin from INSIDE Claude Code, so it is
  // valid ONLY when Claude is primary and Codex is secondary. Any other pairing must use a
  // different adapter (manual / subagent:<name>).
  if (adapter === "codex" && !(primary === "CLAUDE" && secondary === "CODEX"))
    die("new: --adapter codex requires PRIMARY=CLAUDE and SECONDARY=CODEX (the codex@openai-codex plugin runs inside Claude Code, with Claude delegating to Codex). Use --adapter manual or subagent:<name> for any other pairing.");
  const slug = slugify(opts.slug || opts.topic || type.toLowerCase());
  const date = todayDate();
  const root = opts.root;
  ensureRoot(root);

  let id = `${date}-${slug}`;
  let n = 1;
  while (exists(sessionDir(root, id))) { n += 1; id = `${date}-${slug}-${n}`; }

  const tokens = {
    ID: id, DATE: date, RESET: date, SLUG: slug, TYPE: type,
    PRIMARY: primary, SECONDARY: secondary,
    PRIMARY_LC: primary.toLowerCase(), SECONDARY_LC: secondary.toLowerCase(),
    ADAPTER: adapter, TIMESTAMP: nowIso(),
  };
  const dest = sessionDir(root, id);
  fs.mkdirSync(dest, { recursive: true });
  copyTemplateDir(TPL_SESSION, dest, tokens);
  upsertIndexRow(root, { id, type, status: "IDLE", phase: "PLAN" });

  console.log(`Created session ${id}`);
  console.log(`  ${path.relative(root, dest) || dest}`);
  console.log(`  PRIMARY=${primary}  SECONDARY=${secondary}  adapter=${adapter}`);
  console.log("");
  console.log("Next (PRIMARY):");
  console.log(`  1. Fill Topic/Goal/Done in ${path.join("sessions", id, "SESSION.md")}`);
  console.log(`  2. Open TURN-P1: take your turn, then hand off to ${secondary}.`);
  console.log(`  3. Verify after each turn: node "${process.argv[1]}" lint --session ${id}`);
}

function cmdAdvance(opts) {
  const id = requireSession(opts);
  const root = opts.root;
  const dir = sessionDir(root, id);
  const head = parseHead(readText(path.join(dir, "HEAD.md")));
  if (head.state.length !== 2 || !head.byRole.PRIMARY || !head.byRole.SECONDARY)
    die("advance: HEAD.md ## State is malformed — run `lint --session " + id + "` first");
  const errs = [];
  if (head.status !== "ACTIVE") errs.push(`SESSION_STATUS is ${head.status}, expected ACTIVE`);
  if (head.phase !== "PLAN") errs.push(`PHASE is ${head.phase}, expected PLAN`);
  if (head.byRole.PRIMARY.hand !== "START")
    errs.push("PRIMARY must hold START to advance — cross the gate on the PRIMARY's own turn (once both PLAN_AGREE are YES, do not delegate another turn)");
  if (head.gates.PLAN_AGREE_PRIMARY !== "YES" || head.gates.PLAN_AGREE_SECONDARY !== "YES")
    errs.push("both PLAN_AGREE_* must be YES");
  const pointsTxt = readText(path.join(dir, "points.md"));
  const malformed = malformedPointRows(pointsTxt);
  if (malformed.length) errs.push(`malformed point row(s) ${malformed.join(", ")} — fix points.md table formatting`);
  const open = parsePoints(pointsTxt).filter((r) => r.id.startsWith("P") && r.status === "OPEN");
  if (open.length) errs.push(`${open.length} OPEN P* point(s) remain: ${open.map((r) => r.id).join(", ")}`);
  const ctx = path.join(dir, "plan", "context.md");
  if (!exists(ctx) || /^STATUS:\s*EMPTY\s*$/m.test(readText(ctx)))
    errs.push("plan/context.md is still EMPTY — write the frozen plan digest first");
  if (errs.length) die("advance: preconditions not met:\n  - " + errs.join("\n  - "));

  const primary = head.byRole.PRIMARY, secondary = head.byRole.SECONDARY;
  let text = head.raw
    .replace(/^PHASE:.*$/m, "PHASE: IMPL")
    .replace(new RegExp(`^-\\s*${primary.name}:.*$`, "m"), `- ${primary.name}: START - PRIMARY`)
    .replace(new RegExp(`^-\\s*${secondary.name}:.*$`, "m"), `- ${secondary.name}: ON_HOLD - SECONDARY`)
    .replace(/^NEXT_TURN_ID:.*$/m, "NEXT_TURN_ID: I1")
    .replace(/^NEXT_ACTOR:.*$/m, `NEXT_ACTOR: ${primary.name}`)
    .replace(/^LAST_UPDATE:.*$/m, `LAST_UPDATE: ${nowIso()}`);
  atomicWrite(path.join(dir, "HEAD.md"), text);
  const log = path.join(dir, "log.md");
  appendLine(log, `${nowIso()} PHASE_SET PLAN->IMPL plan_open_points=0`);
  appendLine(log, `${nowIso()} STATE_SET ${primary.name}=START ${secondary.name}=ON_HOLD cursor=${head.cursor.TURN_CURSOR} next=I1/${primary.name} seq=${head.cursor.SEQ}`);
  upsertIndexRow(root, { id, type: getKV(readText(path.join(dir, "SESSION.md")), "Type"), status: "ACTIVE", phase: "IMPL" });
  console.log(`Advanced ${id} to IMPL. ${primary.name} (PRIMARY) holds START for TURN-I1.`);
}

function cmdTerminal(opts) {
  const id = requireSession(opts);
  const status = (opts.status || "").toUpperCase();
  if (!TERMINALS.includes(status)) die("terminal: --status must be COMPLETED or ABORTED");
  const root = opts.root;
  const dir = sessionDir(root, id);
  const head = parseHead(readText(path.join(dir, "HEAD.md")));
  if (head.state.length !== 2 || !head.byRole.PRIMARY)
    die("terminal: HEAD.md ## State is malformed — run `lint --session " + id + "` first");
  if (status === "COMPLETED" && (head.phase !== "IMPL"
      || head.gates.IMPL_AGREE_PRIMARY !== "YES" || head.gates.IMPL_AGREE_SECONDARY !== "YES"))
    die("terminal COMPLETED requires PHASE=IMPL and both IMPL_AGREE_*=YES (use --status ABORTED to stop early)");
  let text = head.raw.replace(/^SESSION_STATUS:.*$/m, `SESSION_STATUS: ${status}`)
    .replace(/^LAST_UPDATE:.*$/m, `LAST_UPDATE: ${nowIso()}`);
  for (const s of head.state)
    text = text.replace(new RegExp(`^-\\s*${s.name}:.*$`, "m"), `- ${s.name}: DONE - ${s.role}`);
  atomicWrite(path.join(dir, "HEAD.md"), text);
  appendLine(path.join(dir, "log.md"),
    `${nowIso()} TERMINAL ${status} by=${head.byRole.PRIMARY.name} seq=${head.cursor.SEQ}`);
  upsertIndexRow(root, { id, type: getKV(readText(path.join(dir, "SESSION.md")), "Type"), status, phase: head.phase });
  console.log(`Session ${id} set ${status}. Both hands DONE; no further turns.`);
}

function cmdReset(opts) {
  const id = requireSession(opts);
  const root = opts.root;
  const dir = sessionDir(root, id);
  if (!exists(dir)) die(`reset: session ${id} not found`);
  const head = parseHead(readText(path.join(dir, "HEAD.md")));
  if (head.status === "ACTIVE" && !opts.force)
    die(`reset: session ${id} is ACTIVE. Re-run with --force to archive and reset it.`);
  // preserve config from the existing contract
  const sess = readText(path.join(dir, "SESSION.md"));
  const type = (getKV(sess, "Type") || "META").toUpperCase();
  const roles = getKV(sess, "Roles") || "PRIMARY=CLAUDE, SECONDARY=CODEX";
  const primary = sanitizeActor(roles.match(/PRIMARY=(\w+)/)?.[1] || "CLAUDE");
  const secondary = sanitizeActor(roles.match(/SECONDARY=(\w+)/)?.[1] || "CODEX");
  const adapter = getKV(sess, "SecondaryAdapter") || "codex";
  const date = id.slice(0, 10);
  const slug = id.slice(11) || slugify(type);

  const archived = `${id}.archived-${fsStamp()}`;
  fs.renameSync(dir, sessionDir(root, archived));
  upsertIndexRow(root, { id: archived, type, status: "ARCHIVED", phase: head.phase });

  const tokens = {
    ID: id, DATE: date, RESET: todayDate(), SLUG: slug, TYPE: type, PRIMARY: primary, SECONDARY: secondary,
    PRIMARY_LC: primary.toLowerCase(), SECONDARY_LC: secondary.toLowerCase(),
    ADAPTER: adapter, TIMESTAMP: nowIso(),
  };
  fs.mkdirSync(dir, { recursive: true });
  copyTemplateDir(TPL_SESSION, dir, tokens);
  upsertIndexRow(root, { id, type, status: "IDLE", phase: "PLAN" });
  console.log(`Reset ${id}. Previous tree archived as ${archived} (not deleted).`);
}

function cmdStatus(opts) {
  const root = opts.root;
  const ids = opts.all ? listSessions(root) : [requireSession(opts)];
  if (!ids.length) { console.log("No sessions. Create one: collab-board.mjs new --type FEATURE --slug my-thing"); return; }
  for (const id of ids) {
    const dir = sessionDir(root, id);
    if (!exists(path.join(dir, "HEAD.md"))) { console.log(`${id}: (no HEAD.md)`); continue; }
    const h = parseHead(readText(path.join(dir, "HEAD.md")));
    const open = parsePoints(readText(path.join(dir, "points.md"))).filter((r) => r.status === "OPEN").length;
    const hands = h.state.map((s) => `${s.name}=${s.hand}`).join(" ");
    console.log(`■ ${id}  [${h.status}/${h.phase}]`);
    console.log(`   ${hands}`);
    console.log(`   next: ${h.cursor.NEXT_ACTOR} → ${h.cursor.NEXT_TURN_ID} (${h.phase}); responds_to ${h.cursor.RESPONDS_TO}`);
    console.log(`   open points: ${open}   plan-gate: ${h.gates.PLAN_AGREE_PRIMARY}/${h.gates.PLAN_AGREE_SECONDARY}   impl-gate: ${h.gates.IMPL_AGREE_PRIMARY}/${h.gates.IMPL_AGREE_SECONDARY}`);
  }
}

// ---------- activate (reconcile the catalog when a session goes live on its first turn) ----------
function cmdActivate(opts) {
  const id = requireSession(opts);
  const root = opts.root;
  const dir = sessionDir(root, id);
  if (!exists(path.join(dir, "HEAD.md"))) die(`activate: session ${id} not found`);
  const head = parseHead(readText(path.join(dir, "HEAD.md")));
  const type = (getKV(readText(path.join(dir, "SESSION.md")), "Type") || "META").toUpperCase();
  // The scaffold writes the index row as IDLE; nothing updates it until advance/terminal, so
  // without this the catalog (and lint L16) shows an ACTIVE PLAN session as IDLE for the whole
  // PLAN phase. Force ACTIVE — HEAD may still read IDLE at the instant this runs in the bootstrap.
  upsertIndexRow(root, { id, type, status: "ACTIVE", phase: head.phase || "PLAN" });
  console.log(`Activated ${id} in the catalog (ACTIVE/${head.phase || "PLAN"}).`);
}

// ---------- lint ----------
function cmdLint(opts) {
  const root = opts.root;
  const ids = opts.all ? listSessions(root) : [requireSession(opts)];
  let failed = false;
  for (const id of ids) {
    const findings = lintSession(root, id, { quick: opts.quick });
    const fails = findings.filter((f) => f.level === "FAIL");
    if (fails.length) failed = true;
    console.log(`── lint ${id} ──`);
    if (!findings.length) console.log("PASS (no findings)");
    for (const f of findings) console.log(`${f.level} ${f.code}  ${f.msg}`);
    console.log(`${fails.length ? "FAIL" : "OK"}: ${findings.filter(x=>x.level==="FAIL").length} fail, ${findings.filter(x=>x.level==="WARN").length} warn`);
  }
  if (failed) process.exitCode = 1;
}

function lintSession(root, id, { quick }) {
  const dir = sessionDir(root, id);
  const F = [];
  const add = (level, code, msg) => F.push({ level, code, msg });
  if (!exists(path.join(dir, "HEAD.md"))) { add("FAIL", "L0", `session ${id} has no HEAD.md`); return F; }

  const headText = readText(path.join(dir, "HEAD.md"));
  const head = parseHead(headText);
  const pointsText = exists(path.join(dir, "points.md")) ? readText(path.join(dir, "points.md")) : "";
  const points = parsePoints(pointsText);
  const logText = exists(path.join(dir, "log.md")) ? readText(path.join(dir, "log.md")) : "";
  const events = parseLog(logText);
  const sessText = exists(path.join(dir, "SESSION.md")) ? readText(path.join(dir, "SESSION.md")) : "";
  const turnsDir = path.join(dir, "turns");
  const turnFiles = exists(turnsDir) ? fs.readdirSync(turnsDir).filter((f) => /^[PI]\d+-\w+\.md$/.test(f)) : [];
  const names = head.state.map((s) => s.name);

  // L1 SPLIT-STATE — match only true State-section assignments (`- <ACTOR>: <HAND> - <ROLE>`),
  // so legitimate prose/notes bullets that mention a hand token are not false-flagged.
  if (names.length === 2) {
    const re = new RegExp(`^-\\s*(${names.join("|")}):\\s*(${HANDS.join("|")})\\s*-\\s*(PRIMARY|SECONDARY)\\s*$`, "m");
    const scan = (p) => { if (exists(p) && re.test(readText(p))) add("FAIL", "L1", `hand-token outside HEAD.md in ${path.relative(dir, p)}`); };
    scan(path.join(dir, "points.md")); scan(path.join(dir, "log.md")); scan(path.join(dir, "SESSION.md"));
    for (const f of turnFiles) scan(path.join(turnsDir, f));
    for (const a of (exists(path.join(dir, "agents")) ? fs.readdirSync(path.join(dir, "agents")) : []))
      scan(path.join(dir, "agents", a));
  } else add("FAIL", "L1", `HEAD.md ## State must list exactly 2 actors (found ${names.length})`);

  // L2 PROJECTION
  if (!quick && names.length === 2) {
    const proj = projectLog(events, names);
    if (proj) {
      for (const s of head.state)
        if (proj.hands[s.name] && proj.hands[s.name] !== s.hand)
          add("FAIL", "L2", `HEAD hand ${s.name}=${s.hand} but log projects ${proj.hands[s.name]}`);
      if (proj.phase !== head.phase) add("FAIL", "L2", `HEAD PHASE=${head.phase} but log projects ${proj.phase}`);
      if (proj.seq !== head.cursor.SEQ) add("FAIL", "L2", `HEAD SEQ=${head.cursor.SEQ} but log projects ${proj.seq}`);
      if (proj.status !== head.status) add("FAIL", "L2", `HEAD SESSION_STATUS=${head.status} but log projects ${proj.status}`);
      for (const g of ["PLAN_AGREE_PRIMARY", "PLAN_AGREE_SECONDARY", "IMPL_AGREE_PRIMARY", "IMPL_AGREE_SECONDARY"])
        if (proj.gates[g] !== head.gates[g]) add("FAIL", "L2", `HEAD ${g}=${head.gates[g]} but log projects ${proj.gates[g]}`);
    }
  }

  // L3 DUAL-START / NEXT_ACTOR
  for (const s of head.state) if (!HANDS.includes(s.hand)) add("FAIL", "L3", `invalid hand token ${s.name}=${s.hand}`);
  const active = head.state.filter((s) => s.hand === "START" || s.hand === "WORKING");
  if (head.status === "ACTIVE") {
    if (active.length !== 1) add("FAIL", "L3", `exactly one actor must hold START/WORKING while ACTIVE (found ${active.length})`);
    else if (head.cursor.NEXT_ACTOR !== active[0].name)
      add("FAIL", "L3", `NEXT_ACTOR=${head.cursor.NEXT_ACTOR} but ${active[0].name} holds ${active[0].hand}`);
  } else if (head.status === "IDLE" && active.length) add("WARN", "L3", `IDLE session has an active hand (${active.map((s)=>s.name).join(",")})`);

  // L4 PLAN-GATE + PLAN_OPEN_POINTS mirror
  for (const bad of malformedPointRows(pointsText))
    add("FAIL", "L4", `points.md row ${bad} is malformed (fix the table — an unparseable OPEN point must not be read as resolved)`);
  const openP = points.filter((r) => r.id.startsWith("P") && r.status === "OPEN").length;
  if (head.gates.PLAN_OPEN_POINTS !== openP)
    add("FAIL", "L4", `PLAN_OPEN_POINTS=${head.gates.PLAN_OPEN_POINTS} but points.md has ${openP} OPEN P*`);
  if (head.phase === "IMPL") {
    if (openP) add("FAIL", "L4", `PHASE=IMPL with ${openP} OPEN P* point(s)`);
    if (head.gates.PLAN_AGREE_PRIMARY !== "YES" || head.gates.PLAN_AGREE_SECONDARY !== "YES")
      add("FAIL", "L4", `PHASE=IMPL but PLAN_AGREE not both YES`);
    const ctx = path.join(dir, "plan", "context.md");
    if (!exists(ctx) || /^STATUS:\s*EMPTY\s*$/m.test(readText(ctx)))
      add("FAIL", "L4", `PHASE=IMPL but plan/context.md is empty/missing`);
  }

  // L5 IMPL-BEFORE-GATE
  const hasImplTurn = turnFiles.some((f) => f.startsWith("I"));
  if (hasImplTurn && !events.some((e) => e.type === "PHASE_SET"))
    add("FAIL", "L5", `IMPL turn exists but no PHASE_SET in log`);

  // point statuses sanity
  for (const r of points) if (!POINT_STATUSES.includes(r.status)) add("FAIL", "L4", `point ${r.id} has invalid status ${r.status}`);

  // L6 IMPL-AUTHORITY
  const roleOf = (lc) => head.state.find((s) => s.name.toLowerCase() === lc)?.role;
  const primaryImpl = [];
  for (const f of turnFiles.filter((x) => x.startsWith("I"))) {
    const actorLc = f.match(/^I\d+-(\w+)\.md$/)[1];
    const role = roleOf(actorLc);
    const t = readText(path.join(turnsDir, f));
    const implLine = t.match(/^-\s*Impl:.*$/m)?.[0] || "";
    const hasReal = /BRANCH=(?!—|-\s)\S/.test(implLine) || /LATEST_COMMIT=(?!—|-\s)\S/.test(implLine);
    if (role === "SECONDARY" && hasReal)
      add("FAIL", "L6", `secondary impl turn ${f} carries BRANCH/LATEST — review-only (Rule 7)`);
    if (role === "PRIMARY") primaryImpl.push(f);
  }
  if (primaryImpl.length) {
    // A PRIMARY impl turn must record real code state. `—`/`-` are the "not set yet" placeholders
    // and are rejected; the literal `NONE` is a VALID value meaning "no git / intentionally not
    // tracked" (lets IMPL run in a non-git repo, or before the first commit) — see protocol §9.
    const cs = exists(path.join(dir, "impl", "code_state.md")) ? readText(path.join(dir, "impl", "code_state.md")) : "";
    const unset = (v) => !v || v === "—" || v === "-";
    for (const k of ["BRANCH", "BASE_COMMIT", "LATEST_COMMIT"]) {
      if (unset(getKV(cs, k)))
        add("FAIL", "L6", `impl/code_state.md ${k} unset (use a real value, or NONE for no-git) but PRIMARY impl turns exist`);
    }
  }

  // L7 CONTRACT
  if (turnFiles.some((f) => /^P1-/.test(f))) {
    for (const k of ["Topic", "Goal", "Done"]) {
      const v = getKV(sessText, k);
      if (!v || v === "—") add("FAIL", "L7", `SESSION.md ${k} still "—" but TURN-P1 exists (Rule 2)`);
    }
  }

  // L18 CODEX-ADAPTER — the codex adapter is valid only with PRIMARY=CLAUDE + SECONDARY=CODEX
  if (getKV(sessText, "SecondaryAdapter") === "codex") {
    const roles = getKV(sessText, "Roles") || "";
    if (!/PRIMARY=CLAUDE\b/.test(roles) || !/SECONDARY=CODEX\b/.test(roles))
      add("FAIL", "L18", `SecondaryAdapter=codex requires Roles PRIMARY=CLAUDE, SECONDARY=CODEX (codex@openai-codex runs inside Claude Code)`);
  }

  // L8 ACK (first secondary turn body mentions ACK)
  const secName = head.byRole.SECONDARY?.name?.toLowerCase();
  if (secName) {
    const secTurns = turnFiles.filter((f) => f.endsWith(`-${secName}.md`))
      .sort((a, b) => turnRank(a) - turnRank(b));
    if (secTurns.length && !/\bACK\b/.test(readText(path.join(turnsDir, secTurns[0]))))
      add("WARN", "L8", `${secTurns[0]}: secondary's first turn should ACK the contract`);
  }

  // L9 STALL
  if (head.status === "ACTIVE" && head.stall.LAST_UPDATE) {
    const mins = (new Date() - new Date(head.stall.LAST_UPDATE)) / 60000;
    const check = parseMinutes(getKV(sessText, "Stall"), "CHECK", 15);
    const handoff = parseMinutes(getKV(sessText, "Stall"), "HANDOFF", 10);
    // Advisory only: a long quiet gap may be a real stall OR just a paused-but-healthy board.
    // Never a hard FAIL (it would block an otherwise-clean turn after a lunch/overnight gap).
    if (mins > check + handoff && !events.some((e) => e.type === "STALL_HANDOFF"))
      add("WARN", "L9", `no update for ${Math.round(mins)}m (> CHECK+HANDOFF ${check + handoff}m) — if the owed actor is truly silent, log STALL_HANDOFF and force the handoff (Rule 5)`);
    else if (mins > check && head.stall.STALL_STATE === "OK")
      add("WARN", "L9", `no update for ${Math.round(mins)}m (> CHECK ${check}m) — consider logging STALL_CHECK`);
  }

  // L10 DEADLOCK
  for (const r of points.filter((p) => p.status === "OPEN")) {
    const refs = events.filter((e) => e.type === "TURN_COMMIT" && new RegExp(`points=\\S*\\b${r.id}\\b`).test(e.rest)).length;
    if (refs > 3 && !events.some((e) => e.type === "DECISION" && e.rest.split(/\s+/)[0] === r.id))
      add("FAIL", "L10", `point ${r.id} OPEN after ${refs} turns with no DECISION (Rule 6)`);
  }

  // L11 TERMINAL
  if (TERMINALS.includes(head.status)) {
    if (head.state.some((s) => s.hand !== "DONE")) add("FAIL", "L11", `terminal session but a hand is not DONE`);
    const termIdx = events.findIndex((e) => e.type === "TERMINAL");
    if (termIdx >= 0 && events.slice(termIdx + 1).some((e) => e.type === "TURN_COMMIT" || e.type === "HANDOFF"))
      add("FAIL", "L11", `turns logged after TERMINAL`);
    if (head.status === "COMPLETED" && (head.phase !== "IMPL"
        || head.gates.IMPL_AGREE_PRIMARY !== "YES" || head.gates.IMPL_AGREE_SECONDARY !== "YES"))
      add("FAIL", "L11", `SESSION_STATUS=COMPLETED but not (PHASE=IMPL and both IMPL_AGREE_*=YES) — completion gate skipped (Rule 8/10)`);
  }

  // L12 ESCALATION — a USER_QUESTION in a turn body should have a matching log line.
  const uqLog = events.filter((e) => e.type === "USER_QUESTION").length;
  const uqBody = turnFiles.filter((f) => /USER_QUESTION:/.test(readText(path.join(turnsDir, f)))).length;
  if (uqBody > uqLog) add("WARN", "L12", `${uqBody} USER_QUESTION: in turns but ${uqLog} USER_QUESTION log line(s)`);

  // L13 TURN-SCHEMA (the Impl line is required only for PRIMARY impl turns; secondary review turns omit it)
  for (const f of turnFiles) {
    const t = readText(path.join(turnsDir, f));
    for (const need of ["### TURN-", "- Header:", "- Body:", "- Evidence:", "- Handoff:", "PREV:", "NEXT:"])
      if (!t.includes(need)) add("FAIL", "L13", `${f} missing "${need.trim()}"`);
    if (f.startsWith("I")) {
      const actorLc = f.match(/^I\d+-(\w+)\.md$/)[1];
      if (roleOf(actorLc) === "PRIMARY" && !/^-\s*Impl:/m.test(t))
        add("FAIL", "L13", `${f} (PRIMARY IMPL) missing "- Impl:" line`);
    }
  }

  // L14 CHAIN/ORPHAN
  const committed = new Set(events.filter((e) => e.type === "TURN_COMMIT").map((e) => e.rest.split(/\s+/)[0]));
  for (const f of turnFiles) {
    const tid = f.match(/^([PI]\d+)-/)[1];
    if (!committed.has(tid)) add("FAIL", "L14", `orphan shard ${f}: no TURN_COMMIT in log (crash mid-turn?)`);
  }
  for (const tid of committed)
    if (!turnFiles.some((f) => f.startsWith(tid + "-"))) add("FAIL", "L14", `TURN_COMMIT ${tid} has no shard file`);
  if (head.cursor.RESPONDS_TO && head.cursor.RESPONDS_TO !== "-") {
    const rt = path.join(dir, head.cursor.RESPONDS_TO);
    if (!exists(rt)) add("FAIL", "L14", `HEAD.RESPONDS_TO target missing: ${head.cursor.RESPONDS_TO}`);
  }
  // each shard's PREV link (if not NEW) must point at an existing sibling shard — keeps the chain intact
  for (const f of turnFiles) {
    const prev = readText(path.join(turnsDir, f)).match(/^PREV:\s*\[[^\]]*\]\(([^)]+)\)/m);
    if (prev && !exists(path.join(turnsDir, prev[1])))
      add("FAIL", "L14", `${f} PREV target missing: ${prev[1]}`);
  }

  // L15 MIRROR-DRIFT — skip actors at START or DONE; their mirrors are legitimately stale. A START
  // holder set SELF_HAND=ON_HOLD ending its previous turn and has not acted yet, so its mirror would
  // WARN after every clean handoff. A DONE actor was flipped to DONE by `terminal` (an engine action,
  // not a turn, so the mirror can't have updated) and a terminated session takes no more turns, so the
  // drift is moot. L3 (DUAL-START) guarantees at most one START holder, so a genuinely stale mirror on
  // an ON_HOLD/WORKING actor is still caught.
  for (const s of head.state) {
    if (s.hand === "START" || s.hand === "DONE") continue;
    const af = path.join(dir, "agents", `${s.name.toLowerCase()}.md`);
    if (exists(af)) {
      const sh = getKV(readText(af), "SELF_HAND");
      if (sh && sh !== s.hand) add("WARN", "L15", `agents/${s.name.toLowerCase()}.md SELF_HAND=${sh} ≠ HEAD ${s.hand}`);
    }
  }

  // L19 EVIDENCE-ON-RESOLVE — a turn that RESOLVES a point (a POINT_SET to a non-OPEN status) should
  // carry resolvable evidence. WARN (advisory, never FAIL) when such a turn's `- Evidence:` line is
  // literally `N/A`. Whether a claim is "disputed" is prose guidance, not lintable, so we flag only the
  // explicit empty-evidence token and never judge content (mutual agreement is not verification).
  {
    const resolving = new Set();
    for (const e of events) {
      if (e.type !== "POINT_SET") continue;
      const inM = e.rest.match(/\bin=([PI]\d+)\b/);
      if (inM && /\b[PI]\d+=(AGREED|REJECTED|DEFERRED|OUT_OF_SCOPE)\b/.test(e.rest)) resolving.add(inM[1]);
    }
    for (const tid of resolving) {
      const f = turnFiles.find((x) => x.startsWith(tid + "-"));
      if (!f) continue;
      const ev = readText(path.join(turnsDir, f)).match(/^-\s*Evidence:\s*(.*)$/m);
      if (ev && /^N\/A$/i.test(ev[1].trim()))
        add("WARN", "L19", `${f} resolves a point but Evidence: N/A — cite file:line / command output / doc, or state why none applies`);
    }
  }

  // L16 CATALOG-SYNC
  const idx = path.join(collabDir(root), "index.md");
  if (exists(idx)) {
    const row = readText(idx).split(/\r?\n/).find((l) => l.split("|").map((c) => c.trim())[1] === id);
    if (row) {
      const cells = row.split("|").map((c) => c.trim());
      if (cells[3] !== head.status || cells[4] !== head.phase)
        add("WARN", "L16", `index.md row [${cells[3]}/${cells[4]}] ≠ HEAD [${head.status}/${head.phase}]`);
    } else add("WARN", "L16", `no index.md catalog row for ${id}`);
  }

  return F;
}

function projectLog(events, names) {
  const hands = {}; names.forEach((n) => (hands[n] = "ON_HOLD"));
  let phase = "PLAN", seq = 0, status = "IDLE", activated = false;
  const gates = { PLAN_AGREE_PRIMARY: "NO", PLAN_AGREE_SECONDARY: "NO", IMPL_AGREE_PRIMARY: "NO", IMPL_AGREE_SECONDARY: "NO" };
  for (const e of events) {
    const toks = e.rest.split(/\s+/);
    if (e.type === "STATE_SET" || e.type === "HANDOFF") {
      activated = true;
      for (const t of toks) {
        let m = t.match(/^(\w+)=(\w+)$/); // STATE_SET NAME=hand   (also seq=n / next=...)
        if (m && names.includes(m[1])) hands[m[1]] = m[2];
        m = t.match(/^(\w+):(\w+)->(\w+)$/); // HANDOFF NAME:from->to
        if (m && names.includes(m[1])) hands[m[1]] = m[3];
        m = t.match(/^seq=(\d+)$/); if (m) seq = Number(m[1]);
      }
    } else if (e.type === "GATE_SET") {
      const m = e.rest.match(/^(\w+)=YES/); if (m && m[1] in gates) gates[m[1]] = "YES";
    } else if (e.type === "PHASE_SET") {
      phase = "IMPL";
    } else if (e.type === "TERMINAL") {
      status = toks[0]; names.forEach((n) => (hands[n] = "DONE"));
      const m = e.rest.match(/seq=(\d+)/); if (m) seq = Number(m[1]);
      return { hands, phase, seq, status, gates };
    }
  }
  status = activated ? "ACTIVE" : "IDLE";
  return { hands, phase, seq, status, gates };
}

// ---------- small utils ----------
function turnRank(f) { const m = f.match(/^([PI])(\d+)-/); return (m[1] === "P" ? 0 : 100000) + Number(m[2]); }
function parseMinutes(stallStr, key, dflt) {
  const m = (stallStr || "").match(new RegExp(`${key}=(\\d+)m`));
  return m ? Number(m[1]) : dflt;
}
function requireSession(opts) {
  if (!opts.session) die("this command requires --session <id> (or --all where supported)");
  return opts.session;
}
function die(msg) { console.error(msg); process.exit(1); }

// ---------- arg parsing ----------
function parseArgs(argv) {
  const opts = { root: "." };
  const bool = new Set(["all", "quick", "force"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (bool.has(key)) opts[key] = true;
      else {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith("--")) die(`${a} expects a value`);
        opts[key] = v; i++;
      }
    }
  }
  opts.root = path.resolve(opts.root || ".");
  return opts;
}

const [cmd, ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);
try {
  switch (cmd) {
    case "new": cmdNew(opts); break;
    case "lint": cmdLint(opts); break;
    case "status": cmdStatus(opts); break;
    case "advance": cmdAdvance(opts); break;
    case "activate": cmdActivate(opts); break;
    case "terminal": cmdTerminal(opts); break;
    case "reset": cmdReset(opts); break;
    default:
      console.log("collab-board — commands: new | lint | status | advance | activate | terminal | reset");
      console.log("Run with --help-style usage in the file header. Example:");
      console.log("  node collab-board.mjs new --type FEATURE --slug jwt-auth");
      if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}

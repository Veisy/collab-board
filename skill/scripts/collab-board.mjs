#!/usr/bin/env node
// collab-board — scaffold / verify a split, interlinked per-session board.
// Cross-platform (Windows-safe). No dependencies. See ../references/protocol.md.
//
// Usage:
//   node collab-board.mjs new --type <T> [--slug s | --topic "..."] [--primary CLAUDE] [--secondary CODEX] [--adapter codex-cli|claude-cli|copilot-cli|agy-cli|omp-cli|reasonix-cli|subagent:<name>|manual] [--root .]
//   node collab-board.mjs lint   [--session <id> | --all] [--quick] [--root .]
//   node collab-board.mjs explain <code>             print that check's spec row(s) + the remediation paragraph; an unknown code is an ERROR, never silence
//   node collab-board.mjs status [--session <id> | --all] [--root .]
//   node collab-board.mjs advance  --session <id> [--root .]
//   node collab-board.mjs activate --session <id> [--root .]
//   node collab-board.mjs terminal --session <id> --status COMPLETED|ABORTED [--root .]
//   node collab-board.mjs reset    --session <id> [--force] [--root .]
//   node collab-board.mjs points   --session <id> [--root .]
//   node collab-board.mjs archive  --session <id> [--root .]
//   node collab-board.mjs migrate  --session <id> --to agent/v2|agent/v3 [--root .]
//   node collab-board.mjs relay    --session <id> --capture <f>[,<f>...] [--fused <f>] [--attempt <n>] [--resolve <id>=<STATUS>[,...]] [--renumber <id>:<who>=<newid>[,...]] [--merge <id>:<who>[,...]] [--absent <CELL>[,...]] [--root .]
//   node collab-board.mjs replay   [--session <id> | --all] [--root .]
//   node collab-board.mjs fanout   --seal | --verify --expect <digest> [--manifest <f>] [--root .]
//   node collab-board.mjs doctor   [--root .]        which CLI executors are visible (ADVISORY)

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// The command list AND the help text, read out of this file's own Usage header so `--help` cannot
// fall behind the dispatch switch. It already had: the hand-written list omitted `replay` and
// `fanout` while presenting itself as complete.
const SOURCE = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
const COMMANDS = [...SOURCE.matchAll(/^\/\/\s+node collab-board\.mjs (\w+)/gm)].map((m) => m[1]);
// The Usage block itself, comment markers stripped: what `--help`/`help`/bare invocation prints.
// Printing the pinned header (rather than a pointer at it) is what lets SKILL.md route situational
// commands here without their documentation degrading into a name list.
const USAGE = ((/^\/\/ Usage:\r?\n((?:\/\/.*\r?\n)+)/m.exec(SOURCE) || ["", ""])[1])
  .replace(/^\/\/ ?/gm, "").replace(/\r\n/g, "\n");
const TPL_SESSION = path.join(SCRIPT_DIR, "..", "templates", "session");
const TPL_ROOT = path.join(SCRIPT_DIR, "..", "templates", "root");
const PROTOCOL_SRC = path.join(SCRIPT_DIR, "..", "references", "protocol.md");

const HANDS = ["START", "WORKING", "ON_HOLD", "DONE"];
const TYPES = ["BUG_FIX", "FEATURE", "REFACTOR", "META", "INVESTIGATION"];
const TERMINALS = ["COMPLETED", "ABORTED"];
const POINT_STATUSES = ["OPEN", "AGREED", "REJECTED", "OUT_OF_SCOPE"];
// adapter -> the SECONDARY actor that adapter drives, and the CLI it dispatches. A CLI executor
// names its actor: `agents/<actor>.md`, the turn-shard suffix and `via=` all follow from it, so a
// mismatched pairing is a board that cannot be read consistently (lint L18).
const CLI_EXECUTOR_SPECS = [
  { adapter: "codex-cli", secondary: "CODEX", bin: "codex", aliases: ["codex"] },
  { adapter: "claude-cli", secondary: "CLAUDE", bin: "claude", aliases: [] },
  { adapter: "copilot-cli", secondary: "COPILOT", bin: "copilot", aliases: [] },
  { adapter: "agy-cli", secondary: "ANTIGRAVITY", bin: "agy", aliases: [] },
  { adapter: "omp-cli", secondary: "OMP", bin: "omp", aliases: [] },
  { adapter: "reasonix-cli", secondary: "REASONIX", bin: "reasonix", aliases: [] },
];
// Every accepted spelling, alias included, mapped to the actor it requires.
const CLI_EXECUTORS = Object.fromEntries(CLI_EXECUTOR_SPECS.flatMap(
  (e) => [[e.adapter, e.secondary], ...e.aliases.map((a) => [a, e.secondary])]));
// Legacy spellings normalise to their canonical adapter at scaffold time.
const ADAPTER_ALIASES = Object.fromEntries(CLI_EXECUTOR_SPECS.flatMap(
  (e) => e.aliases.map((a) => [a, e.adapter])));
const CANONICAL_ADAPTERS = CLI_EXECUTOR_SPECS.map((e) => e.adapter);
// The one strict point-row pattern, shared by parsePoints and malformedPointRows. The
// shape-detector/strict-parser pair must never drift apart — an unparseable OPEN point
// must not be silently read as resolved (L4).
// PROTOCOL §8 calls the event vocabulary CLOSED, and until now nothing enforced that: parseLog
// accepted any word as a type and every projector ignored what it did not recognise, so a typo
// (`HANDOF`, `POINT_ST`) silently dropped a real event out of every replay while the log still
// LOOKED complete. A documented closed set with no check is the same overclaim shape this work
// exists to remove, so the set is now enforced where it is declared.
// Every structured file a session owns, in ONE place. Enumerating them per check is how the
// unclosed-comment scan came to omit plan/context.md and impl/code_state.md — the two whose
// contents gate the PLAN->IMPL transition.
const BOARD_FILES = ["HEAD.md", "SESSION.md", "points.md", "log.md", "plan/context.md", "impl/code_state.md"];
// Files where a hidden declaration is read as a VALUE instead of reported. Derived from which
// consumer treats absence as meaningful, not from which file feels important; the reasoning and the
// two inputs that fixed each bound are at the emission site.
const NESTED_OPENER_SCOPE = new Set(["log.md", "SESSION.md", "plan/context.md"]);

// ---------- ruleset provenance ----------
// A session pins an immutable PROTOCOL.md, but lint always judged by the INSTALLED rules. Measured:
// running the pre-branch engine and this one over the same 26 frozen boards, five boards that lint
// CLEAN under the old engine FAIL under the new one — on rules that did not exist when they were
// written. Two of those checks have no remedy at all, because the log is append-only: appending a
// correctly attributed GATE_SET leaves an old unattributed one FAILing forever, and an event whose
// type was legal when written cannot be deleted, indented or commented out.
//
// So applicability is keyed to PROVENANCE, not to the tool version. `OPEN ... ruleset=<id>` records
// the rules in force when the board was created, exactly as `agent_schema=` records its schema.
// ABSENT means legacy: the diagnostic still prints, so nothing is hidden, but it does not GATE,
// because a FAIL a board cannot act on only stalls it — the same reasoning L27 already ships under.
//
// The split is by REMEDY, not by age. A check a board can clear by a protocol-legal append (a
// retired point status, an oversized actor file, a barren phase) stays FAIL for every board; only a
// dead end is gated. There is deliberately NO migration edge: opting an old board into a rule it
// cannot satisfy would promise a remedy that does not exist.
const RULESETS = ["r1"];
const CURRENT_RULESET = "r1";
// Every DEAD-END arm, with the ruleset that introduced it. The inventory is the mechanism: gating
// only the two arms that motivated it left five others FAILing boards that equally cannot repair
// them, which is the same inconsistency in a smaller place. The test is not "is this check new" but
// "does its finding name bytes an append-only log has already fixed".
// MEMBERSHIP RULE, so this stays decidable instead of becoming a list someone extends by feel:
// an arm belongs here when its finding's SUBJECT is a byte of IMMUTABLE COMMITTED HISTORY that no
// legal append can clear. The predicate is stated over immutability rather than over one filename,
// because an earlier draft said `log.md` and then drew a conclusion about shards that the sentence
// did not license. Three consequences, each argued rather than assumed:
//   - A finding about `HEAD.md` or `points.md` is NOT here, however old the board: those bytes are
//     editable, so the remedy exists and the check must gate.
//   - A turn SHARD is immutable too — §5 freezes everything but the predecessor's `NEXT` token — so
//     it satisfies the predicate. No SHIPPED arm names committed shard bytes, which is why every
//     entry below happens to be a log arm; that is a fact about the current inventory, not a
//     narrowing of the rule. A future check naming shard bytes qualifies and must be added here
//     deliberately. The scope is ENUMERATED, not proven closed, and this line is the difference.
//   - An arm whose remedy is "append the event you omitted" is NOT here either. `REFRAME
//     outcome=ESCALATE` with no `USER_QUESTION` naming that turn is cleared by appending the
//     USER_QUESTION, so it keeps FAILing; the barren arm is cleared by logging a REFRAME, and
//     churn specifically by one carrying `trigger=CHURN`.
// Provenance parsing itself is deliberately NOT gated: it is the bootstrap that decides gating, so
// exempting it on its own evidence would let an unreadable token choose its own leniency.
const RULESET_GATED = {
  L0_NESTED_COMMENT: "r1",     // a nested opener already written into log.md
  L11_AFTER_TERMINAL: "r1",    // an event logged after TERMINAL
  L20_GATE_AUTHOR: "r1",       // GATE_SET with no by=
  L20_GATE_FORGED: "r1",       // GATE_SET whose by= names the other actor
  // A malformed `verified=` token is committed log bytes like any other, so it satisfies the
  // membership rule above and belongs here. It is pinned at r1 rather than to a new ruleset
  // because no board written before this check exists CAN carry the token: it did not exist, so
  // there is no history for the gate to protect. Introducing a ruleset for it would buy leniency
  // nobody needs and cost every future board a version bump.
  L20_GATE_VERIFIED: "r1",     // GATE_SET verified= off its grammar, unlinked, or citing no evidence
  L22_CLOSED_VOCAB: "r1",      // unknown event type, or a timestamped non-event line
  L22_MERGED_LINE: "r1",       // two events merged by a missing trailing newline
  L22_COMMENTED_EVENT: "r1",   // an event line inside a comment
  L23_TIMESTAMP: "r1",         // invalid or decreasing timestamps
  L26_REFRAME_FORM: "r1",      // a REFRAME event off its documented form
  L26_REFRAME_AUTHOR: "r1",    // a REFRAME event authored by the non-PRIMARY
};
// Known keys on the OPEN line. A CLOSED grammar, because near-miss detection cannot be enumerated:
// `rulset=r1` is not a spelling anyone can list in advance, and it read as absence, which is the
// lenient direction. Deny-unknown is the same principle L29 already applies to SESSION keys.
const OPEN_KEYS = new Set(["session", "by", "agent_schema", "ruleset"]);
// Provenance is read from the LIVE view — a commented-out OPEN is not an origin — but the RAW line
// is compared against it, because the live view is exactly where an escape hides. Wrapping the token
// in backticks made `codeMask` blank it and the board fell back to legacy, silently and leniently.
// Malformed provenance is never read as absence: that would make the malformed spelling itself the
// exemption, which is how three earlier defects in this file worked.
function boardRuleset(logLive, logRaw) {
  const rawLines = logRaw.split(/\r?\n/);
  let ruleset = null, opens = 0;
  const malformed = [];
  for (const { no, event } of logLines(logLive)) {
    if (!event || event.type !== "OPEN") continue;
    opens++;
    const raw = rawLines[no - 1] || "";
    // The boundary is "not inside a word", NOT "after whitespace". Requiring whitespace let a
    // backtick carry the escape: `` `ruleset=r1` `` is masked by codeMask in the live view AND
    // skipped by a whitespace-anchored raw scan, so the board fell back to legacy in silence.
    // CARDINALITY FIRST. It used to sit behind the `if (!live) continue` below, so a second OPEN
    // carrying NO ruleset skipped the only origin check: the board had two origins and nothing said
    // so. The check belongs to the OPEN event, not to the token it happens to carry.
    if (opens > 1) malformed.push("a second OPEN event declares an origin — a board has exactly one");
    // A strict TOKENIZER, not a scan for known shapes. Matching `key=` anywhere let
    // `ruleset<ZWSP>=r1` past every reader: the zero-width character sits between key and `=`, so
    // no regex saw a declaration and the board fell silently back to legacy. Machine tokens are
    // fixed ASCII (§9), so each payload token is required to BE one — printable ASCII, `key=value`,
    // key known. The ways a token can be corrupted cannot be enumerated; being well-formed can.
    const payload = raw.replace(/^\s*\S+\s+OPEN\b/, "").trim();
    for (const tok of payload.split(/\s+/).filter(Boolean)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\x21-\x7E]*)$/.exec(tok);
      if (!m)
        malformed.push(`OPEN payload token ${JSON.stringify(tok)} is not a printable-ASCII key=value — machine keys are fixed ASCII, and a token no reader can parse must not read as absence`);
      else if (!OPEN_KEYS.has(m[1]))
        malformed.push(`OPEN declares unknown key ${JSON.stringify(m[1])} — the payload is a closed grammar, and an unreadable key read as absence would be the exemption`);
    }
    const rawHits = [...raw.matchAll(/(?<![A-Za-z0-9_])ruleset=([^\s`]*)/g)];
    if (rawHits.length > 1) malformed.push("OPEN declares ruleset more than once");
    const live = event.rest.match(/(?<![A-Za-z0-9_])ruleset=([^\s`]*)/);
    if (rawHits.length && !live)
      malformed.push("OPEN declares a ruleset that the live view does not see — it is masked by a comment or a code span, and a masked declaration must not read as absence");
    if (!live) continue;
    if (!live[1]) malformed.push("OPEN declares an empty ruleset value");
    else if (RULESETS.includes(live[1])) ruleset = live[1];
    else malformed.push(`OPEN ruleset=${JSON.stringify(live[1])} is not one of ${RULESETS.join(", ")}`);
  }
  return { ruleset, malformed };
}
// FAIL when the board declares the ruleset that introduced the check (or a later one); WARN when it
// predates it. Malformed provenance already FAILs on its own and must not buy the exemption, so it
// is resolved to the current ruleset here rather than to legacy.
function gatedSeverity(boardRs, key) {
  const since = RULESET_GATED[key];
  if (!boardRs) return "WARN";
  return RULESETS.indexOf(boardRs) >= RULESETS.indexOf(since) ? "FAIL" : "WARN";
}
const LEGACY_NOTE = " (this board declares no ruleset, so it predates the rule and cannot repair an append-only log; reported, not gated)";
const LOG_EVENTS = new Set([
  "OPEN", "STATE_SET", "TURN_COMMIT", "POINT_SET", "GATE_SET", "PHASE_SET", "HANDOFF",
  "STALL_CHECK", "STALL_HANDOFF", "DECISION", "USER_QUESTION", "TERMINAL", "SCHEMA_SET",
  "REFRAME",
]);
// A type in the vocabulary is only half of an event: the PAYLOAD is documented too, and a payload
// nobody validates is a payload nobody reads. `PHASE_SET PLAN->IMPL garbage` advanced the phase
// because the projector matched a PREFIX of the one documented form, and `SCHEMA_SET
// agent/v2->agent/v1 by=STRANGER` demoted a board's schema because nothing constrained the
// direction or the author. These are the exact forms from PROTOCOL §8; anything else FAILs and no
// projector applies it.
// The count is not decoration: PLAN->IMPL is only legal with no OPEN P* point, so the event
// records zero or it records a transition that should not have happened. Accepting any digits
// meant the field was parsed and then discarded, which is the same as not having it.
const PHASE_SET_FORM = /^PLAN->IMPL plan_open_points=([0-9]+)$/;
// Whole line, not recognised fragments. Extracting the pairs it understood and ignoring the rest
// let trailing text ride along unchecked — the same shape as PHASE_SET's prefix match.
// TWO SETS, deliberately, because they answer different questions — and neither is spelled twice.
//
// POINT_STATUSES is what a board may WRITE. POINT_STATUS_RE is what the log parser may READ, and it
// must still recognise the RETIRED `DEFERRED`. Otherwise a historical
// `POINT_SET P2=DEFERRED P5=AGREED P8=AGREED in=P4` stops matching the form as a WHOLE, the
// projector drops the line entirely, and the legitimate settlements recorded ALONGSIDE the deferral
// vanish with it. Measured: removing it from the READER turned two corpus boards that had parked
// work into 43 findings spread across unrelated points.
//
// The rule is about what a board may DO, not about making its history unreadable. So history
// parses, no new board can write the status, and L4 reports the parked row on its own terms.
const RETIRED_STATUSES = ["DEFERRED"];
const POINT_STATUS_RE = "(?:" + POINT_STATUSES.concat(RETIRED_STATUSES).join("|") + ")";
const POINT_SET_FORM = new RegExp(
  "^([PI][0-9]+=" + POINT_STATUS_RE + "(?: [PI][0-9]+=" + POINT_STATUS_RE + ")*)" +
  "(?: in=([PI][0-9]+))?$");
// The agent-file schemas, as ONE table: an ordered key list per version and the legal migration
// EDGES between them. Three things used to hardcode the version set independently — this regex,
// `AGENT_SCHEMAS`, and the supported-migration check — so adding a version meant editing three
// places that had to agree.
//
// EDGES, NOT A CROSS PRODUCT, and the distinction is the whole point. Deriving this form from
// "allowed FROM version" x "allowed TO version" would accept `agent/v1->agent/v3`, which the old
// hardcoded `v[12]` spelling rejected — a real widening traded for tidiness, and exactly what a
// generated validator is prone to. The alternation below is built from the legal edges themselves,
// so a transition that is not a declared migration cannot parse, and the append path and the
// replay path share that one predicate.
const AGENT_SCHEMA_TABLE = {
  v1: { keys: null, from: null },   // legacy: no closed key grammar, and no edge into it
  v2: { keys: ["SELF_HAND", "LAST_TURN_WRITTEN", "ACTIVE_RECOVERY", "EXECUTOR_THREAD", "UNRESOLVED_CONCERNS"], from: "v1" },
  // v3 drops the two mirrors. `SELF_HAND` duplicated HEAD `## State`, which is authoritative, and
  // `LAST_TURN_WRITTEN` duplicated the cursor; both had to be kept in step with a second writer and
  // neither was read for anything a turn depends on. What remains is state that exists NOWHERE
  // else: an in-flight recovery, the executor thread, and the concerns this actor still holds.
  v3: { keys: ["ACTIVE_RECOVERY", "EXECUTOR_THREAD", "UNRESOLVED_CONCERNS"], from: "v2" },
};
const AGENT_SCHEMAS = Object.keys(AGENT_SCHEMA_TABLE);
const AGENT_SCHEMA_EDGES = Object.entries(AGENT_SCHEMA_TABLE)
  .filter(([, v]) => v.from).map(([to, v]) => [v.from, to]);
const SCHEMA_SET_FORM = new RegExp(
  "^(?:" + AGENT_SCHEMA_EDGES.map(([f, t]) => `agent/${f}->agent/${t}`).join("|") + ")"
  + " by=([A-Za-z0-9_-]+)$");
// A SHAPE-ONLY reader, used to DIAGNOSE and never to accept. Narrowing acceptance to declared edges
// would otherwise cost the precise message a hand-edited downgrade used to get: `agent/v2->agent/v1`
// stopped parsing at all and was reported as "not the documented form", which is true but tells the
// reader nothing about why their well-formed-looking line was refused. Acceptance stays narrow;
// only the wording is generous.
const SCHEMA_SET_SHAPE = /^agent\/(v\d+)->agent\/(v\d+) by=([A-Za-z0-9_-]+)$/;
// The edge that produced a match, recovered by re-testing each — the alternation deliberately has
// no per-branch capture groups, because numbering them is a second encoding of the same table.
function schemaSetEdge(rest) {
  if (!SCHEMA_SET_FORM.test(rest)) return null;
  for (const [f, t] of AGENT_SCHEMA_EDGES)
    if (rest.startsWith(`agent/${f}->agent/${t} `)) return { from: f, to: t, by: rest.split("by=")[1] };
  return null;
}
// The four gates, and ONE predicate for "this GATE_SET names one" — shared by the projector and by
// Rule 11's counter. When they were two, a line could advance the projection while buying (or not
// buying) a convergence window on different terms. The trailing boundary is the PHASE_SET lesson
// applied here: `(\w+)=YES` alone is a PREFIX match, so `PLAN_AGREE_PRIMARY=YESTERDAY` set the gate.
const GATE_NAMES = ["PLAN_AGREE_PRIMARY", "PLAN_AGREE_SECONDARY", "IMPL_AGREE_PRIMARY", "IMPL_AGREE_SECONDARY"];
function gateSetName(rest) {
  const m = /^([A-Za-z_]+)=YES(?=\s|$)/.exec(String(rest));
  return m && GATE_NAMES.includes(m[1]) ? m[1] : null;
}
// §8's DECISION form. Rule 11 counts a DECISION as a settlement, so an off-form line must not buy
// a convergence window it does not record — the same reason REFRAME and PHASE_SET are whole-line.
// DEFER is gone with the status. A DECISION may accept or reject; it may not park.
const DECISION_FORM = /^([PI][0-9]+) -> (ACCEPT|REJECT) by=([A-Za-z0-9_]+)$/;
// A GATE_SET names the turn that justifies it, and it has two spellings. `justified_by=` is what
// §8 documents and what a board writes today; `in=` is the older one, still present in committed
// history and in the boards this suite scaffolds. Same treatment as the retired point status
// below: the READER accepts both so old logs keep parsing, the documented grammar stays one
// spelling, and nothing downstream has to know which it read. Written as ONE predicate because
// the tail check and the justifier lookup are the two readers that must agree about it.
const JUSTIFIER_KEYS = ["justified_by", "in"];
const JUSTIFIER = new RegExp("^(?:" + JUSTIFIER_KEYS.join("|") + ")=[PI][0-9]+$");
// Rule 11's step-back. This is the one event that BUYS a fresh convergence window, so a malformed
// one read loosely would silence the very check it satisfies — the same shape as PHASE_SET's old
// prefix match, but pointed at the check that exists to notice a spiralling session.
const REFRAME_TRIGGERS = ["BARREN", "CHURN", "REPEAT", "MANUAL"];
const REFRAME_OUTCOMES = ["CONTINUE", "REFRAME", "NARROW", "ESCALATE", "ABORT"];
const REFRAME_FORM = new RegExp(
  "^by=([A-Za-z0-9_-]+) in=([PI][0-9]+) trigger=(" + REFRAME_TRIGGERS.join("|") + ")"
  + " outcome=(" + REFRAME_OUTCOMES.join("|") + ")$");
// The step-back's mark in the turn shard itself (PROTOCOL §5). A TOKEN, not a reading: it says a
// line claims to be a step-back, never that the turn actually changed altitude.
const REFRAME_LINE = /^[ \t]*-?[ \t]*REFRAME:/m;
// Rule 11 thresholds. BARREN: turns since the last settlement; 8 is four complete exchanges that
// settled nothing. CHURN: how many times ONE point may be resolved and re-opened in a phase; the
// first re-open is a legitimate correction under new evidence, the second is re-litigation.
const CONVERGE_DEFAULTS = { BARREN: 8, CHURN: 2 };
// L27's single threshold. Chosen, not derived: it is L24's WARN value, which also sits comfortably
// above the largest points.md in the recorded corpus (5,049 B on the longest session), so it warns
// about growth without nagging a board that is legitimately long.
const POINTS_WARN_AT = 8192;
// The SECONDARY fan-out per turn is the CROSS PRODUCT |disjoint scopes| x |roster contributors|:
// every contributor works every scope, independently. Different scopes with one model is
// COVERAGE; the same scope across models is DECORRELATION; the same model on the same scope
// twice is one reviewer billed twice, which the product never produces.
// No recorded fan-out has exceeded 2 contributors on 1 scope, so nothing in the corpus justifies
// a number here even if one were wanted; BARREN=8 / CHURN=2 are the cautionary precedent for a
// threshold nobody could reproduce, and they at least have `replay` behind them.
// No SCOPES_MAX and no ROSTER_MAX, deliberately. The number of contributors a turn deserves is
// the number of DISJOINT scopes its work actually decomposes into, times the vendors available —
// both properties of the task and the machine, neither of which a constant in this file knows. A
// number the engine enforces is a number the next session obeys INSTEAD of thinking, which is
// worse here than no number, because MORE AGENTS IS NOT BETTER: two contributors reading the same
// files are one reviewer billed twice, and volume without decorrelation spends tokens to lower
// quality. What IS enforced is that the product is COMPLETE and that no contributor is counted
// twice. What is NOT enforceable is whether two declared scopes are genuinely disjoint — that is
// a protocol obligation and is stated as one, never dressed up as a check.
const CONVERGE_FORM = /^BARREN=([0-9]+),\s*CHURN=([0-9]+)$/;
const POINT_ROW_RE = /^[ \t]*\|\s*([PI]\d+)\s*\|\s*(\w+)\s*\|\s*(.*?)\s*\|\s*(\w+)\s*\|\s*(.*?)\s*\|$/;

// ONE reader for every homogeneous comma-separated LIST value in a board FILE. Two existed and
// disagreed in two dimensions at once: UNRESOLVED_CONCERNS refused a space after the comma while
// SecondaryPanel trimmed it, and SecondaryPanel silently DROPPED empty items where concerns
// refused them. Each reader was defensible read alone, which is exactly why nothing disagreed
// until a writer put one space in an agent file and the board lost a turn to it.
//
// Strict, by this repo's own rule that a guard must reject what it cannot classify rather than
// skip it: an empty item makes the WHOLE value malformed instead of vanishing from the list.
// Item validation stays with the caller — that is the one genuine per-field difference, and it
// is no obstacle to sharing the separator convention.
//
// NOT for two neighbouring shapes, named here so the next comma-bearing field knows which side
// of the boundary it is on. Fixed-arity RECORDS with per-field grammars (CONVERGE_FORM above,
// ACTIVE_RECOVERY) are anchored patterns, not lists. CLI argv lists are outermost input shaping
// whose values the engine re-emits canonically, so they stay lenient inline.
// Returns null when the value is not a well-formed list, otherwise the trimmed items.
const listItems = (v) => {
  if (typeof v !== "string" || v === "") return null;
  const items = v.split(",").map((x) => x.trim());
  return items.some((x) => x === "") ? null : items;
};

// ONE reader for the log's `points=` token, which had THREE: two split-and-skip sites and a
// word-boundary regex. They disagree on inputs like `points=P1.md`, which satisfies the regex
// and neither split — a same-token double reader, this file's dominant defect, latent only
// because no legitimate writer emits such a token. This is deliberately NOT listItems: the
// token's alphabet is space-free by construction (it is captured with `(\S+)`), and a malformed
// item is skipped exactly as all three sites skip it today. Making it FAIL would be a new
// finding naming immutable history, which is a dead end without ruleset gating.
const pointsIds = (rest) => {
  const m = /\bpoints=(\S+)/.exec(rest || "");
  if (!m || m[1] === "-") return [];
  return m[1].split(",").filter((id) => /^[PI][0-9]+$/.test(id));
};

function defaultAdapter(secondary) {
  const e = CLI_EXECUTOR_SPECS.find((x) => x.secondary === secondary);
  return e ? e.adapter : "manual";
}
function isValidAdapter(adapter) {
  return Object.prototype.hasOwnProperty.call(CLI_EXECUTORS, adapter)
    || adapter === "manual" || /^subagent:\S+$/.test(adapter || "");
}
// The list users are shown, derived so it can never disagree with the list that is accepted.
function adapterChoices() {
  return CANONICAL_ADAPTERS.join(", ") + ", manual, or subagent:<name>";
}
// An adapter drives an actor FAMILY, not one fixed name. `CLAUDE`, `CLAUDE_2` and `CLAUDE_FRESH`
// are all the CLAUDE family and all driven by `claude-cli`; `CLAUDEX` and a bare trailing `CLAUDE_`
// are not. This is the ONE relation between two actor names anywhere in the engine beyond equality,
// and it never asks what MODEL runs anything — which is the whole point. Two ACTORS must be
// distinct; two MODELS need not be, so a board may legitimately run the same model in both seats
// when no second vendor is available.
function inFamily(actor, base) {
  const a = String(actor || "").toUpperCase(), b = String(base || "").toUpperCase();
  if (!a || !b) return false;
  return a === b || (a.startsWith(b + "_") && a.length > b.length + 1);
}
// The ONE boundary predicate for "may this adapter drive this secondary". Fixed at the boundary
// rather than at each call site, so a future caller cannot re-derive it more loosely (cmdNew and
// L18 both hand-rolled the equality before this, which is how they could have drifted apart).
// Note what this still CATCHES: `--secondary CODEX --adapter claude-cli` remains a refusal, because
// CODEX is not in the CLAUDE family. It is a naming-honesty guard, not a model-distinctness guard,
// and it explicitly PERMITS the same model on both sides under a distinct actor name.
function adapterMatchesSecondary(adapter, secondary) {
  return !CLI_EXECUTORS[adapter] || inFamily(secondary, CLI_EXECUTORS[adapter]);
}

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
// A board ARTIFACT is a regular file. A directory wearing an artifact name reached readFileSync and
// threw EISDIR, which does not merely miss one finding — it takes every invariant on the board down
// and reports nothing at all. That happened at three separate call sites before it became one
// predicate: a turn-shaped directory, a directory in agents/, and a directory named points.md.
function isBoardDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function isBoardFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function readText(p) {
  const s = fs.readFileSync(p, "utf8");
  // strip a leading UTF-8 BOM (U+FEFF): fs's utf8 decode leaves it as a literal char that would
  // break any ^-anchored key regex on line 1. charCodeAt avoids an invisible/escaped char in source.
  // No shipped template puts a key on line 1 today, so this is latent — but a free guard (see L21).
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file); // MoveFileEx replace-existing on Windows → atomic
}
function appendEvent(file, line) {
  // appendFileSync only guarantees the APPENDED text ends in \n — it never checks the EXISTING file.
  // If the previous writer (this engine, or an agent's hand-append) left no trailing newline, the new
  // event merges onto the old last line: parseLog still matches it (the first event's type wins), so
  // the appended event is silently absorbed into the prior event's `rest` and vanishes from every
  // replay. Guard the existing tail too so no append can be lost.
  let withNl = line.endsWith("\n") ? line : line + "\n";
  const prev = exists(file) ? readText(file) : "";
  // The clamp below looks at the LAST EVENT, and an event inside a comment is not an event. Read
  // raw, a commented line within the same wall-clock second steered the timestamp of a real
  // append. The bytes written still go at the end of the raw file; only the DECISION is live.
  const prevLive = liveText(prev);
  // Engine stamps are second-precision, but an agent (or a scribe following DISPATCH_UTC)
  // may legally write millisecond-precision events. Within the same wall-clock second the
  // truncated engine stamp parses EARLIER than the file's last event and would violate the
  // L23 non-decreasing invariant. Clamp to the last event's timestamp (equality is valid) —
  // but ONLY for that sub-second truncation artifact: a decrease of a full second or more
  // means the earlier event carries wrong time, and the engine writes its true stamp so
  // L23 surfaces that instead of the clamp silently inheriting a fabricated future time.
  const TS_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2}))\s/;
  const lastTs = [...prevLive.matchAll(new RegExp(TS_RE.source, "gm"))].pop()?.[1];
  const newTs = withNl.match(TS_RE)?.[1];
  const lag = lastTs && newTs ? Date.parse(lastTs) - Date.parse(newTs) : 0;
  if (lag > 0 && lag < 1000) withNl = lastTs + withNl.slice(newTs.length);
  fs.appendFileSync(file, prev.length > 0 && !prev.endsWith("\n") ? "\n" + withNl : withNl);
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
  // LIVE: a row inside a comment is not a row. Reading raw here would report a commented-out
  // draft as a malformed live row.
  for (const line of liveText(text).split(/\r?\n/)) {
    // Shape-detector is case-insensitive on the id so a lowercase `p1`/`i2` row (which the strict,
    // uppercase-only parser would silently drop) is caught as malformed instead of read as resolved.
    if (/^\|\s*[PIpi]\d+\s*\|/.test(line) && !POINT_ROW_RE.test(line))
      bad.push((line.match(/^\|\s*([PIpi]\d+)/) || [])[1] || "?");
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
// Board files SHIP HTML comment blocks (every template has one), and a declaration inside a comment
// is not a declaration. This is masked ONCE, here, rather than at each call site: fixing it
// per-caller produced four separate escapes of the same shape — a whole-file schema scan, unmasked
// agent-file comments, a scavenged Roles value, and finally a `Roles:` line hidden in SESSION.md's
// own shipped comment block, which satisfied an exactly-one check and was then believed. Every key
// read and every cardinality count now sees the same live text, including callers not yet written.
// Comment spans are blanked IN PLACE (newlines preserved) so line numbers and column-0 anchoring
// are unaffected.

// Which characters sit inside a CODE span or fence, where comment markers are literal text rather
// than syntax. These board files are documents about a Markdown format, so they quote `<!--` in
// prose constantly — four of this repo's own boards do — and treating a quoted opener as a real
// one masked the rest of the file and produced a cascade of false "missing declaration" findings.
// A masker that does not understand code spans is not reading Markdown, it is reading for '<!--'.
function codeMask(text) {
  const inCode = new Array(text.length).fill(false);
  const FENCE = /^[ ]{0,3}(```+|~~~+)/;
  let i = 0, fence = null;
  while (i < text.length) {
    let eol = text.indexOf("\n", i);
    if (eol === -1) eol = text.length;
    const line = text.slice(i, eol);
    const fm = FENCE.exec(line);
    if (fence) {
      // Everything inside a fence is literal, including the closing line itself.
      for (let k = i; k < eol; k++) inCode[k] = true;
      if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length) fence = null;
    } else if (fm) {
      fence = fm[1];
      for (let k = i; k < eol; k++) inCode[k] = true;
    } else {
      // Inline spans: a run of N backticks opens, and the next run of exactly N closes. An
      // unterminated run is not a span, so it must not swallow the rest of the line.
      let j = 0;
      while (j < line.length) {
        if (line[j] !== "`") { j++; continue; }
        let n = 0;
        while (j + n < line.length && line[j + n] === "`") n++;
        const run = "`".repeat(n);
        let close = j + n;
        for (;;) {
          close = line.indexOf(run, close);
          if (close === -1) break;
          if (line[close + n] !== "`") break;
          close += n;
        }
        if (close === -1) { j += n; continue; }
        for (let k = j; k < close + n; k++) inCode[i + k] = true;
        j = close + n;
      }
    }
    i = eol + 1;
  }
  return inCode;
}
// Comment spans OUTSIDE code, located once and shared by every consumer, so the reader and the
// unclosed-comment check can never disagree about where a comment begins.
function commentSpans(text) {
  const inCode = codeMask(text);
  const spans = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("<!--", i);
    if (open === -1) break;
    if (inCode[open]) { i = open + 4; continue; }
    let close = open + 4;
    for (;;) {
      close = text.indexOf("-->", close);
      if (close === -1 || !inCode[close]) break;
      close += 3;
    }
    if (close === -1) { spans.push([open, text.length, true]); break; }
    spans.push([open, close + 3, false]);
    i = close + 3;
  }
  return spans;
}
function hasUnclosedComment(text) {
  return commentSpans(text).some(([, , unclosed]) => unclosed);
}
// A `<!--` INSIDE an open comment is not a comment — HTML does not nest them, so the FIRST `-->`
// ends the span and whatever follows re-enters live text. The scanner is right about the span and
// that is exactly what makes the input dangerous: `<!-- <!-- <ts> SCHEMA_SET ... --> -->` hides an
// event from every reader. The span ends at the first closer, so the payload begins with the second
// `<!--` and no anchored selector can see the timestamp behind it; the trailing `-->` is then stray
// text nothing claims. Reported here, at the boundary that owns comment structure, rather than in
// L22 — widening L22's anchored selector to chase it would break the quotation control that makes
// the selector correct. A guard must reject what it cannot classify, and this is unclassifiable:
// the bytes read one way to the scanner and the opposite way to a human.
function nestedCommentOpeners(text) {
  const inCode = codeMask(text);
  const hits = [];
  for (const [a, b] of commentSpans(text)) {
    let k = text.indexOf("<!--", a + 4);
    while (k !== -1 && k < b) {
      if (!inCode[k]) hits.push(k);
      k = text.indexOf("<!--", k + 4);
    }
  }
  return hits;
}
// The LIVE view: what the document DECLARES. Two things are not declarations — text inside a
// comment, and text quoted as code — and both are blanked. Masking only comments left the second
// half of that promise unkept: a fenced quote of `Roles:` or `SEQ:` was read as a real one.
function liveText(text) {
  const spans = commentSpans(text);
  const inCode = codeMask(text);
  let any = spans.length > 0;
  if (!any) for (let k = 0; k < inCode.length; k++) if (inCode[k]) { any = true; break; }
  if (!any) return text;
  // Masked IN PLACE, preserving columns and line boundaries: splicing would concatenate the
  // neighbours of a comment and can MANUFACTURE a declaration out of two halves.
  const out = text.split("");
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " "; };
  for (const [a, b] of spans) blank(a, b);
  for (let k = 0; k < inCode.length; k++) if (inCode[k] && out[k] !== "\n") out[k] = " ";
  return out.join("");
}
// Selects a mutation target on the LIVE view, then splices into the ORIGINAL bytes at that exact
// offset. A raw first-match replace let a commented column-0 decoy ABSORB a write: after
// `terminal --status ABORTED` the commented declaration became ABORTED while the live one stayed
// IDLE, so the board's real status was never written. Declaration masking governs mutation-target
// selection, not only reading. Returns null when the live match is absent or ambiguous, so callers
// refuse rather than write to a guessed target.
// `within` bounds the search to a region of the LIVE view (offsets are preserved, so a match
// found there splices into the original bytes at the same offset). Used for State rows, whose
// scope is the `## State` section — matching them file-wide made the writer disagree with the
// reader about what a row even is.
function stateSectionRange(live) {
  const m = /^## State$/m.exec(live);
  if (!m) return null;
  const start = m.index + m[0].length;
  const next = /^## /m.exec(live.slice(start));
  return [start, next ? start + next.index : live.length];
}
function replaceLiveLine(text, re, replacement, within) {
  const live = liveText(text);
  if (within) {
    const range = within(live);
    if (!range) return null;
    const [lo, hi] = range;
    const rx2 = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    const hits2 = [...live.slice(lo, hi).matchAll(rx2)];
    if (hits2.length !== 1) return null;
    const at2 = lo + hits2[0].index;
    return text.slice(0, at2) + replacement + text.slice(at2 + hits2[0][0].length);
  }
  const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const hits = [...live.matchAll(rx)];
  if (hits.length !== 1) return null;
  const at = hits[0].index;
  return text.slice(0, at) + replacement + text.slice(at + hits[0][0].length);
}
function getKV(text, key) {
  const m = liveText(text).match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  return m ? m[1].trim() : null;
}
// `SCHEMA` names the grammar a file claims to follow, so it is admissible in EVERY board file and
// belongs to no single payload. One corpus board declares it in `impl/code_state.md`, where the
// template puts the schema in the H1 line instead; that board is well-formed and must stay so.
const SCHEMA_KEY = "SCHEMA";
// The closed grammars, in one table. `SESSION.md` was an OPEN grammar: appending `BoardWritMode:`
// or `SecondaryModle:` produced byte-identical lint output, so a typo silently disabled sole-writer
// mode and L25 with it — the board asserted a constraint that nothing enforced. A key the engine
// can READ must be a key lint KNOWS, so the accessors below and L29 read these same entries.
const SESSION_GRAMMAR = {
  file: "SESSION.md",
  // Declared by 28 of 28 boards in the recorded corpus.
  core: ["Catalog", "Protocol", "Type", "Reset", "Topic", "Goal", "Done", "Stall", "Roles", "SecondaryAdapter"],
  // Optional and strictly additive. The corpus cannot be the source of this list: `Converge`
  // post-dates most boards and its template says the line may be deleted entirely, while
  // `SecondaryModel`/`SecondaryEffort` are documented but declared by NO board. A known set
  // derived from observed boards would reject both the moment someone used them.
  optional: ["Converge", "BoardWriteMode", "SecondaryPanel", "SecondaryModel", "SecondaryEffort"],
};
const CODE_STATE_GRAMMAR = {
  file: path.join("impl", "code_state.md"),
  core: ["BRANCH", "BASE_COMMIT", "LATEST_COMMIT"],
  optional: [],
};
const CLOSED_GRAMMARS = [SESSION_GRAMMAR, CODE_STATE_GRAMMAR];
// L29 checks that no key is UNKNOWN or REPEATED. It deliberately does not check that the core keys
// are PRESENT: L6 already owns code_state's fields and L18/L2 own the SESSION values they read, and
// a second owner of one invariant is how the two-readers defect class starts.
// `live` must ALREADY be the live view — lint's `cached()` is that view, and masking here as well
// would be a second, independently-editable copy of the rule about what counts as a declaration.
// The negative control for this is the call site, not this function: mask twice and reverting
// either one is unobservable, which is a guard that cannot be tested.
function grammarProblems(live, g) {
  const known = new Set([SCHEMA_KEY, ...g.core, ...g.optional]);
  const counts = new Map();
  for (const line of live.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  const problems = [];
  for (const [k, n] of counts) {
    if (!known.has(k)) problems.push(`${k} is not a key of this file (known: ${[...known].sort().join(", ")}) — a structured file declares only the keys its grammar defines (§9); rename a typo to the key it meant, or move prose out of key position (indent it or comment it)`);
    else if (n > 1) problems.push(`${k} declared ${n} times — only the first live declaration is ever read; keep exactly one and delete the rest`);
  }
  return problems;
}
// The readers ARE the grammar, generated from it rather than written beside it. Eight SESSION keys
// were spelled as bare strings at ten call sites — `Stall` twice on ADJACENT lines — and a typo at
// any one of them returns null and takes a default, byte-identical to the key being absent.
//
// Generating them is what makes this a boundary fix instead of ten call-site fixes: `SESSION.Foo`
// exists if and only if `Foo` is in the grammar, so a key the engine reads cannot be one lint
// rejects, and misspelling one raises a TypeError at first use instead of returning null. Wrapping
// each site by hand would have converged when the sites ran out, not when the code was right.
// The SHIPPED v2 notes comment states a rule that is false under v3 — five mandatory keys, never
// delete one. Migration copies the notes suffix verbatim, which is right for an actor's own words
// and wrong for boilerplate this project put there. Exactly one known block is replaced, matched by
// a sentence no human note would contain by accident; anything else is left alone.
// Matched by TWO sentences that only ever appeared together in the shipped block, not by one
// substring. An actor who quotes "the five keys above are a CLOSED grammar" in a comment of their
// own — to disagree with it, say — was having their notes deleted by a migration, because one
// phrase identified the block and the whole enclosing comment was then replaced. Exact source-header
// validation cannot carry a refusal about the discretionary suffix; the match has to be specific
// enough that no human note reproduces it by accident.
const V2_BOILERPLATE = "The five keys above are a CLOSED grammar";
const V2_BOILERPLATE_2 = "Everything below this comment is DISCRETIONARY and IS size-checked";
function retireBoilerplate(buf) {
  const s = buf.toString("utf8");
  const at = s.indexOf(V2_BOILERPLATE);
  if (at < 0) return buf;
  if (!s.includes(V2_BOILERPLATE_2)) return buf;   // one phrase alone is a quotation, not the block
  const open = s.lastIndexOf("<!--", at);
  const close = s.indexOf("-->", at);
  if (open < 0 || close < 0) return buf;   // not a well-formed block: leave the actor's bytes alone
  const replacement = "<!-- Scratch space for this actor only. NON-AUTHORITATIVE — HEAD.md ## State is the truth.\n"
    + "     The three keys above are a CLOSED grammar; their forms and the size ladder that applies\n"
    + "     below this comment are in references/protocol.md §9. -->";
  return Buffer.from(s.slice(0, open) + replacement + s.slice(close + 3), "utf8");
}
function readersFor(grammar) {
  return Object.fromEntries(
    [...grammar.core, ...grammar.optional].map((k) => [k, (sessText) => getKV(sessText, k)]));
}
const SESSION = readersFor(SESSION_GRAMMAR);
// `impl/code_state.md` had the same defect one grammar over: L6 carried its own inline
// `["BRANCH", "BASE_COMMIT", "LATEST_COMMIT"]` — a THIRD copy of a list that already existed twice
// — and read through it dynamically, which is how it stayed invisible to a per-key search.
const CODE_STATE = readersFor(CODE_STATE_GRAMMAR);
// `getKV` returns the FIRST declaration, so a file carrying a key twice silently resolves to
// whichever came first while the other value sits there contradicting it. For AUTHORITATIVE keys
// that is two truths on one board: a first `IMPL_AGREE_SECONDARY: YES` with a second `: NO` can
// satisfy the projection and the completion guard while the board plainly says both. Every
// authoritative key must be declared exactly once, checked before any mutation, not only in lint.
const HEAD_AUTHORITATIVE = [
  "PROTOCOL", "SESSION_STATUS", "PHASE", "TURN_CURSOR", "RESPONDS_TO", "NEXT_TURN_ID", "NEXT_ACTOR", "SEQ",
  "PLAN_AGREE_PRIMARY", "PLAN_AGREE_SECONDARY", "IMPL_AGREE_PRIMARY", "IMPL_AGREE_SECONDARY",
  "PLAN_OPEN_POINTS", "LAST_UPDATE", "STALL_STATE",
];
function duplicateKeys(text, keys) {
  const dup = [];
  const live = liveText(text);   // count LIVE declarations only — a commented one is not a declaration
  for (const k of keys) {
    const n = (live.match(new RegExp(`^${k}:`, "gm")) || []).length;
    if (n > 1) dup.push(`${k} x${n}`);
  }
  return dup;
}
// Duplicate detection is INVERTED: reject ANY repeated top-level `KEY:` line rather than checking a
// hand-maintained list. `HEAD/v1` has no legitimate repeated scalar, and a curated list is the same
// narrow-fix shape it was meant to close — a key added to the schema later would silently go
// uncovered. Inversion cannot catch ZERO declarations though, so the required-key check below is
// still needed: the two are complements, not alternatives. (`## State` rows start with `- ` and are
// not top-level keys, so the actor list is untouched.)
function headKeyProblems(text) {
  const counts = new Map();
  for (const line of liveText(text).split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  const problems = [];
  for (const [k, n] of counts) if (n > 1) problems.push(`${k} declared ${n} times`);
  for (const k of HEAD_AUTHORITATIVE) if (!counts.has(k)) problems.push(`${k} is missing`);
  return problems;
}
function parseHead(text) {
  const state = [];
  // The State block is read from the LIVE view: an actor row inside a comment was previously
  // believed live, so a session could pass lint with no real SECONDARY row at all. Section
  // cardinality is reported so callers can refuse a HEAD declaring two State sections.
  const liveHead = liveText(text);
  const stateSections = liveHead.split(/^## State$/m).length - 1;
  const stateBlock = liveHead.split(/^## State$/m)[1]?.split(/^## /m)[0] ?? "";
  // Actor names are restricted to `[A-Za-z0-9_]+` AT THE PARSER, not merely by convention. They are
  // interpolated into a dynamic RegExp downstream (L1's split-state scan), so accepting any
  // non-space token let an actor named `[` make regex construction THROW — killing lint outright
  // rather than reporting a finding, which disables the verifier instead of tripping it. A name
  // outside the set is surfaced as a malformed row (L1 reports the count mismatch) and never
  // reaches interpolation. §10 already fixes actor names as ASCII machine tokens.
  const malformed = [];
  // stateBlock is already the live view (sliced out of liveHead above), so this split is live.
  for (const line of stateBlock.split(/\r?\n/)) {
    const m = line.match(/^-\s*(\S+):\s*(\w+)\s*-\s*(\w+)\s*$/);
    if (!m) continue;
    if (!/^[A-Za-z0-9_]+$/.test(m[1])) { malformed.push(m[1]); continue; }
    state.push({ name: m[1], hand: m[2], role: m[3].toUpperCase() });
  }
  const byRole = {};
  for (const s of state) byRole[s.role] = s;
  return {
    raw: text,
    status: getKV(text, "SESSION_STATUS"),
    phase: getKV(text, "PHASE"),
    state, byRole, malformedActors: malformed, stateSectionCount: stateSections,
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
const POINTS_HOT = "points.md";
const POINTS_COLD = "points-archive.md";
// A row's home is part of the row. `union` is what every DECISION reads: an id resolved five turns
// ago still resolves a citation, still blocks a gate if it is somehow OPEN, and still reconciles
// against the log. `hot` is what an ACTOR reads each turn, and is the only thing the archive makes
// smaller — the engine reads both, which costs filesystem bytes and no context at all.
//
// Rows carry their SOURCE because a writer that does not know which file a row came from will
// either duplicate it or write to the wrong one. The review named relay as exactly that case: it
// renders point rows, so it needs source-aware writes, not a read-only union map.
function loadPoints(dir) {
  const hotPath = path.join(dir, POINTS_HOT), coldPath = path.join(dir, POINTS_COLD);
  // FILE-KIND AWARE. A DIRECTORY named points.md reaches readFileSync and ends the whole run with
  // EISDIR, taking every other invariant down with it — the hostile-input sweep caught this loader
  // repeating a mistake the rest of the engine had already learned. A non-file reads as absent here
  // and surfaces as L0's finding, which is the check that owns it.
  const hotText = isBoardFile(hotPath) ? readText(hotPath) : "";
  const coldText = isBoardFile(coldPath) ? readText(coldPath) : "";
  const hot = parsePoints(hotText).map((r) => Object.assign({}, r, { source: POINTS_HOT }));
  const archive = parsePoints(coldText).map((r) => Object.assign({}, r, { source: POINTS_COLD }));
  const union = hot.concat(archive);
  const byId = new Map();
  const duplicates = [];
  for (const r of union) {
    if (byId.has(r.id)) duplicates.push(r.id);
    else byId.set(r.id, r);
  }
  return { hot, archive, union, byId, duplicates, hotText, coldText, hotPath, coldPath,
    hasArchive: isBoardFile(coldPath) };
}
// MOVING A ROW BACK. `source` was recorded and then never consulted at the one boundary that
// mutates rows: relay reads and writes points.md alone, so setting an ARCHIVED id either failed
// as an unknown id or appended a SECOND hot row and orphaned the archived one. A field that marks
// ownership and is not read at the write is not a boundary fix, it is a note.
//
// Re-hot is therefore part of the write, not a separate command an operator must remember: a
// point being written about is a point in play, and a point in play belongs where every turn
// reads it.
function rehotPoints(dir, ids) {
  const pts = loadPoints(dir);
  if (!pts.hasArchive) return [];
  const want = new Set(ids);
  const moving = pts.archive.filter((r) => want.has(r.id)).map((r) => r.id);
  if (!moving.length) return [];
  const move = new Set(moving);
  const nlA = /\r\n/.test(pts.coldText) ? "\r\n" : "\n";
  const keptCold = [], rows = [];
  for (const line of pts.coldText.split(/\r?\n/)) {
    const m = line.match(POINT_ROW_RE);
    if (m && move.has(m[1])) { rows.push(line); continue; }
    keptCold.push(line);
  }
  atomicWrite(pts.coldPath, keptCold.join(nlA).replace(/(\r?\n)+$/, "") + nlA);
  const nlH = /\r\n/.test(pts.hotText) ? "\r\n" : "\n";
  atomicWrite(pts.hotPath, pts.hotText.replace(/(\r?\n)+$/, "") + nlH + rows.join(nlH) + nlH);
  return moving;
}
// ELIGIBILITY IS DERIVED FROM LOG ORDER, with no new field and no new event. A row may be archived
// once it has been settled for two whole turns: take the LATEST transition into a settled status
// and count the TURN_COMMIT events strictly after it. Re-asserting the same status does not reset
// the count; reopening and re-resolving does, because the latest transition moves.
function pointAge(events) {
  const settledAt = new Map();
  let commits = 0;
  for (const e of events) {
    if (e.type === "TURN_COMMIT") { commits++; continue; }
    if (e.type !== "POINT_SET") continue;
    const m = POINT_SET_FORM.exec(e.rest);
    if (!m) continue;
    for (const tok of m[1].split(" ")) {
      const parts = tok.split("=");
      const id = parts[0], status = parts[1];
      if (status === "OPEN") settledAt.delete(id);
      else if (!settledAt.has(id) || settledAt.get(id).status !== status)
        settledAt.set(id, { status: status, at: commits });
    }
  }
  return { commits, turnsSettled: (id) => (settledAt.has(id) ? commits - settledAt.get(id).at : null) };
}
const ARCHIVE_AFTER_TURNS = 2;

function parsePoints(text) {
  const rows = [];
  // LIVE: a commented-out row was parsed as a real one, so commenting a point out still COUNTED
  // it as OPEN — the same shape as the commented HEAD actor row and the commented log event.
  for (const line of liveText(text).split(/\r?\n/)) {
    const m = line.match(POINT_ROW_RE);
    if (m) rows.push({ id: m[1], part: m[2], title: m[3], status: m[4], resolved: m[5] });
  }
  return rows;
}
// A line that BEGINS with a timestamp is claiming to be an event. That claim is what gets
// checked — not merely the lines that happen to parse. Recognising events by "does it match"
// meant a line one character off the grammar (`<ts> -HANDOFF ...`) was not an event to any check
// and passed with no finding at all, which is the same reach-it-from-outside shape as every other
// escape here: the selector was the grammar it was supposed to be selecting for.
// The timestamp is one grammar, and it must be a real instant. The previous pattern accepted
// 2026-99-99T99:99:99Z; L23 then compared NaN, which is false in both directions, so an
// impossible timestamp ordered nothing and reported nothing. Shape is checked lexically and the
// value is then confirmed to round-trip, which rejects 2026-02-30 as well as month 99.
const TS_SHAPE = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(\.\d+)?(Z|[+-]\d\d:?\d\d)$/;
function isRealTimestamp(v) {
  const m = TS_SHAPE.exec(v);
  if (!m) return false;
  if (!Number.isFinite(Date.parse(v))) return false;
  // ONE path for every offset: the WALL-CLOCK fields are what the string states, and they are
  // valid or not independently of the offset they are stated in. Splitting this into a UTC branch
  // and an offset branch made the two disagree about 2026-02-30.
  //
  // Checked ARITHMETICALLY rather than by round-tripping through Date. Date.parse rolls 2026-02-30
  // into March 2, so the fields must be demanded back — but doing that with Date.UTC introduced a
  // fresh rejection, because Date.UTC maps years 0..99 to 1900..1999 and so declared the
  // legitimate instant 0099-01-01T00:00:00Z unreal. A calendar does not need a Date to validate it.
  const [Y, MO, D, H, MI, SE] = [+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]];
  const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const DAYS = [31, leap(Y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (MO < 1 || MO > 12) return false;
  if (D < 1 || D > DAYS[MO - 1]) return false;
  if (H > 23 || MI > 59) return false;
  // RFC 3339 permits a leap second, but only as the last second of a UTC day.
  if (SE > 59 && !(SE === 60 && H === 23 && MI === 59)) return false;
  return true;
}
// A line CLAIMS to be an event by looking like a date-time, and that claim is judged INDEPENDENTLY
// of the grammar being judged. Selecting with the four-digit year the grammar itself requires is
// the applicability defect this whole review keeps finding: a 40-digit year failed the selector,
// so it was not an event to any check and disappeared with no finding at all.
const LOG_TS = /^[ \t]*[0-9]+-[0-9]+-[0-9]+T/;
const LOG_LINE = /^(\d{4}-\d\d-\d\dT[\d:]+(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?)\s+([A-Z][A-Z_]*)(?:\s+(.*))?$/;
// Every timestamp-shaped line in the LIVE view, with the parse that line yields (null if none).
// Comments are masked first: an event inside a comment was replayed by every projector, so a
// commented-out TERMINAL silently ended a live session's projected state.
function logLines(text) {
  // Masking is idempotent, so callers holding a live view may pass it straight through.
  return liveText(text).split(/\r?\n/)
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => LOG_TS.test(line))
    .map((x) => {
      const m = LOG_LINE.exec(x.line);
      return { ...x, event: m ? { ts: m[1], type: m[2], rest: (m[3] || "").trim(), raw: x.line } : null };
    });
}
function parseLog(text) {
  return logLines(text).filter((x) => x.event && LOG_EVENTS.has(x.event.type)).map((x) => x.event);
}

// ---------- actor-file regions ----------
// ONE reader owns where an actor file's header ends and its discretionary region begins. Two
// implementations of this would drift, and the drift is not cosmetic: `migrate` rewrites the
// header and preserves the notes byte-for-byte, so if it disagreed with L24 about the boundary
// it would either eat notes or leave a file L24 rejects. Returns raw bytes as well, because the
// size ladder is a byte check and a decoded length would under-report CRLF and multibyte cost.
// ONE comment/code scanner for the whole engine. This function used to carry its own byte-level
// scan, which is precisely the drift the module comment above warns about: it understood comments
// but not code, so a fenced example containing `<!--` — the kind of thing an actor file
// legitimately quotes — was read as a real unclosed comment. L24 then reported a missing
// PRIVATE_NOTES delimiter and charged the entire file as discretionary, while L0, reading the same
// bytes through the shared scanner, correctly said nothing. Two scanners is two answers.
//
// Offsets are still computed in BYTES, because the size ladder charges CRLF and multibyte cost.
// The live view preserves line boundaries, so line N of the live view corresponds to line N of the
// raw bytes and the delimiter's byte offset is the sum of the raw line lengths before it.
function actorRegions(file) {
  const raw = fs.readFileSync(file);
  const text = raw.toString("utf8").replace(/^\uFEFF/, "");
  const live = liveText(text);
  const liveLines = live.split(/\r?\n/);

  // Byte length of each raw line INCLUDING its terminator, so an offset can be recovered without
  // assuming one byte per character.
  const rawLineBytes = [];
  {
    let start = 0;
    for (let i = 0; i <= raw.length; i++) {
      if (i === raw.length) { if (i > start) rawLineBytes.push(i - start); break; }
      if (raw[i] === 0x0a) { rawLineBytes.push(i - start + 1); start = i + 1; }
    }
  }

  // The delimiter is a WHOLE LINE and must be LIVE: `PRIVATE_NOTES: junk` is not the delimiter,
  // and neither is one inside a comment — selecting a commented one truncates the header before
  // the real schema declaration and drops the mandatory keys into uncounted bytes.
  let markerIdx = -1;
  for (let i = 0; i < liveLines.length; i++) {
    if (liveLines[i].replace(/\r$/, "") === "PRIVATE_NOTES:") { markerIdx = i; break; }
  }
  let markerLf = -1;
  if (markerIdx >= 0) {
    let off = 0;
    for (let i = 0; i <= markerIdx; i++) off += rawLineBytes[i] || 0;
    markerLf = off - 1;                       // the LF that ends the delimiter line
  }

  // Trailing blanks a comment or code span created at end of line are dropped, so a legitimate
  // trailing comment passes while padding the author actually wrote still fails the grammar.
  const rawLines = text.split(/\r?\n/);
  const trimMasked = (liveLine, i) => {
    const rawLine = rawLines[i] || "";
    let cut = liveLine.length;
    while (cut > 0 && liveLine[cut - 1] === " " && rawLine[cut - 1] !== " " && rawLine[cut - 1] !== undefined) cut--;
    return liveLine.slice(0, cut);
  };
  const headerLines = (markerIdx >= 0 ? liveLines.slice(0, markerIdx) : liveLines)
    .map((l, i) => trimMasked(l.replace(/\r$/, ""), i));
  const inComment = hasUnclosedComment(text);

  // With no LIVE delimiter there is no mandatory region to exempt, so the WHOLE file is
  // discretionary. Returning 0 here let a 20,000-byte actor file lint clean — and actor files ARE
  // read every owner turn (SKILL.md "Bounded turn read-set"), so "nothing reads it" was false.
  const disc = markerLf >= 0 && markerLf < raw.length ? raw.length - (markerLf + 1)
    : (markerLf < 0 ? raw.length : 0);
  return { raw, text, headerLines, markerLf, inComment, disc };
}

// ---------- board target boundary ----------
// A command's target is part of its applicability. Every identifier that reaches a board path is
// validated as ONE nonempty path component FIRST: an unvalidated `--session` let
// `reset --session ../../victim --force` archive a directory OUTSIDE .collab-board and re-scaffold
// a board in its place, and let every other command read and mutate outside the workspace. This is
// LEXICAL confinement — it stops traversal, it does not establish canonical containment across
// symlinks or junctions, and nothing here should be described as if it did.
// The one grammar for a turn-shard filename, shared by discovery and by every link target.
// ONE grammar for a turn id and one for an actor/contributor token, composed into every name
// built from them. When the writer and the reader each spelled their own version of this, `relay`
// wrote `captures/P1-codex-cli.relay` and `captureFiles` — whose pattern stops at `[A-Za-z0-9_]+`
// — could not see it again, so L25 reported an honest relay as a tampered capture. Two scanners
// give two answers about the same bytes; there is one scanner here.
const TURN_ID_SRC = "[PI][0-9]+";
const TOKEN_SRC = "[A-Za-z0-9_]+";
const TURN_ID = new RegExp("^" + TURN_ID_SRC + "$");
const ACTOR_TOKEN = new RegExp("^" + TOKEN_SRC + "$");
const SHARD_NAME = new RegExp("^" + TURN_ID_SRC + "-" + TOKEN_SRC + "\\.md$");
// Recognising a shard name and TAKING IT APART are the same grammar, so they are built from the
// same two sources. Four call sites each spelled their own `/^([PI]\d+)-(\w+)\.md$/`; a fifth
// spelled the whole name differently again at the discovery site, which is how a name could be
// discovered by one pattern and decomposed by another that disagreed about its parts.
const SHARD_PARTS = new RegExp("^(" + TURN_ID_SRC + ")-(" + TOKEN_SRC + ")\\.md$");
function shardParts(name) {
  const m = SHARD_PARTS.exec(name);
  return m ? { id: m[1], actor: m[2] } : null;
}
const CAPTURE_NAME = new RegExp("^" + TURN_ID_SRC + "-" + TOKEN_SRC + "\\.relay$");
function isSafeComponent(v) {
  return typeof v === "string" && v.length > 0
    && v !== "." && v !== ".."
    && !v.includes("/") && !v.includes("\\") && !v.includes("\0");
}
function requireSafeComponent(v, what) {
  if (!isSafeComponent(v))
    die(`${what} must be a single path component (no "/", "\\\\", "..", "." or NUL): ${JSON.stringify(v)}`);
  return v;
}

// ---------- root / session paths ----------
function collabDir(root) { return path.join(root, ".collab-board"); }
function sessionDir(root, id) {
  requireSafeComponent(id, "session id");
  return path.join(collabDir(root), "sessions", id);
}
// A MISSING sessions directory is not an empty one. Returning [] for both made `--all` over a
// mistyped --root indistinguishable from a clean corpus: zero boards, exit 0, and a two-engine
// diff of nothing against nothing that reads IDENTICAL. That is a guard passing on input it
// could not classify, and it happened during the very review that found it.
//
// The two cases are genuinely different and are answered differently: no `.collab-board/sessions`
// means this is not a board root, which is a usage error worth refusing; the directory present
// and empty means a board root with no boards yet, which is a true answer of zero.
function listSessions(root) {
  const dir = path.join(collabDir(root), "sessions");
  if (!exists(dir)) die(`no board root at ${path.resolve(root)} — ${dir} does not exist. A root with no boards YET has that directory and reports zero; a root that never had one is a mistyped path, and reporting zero for it would make an empty result indistinguishable from a clean corpus`);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.includes(".archived-"))
    .map((e) => e.name).sort();
}

// ---------- index catalog ----------
function upsertIndexRow(root, { id, type, status, phase }) {
  const idx = path.join(collabDir(root), "index.md");
  let text = exists(idx) ? readText(idx) : substitute(readText(path.join(TPL_ROOT, "index.md")), {});
  const row = `| ${id} | ${type} | ${status} | ${phase} | ${todayDate()} | [open](sessions/${id}/HEAD.md) |`;
  // Target selection on the LIVE view, bytes written to the ORIGINAL — the same discipline the
  // HEAD writers use. Matching raw would let a commented-out row absorb the update, leaving the
  // real row stale and the write invisible.
  const lines = text.split(/\r?\n/);
  const liveLines = liveText(text).split(/\r?\n/);
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const cells = (liveLines[i] || "").split("|").map((c) => c.trim());
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
  if (primary === secondary)
    die(`new: PRIMARY and SECONDARY must be distinct actor names (both resolved to ${primary})`);
  let adapter = opts.adapter || defaultAdapter(secondary);
  if (!isValidAdapter(adapter))
    die(`new: invalid --adapter "${adapter}". Use ${adapterChoices()}.`);
  if (ADAPTER_ALIASES[adapter]) adapter = ADAPTER_ALIASES[adapter];   // legacy spelling, normalised at scaffold
  // A CLI executor drives an actor FAMILY, so the secondary must be IN that family (and, via the
  // distinctness check above, differ from the PRIMARY). See references/executors/. Other pairings
  // use manual / subagent:<name>. Routed through the one boundary predicate rather than re-derived
  // here, so this and L18 cannot answer differently about the same board.
  {
    const want = CLI_EXECUTORS[adapter];
    if (want && !adapterMatchesSecondary(adapter, secondary))
      die(`new: --adapter ${adapter} requires SECONDARY=${want} or a ${want}_* family name (a CLI executor dispatches the actor family it names). Use --adapter manual or subagent:<name> for any other secondary.`);
  }
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
  atomicWrite(path.join(dest, "PROTOCOL.md"), readText(PROTOCOL_SRC));
  upsertIndexRow(root, { id, type, status: "IDLE", phase: "PLAN" });

  console.log(`Created session ${id}`);
  console.log(`  ${path.relative(root, dest) || dest}`);
  console.log(`  PRIMARY=${primary}  SECONDARY=${secondary}  adapter=${adapter}`);
  console.log("");
  console.log("Next (PRIMARY):");
  console.log(`  1. Fill Topic/Goal/Done in ${path.join("sessions", id, "SESSION.md")}`);
  console.log(`  2. Open TURN-P1: take your turn, then hand off to ${secondary}.`);
  console.log(`  3. Verify after each turn: node "${process.argv[1]}" lint --session ${id}`);
  // ADVISORY ONLY, printed AFTER the session exists - nothing below can fail the scaffold. This
  // is where the preference for several vendors is actually stated to a user, rather than left
  // in a document they have not read yet. It speaks on EVERY machine: below two visible vendors it
  // says connect another, and at two or more it recommends declaring a roster. The older comment
  // here claimed a multi-vendor machine is never nagged, which the roster branch and its own
  // fixture both refute — and the advice is worth giving in both cases, so the comment was the
  // wrong half.
  const advice = vendorAdvice(detectExecutors(process.env));
  if (advice.length) {
    console.log("");
    console.log("Multi-vendor advisory (does not affect this session):");
    for (const l of advice) console.log(l);
  }
  console.log("");
  for (const l of preferenceNotice()) console.log(l);
}

function cmdAdvance(opts) {
  const id = requireSession(opts);
  const root = opts.root;
  const dir = sessionDir(root, id);
  const head = parseHead(readText(path.join(dir, "HEAD.md")));
  // A MUTATING command must not act on a HEAD lint would reject. `state.length === 2` is satisfied
  // by two valid rows even when a third, invalid actor row is also present — so without the
  // malformedActors check these guards would happily rewrite a State block that lint reports as
  // L1. Reading a malformed board is diagnostic; writing one is corruption.
  requireWritableHead("advance", id, head);
  requireContractIdentity("advance", dir, id, head);
  const errs = [];
  if (head.status !== "ACTIVE") errs.push(`SESSION_STATUS is ${head.status}, expected ACTIVE`);
  if (head.phase !== "PLAN") errs.push(`PHASE is ${head.phase}, expected PLAN`);
  if (head.byRole.PRIMARY.hand !== "START")
    errs.push("PRIMARY must hold START to advance — cross the gate on the PRIMARY's own turn (once both PLAN_AGREE are YES, do not delegate another turn)");
  if (head.gates.PLAN_AGREE_PRIMARY !== "YES" || head.gates.PLAN_AGREE_SECONDARY !== "YES")
    errs.push("both PLAN_AGREE_* must be YES");
  const pointsTxt = readText(path.join(dir, "points.md"));
  const unionRows = loadPoints(dir).union;
  const malformed = malformedPointRows(pointsTxt);
  if (malformed.length) errs.push(`malformed point row(s) ${malformed.join(", ")} — fix points.md table formatting`);
  const open = unionRows.filter((r) => r.id.startsWith("P") && r.status === "OPEN");
  if (open.length) errs.push(`${open.length} OPEN P* point(s) remain: ${open.map((r) => r.id).join(", ")}`);
  // A retired status is not a settlement. Filtering on `OPEN` alone is what let a DEFERRED point
  // satisfy this gate — two corpus boards crossed carrying parked work with lint PASSing. Nothing
  // can WRITE one any more, so this only fires on a legacy board; it fires anyway, because that is
  // exactly the board where the work was quietly left behind.
  const parked = unionRows.filter((r) => r.id.startsWith("P") && RETIRED_STATUSES.includes(r.status));
  if (parked.length)
    errs.push(`${parked.length} P* point(s) carry the retired status ${RETIRED_STATUSES.join("/")}: ${parked.map((r) => r.id).join(", ")} — a board may not cross a phase gate carrying work it parked. Resolve each, mark it OUT_OF_SCOPE only if the board DETERMINED it is not needed (that is a decision, not a way to say unresolved), or carry it to a successor board and open it there.`);
  const ctx = path.join(dir, "plan", "context.md");
  // LIVE, like L4, which enforces the same rule at lint time. Read raw, a commented-out
  // placeholder blocked a gate that the board had legitimately satisfied.
  if (!exists(ctx) || /^STATUS:\s*EMPTY\s*$/m.test(liveText(readText(ctx))))
    errs.push("plan/context.md is still EMPTY — write the frozen plan digest first");
  if (errs.length) die("advance: preconditions not met:\n  - " + errs.join("\n  - "));

  const primary = head.byRole.PRIMARY, secondary = head.byRole.SECONDARY;
  // Every replacement selects its target on the LIVE view: a commented decoy must never absorb the
  // write, and an absent or ambiguous live target must refuse rather than be guessed at.
  let text = head.raw;
  for (const [re, to, what, within] of [
    [/^PHASE:.*$/m, "PHASE: IMPL", "PHASE"],
    [new RegExp("^-\\s*" + primary.name + ":.*$", "m"), "- " + primary.name + ": START - PRIMARY", primary.name + " State row", stateSectionRange],
    [new RegExp("^-\\s*" + secondary.name + ":.*$", "m"), "- " + secondary.name + ": ON_HOLD - SECONDARY", secondary.name + " State row", stateSectionRange],
    [/^NEXT_TURN_ID:.*$/m, "NEXT_TURN_ID: I1", "NEXT_TURN_ID"],
    [/^NEXT_ACTOR:.*$/m, "NEXT_ACTOR: " + primary.name, "NEXT_ACTOR"],
    [/^LAST_UPDATE:.*$/m, "LAST_UPDATE: " + nowIso(), "LAST_UPDATE"],
  ]) {
    const next = replaceLiveLine(text, re, to, within);
    if (next === null) die("advance: HEAD.md has no single live " + what + " declaration to update - run `lint --session " + id + "` first");
    text = next;
  }
  atomicWrite(path.join(dir, "HEAD.md"), text);
  const log = path.join(dir, "log.md");
  appendEvent(log, `${nowIso()} PHASE_SET PLAN->IMPL plan_open_points=0`);
  appendEvent(log, `${nowIso()} STATE_SET ${primary.name}=START ${secondary.name}=ON_HOLD cursor=${head.cursor.TURN_CURSOR} next=I1/${primary.name} seq=${head.cursor.SEQ}`);
  upsertIndexRow(root, { id, type: SESSION.Type(readText(path.join(dir, "SESSION.md"))), status: "ACTIVE", phase: "IMPL" });
  console.log(`Advanced ${id} to IMPL. ${primary.name} (PRIMARY) holds START for TURN-I1.`);
}

function cmdTerminal(opts) {
  const id = requireSession(opts);
  const status = (opts.status || "").toUpperCase();
  if (!TERMINALS.includes(status)) die("terminal: --status must be COMPLETED or ABORTED");
  const root = opts.root;
  const dir = sessionDir(root, id);
  const head = parseHead(readText(path.join(dir, "HEAD.md")));
  // Same rule as `advance`: never mutate a State block lint would reject (see there).
  requireWritableHead("terminal", id, head);
  // A board may not be ended out from under a SECONDARY that is mid-turn. Rule 8 gives terminal
  // status to the PRIMARY and §3 makes START the mutex, but this command checked neither: a board
  // in the frozen corpus was aborted with the SECONDARY at START and lints clean to this day,
  // because nothing looks. `cmdAdvance` has always refused the equivalent — two commands that end
  // a phase, one honouring the mutex and one not, is this file's dominant defect in its own
  // command surface.
  //
  // The predicate is the SECONDARY's HAND, deliberately not `PRIMARY holds START`: an IDLE board
  // carries both hands ON_HOLD and must stay closable, and that shape would refuse the very case
  // it was written to serve. Write-time only — the read-time twin would be a finding on immutable
  // history that no append can clear, which is a dead end rather than a check.
  const secHand = head.byRole.SECONDARY.hand;
  if (secHand === "START" || secHand === "WORKING")
    die(`terminal: ${head.byRole.SECONDARY.name} (SECONDARY) holds ${secHand}, so this turn is not the PRIMARY's to end — §3 makes START the mutex and Rule 8 gives terminal status to the PRIMARY. If the SECONDARY is genuinely stalled, take the seat the way the protocol provides: log STALL_CHECK, then STALL_HANDOFF moving ${head.byRole.SECONDARY.name} to ON_HOLD and ${head.byRole.PRIMARY.name} to START (Rule 5), then run terminal. A KNOWN USAGE LIMIT IS NOT A STALL (§4) — pause at the last confirmed HANDOFF and resume instead.`);
  requireContractIdentity("terminal", dir, id, head);
  // Idempotent re-run: the write order is HEAD -> TERMINAL log line -> catalog row, so a crash
  // leaves two distinct repair windows. A prior SAME-status TERMINAL in the log means only the
  // catalog row can be missing/stale — reconcile HEAD + catalog and append NO second event
  // (L11 would flag activity after TERMINAL; the log stays single-event). A DIFFERENT status is
  // a conflict: refuse before touching anything — and check this BEFORE the completion gate, so
  // a conflicting re-run gets the true diagnostic, not a misleading gate error. No prior
  // TERMINAL = the normal path, which also repairs the post-HEAD/pre-log crash window by
  // completing the missing writes.
  const logFile = path.join(dir, "log.md");
  const prior = exists(logFile) ? parseLog(readText(logFile)).find((e) => e.type === "TERMINAL") : undefined;
  const priorStatus = prior?.rest.split(/\s+/)[0];
  if (prior && priorStatus !== status)
    die(`terminal: session ${id} already logged TERMINAL ${priorStatus} — cannot re-terminal as ${status}`);
  if (status === "COMPLETED" && (head.phase !== "IMPL"
      || head.gates.IMPL_AGREE_PRIMARY !== "YES" || head.gates.IMPL_AGREE_SECONDARY !== "YES"))
    die("terminal COMPLETED requires PHASE=IMPL and both IMPL_AGREE_*=YES (use --status ABORTED to stop early)");
  // COMPLETED asserts the work is DONE, and until now this gate never read points.md at all — so a
  // board could complete carrying OPEN points, including every `I*` raised during IMPL, which
  // `advance` never saw because it checks `P*` at the PLAN gate only. That is the deferral hazard
  // one gate later: the phase gate was taught to refuse parked work, and the gate that says
  // "finished" was left asking about phase and gates and nothing else.
  //
  // What this CAN check is that no point is still open. What it cannot check is whether the work a
  // RESOLVED point describes was actually done — a point marked AGREED with nothing built is
  // indistinguishable from one that shipped, which is why `DECISION` carries direction and status
  // carries delivery, and why that separation is a protocol obligation rather than a check.
  // ABORTED is exempt: stopping early is an honest end, and refusing it would leave a board with
  // open points no legal way to stop.
  if (status === "COMPLETED") {
    const pf = path.join(dir, "points.md");
    const open = exists(pf) ? loadPoints(dir).union.filter((r) => r.status === "OPEN") : [];
    if (open.length)
      die(`terminal COMPLETED refused: ${open.length} point(s) still OPEN (${open.map((r) => r.id).join(", ")}). A completed board may not carry unfinished work — resolve each, mark it OUT_OF_SCOPE only if the board DETERMINED it is not needed (that is a decision, not a way to say unresolved), carry it to a successor board, or stop with --status ABORTED.`);
  }
  // Same live-target discipline as advance. This is the exact path where a column-0 commented
  // SESSION_STATUS decoy absorbed `terminal --status ABORTED` while the live declaration stayed
  // IDLE - the board reported a status it had never actually been given.
  let text = head.raw;
  const edits = [
    [/^SESSION_STATUS:.*$/m, "SESSION_STATUS: " + status, "SESSION_STATUS"],
    [/^LAST_UPDATE:.*$/m, "LAST_UPDATE: " + nowIso(), "LAST_UPDATE"],
  ];
  for (const s of head.state)
    edits.push([new RegExp("^-\\s*" + s.name + ":.*$", "m"), "- " + s.name + ": DONE - " + s.role, s.name + " State row", stateSectionRange]);
  for (const [re, to, what, within] of edits) {
    const next = replaceLiveLine(text, re, to, within);
    if (next === null) die("terminal: HEAD.md has no single live " + what + " declaration to update - run `lint --session " + id + "` first");
    text = next;
  }
  atomicWrite(path.join(dir, "HEAD.md"), text);
  if (!prior)
    appendEvent(logFile,
      `${nowIso()} TERMINAL ${status} by=${head.byRole.PRIMARY.name} seq=${head.cursor.SEQ}`);
  upsertIndexRow(root, { id, type: SESSION.Type(readText(path.join(dir, "SESSION.md"))), status, phase: head.phase });
  console.log(prior
    ? `Session ${id} was already ${status}; reconciled HEAD/catalog (no new TERMINAL event).`
    : `Session ${id} set ${status}. Both hands DONE; no further turns.`);
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
  const type = (SESSION.Type(sess) || "META").toUpperCase();
  // `reset` is a RECOVERY operation, so unlike the mutators above it must stay able to replace a
  // malformed HEAD — that is the situation it exists for. Its CONTRACT carry-forward is a different
  // matter: silently defaulting a missing or duplicated `Roles` would re-scaffold the session with
  // the WRONG ACTORS, turning a recovery into a quiet substitution. Carry forward only a single,
  // whole, well-formed declaration; otherwise refuse and let the caller state the roles explicitly.

  // BOTH actors come from the SAME parse. Taking one from the parse and leaving the other on a
  // looser pattern is how `Roles: PRIMARY = ALPHA, SECONDARY = BETA` carried ALPHA forward and
  // silently replaced BETA with the default — the substitution this guard exists to prevent,
  // reintroduced by applying the fix to only half of it. A MISSING Roles line is refused too: an
  // empty value is not a licence to default, it is a contract that cannot be carried forward.
  const rc = contractRoles(sess);
  if (rc.problem) die(`reset: ${rc.problem} — its actors cannot be carried forward`);
  const roles = `PRIMARY=${rc.primary}, SECONDARY=${rc.secondary}`;
  const primary = sanitizeActor(rc.primary);
  const secondary = sanitizeActor(rc.secondary);
  if (primary === secondary)
    die(`reset: PRIMARY and SECONDARY must be distinct actor names (both resolved to ${primary})`);
  let adapter = SESSION.SecondaryAdapter(sess) || defaultAdapter(secondary);
  if (!isValidAdapter(adapter) || !adapterMatchesSecondary(adapter, secondary)) {
    const fallback = defaultAdapter(secondary);
    console.warn(`reset: stored SecondaryAdapter=${adapter} is invalid for SECONDARY=${secondary}; using ${fallback}`);
    adapter = fallback;
  }
  if (adapter === "codex") adapter = "codex-cli"; // legacy alias, normalized on re-scaffold
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
  atomicWrite(path.join(dir, "PROTOCOL.md"), readText(PROTOCOL_SRC));
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
    const open = loadPoints(dir).union.filter((r) => r.status === "OPEN").length;
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
  // `activate` publishes catalog state DERIVED from HEAD, so it is an ordinary mutator: refusing
  // here is refusing to publish a derived lie. (`status` stays diagnostic — it is read-only.)
  requireWritableHead("activate", id, head);
  requireContractIdentity("activate", dir, id, head);
  const type = (SESSION.Type(readText(path.join(dir, "SESSION.md"))) || "META").toUpperCase();
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
    // Route the reader to the ROW, not to the file. `lint-spec.md` is 38 KB and the argument for
    // letting it grow that large is that `explain` serves one row from a subprocess instead — an
    // argument that only holds if the agent holding a finding knows the command exists. Without
    // this line the only pointer is a References entry read once per thread, and the fallback is
    // reading 38 KB into context to understand one code. Printed only when there is something to
    // explain, so a clean run stays one line.
    if (findings.length)
      console.log(`  (spec + remediation for any code above: \`explain ${findings[0].code}\`)`);
  }
  if (failed) process.exitCode = 1;
}

function lintSession(root, id, { quick }) {
  const dir = sessionDir(root, id);
  const F = [];
  const add = (level, code, msg) => F.push({ level, code, msg });
  if (!exists(path.join(dir, "HEAD.md"))) { add("FAIL", "L0", `session ${id} has no HEAD.md`); return F; }

  // Per-run memoized text reads: several checks visit the same turn/agent files (L1, L6, L8,
  // L12, L13, L14, L19). Lint is read-only and single-pass, so within-run staleness cannot
  // arise. L21 is EXEMPT — it must scan raw bytes (fs.readFileSync, no decode), never this
  // BOM-stripped text cache.
  const readCache = new Map();
  // Every board read goes through here, so this is where absence and wrong-kind are handled once.
  // A missing file reads as empty and a DIRECTORY reads as empty-and-reported: previously either
  // one threw out of whatever check happened to touch it first, ending the run with no findings
  // at all. A crash is strictly worse than a wrong finding — it takes every other invariant down.
  const notAFile = new Set();
  // RAW bytes. Named, because every use of it is a claim that this particular check must see
  // comment characters, and that claim should be visible at the call site and countable from
  // outside. Prefer `cached` unless the check is ABOUT comments or is computing byte offsets.
  const cachedRaw = (p) => {
    let t = readCache.get(p);
    if (t === undefined) {
      if (!exists(p)) t = "";
      else if (!isBoardFile(p)) { notAFile.add(path.relative(dir, p).replace(/\\/g, "/")); t = ""; }
      else t = readText(p);
      readCache.set(p, t);
    }
    return t;
  };
  // THE DEFAULT. A semantic check asks what the board DECLARES, and a declaration inside a comment
  // is not a declaration — in either direction. Before this, seven consumers read raw: a commented
  // `STATUS: EMPTY` and a commented State row produced FALSE findings, while a shard whose only
  // `- Evidence:` line was inside a comment SATISFIED the check that requires one.
  const liveCache = new Map();
  const cached = (p) => {
    let t = liveCache.get(p);
    if (t === undefined) { t = liveText(cachedRaw(p)); liveCache.set(p, t); }
    return t;
  };

  const headText = cached(path.join(dir, "HEAD.md"));
  const head = parseHead(headText);
  const pointsText = cached(path.join(dir, "points.md"));
  const pointsLoad = loadPoints(dir);
  const points = pointsLoad.union;
  const logText = cached(path.join(dir, "log.md"));
  const events = parseLog(logText);
  const rulesetProv = boardRuleset(logText, cachedRaw(path.join(dir, "log.md")));
  // Resolved to the CURRENT ruleset when malformed, so a mistyped token is fully gated rather than
  // inheriting the legacy exemption. The malformed provenance itself is reported below.
  const boardRs = rulesetProv.malformed.length ? CURRENT_RULESET : rulesetProv.ruleset;
  // One helper for every dead-end arm, so the severity decision cannot drift between call sites.
  const addGated = (key, code, msg) => {
    const sev = gatedSeverity(boardRs, key);
    add(sev, code, msg + (sev === "WARN" ? LEGACY_NOTE : ""));
  };
  const sessText = cached(path.join(dir, "SESSION.md"));
  const turnsDir = path.join(dir, "turns");
  // File-kind aware: a DIRECTORY named like a shard previously reached readFileSync and crashed lint
  // with EISDIR, taking every other invariant down with it. Discovery yields regular files only, so a
  // turn-shaped directory surfaces as a missing shard (L14) instead of disabling the checker.
  const turnEntries = isBoardDir(turnsDir) ? fs.readdirSync(turnsDir, { withFileTypes: true }) : [];
  const turnFiles = turnEntries.filter((e) => e.isFile() && SHARD_NAME.test(e.name)).map((e) => e.name);
  const turnShapedDirs = turnEntries.filter((e) => !e.isFile() && SHARD_NAME.test(e.name)).map((e) => e.name);
  // One index from id to shard(s), built where the shards are discovered. Every consumer resolves
  // an id through THIS rather than re-deriving it with a first match, which is how a duplicate
  // shard could satisfy one check and mislead another.
  const shardsById = new Map();
  for (const f of turnFiles) {
    const tid = shardParts(f).id;
    if (!shardsById.has(tid)) shardsById.set(tid, []);
    shardsById.get(tid).push(f);
  }
  const names = head.state.map((s) => s.name);

  // L28 PROTOCOL-SNAPSHOT — each session names the immutable protocol it follows. New sessions
  // carry a local snapshot; legacy sessions may still point at ../../PROTOCOL.md. Validate only
  // identity and existence: comparing an old snapshot with a newer installed source would defeat
  // snapshot isolation. Confine the target to .collab-board so a malformed HEAD cannot turn lint
  // into a filesystem existence oracle outside the board.
  {
    const declared = getKV(headText, "PROTOCOL");
    const contract = SESSION.Protocol(sessText);
    if (!declared) add("FAIL", "L28", "HEAD.md PROTOCOL is missing — every session pins the immutable protocol it follows (§2/§9); HEAD is editable: restore the PROTOCOL: line to the same session-relative path SESSION.md's Protocol: declares (new boards: PROTOCOL.md; legacy: ../../PROTOCOL.md)");
    else {
      const boardRoot = path.resolve(collabDir(root));
      const target = path.resolve(dir, declared);
      const rel = path.relative(boardRoot, target);
      const confined = rel !== "" && !rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel);
      if (!confined)
        add("FAIL", "L28", `HEAD.md PROTOCOL escapes .collab-board: ${JSON.stringify(declared)}`);
      else if (!isBoardFile(target))
        add("FAIL", "L28", `declared protocol target is missing or not a file: ${declared}`);
      if (contract !== declared)
        add("FAIL", "L28", `SESSION.md Protocol=${contract || "(missing)"} differs from HEAD.md PROTOCOL=${declared}`);
    }
  }

  // L29 CLOSED-GRAMMAR — a structured file may declare only the keys its grammar defines. HEAD.md
  // has had this since its own inversion; SESSION.md did not, so `BoardWritMode: PRIMARY_ONLY` read
  // as PROSE: sole-writer mode and L25 stayed off while the file said otherwise, and lint's output
  // was byte-identical either way. A file that is only checked for the keys it HAS cannot report
  // the key it MEANT. Keys are read through the shared live view, so a key named in a comment or a
  // fenced example is not a declaration.
  for (const g of CLOSED_GRAMMARS) {
    const p = path.join(dir, g.file);
    if (!isBoardFile(p)) continue;          // absent files are other checks' business (L0, L6)
    for (const prob of grammarProblems(cached(p), g))
      add("FAIL", "L29", `${g.file.split(path.sep).join("/")}: ${prob}`);
  }

  // L1 SPLIT-STATE — match only true State-section assignments (`- <ACTOR>: <HAND> - <ROLE>`),
  // so legitimate prose/notes bullets that mention a hand token are not false-flagged.
  // Distinctness is CASE-INSENSITIVE. Actor names key case-insensitive artifacts — `agents/<actor>.md`
  // is derived by lowercasing — so `CODEX` and `codex` are two names for one actor, not two actors.
  // Treating them as distinct let a board declare a case-colliding pair whose two expected actor
  // files collapse onto one, so the other actor's file could vanish with no finding anywhere.
  if (names.length === 2 && names[0].toLowerCase() !== names[1].toLowerCase()) {
    const re = new RegExp(`^-\\s*(${names.join("|")}):\\s*(${HANDS.join("|")})\\s*-\\s*(PRIMARY|SECONDARY)\\s*$`, "m");
    const scan = (p) => { if (exists(p) && re.test(cached(p))) add("FAIL", "L1", `hand-token outside HEAD.md in ${path.relative(dir, p)} — HEAD.md ## State is the ONE authoritative home for hand-state (Rule 1) and a State-shaped row elsewhere is a second truth; reword or remove that row (an actor's own mirror belongs in agents/<actor>.md under its schema's keys, and prose may mention a hand token freely — only the exact "- <ACTOR>: <HAND> - <ROLE>" row form matches)`); };
    scan(path.join(dir, "points.md")); scan(path.join(dir, "log.md")); scan(path.join(dir, "SESSION.md"));
    // HEAD.md too, OUTSIDE its State section. A State-shaped line under another heading is not a
    // row to parseHead but was a second match to the writers, which then refused every mutation
    // while lint - the very thing their error message tells the operator to run - reported PASS.
    {
      const live = liveText(headText);
      const range = stateSectionRange(live);
      const outside = range ? live.slice(0, range[0]) + live.slice(range[1]) : live;
      if (re.test(outside))
        add("FAIL", "L1", `hand-token outside the ## State section in HEAD.md — parseHead does not read it as a row, but advance and terminal refuse to write while it is there; delete or reword the stray row (Rule 1: the ## State section is the one place hand-state is declared)`);
    }
    scan(path.join(dir, "plan", "context.md")); scan(path.join(dir, "impl", "code_state.md"));
    for (const f of turnFiles) scan(path.join(turnsDir, f));
    // Regular files only — a directory here previously reached readFileSync and crashed lint.
    for (const a of (isBoardDir(path.join(dir, "agents"))
      ? fs.readdirSync(path.join(dir, "agents"), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
      : []))
      scan(path.join(dir, "agents", a));
  } else add("FAIL", "L1", names.length !== 2
    ? `HEAD.md ## State must list exactly 2 actors (found ${names.length})`
    : `HEAD.md ## State lists the same actor twice (${names.join(", ")}) — PRIMARY and SECONDARY must be distinct, case-insensitively`);

  // L1 (identity) — HEAD's actor names and roles must match SESSION.md `Roles`. HEAD is the
  // authority for hand STATE, never for WHO the actors are: the contract names them, and SESSION.md
  // is write-once. Without this, an ON_HOLD actor could be renamed in HEAD (and its agent file
  // renamed to match) and pass every other check, because log replay simply never mentions the old
  // name and leaves the substitute at its default ON_HOLD. Any check that derives a file set from
  // `head.state` — L24 does — is only as sound as this reconciliation.
  {
    const bad = headKeyProblems(headText);
    if (bad.length)
      add("FAIL", "L1", `HEAD.md key problems — ${bad.join("; ")}. Each authoritative key must appear exactly once; only the first declaration is ever read`);
  }
  // Every structured board file, not only the one where this was first noticed.
  {
    const agentsDir0 = path.join(dir, "agents");
    const structured = BOARD_FILES.map((n) => [n, path.join(dir, n)]);
    if (isBoardDir(agentsDir0))
      for (const e of fs.readdirSync(agentsDir0, { withFileTypes: true }))
        if (e.isFile() && e.name.toLowerCase().endsWith(".md"))
          structured.push([`agents/${e.name}`, path.join(agentsDir0, e.name)]);
    for (const f of turnFiles) structured.push([`turns/${f}`, path.join(turnsDir, f)]);
    for (const [name, f] of structured) {
      if (!exists(f) || !isBoardFile(f)) continue;
      const rawText = cachedRaw(f);
      if (hasUnclosedComment(rawText))
        add("FAIL", "L0", `${name} has an unclosed <!-- comment — it masks to end of file, so it hides nothing today and swallows whatever is written next (an event appended after one vanished from every replay). Append the missing "-->" — legal even in the append-only log — so nothing further is swallowed; what the open span already covers stays commented, and in the log a swallowed event is re-recorded by a fresh append after the closer, never by editing earlier lines`);
      // The scope is the finding's justification rather than caution. The harm is a declaration
      // that goes MISSING IN SILENCE, so the scope is exactly the files where absence is READ AS
      // A VALUE rather than reported:
      //   log.md          — a hidden event is never replayed, and nothing counts events.
      //   SESSION.md      — `convergeThresholds` reads absence as the defaults, so hiding a
      //                     declared `Converge:` silently loosens the board's own limits.
      //   plan/context.md — the gate rejects a LIVE `STATUS: EMPTY`, so hiding the sentinel walks
      //                     an empty plan through PLAN->IMPL.
      // HEAD, points.md, impl/code_state.md and the turn shards are OUT, because there a vanished
      // declaration is reported by its own consumer under a diagnostic that says what was lost —
      // L1/L2 for HEAD keys, L2/L4 for point rows, L6 for code state, L13 for shard lines.
      //
      // Both bounds were established the hard way. Board-wide, this check FAILED a legitimate turn:
      // the SECONDARY's own shard quotes this exploit in prose, and quoting board syntax is normal
      // in a review turn. Log-only then MISSED the two silent losses above, which the SECONDARY
      // demonstrated when asked to attack the narrower scope. Neither bound was reasoned to; each
      // came from an input someone constructed.
      if (NESTED_OPENER_SCOPE.has(name)) {
        const nested = nestedCommentOpeners(rawText);
        if (nested.length) {
          const line = rawText.slice(0, nested[0]).split(/\r?\n/).length;
          // Gated only for the log, whose bytes are append-only. SESSION.md and plan/context.md are
          // editable, so their finding always has a remedy and always gates.
          const msg = `${name} line ${line} opens a <!-- comment inside an open comment — comments do not nest, so the first --> ends the span and the rest re-enters live text; a declaration behind the inner opener is read by nobody, and in this file absence is read as a value rather than reported. In an editable file, delete or reword the inner "<!--" so the span closes where it appears to; in the append-only log no in-place remedy exists — a swallowed declaration is re-recorded by a fresh append after the span closes`;
          if (name === "log.md") addGated("L0_NESTED_COMMENT", "L0", msg);
          else add("FAIL", "L0", msg);
        }
      }
    }
  }
  // A second LIVE declaration of an authoritative key is a second truth. advance and terminal have
  // always refused such a HEAD; lint said nothing about it, so the board could sit in that state
  // indefinitely and only reveal it when someone tried to move the turn on.
  for (const problem of headKeyProblems(head.raw))
    add("FAIL", "L1", `HEAD.md ${problem} — each authoritative key must be declared exactly once`);
  for (const d2 of ["turns", "agents", "plan", "impl"])
    if (exists(path.join(dir, d2)) && !isBoardDir(path.join(dir, d2)))
      add("FAIL", "L0", `${d2}/ exists but is not a directory — reading it used to end the run with ENOTDIR and report nothing at all`);
  for (const name of notAFile)
    add("FAIL", "L0", `${name} exists but is not a regular file — a directory cannot be a board artifact, and reading one used to end the run with EISDIR and report nothing at all`);
  if (head.stateSectionCount !== 1)
    add("FAIL", "L1", `HEAD.md declares ${head.stateSectionCount} live "## State" sections — exactly one is required (two sections are two truths)`);
  for (const bad of head.malformedActors)
    add("FAIL", "L1", `HEAD.md ## State has an invalid actor name ${JSON.stringify(bad)} — actor names must match [A-Za-z0-9_]+ (§10: machine tokens)`);
  let rolesParsed = null;   // L1 parses Roles ONCE; L18 reuses that verdict (E5)
  {
    // The WHOLE `Roles` value is parsed as exactly `PRIMARY=<actor>, SECONDARY=<actor>`, not
    // scavenged for fragments. A tolerant scan only ever ADDS a comparison, so anything it fails to
    // parse — absent, partial, duplicated, or with trailing junk — silently skipped the
    // reconciliation. That is the same absence-versus-malformed escape the SCHEMA line had three
    // times: a check that degrades to "no opinion" on malformed input is not fail-closed.
    // The field must occur EXACTLY ONCE. `getKV` returns the first match, so a second, conflicting
    // `Roles:` line would be silently ignored — leaving the contract carrying two contradictory
    // declarations while every check quietly agreed with whichever came first. Parsing one value
    // whole is not enough if the file may hold more than one value.
    // Counted on LIVE text, like every other cardinality count. Counting raw here while `getKV`
    // read live text was an internal contradiction: a live declaration beside a commented one was
    // read correctly and then reported as two declarations.
    const rc = contractRoles(sessText);
    if (rc.problem) add("FAIL", "L1", rc.problem);
    else {
      rolesParsed = [null, rc.primary, rc.secondary];
      const want = { PRIMARY: rc.primary, SECONDARY: rc.secondary };
      for (const role of ["PRIMARY", "SECONDARY"]) {
        const actor = head.byRole[role];
        if (!actor)
          add("FAIL", "L1", `HEAD.md ## State declares no ${role} — SESSION.md Roles names ${role}=${want[role]}`);
        else if (want[role].toLowerCase() !== actor.name.toLowerCase())
          add("FAIL", "L1", `HEAD.md names ${role}=${actor.name} but SESSION.md Roles declares ${role}=${want[role]} — the contract names the actors, HEAD only tracks their hands`);
      }
    }
  }

  // L2 PROJECTION
  if (!quick && names.length === 2) {
    const proj = projectLog(events, names);
    for (const s of head.state)
      if (proj.hands[s.name] && proj.hands[s.name] !== s.hand)
        add("FAIL", "L2", `HEAD hand ${s.name}=${s.hand} but log projects ${proj.hands[s.name]}`);
    if (proj.phase !== head.phase) add("FAIL", "L2", `HEAD PHASE=${head.phase} but log projects ${proj.phase}`);
    if (proj.seq !== head.cursor.SEQ) add("FAIL", "L2", `HEAD SEQ=${head.cursor.SEQ} but log projects ${proj.seq}`);
    if (proj.status !== head.status) add("FAIL", "L2", `HEAD SESSION_STATUS=${head.status} but log projects ${proj.status}`);
    for (const g of ["PLAN_AGREE_PRIMARY", "PLAN_AGREE_SECONDARY", "IMPL_AGREE_PRIMARY", "IMPL_AGREE_SECONDARY"])
      if (proj.gates[g] !== head.gates[g]) add("FAIL", "L2", `HEAD ${g}=${head.gates[g]} but log projects ${proj.gates[g]}`);
    // Point state is projected too, so the projection ENFORCES the derivation rather than merely
    // making it available. A points.md row edited to disagree with its own POINT_SET history is the
    // same class of divergence as a HEAD gate disagreeing with its GATE_SET.
    {
      // The UNION of projected and tabled ids, and the WHOLE row. Iterating only projected rows
      // let a table-only row pass, and comparing only status let a stale or wrong Resolved In pass,
      // while the projector advertised existence + status + Resolved In.
      const projPts = projectPoints(events);
      const proj = new Map(projPts.map((r) => [r.id, r]));
      const rows = new Map(points.map((r) => [r.id, r]));
      // A Resolved In cell is either `-` or a Markdown link, and BOTH halves are checked: the
      // label names the resolving turn and the destination must be that turn's own shard.
      const RESOLVED_LINK = /^\[([PI][0-9]+)\]\(([^)]*)\)$/;
      const linkId = (v) => {
        const m = RESOLVED_LINK.exec((v || "").trim());
        return m ? m[1] : ((v || "").trim() || null);
      };
      for (const id of [...new Set([...proj.keys(), ...rows.keys()])].sort()) {
        const pr = proj.get(id), row = rows.get(id);
        if (!row) { add("FAIL", "L2", `log projects point ${id} but points.md has no such row`); continue; }
        if (!pr) { add("FAIL", "L2", `points.md has row ${id} but the log projects no such point`); continue; }
        if (row.status !== pr.status)
          add("FAIL", "L2", `points.md ${id}=${row.status} but log projects ${pr.status}`);
        const raw = (row.resolved || "").trim();
        const have = linkId(row.resolved), want = pr.resolvedIn;
        if ((want || null) !== (have === "-" ? null : have)) {
          // Two different mismatches used to share one sentence, and the shared one named no
          // remedy: an UNRESOLVED row whose cell is anything but a bare hyphen reported
          // `Resolved In=<cell> but log projects -`, where the trailing `-` meant "no resolving
          // turn" and read as the literal cell value the writer should have used. A scaffolded
          // board carries no example row — it cannot, since the engine and its suite match this
          // file's bytes — so the diagnostic is the only place the placeholder is ever stated.
          if (!want)
            add("FAIL", "L2", `points.md ${id} Resolved In=${raw || "(empty)"} but the log resolves ${id} in no turn - an unresolved row carries a bare ASCII hyphen`);
          else
            add("FAIL", "L2", `points.md ${id} Resolved In=${have || "-"} but log projects ${want}`);
        } else if (want) {
          // The label agreed. Now the DESTINATION, which nothing had been reading: it must be the
          // resolving turn's own shard, and that shard must exist.
          const lm = RESOLVED_LINK.exec(raw);
          if (!lm)
            add("FAIL", "L2", `points.md ${id} Resolved In=${JSON.stringify(raw)} is not a "[<turn-id>](turns/<shard>.md)" link — a resolved point must point at the turn that resolved it`);
          else {
            const dest = lm[2];
            const name = dest.startsWith("turns/") ? dest.slice("turns/".length) : null;
            // The UNIQUE shard for that id (L14 fails a duplicate), not a first match.
            const forWant = shardsById.get(want) || [];
            const actual = forWant.length === 1 ? forWant[0] : null;
            if (name === null || !SHARD_NAME.test(name) || !name.startsWith(want + "-"))
              add("FAIL", "L2", `points.md ${id} Resolved In links to ${JSON.stringify(dest)} but the log says ${want} resolved it — the label and the destination name different turns`);
            else if (actual && name !== actual)
              add("FAIL", "L2", `points.md ${id} Resolved In links to ${JSON.stringify(dest)} but ${want}'s shard is turns/${actual} — the link does not dereference`);
            // A resolving turn with no shard at all is L14's finding, not a second one here.
          }
        }
      }
    }
  }

  // L3 DUAL-START / NEXT_ACTOR
  for (const s of head.state) if (!HANDS.includes(s.hand)) add("FAIL", "L3", `invalid hand token ${s.name}=${s.hand} — the legal vocabulary is ${HANDS.join("|")} (§3, a machine token per §10); HEAD is editable state: set the actor's true hand, reconciling against log replay (L2's derivation) rather than guessing`);
  const active = head.state.filter((s) => s.hand === "START" || s.hand === "WORKING");
  if (head.status === "ACTIVE") {
    if (active.length !== 1) add("FAIL", "L3", `exactly one actor must hold START/WORKING while ACTIVE (found ${active.length})`);
    else if (head.cursor.NEXT_ACTOR !== active[0].name)
      add("FAIL", "L3", `NEXT_ACTOR=${head.cursor.NEXT_ACTOR} but ${active[0].name} holds ${active[0].hand}`);
  } else if (head.status === "IDLE" && active.length) add("WARN", "L3", `IDLE session has an active hand (${active.map((s)=>s.name).join(",")})`);

  // L27 POINTS-SIZE — points.md is in every turn's read-set and was the only file there with no
  // ceiling at all: `agents/` got the L24 ladder, and the point tracker kept only an unenforced
  // "keep it lean" comment. WARN-ONLY, deliberately. L24 can FAIL because it has a remedy — move
  // settled prose out and leave an `id@pointer`. Point ROWS have no such destination: they are the
  // tracker, and a check whose remedy does not exist would only block a long session. So this
  // reports and never gates. The threshold sits above the largest real board on record (5,049 B,
  // a 43-turn session) so a legitimately long tracker is not nagged, and matches L24's 8,192 B so
  // there is one number to remember rather than two.
  {
    const pb = Buffer.byteLength(pointsText, "utf8");
    if (pb > POINTS_WARN_AT)
      add("WARN", "L27", `points.md is ${pb} B (> ${POINTS_WARN_AT} B) and every turn reads it — run \`archive --session ${id}\` to move rows settled for ${ARCHIVE_AFTER_TURNS}+ turns out of the read-set, and for what stays, move prose out of a long title into the shard and leave an id@pointer`);
  }

  // L4 PLAN-GATE + PLAN_OPEN_POINTS mirror
  for (const bad of malformedPointRows(pointsText))
    add("FAIL", "L4", `points.md row ${bad} is malformed (fix the table — an unparseable OPEN point must not be read as resolved)`);

  // ARCHIVE OWNERSHIP. Splitting the tracker in two creates exactly two new ways to lie, and
  // both are checked here rather than trusted: a row in BOTH files (which of them is the board's
  // answer?) and an OPEN row in the archive (work that no turn will read again while it is still
  // unfinished). Every decision reads the union, so an id that appears twice makes the union
  // ambiguous at exactly the moment a gate consults it.
  for (const dupId of new Set(pointsLoad.duplicates))
    add("FAIL", "L4", `point ${dupId} has a row in BOTH points.md and points-archive.md — every decision reads the two together, so a duplicated id makes the union ambiguous; keep exactly one row and delete the other`);
  for (const r of pointsLoad.archive)
    if (r.status === "OPEN")
      add("FAIL", "L4", `points-archive.md carries ${r.id} as OPEN — the archive is for settled work, and unfinished work must stay in points.md where every turn reads it`);  const openP = points.filter((r) => r.id.startsWith("P") && r.status === "OPEN").length;
  if (head.gates.PLAN_OPEN_POINTS !== openP)
    add("FAIL", "L4", `PLAN_OPEN_POINTS=${head.gates.PLAN_OPEN_POINTS} but points.md has ${openP} OPEN P*`);
  if (head.phase === "IMPL") {
    if (openP) add("FAIL", "L4", `PHASE=IMPL with ${openP} OPEN P* point(s)`);
    if (head.gates.PLAN_AGREE_PRIMARY !== "YES" || head.gates.PLAN_AGREE_SECONDARY !== "YES")
      add("FAIL", "L4", `PHASE=IMPL but PLAN_AGREE not both YES`);
    const ctx = path.join(dir, "plan", "context.md");
    if (!exists(ctx) || /^STATUS:\s*EMPTY\s*$/m.test(cached(ctx)))
      add("FAIL", "L4", `PHASE=IMPL but plan/context.md is empty/missing`);
  }

  // A PHASE_SET that is not the one form §8 defines is a FAIL rather than a silent no-op: the
  // projector now ignores it, so without this the board would only show up as an L2 divergence
  // with no indication of which line caused it.
  for (const e of events) {
    if (e.type !== "PHASE_SET") continue;
    const pm = PHASE_SET_FORM.exec(e.rest);
    if (!pm)
      add("FAIL", "L2", `log.md PHASE_SET ${JSON.stringify(e.rest)} is not the documented "PLAN->IMPL plan_open_points=<n>" form — the projector does not apply it`);
    else if (pm[1] !== "0")
      add("FAIL", "L2", `log.md PHASE_SET declares plan_open_points=${pm[1]} — the PLAN->IMPL gate requires zero OPEN P* points, so any other count records a transition that was not permitted`);
  }

  // A POINT_SET that resolves a point must say WHERE. Without `in=` the projector recorded a
  // terminal status with no resolving turn, and L2 then accepted a table row whose Resolved In was
  // blank — so the whole-row reconciliation could be stepped around by omitting one field.
  // The set of turn ids the board actually has. A reference to a turn that was never committed
  // and has no shard names nothing — the same defect class as a link target that does not exist,
  // and it is what let `in=P999` stand as a resolving turn.
  const knownTurnIds = new Set([
    ...events.filter((e) => e.type === "TURN_COMMIT").map((e) => e.rest.split(/\s+/)[0]),
    ...turnFiles.map((f) => f.split("-")[0]),
  ].filter((x) => /^[PI][0-9]+$/.test(x)));
  for (const e of events) {
    if (e.type !== "POINT_SET") continue;
    // FULL LINE. Extracting the pairs it recognised and ignoring the rest let trailing text ride
    // along unchecked, while the prose claimed payloads are grammar.
    const m = POINT_SET_FORM.exec(e.rest);
    if (!m) {
      add("FAIL", "L2", `log.md POINT_SET ${JSON.stringify(e.rest)} is not the documented "<id>=<STATUS> [...] [in=<turn-id>]" form — the projector reads only what the form defines`);
      continue;
    }
    const pairs = m[1].split(" ").map((tok) => tok.split("="));
    // Two assignments to one id in a single event state two things about the same point, and the
    // projector resolved them left-to-right — so which one took effect was an accident of order.
    const dup = pairs.map(([id]) => id).find((id, i, all) => all.indexOf(id) !== i);
    if (dup) {
      add("FAIL", "L2", `log.md POINT_SET ${JSON.stringify(e.rest)} assigns ${dup} twice in one event — a point has one status per event`);
      continue;
    }
    const resolvesAny = pairs.some(([, st]) => st !== "OPEN");
    if (resolvesAny && !m[2])
      add("FAIL", "L2", `log.md POINT_SET ${JSON.stringify(e.rest)} resolves a point but carries no in=<turn-id> — a resolved point must name the turn that resolved it`);
    else if (m[2] && !knownTurnIds.has(m[2]))
      add("FAIL", "L2", `log.md POINT_SET in=${m[2]} names a turn that has no TURN_COMMIT and no shard — a resolving turn must exist`);
  }

  // L5 IMPL-BEFORE-GATE — the spec has always said "any I* turn shard OR TURN_COMMIT", but the
  // check read shard FILENAMES only, so IMPL work committed before the gate passed L5 whenever its
  // shard was absent. Narrowing the sentence would have been the cheaper fix and the wrong one:
  // the sentence describes the invariant that matters.
  const implShard = turnFiles.find((f) => f.startsWith("I"));
  const implCommit = events.find((e) => e.type === "TURN_COMMIT" && /^I\d+\b/.test(e.rest));
  if ((implShard || implCommit) && !events.some((e) => e.type === "PHASE_SET"))
    add("FAIL", "L5", `IMPL turn exists (${implShard ? `turns/${implShard}` : `TURN_COMMIT ${implCommit.rest.split(/\s+/)[0]}`}) but no PHASE_SET in log — the PLAN->IMPL crossing is recorded as a PHASE_SET event (Rule 3/§4). The log is append-only: never insert or backdate a line. If the gate genuinely held (zero OPEN P* points, both PLAN_AGREE_* YES), append the PHASE_SET now — a late record at the current instant is legal and the out-of-order history stays visible, which is the honest state; if the gate did not hold, the impl work jumped it and the gate must be satisfied first`);

  // point statuses sanity
  for (const r of points) {
    if (POINT_STATUSES.includes(r.status)) continue;
    // A retired status gets its OWN diagnostic. "invalid status DEFERRED" would read as a typo and
    // send a reader looking for a formatting mistake, when the finding is that this board parked
    // work it needed — which is the one thing a board may not do.
    if (RETIRED_STATUSES.includes(r.status))
      add("FAIL", "L4", `point ${r.id} is ${r.status}, and a board may not leave real work undone — there is no deferral status. Resolve it here, mark it OUT_OF_SCOPE only if the board DETERMINED it is not needed (that is a decision, not a way to say unresolved), or carry it to a successor board and open it there.`);
    else add("FAIL", "L4", `point ${r.id} has invalid status ${r.status}`);
  }

  // L6 IMPL-AUTHORITY — Rule 7: the SECONDARY OMITS `Impl:` entirely and the PRIMARY ECHOES all
  // three code_state values. Both halves were under-enforced: an all-NONE SECONDARY line passed
  // because only "real" values were rejected, and the PRIMARY shard was never compared against
  // code_state.md at all, so two real-but-contradictory records could coexist. Cardinality is part
  // of it — zero or two `Impl:` lines, or a duplicated code-state key, is not "one echo".
  const roleOf = (seg) => head.state.find((s) => s.name.toLowerCase() === String(seg).toLowerCase())?.role;
  for (const f of turnFiles) {
    const seg = shardParts(f);
    if (seg && !roleOf(seg.actor))
      add("FAIL", "L6", `${f} names actor ${JSON.stringify(seg.actor)}, which HEAD.md declares no role for — every role-conditional check silently does not apply to such a shard`);
  }
  const primaryImpl = [];
  for (const f of turnFiles.filter((x) => x.startsWith("I"))) {
    const actorLc = shardParts(f).actor;
    const role = roleOf(actorLc);
    const implLines = liveText(cached(path.join(turnsDir, f))).split(/\r?\n/)
      .filter((l) => /^-\s*Impl:/.test(l));
    if (role === "SECONDARY" && implLines.length)
      add("FAIL", "L6", `secondary impl turn ${f} carries an Impl: line — a SECONDARY IMPL turn is review-only and omits it entirely (Rule 7)`);
    if (role === "PRIMARY") primaryImpl.push([f, implLines]);
  }
  if (primaryImpl.length) {
    // `—`/`-` are the "not set yet" placeholders and are rejected; the literal `NONE` is VALID,
    // meaning "no git / intentionally not tracked" (a non-git repo, or before the first commit).
    const csPath = path.join(dir, "impl", "code_state.md");
    const cs = exists(csPath) ? cached(csPath) : "";
    const KEYS = CODE_STATE_GRAMMAR.core;
    const unset = (v) => !v || v === "—" || v === "-";
    const csDup = duplicateKeys(cs, KEYS);
    if (csDup.length)
      add("FAIL", "L6", `impl/code_state.md declares ${csDup.join(", ")} more than once — exactly one live declaration each, or the echo compares against a value nobody reads`);
    for (const k of KEYS)
      if (unset(CODE_STATE[k](cs)))
        add("FAIL", "L6", `impl/code_state.md ${k} unset (use a real value, or NONE for no-git) but PRIMARY impl turns exist`);
    // Only the LATEST PRIMARY impl shard is compared against code_state.md. That file is a moving
    // SINGLETON which every IMPL turn updates, so an earlier shard legitimately records the commit
    // that was current at ITS turn - comparing all of them manufactures a finding for every turn
    // but the last. Cardinality and placeholder checks still apply to EVERY primary shard.
    const turnNo = (f) => Number((f.match(/^I(\d+)-/) || [])[1] || 0);
    const latest = primaryImpl.reduce((a2, b2) => (turnNo(b2[0]) > turnNo(a2[0]) ? b2 : a2))[0];
    for (const [f, implLines] of primaryImpl) {
      if (implLines.length !== 1) {
        add("FAIL", "L6", `PRIMARY impl turn ${f} has ${implLines.length} Impl: lines — exactly one is required (Rule 7)`);
        continue;
      }
      for (const k of KEYS) {
        const m = implLines[0].match(new RegExp(k + "=(\\S+)"));
        if (!m || unset(m[1])) {
          add("FAIL", "L6", `PRIMARY impl turn ${f} Impl: line has no real ${k} (use a real value, or NONE for no-git)`);
          continue;
        }
        const want = CODE_STATE[k](cs);
        if (f === latest && want && !unset(want) && m[1] !== want)
          add("FAIL", "L6", `PRIMARY impl turn ${f} Impl: ${k}=${m[1]} but impl/code_state.md says ${want} — the shard ECHOES code_state (Rule 7), it does not disagree with it`);
      }
    }
  }

  // L7 CONTRACT
  if (turnFiles.some((f) => /^P1-/.test(f))) {
    // Read through the grammar-derived table, not `getKV` — a name added to this list that the
    // grammar does not define throws here instead of silently returning null. The literal-name ban
    // could not see this loop at all: its key is a variable.
    for (const k of ["Topic", "Goal", "Done"]) {
      const v = SESSION[k](sessText);
      if (!v || v === "—") add("FAIL", "L7", `SESSION.md ${k} still "—" but TURN-P1 exists (Rule 2)`);
    }
  }

  // L18 CLI-EXECUTOR — a CLI executor adapter must match the SECONDARY actor (the PRIMARY is
  // distinct by scaffold-time enforcement). `codex` is the legacy alias of `codex-cli`, kept
  // valid on existing boards so no migration is forced.
  {
    const adapterVal = SESSION.SecondaryAdapter(sessText);
    // ONE parse, one verdict. L1 already parsed and validated this value; re-deriving it here with
    // a looser pattern meant spaces around "=" could false-FAIL a board L1 had accepted.
    const pan = secondaryPanel(sessText, head.byRole.PRIMARY && head.byRole.PRIMARY.name);
    if (pan.problem) add("FAIL", "L18", `SESSION.md ${pan.problem}`);
    // With a panel, the SECONDARY actor is the panel's name and no single executor owns it, so the
    // pairing rule below does not apply — what applies instead is that a panel turn must be
    // relayed and must cite every contributor (L25).
    const wantSecondary = pan.panel ? null : CLI_EXECUTORS[adapterVal];
    if (pan.panel && boardWriteMode(sessText).mode !== "PRIMARY_ONLY")
      add("FAIL", "L18", `SESSION.md declares a SecondaryPanel but not BoardWriteMode: PRIMARY_ONLY — several executors cannot each write the same turn, so a panel board must be sole-writer`);
    if (!isValidAdapter(adapterVal))
      add("FAIL", "L18", `SecondaryAdapter=${adapterVal || "(missing)"} is invalid (expected ${adapterChoices()})`);
    else if (wantSecondary && rolesParsed && !adapterMatchesSecondary(adapterVal, rolesParsed[2]))
      add("FAIL", "L18", `SecondaryAdapter=${adapterVal} requires SECONDARY=${wantSecondary} or a ${wantSecondary}_* family name (a CLI executor drives the actor family it names)`);
  }

  // L8 ACK (first secondary turn body mentions ACK)
  const secName = head.byRole.SECONDARY?.name?.toLowerCase();
  if (secName) {
    const secTurns = turnFiles.filter((f) => f.endsWith(`-${secName}.md`))
      .sort((a, b) => turnRank(a) - turnRank(b));
    if (secTurns.length && !/\bACK\b/.test(cached(path.join(turnsDir, secTurns[0]))))
      add("WARN", "L8", `${secTurns[0]}: secondary's first turn should ACK the contract`);
  }

  // L9 STALL
  if (head.status === "ACTIVE" && head.stall.LAST_UPDATE) {
    const mins = (new Date() - new Date(head.stall.LAST_UPDATE)) / 60000;
    const check = parseMinutes(SESSION.Stall(sessText), "CHECK", 15);
    const handoff = parseMinutes(SESSION.Stall(sessText), "HANDOFF", 10);
    // Advisory only: a long quiet gap may be a real stall OR just a paused-but-healthy board.
    // Never a hard FAIL (it would block an otherwise-clean turn after a lunch/overnight gap).
    if (mins > check + handoff && !events.some((e) => e.type === "STALL_HANDOFF"))
      add("WARN", "L9", `no update for ${Math.round(mins)}m (> CHECK+HANDOFF ${check + handoff}m) — if the owed actor is truly silent, log STALL_HANDOFF and force the handoff (Rule 5)`);
    else if (mins > check && head.stall.STALL_STATE === "OK")
      add("WARN", "L9", `no update for ${Math.round(mins)}m (> CHECK ${check}m) — consider logging STALL_CHECK`);
  }

  // L10 DEADLOCK
  for (const r of points.filter((p) => p.status === "OPEN")) {
    const refs = events.filter((e) => e.type === "TURN_COMMIT" && pointsIds(e.rest).includes(r.id)).length;
    if (refs > 3 && !events.some((e) => e.type === "DECISION" && e.rest.split(/\s+/)[0] === r.id))
      add("FAIL", "L10", `point ${r.id} OPEN after ${refs} turns with no DECISION (Rule 6)`);
  }

  // L11 TERMINAL
  if (TERMINALS.includes(head.status)) {
    if (head.state.some((s) => s.hand !== "DONE")) add("FAIL", "L11", `terminal session but a hand is not DONE — Rule 8: COMPLETED/ABORTED ends with both hands DONE. HEAD.md is the editable side: set both ## State rows to DONE (the TERMINAL log line already records that the session ended; never delete it to match a stale hand)`);
    const termIdx = events.findIndex((e) => e.type === "TERMINAL");
    if (termIdx >= 0 && events.slice(termIdx + 1).some((e) => e.type === "TURN_COMMIT" || e.type === "HANDOFF"))
      addGated("L11_AFTER_TERMINAL", "L11", `turns logged after TERMINAL — Rule 8: a terminal session takes no more turns. No in-place remedy exists: the log is append-only and these events are committed history, so the record stands as written; work that must continue belongs on a successor board`);
    if (head.status === "COMPLETED" && (head.phase !== "IMPL"
        || head.gates.IMPL_AGREE_PRIMARY !== "YES" || head.gates.IMPL_AGREE_SECONDARY !== "YES"))
      add("FAIL", "L11", `SESSION_STATUS=COMPLETED but not (PHASE=IMPL and both IMPL_AGREE_*=YES) — completion gate skipped (Rule 8/10). Reconcile HEAD against the log: if the log has no TERMINAL event, HEAD's status is the wrong side — set it back to what replay projects; if TERMINAL is real and the gates were never set, the completion was unearned and stands only as history — continuing work belongs on a successor board`);
    // The read-time twin of the refusal in `cmdTerminal`. A write-time check alone only constrains
    // the command; a board hand-edited to COMPLETED, or completed before this check existed, still
    // reads as finished to every later session. This is the pattern the rest of this file follows —
    // refuse at write time, report at read time — and its absence is how two corpus boards carried
    // parked work through a gate for weeks with lint saying PASS.
    const openAtEnd = points.filter((r) => r.status === "OPEN");
    if (head.status === "COMPLETED" && openAtEnd.length)
      add("FAIL", "L11", `SESSION_STATUS=COMPLETED but ${openAtEnd.length} point(s) are still OPEN (${openAtEnd.map((r) => r.id).join(", ")}) — a completed board may not carry unfinished work. If a point was in fact settled, fix its row to the status its resolving turn shows; otherwise carry it to a successor board and open it there — a terminal board takes no more turns`);
  }

  // L12 ESCALATION — a USER_QUESTION in a turn body should have a matching log line.
  const uqLog = events.filter((e) => e.type === "USER_QUESTION").length;
  const uqBody = turnFiles.filter((f) => /USER_QUESTION:/.test(cached(path.join(turnsDir, f)))).length;
  if (uqBody > uqLog) add("WARN", "L12", `${uqBody} USER_QUESTION: in turns but ${uqLog} USER_QUESTION log line(s) — Rule 9 records an escalation twice, in the turn body and as a "<ts> USER_QUESTION by=<ACTOR> in=<turn-id>" log event; append the missing event(s) now (a late append at the current instant is legal in the append-only log), never edit earlier lines`);

  // L13 TURN-SCHEMA (the Impl line is required only for PRIMARY impl turns; secondary review turns omit it)
  for (const f of turnFiles) {
    const t = cached(path.join(turnsDir, f));
    for (const need of ["### TURN-", "- Header:", "- Body:", "- Evidence:", "- Handoff:", "PREV:", "NEXT:"])
      if (!t.includes(need)) add("FAIL", "L13", `${f} missing "${need.trim()}"`);
    if (f.startsWith("I")) {
      const actorLc = f.match(/^I\d+-(\w+)\.md$/)[1];
      if (roleOf(actorLc) === "PRIMARY" && !/^-\s*Impl:/m.test(t))
        add("FAIL", "L13", `${f} (PRIMARY IMPL) missing "- Impl:" line`);
    }
  }

  // L30 TAIL LEGIBILITY. ONE arm for every way a TURN_COMMIT line carries something its readers
  // cannot classify, because they are one defect: bytes the writer wrote and every reader drops.
  // The conditions are the code below and the lint-spec L30 row; deliberately no count in prose,
  // since a comment that says how many there are is a second copy of the arm's shape.
  //
  // The discriminator is BARENESS, not id shape. §8 makes every TURN_COMMIT token after the
  // positional turn id `key=value`, so a token with no `=` is one no reader can classify — and an
  // id-shape regex was tried first and MISSED the motivating case, because `points=P1,P2 P3,P4`
  // strands `P3,P4`, which is not id-shaped. Measured before shipping: 0 bare tail tokens and 0
  // malformed items in 611 committed TURN_COMMITs across every live board and both corpus roots.
  //
  // WARN, never FAIL, and therefore NOT in RULESET_GATED: that table governs FAIL severity, and a
  // finding here names committed log bytes no legal append can rewrite. The remedy is forward-only,
  // so the diagnostic says so rather than implying a repair that does not exist.
  for (const e of events.filter((x) => x.type === "TURN_COMMIT")) {
    const toks = e.rest.trim().split(/\s+/);
    const tid = toks[0];
    // The positional id is EXEMPT from the bare-token scan below, so it has to be classified
    // here or the exemption is silent trust. It is also a fail-open in its own right: L14's
    // shard check `continue`s on a first token failing this same test, so a TURN_COMMIT with an
    // illegible id is the one commit nothing verifies a shard for. Reported here rather than as
    // a new rule, because this loop is already the place that decides whether a TURN_COMMIT line
    // can be read at all; L14 keeps owning shard existence for the lines that can.
    if (!/^[PI][0-9]+$/.test(tid))
      add("WARN", "L30", `TURN_COMMIT first token ${JSON.stringify(tid)} is not a turn id of the form P<n> or I<n> — every id-to-shard lookup tests that shape first, so L14 skips this line entirely and NOTHING checks that the turn it claims to commit has a shard. The log is append-only, so this line has no in-place remedy: commit the turn again under a legible id, and leave this one as history`);
    const bare = toks.slice(1).filter((t) => t && !t.includes("="));
    if (bare.length)
      add("WARN", "L30", `TURN_COMMIT ${tid} tail carries ${bare.length} token(s) with no "=": ${bare.map((t) => JSON.stringify(t)).join(", ")} — after the turn id §8's tail is entirely key=value, so a bare token is one no reader classifies and every reader drops. The usual cause is a space inside points= (points=P1 P2, or points=P1,P2 P3,P4), which strands the ids after the space: they are absent from L10 reference counting and Rule 11 exposure, though point STATUS is unaffected because it projects from POINT_SET. The log is append-only and this line has no in-place remedy; name the stranded ids in the points= token of a LATER turn, and leave this line as history`);
    const pm = /\bpoints=(\S+)/.exec(e.rest);
    if (pm && pm[1] !== "-") {
      const badItems = pm[1].split(",").filter((x) => !/^[PI][0-9]+$/.test(x));
      if (badItems.length)
        add("WARN", "L30", `TURN_COMMIT ${tid} points=${pm[1]} carries ${badItems.length} item(s) that are not a point id: ${badItems.map((t) => JSON.stringify(t)).join(", ")} — the token is a comma-separated list of P/I ids, and pointsIds skips what it cannot parse, so those entries reach no reader. Same append-only limit as above: restate the intended ids on a LATER turn rather than editing this line`);
    }
  }

  // L14 CHAIN/ORPHAN
  const committed = new Set(events.filter((e) => e.type === "TURN_COMMIT").map((e) => e.rest.split(/\s+/)[0]));
  for (const f of turnFiles) {
    const tid = shardParts(f).id;
    if (!committed.has(tid)) add("FAIL", "L14", `orphan shard ${f}: no TURN_COMMIT in log (crash mid-turn?) — the HANDOFF line is a turn's commit point (§3), so this turn never committed; either complete the missing writes (append its TURN_COMMIT and HANDOFF) or delete the orphan shard and re-delegate the turn — reconcile per recovery.md before retrying`);
  }
  // ONE root. `PREV: NEW` declares "no predecessor", so a second one declares a second beginning
  // and the chain has no order at all — every PREV/NEXT target still resolves, so L14's link checks
  // pass and nothing notices. A relay that let a contributor supply its own PREV produced exactly
  // this, and the scoped-prompt template hands the secondary the literal string `PREV: NEW` to
  // fill in, so it is the likely accident rather than an exotic one.
  {
    const roots = turnFiles.filter((f) => /^PREV:\s*NEW\s*$/m.test(cached(path.join(turnsDir, f))));
    if (roots.length > 1)
      add("FAIL", "L14", `${roots.length} shards declare "PREV: NEW" (${roots.join(", ")}) — a chain has one root, and a second one leaves the turns with no derivable order even though every link still resolves`);
  }
  // ONE shard per turn id, and its filename actor is the actor that committed the turn. Without
  // both halves, resolving an id to a shard is a first-match accident rather than a lookup.
  for (const [tid, fs2] of shardsById)
    if (fs2.length > 1)
      add("FAIL", "L14", `turn ${tid} has ${fs2.length} shards (${fs2.join(", ")}) — a turn id names one turn by one actor, and every id-to-shard lookup would otherwise take whichever came first`);
  for (const e of events) {
    if (e.type !== "TURN_COMMIT") continue;
    const toks = e.rest.split(/\s+/);
    const tid = toks[0];
    if (!/^[PI]\d+$/.test(tid)) continue;
    const have = shardsById.get(tid) || [];
    if (!have.length) { add("FAIL", "L14", `TURN_COMMIT ${tid} has no shard file`); continue; }
    const am = e.rest.match(/\bactor=([A-Za-z0-9_]+)/);
    if (!am || have.length !== 1) continue;   // multi-shard already reported above
    const want = `${tid}-${am[1].toLowerCase()}.md`;
    if (have[0].toLowerCase() !== want.toLowerCase())
      add("FAIL", "L14", `TURN_COMMIT ${tid} says actor=${am[1]} but its shard is turns/${have[0]} — the shard's actor must be the actor that committed the turn`);
  }
  if (head.cursor.RESPONDS_TO && head.cursor.RESPONDS_TO !== "-") {
    // Declared grammar: literal "turns/" plus ONE filename component. Validated BEFORE the join, so
    // a traversal cannot steer the scoped turn read outside the session.
    const rtRaw = head.cursor.RESPONDS_TO;
    const rtName = rtRaw.startsWith("turns/") ? rtRaw.slice("turns/".length) : null;
    // A bad RESPONDS_TO is one finding, not a reason to abandon the rest of the board - the early
    // return here suppressed every later check on a session with one malformed cursor.
    if (rtName === null || !isSafeComponent(rtName) || !SHARD_NAME.test(rtName)) {
      add("FAIL", "L14", `HEAD.RESPONDS_TO is not "turns/<shard>.md": ${JSON.stringify(rtRaw)}`);
    } else if (!exists(path.join(turnsDir, rtName))) {
      add("FAIL", "L14", `HEAD.RESPONDS_TO target missing: ${head.cursor.RESPONDS_TO}`);
    }
  }
  // PREV and NEXT are both validated and resolved by the single loop below.
  // symmetric with the PREV check: a shard's NEXT link (a real link, not the literal "pending") must
  // also resolve — backstop for a write-order regression (predecessor NEXT flipped before the
  // successor shard exists) or a hand-edit that points NEXT at a missing file.
  // A board-stored path is a target, and a target is part of applicability. These were joined and
  // dereferenced raw, so an EXISTING file outside the board satisfied the sibling-chain invariant —
  // `turns/../../../../outside.md` resolved to <root>/outside.md and produced zero findings. The
  // declared grammar is one filename component; anything else FAILs and the candidate is not touched.
  for (const f of turnFiles) {
    const shard = cached(path.join(turnsDir, f));
    for (const key of ["PREV", "NEXT"]) {
      const m = shard.match(new RegExp(`^${key}:\\s*\\[[^\\]]*\\]\\(([^)]+)\\)`, "m"));
      if (!m) continue;
      // The declared grammar is a SIBLING SHARD FILENAME, narrower than 'a safe path component' -
      // the diagnostic already claimed that while the check accepted any filename.
      if (!isSafeComponent(m[1]) || !SHARD_NAME.test(m[1])) {
        add("FAIL", "L14", `${f} ${key} target is not a sibling shard filename: ${JSON.stringify(m[1])}`);
        continue;
      }
      if (!exists(path.join(turnsDir, m[1])))
        add("FAIL", "L14", `${f} ${key} target missing: ${m[1]}`);
    }
  }

  for (const d of turnShapedDirs)
    add("FAIL", "L14", `turns/${d} is a directory, not a turn shard — a turn-shaped directory cannot satisfy the chain`);

  // L15 MIRROR-DRIFT — skip actors at START or DONE; their mirrors are legitimately stale. A START
  // holder set SELF_HAND=ON_HOLD ending its previous turn and has not acted yet, so its mirror would
  // WARN after every clean handoff. A DONE actor was flipped to DONE by `terminal` (an engine action,
  // not a turn, so the mirror can't have updated) and a terminated session takes no more turns, so the
  // drift is moot. L3 (DUAL-START) guarantees at most one START holder, so a genuinely stale mirror on
  // an ON_HOLD/WORKING actor is still caught.
  //
  // RETIRED FOR agent/v3 ONLY, not deleted. v3 has no `SELF_HAND`, so there is no mirror to drift
  // and the check is meaningless there. But provenance deliberately leaves frozen v1 and v2 boards
  // on their own schema, and those files still carry the mirror — deleting the check outright would
  // stop reporting real drift on every board that never migrates. L24 does not cover this: it
  // proves key SHAPE and value grammar, never semantic disagreement with HEAD.
  {
    const schemaNow = boardAgentSchema(events, head.byRole.PRIMARY && head.byRole.PRIMARY.name).schema;
    if (!AGENT_SCHEMA_TABLE[schemaNow] || AGENT_SCHEMA_TABLE[schemaNow].keys === null
        || AGENT_SCHEMA_TABLE[schemaNow].keys.includes("SELF_HAND")) {
      for (const s of head.state) {
        if (s.hand === "START" || s.hand === "DONE") continue;
        const af = path.join(dir, "agents", `${s.name.toLowerCase()}.md`);
        if (exists(af)) {
          const agentText = cached(af);
          const sh = getKV(agentText, "SELF_HAND");
          if (sh && sh !== s.hand) add("WARN", "L15", `agents/${s.name.toLowerCase()}.md SELF_HAND=${sh} ≠ HEAD ${s.hand} — HEAD.md ## State is authoritative and the mirror is the actor's convenience (Rule 1); update SELF_HAND to ${s.hand}, never HEAD to match the mirror`);
        }
      }
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
      const ev = cached(path.join(turnsDir, f)).match(/^-\s*Evidence:\s*(.*)$/m);
      if (ev && /^N\/A$/i.test(ev[1].trim()))
        add("WARN", "L19", `${f} resolves a point but Evidence: N/A — cite file:line / command output / doc, or state why none applies`);
    }
  }

  // L20 GATE-AUTHORSHIP — each gate is set by its OWN actor (Rule 10). A GATE_SET whose by=<ACTOR>
  // disagrees with the gate's role suffix is a forged sign-off (one actor flipping the other's
  // agreement gate) — the rubber-stamp vector §4 guards against. `\bby=` matches only the standalone
  // author token; the leading `_` in justified_by=/relayed_by= blocks the word boundary.
  if (head.byRole.PRIMARY && head.byRole.SECONDARY) {
    for (const e of events) {
      if (e.type !== "GATE_SET") continue;
      const g = e.rest.match(/^(\w*?_(PRIMARY|SECONDARY))=YES/);
      const by = e.rest.match(/\bby=(\w+)/);
      // projectLog APPLIES any recognised GATE_SET, so a gate with no author was still projected
      // while this check had no opinion on it - a gate set by nobody passed. Authorship is now
      // REQUIRED, not merely checked when present.
      if (g && !by) {
        // Dead end on an existing board: the event is already written and the log is append-only,
        // so a later attributed GATE_SET does not suppress this one. Gated by ruleset provenance.
        addGated("L20_GATE_AUTHOR", "L20", "GATE_SET " + g[1] + " carries no by=<ACTOR> - a gate must be set by its own actor (Rule 10)");
        continue;
      }
      if (g && by) {
        const expected = head.byRole[g[2]]?.name;
        if (expected && by[1] !== expected)
          addGated("L20_GATE_FORGED", "L20", `GATE_SET ${g[1]} by=${by[1]} but ${g[2]} is ${expected} (Rule 10: each gate set by its own actor)`);
      }
    }
  }

  // L20 GATE-PROVENANCE — the OPTIONAL `verified=self|reported` token records whether the actor
  // setting the gate RAN the check it cites or relied on the other actor's report. The distinction
  // is not cosmetic: a gate backed by the reviewer executing the command is worth more than one
  // taken on the author's word, and until this token existed the log could not tell them apart, so
  // a reader months later had to assume the weaker reading for every gate.
  //
  // Lint checks GRAMMAR, LINKAGE and the PRESENCE of evidence. It cannot check truth, and pretending
  // otherwise would be the failure this token exists to expose. What it can refuse is a
  // `verified=self` that cites no turn, cites a turn that does not exist, or cites one whose
  // Evidence field is empty or literally N/A — a self-verification claim with nothing under it.
  //
  // Absence means "no applicable executable check", NOT "unverified". Requiring the token on every
  // gate would put a compliance word on turns where nothing is runnable, which is how an attestation
  // becomes a formality.
  {
    for (const e of events) {
      if (e.type !== "GATE_SET") continue;
      const gate = gateSetName(e.rest);
      if (!gate) continue;                       // unrecognised gate: L22 and the arms above own it
      // THE WHOLE TAIL, not the first token that matches. `\bverified=(\S*)` read
      // `verified=self verified=banana` as `self` and never looked at the second, which is the
      // defect this file exists to keep out: a payload field validated by first match while §8
      // calls the grammar closed. The tail is now enumerated — every token after the author must
      // be one this grammar defines, and no key may repeat.
      //
      // Scoped to lines whose FIRST tail token is a well-formed `by=`. A gate with no author is
      // already reported by L20_GATE_AUTHOR on committed history no append can repair; reporting
      // the same line twice would add a finding to boards that can act on neither.
      const toks = e.rest.trim().split(/\s+/).slice(1);
      if (!toks.length || !/^by=[A-Za-z0-9_]+$/.test(toks[0])) continue;
      const seenKeys = new Set();
      for (const tok of toks.slice(1)) {
        const key = tok.split("=")[0];
        // Deduplicate on the SEMANTIC key, not the literal one. `in=` and `justified_by=` are two
        // spellings of one field, so a literal-key set let `in=P1 justified_by=P2` through and the
        // lookup below silently took whichever came first — the same two-values/first-reader
        // ambiguity this whole-tail read exists to close, reintroduced by the alias that made the
        // read possible. Whether an alias is one field or two is a question with one answer, and
        // it is answered in one place.
        const canon = JUSTIFIER_KEYS.includes(key) ? JUSTIFIER_KEYS[0] : key;
        if (seenKeys.has(canon)) {
          addGated("L20_GATE_VERIFIED", "L20", canon === JUSTIFIER_KEYS[0]
            ? `${gate} names the justifying turn twice (${toks.filter((t) => JUSTIFIER_KEYS.includes(t.split("=")[0])).join(" ")}) - ${JUSTIFIER_KEYS.join(" and ")} are one field, so two of them leave two readers disagreeing about which turn counts`
            : `${gate} repeats ${key}= - the GATE_SET tail is a closed grammar and a repeated key leaves two readers disagreeing about which one counts`);
          continue;
        }
        seenKeys.add(canon);
        if (JUSTIFIER_KEYS.includes(key)) {
          if (!JUSTIFIER.test(tok))
            addGated("L20_GATE_VERIFIED", "L20", `${gate} ${tok} does not name a turn id`);
          continue;
        }
        if (key !== "verified") {
          addGated("L20_GATE_VERIFIED", "L20", `${gate} carries unknown token ${tok} - the GATE_SET tail admits only justified_by=<turn-id> and verified=self|reported`);
          continue;
        }
        const val = tok.slice("verified=".length);
        if (val !== "self" && val !== "reported") {
          addGated("L20_GATE_VERIFIED", "L20", `${gate} verified=${JSON.stringify(val)} is not \`self\` or \`reported\` - self means this actor ran the cited command, reported means it relied on another actor's result`);
          continue;
        }
        const jb = toks.find((t) => JUSTIFIER.test(t));
        if (!jb) {
          addGated("L20_GATE_VERIFIED", "L20", `${gate} carries verified=${val} but names no turn - a verification claim has to name the turn that records what was run`);
          continue;
        }
        const id = jb.slice(jb.indexOf("=") + 1);
        const f = turnFiles.find((x) => x.startsWith(id + "-"));
        if (!f) {
          addGated("L20_GATE_VERIFIED", "L20", `${gate} verified=${val} justified_by=${id} but no turn shard ${id}-*.md exists`);
          continue;
        }
        const ev = cached(path.join(turnsDir, f)).match(/^-\s*Evidence:\s*(.*)$/m);
        const text = ev ? ev[1].trim() : "";
        if (!text || /^N\/A$/i.test(text))
          addGated("L20_GATE_VERIFIED", "L20", `${gate} verified=${val} cites ${f}, whose Evidence is ${text ? "N/A" : "absent"} - record the command and its outcome, or drop the token`);
      }
    }
  }

  // L21 ENCODING — a model turn or an external editor can re-save a board file as UTF-8-with-BOM
  // and/or cp1252 double-encoded; readText's utf8 decode hides both, so it would pass lint silently.
  // Byte-scan (do NOT text-decode). WARN-only: never block a turn on a recoverable hygiene issue, and
  // the mojibake sentinel keeps a small residual FP risk on legitimate accented prose.
  {
    const encTargets = BOARD_FILES.map((n) => path.join(dir, ...n.split("/")));
    if (isBoardDir(path.join(dir, "agents")))
      for (const a of fs.readdirSync(path.join(dir, "agents"), { withFileTypes: true })
        .filter((e) => e.isFile()).map((e) => e.name)) encTargets.push(path.join(dir, "agents", a));
    for (const f of turnFiles) encTargets.push(path.join(turnsDir, f));
    for (const p of encTargets) {
      // KIND, not mere existence. Guarding a read with `exists` is what let a directory named
      // points.md reach readFileSync and end the whole run with EISDIR — the third call site to
      // make that exact mistake, which is why the predicate is now shared rather than re-derived.
      if (!isBoardFile(p)) continue;
      const buf = fs.readFileSync(p); // raw bytes — do not decode
      const rel = path.relative(dir, p).replace(/\\/g, "/");
      if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
        add("WARN", "L21", `${rel} starts with a UTF-8 BOM (EF BB BF) — re-save as clean UTF-8, no BOM`);
      for (let i = 0; i < buf.length - 2; i++) {
        // cp1252 double-encoding run: Â/â (0xC3 0x82 / 0xC3 0xA2) followed by another high byte (e.g.
        // â€ = C3 A2 E2). Requiring the trailing high byte avoids flagging a real é (C3 A9) or âge.
        if (buf[i] === 0xc3 && (buf[i + 1] === 0x82 || buf[i + 1] === 0xa2) && buf[i + 2] >= 0x80) {
          add("WARN", "L21", `${rel} has a cp1252 double-encoding mojibake run near byte ${i} — re-encode as clean UTF-8`);
          break;
        }
      }
    }
  }

  // L22 MERGED-LOG-LINE — an append that lacked a trailing-newline guarantee merges the new
  // event onto the previous line; parseLog still matches (the first event's type wins), so the appended
  // event is invisible to every replay. No §8 event carries a bare ISO-8601 timestamp as a field value,
  // so 2+ timestamps on one raw line means two events merged. Narrow by design — header/comment lines
  // carry no timestamp, so this never false-positives within the closed log grammar.
  {
    const tsRe = /\d{4}-\d\d-\d\dT[\d:]+(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?/g;
    // The LIVE view. Reading raw here made a comment that merely MENTIONS two timestamps
    // ("comparison window: <a> through <b>") report as two merged events — a false finding
    // introduced by the same change that closed the raw-line hole, and the first regression this
    // review found. A merge inside a comment is reported by the commented-event check instead.
    logText.split(/\r?\n/).forEach((line, i) => {          // logText is already the live view
      const hits = line.match(tsRe) || [];
      if (hits.length > 1)
        addGated("L22_MERGED_LINE", "L22", `log.md line ${i + 1} embeds ${hits.length} timestamps — two events merged onto one line (a prior append lacked a trailing newline)`);
    });
  }

  // L22 CLOSED-VOCABULARY — an event whose type is not in §8 is not "extra information", it is an
  // event no rule replays. Every line that BEGINS with a timestamp is judged, not only the ones
  // that parse: a line one character off the grammar was previously not an event to any check.
  for (const m of rulesetProv.malformed)
    add("FAIL", "L22", `log.md ${m} — ruleset provenance decides which dead-end rules gate this board, so an unreadable one must not be read as "legacy" and exempted`);
  for (const { line, no, event } of logLines(logText)) {
    // Both arms are dead ends once written: an append-only log cannot drop the line, indenting it
    // keeps it selected, and commenting it out is itself a finding. Gated by ruleset provenance so
    // a board written under the open grammar is told, not blocked.
    if (!event)
      addGated("L22_CLOSED_VOCAB", "L22", `log.md line ${no} starts with a timestamp but is not an event line — no projector reads it: ${JSON.stringify(line.slice(0, 120))}`);
    else if (!LOG_EVENTS.has(event.type))
      addGated("L22_CLOSED_VOCAB", "L22", `log.md line ${no} has event type ${JSON.stringify(event.type)}, which PROTOCOL §8 does not define — no projector replays it, so the state it claims to record is invisible: ${JSON.stringify(line.slice(0, 120))}`);
  }
  // An event inside a comment is not an event — but it is not nothing either. Every projector used
  // to replay it, so a commented-out TERMINAL ended a live session's projected state. Masking it
  // without saying so would merely move the surprise, so the ambiguity is reported.
  //
  // Scanning the RAW line with `LOG_TS` was the obvious form and it was anchored, so it saw only
  // the comment style that leaves the timestamp at column 0 — a BLOCK comment. Wrapping the same
  // line inline (`<!-- <ts> EVENT ... -->`) moved the timestamp behind the marker and hid the event
  // from this check AND from the closed-vocabulary loop above, leaving L2 projection as the only
  // witness, and only for the events L2 replays. `SCHEMA_SET`, `DECISION`, `USER_QUESTION` and
  // `REFRAME` are not among them, so a `SCHEMA_SET` could be hidden to make a v2 board read as
  // exempt legacy v1. The escape came from outside the check's grammar, as they do here.
  //
  // The boundary is the COMMENT SPAN, not the raw line: take each span's payload, drop the
  // delimiters, and apply the SAME anchored `LOG_TS` at each payload line's logical start. That
  // keeps the selector identical to the live path, so a line reads as an event here exactly when it
  // would read as one if uncommented — which is the question being asked. Anchoring is what
  // separates a RECORD from a QUOTATION: `<!-- Example: <ts> GATE_SET ... -->` does not begin with
  // a timestamp and is correctly ignored, while a search for a timestamp anywhere in the line would
  // report every doc comment that quotes the grammar.
  {
    const logRaw = cachedRaw(path.join(dir, "log.md"));
    const lineOf = (off) => {
      let n = 1;
      for (let k = 0; k < off && k < logRaw.length; k++) if (logRaw[k] === "\n") n++;
      return n;
    };
    for (const [a, b] of commentSpans(logRaw)) {
      const payload = logRaw.slice(a, b).replace(/^<!--/, "    ").replace(/-->$/, "   ");
      payload.split(/\r?\n/).forEach((line, i) => {
        if (!LOG_TS.test(line)) return;
        // SELECTION is the anchored `LOG_TS` on the line as it stands; the trim is only so the
        // diagnostic can NAME the type. `LOG_LINE` is anchored with no leading slack, and the
        // delimiters were blanked in place to keep offsets, so an untrimmed line would parse as
        // nothing and report every hidden event under the same generic wording.
        const m = LOG_LINE.exec(line.trim());
        const what = m && LOG_EVENTS.has(m[2])
          ? `a ${m[2]} event`
          : "an event line";
        addGated("L22_COMMENTED_EVENT", "L22", `log.md line ${lineOf(a) + i} is ${what} inside a comment — the log is append-only and an event is either recorded or absent, never commented out: ${JSON.stringify(line.trim().slice(0, 120))}`);
      });
    }
  }

  // L23 LOG-TIMESTAMP-ORDER — DISPATCH_UTC gives a shell-free secondary a deterministic base,
  // and every later event must keep that causal order. Equal timestamps remain valid for legacy
  // boards. A decrease can also expose STALL_CHECK racing a late-landing dispatched turn; that is
  // a near-double-writer condition worth failing explicitly, not a false positive to suppress.
  for (let i = 1; i < events.length; i++) {
    const prev = Date.parse(events[i - 1].ts);
    const curr = Date.parse(events[i].ts);
    if (Number.isFinite(prev) && Number.isFinite(curr) && curr < prev) {
      addGated("L23_TIMESTAMP", "L23", `log timestamp decreases at ${events[i].type} ${events[i].ts} after ${events[i - 1].type} ${events[i - 1].ts} (possible stall/late-turn overlap or fabricated time)`);
      break;
    }
  }
  // An unparseable or calendar-impossible timestamp ordered nothing and reported nothing: every
  // comparison against NaN is false, so the ordering check silently passed over it.
  for (const e of events)
    if (!isRealTimestamp(e.ts))
      addGated("L23_TIMESTAMP", "L23", `log timestamp ${JSON.stringify(e.ts)} (${e.type}) is not a real RFC3339 instant — it cannot be ordered, so every ordering check silently passes over it`);
  const futureLimit = Date.now() + 60_000; // tolerate small host-clock jitter, not invented minutes
  const futureEvent = events.find((e) => Date.parse(e.ts) > futureLimit);
  if (futureEvent)
    add("FAIL", "L23", `log timestamp ${futureEvent.ts} (${futureEvent.type}) is more than 60s in the future — event times come from the live clock or the PRIMARY-supplied DISPATCH_UTC base (§8), never estimation. The log is append-only, so the line itself has no in-place remedy: if the host clock is wrong, fix the clock; otherwise the finding clears by itself once real time passes the written instant, and the invented instant stays visible as history`);
  if (Date.parse(head.stall.LAST_UPDATE) > futureLimit)
    add("FAIL", "L23", `HEAD.LAST_UPDATE=${head.stall.LAST_UPDATE} is more than 60s in the future — §8: never estimate wall-clock time. HEAD is editable state: rewrite LAST_UPDATE from the live clock (any legitimate later write corrects it as a side effect)`);

  // L24 ACTOR-NOTES — bound an actor file's DISCRETIONARY region and, for `agent/v2`, enforce a
  // CLOSED mandatory grammar. Motivation is measured, not hypothetical: one actor file on record
  // reached 44,336 B while every other file on record stayed at or under 8,934 B, and an actor
  // file is re-read on every turn its owner takes. Two deliberate design choices:
  //   * MANDATORY BYTES ARE EXCLUDED from the size count. An actor mid-recovery must never be
  //     pushed to drop the very fields that make recovery possible in order to clear a lint.
  //   * The grammar is CLOSED (unknown keys FAIL) and UNRESOLVED_CONCERNS holds ids and pointers
  //     ONLY. An open-ended field would let arbitrary prose be relabelled into the exempt region,
  //     which is exactly the escape this check exists to shut.
  // Thresholds: 8,192 B is CHOSEN (early warning); 16,384 B is DERIVED as 2x that target and sits
  // above every recorded file except the known runaway outlier. Legacy `agent/v1` gets the size
  // ladder but never a retroactive grammar failure — existing boards stay readable, and migration
  // to v2 is explicit, never implicit.
  {

  const WARN_AT = 8192, FAIL_AT = 16384;

    // The FILE SET is part of the check, not a preamble to it. Enumerating whatever `*.md` happens
    // to be present leaves two escapes: renaming or deleting an actor file skips its grammar and
    // size ladder with no finding at all, and a stray `.md` gets judged as an actor file it is not.
    // Reconcile against the actors HEAD declares instead, so the set is derived rather than
    // discovered. Directories and other entries are not actor files.
    const boardSchema = boardAgentSchema(events, head.byRole.PRIMARY && head.byRole.PRIMARY.name);
    for (const m of boardSchema.malformed)
      add("FAIL", "L24", `log.md agent-schema provenance is malformed: ${m} — the board's schema must be unambiguous before any actor grammar can be selected`);
    const agentsDir = path.join(dir, "agents");
    const expectedAgents = head.state.map((s) => `${s.name.toLowerCase()}.md`);
    const presentAgents = isBoardDir(agentsDir)
      ? fs.readdirSync(agentsDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
      : [];
    for (const want of expectedAgents)
      if (!presentAgents.some((n) => n.toLowerCase() === want))
        add("FAIL", "L24", `agents/${want} is missing — every actor in HEAD.md ## State must have an actor file`);
    for (const n of presentAgents)
      if (!expectedAgents.includes(n.toLowerCase()))
        add("FAIL", "L24", `agents/${n} is not an actor file for any actor in HEAD.md — agents/ holds one actor file per actor and nothing else`);
    // Directories too. Skipping non-files kept them from crashing the read, but it also kept them
    // from being reported at all, so agents/ could accumulate litter no check ever mentioned.
    if (isBoardDir(agentsDir))
      for (const e of fs.readdirSync(agentsDir, { withFileTypes: true }))
        if (!e.isFile())
          add("FAIL", "L24", `agents/${e.name} is not a regular file — agents/ holds one actor file per actor and nothing else`);
    const agentFiles = presentAgents.filter((n) => expectedAgents.includes(n.toLowerCase())).sort();
    for (const f of agentFiles) {
      // RAW bytes, like L21 — never the BOM-stripped text cache. CRLF and multibyte cost is real
      // cost, and a check that measures decoded length would under-report both.
      const { raw, text, headerLines, markerLf, inComment, disc } = actorRegions(path.join(agentsDir, f));
      const rel = `agents/${f}`;

      // The schema is resolved ONLY from that masked header, never from the whole file. Scanning
      // the whole file is wrong in both directions: a legacy v1 file whose notes happen to quote
      // the v2 schema line would be forced through v2 grammar and fail, and — worse — declaring any
      // other version would make a whole-file v2 match false and SILENTLY opt the file out of the
      // closed grammar. Every way of leaving the version unresolvable is such an escape, so a
      // PRESENT-but-invalid declaration FAILs and so does an ambiguous one. Only a WHOLLY ABSENT
      // declaration stays tolerated, for pre-schema files — and "absent" means no schema-SHAPED
      // line at all, not merely no well-formed one: `SCHEMA : x` is invalid presence, not absence,
      // or the malformed spelling becomes the escape.
      // "Shaped like a declaration" is decided by the SCHEMA token alone, independent of
      // punctuation: requiring a colon let `SCHEMA=...` and `SCHEMA ...` count as ZERO declarations
      // and take the legacy-absence path, so the punctuation itself became the escape. The strict
      // form permits no trailing padding either, or the "exact spelling" diagnostic would be a
      // claim the regex does not make.
      const SCHEMA_STRICT = /^SCHEMA: (\S(?:.*\S)?)$/;
      const schemaLines = headerLines.filter((l) => SCHEMA_SHAPED.test(l));
      const strict = schemaLines.length === 1 ? SCHEMA_STRICT.exec(schemaLines[0]) : null;
      const schemaVal = strict ? strict[1] : null;
      if (schemaLines.length > 1)
        add("FAIL", "L24", `${rel} header carries ${schemaLines.length} SCHEMA: lines — exactly one is required to resolve the agent schema`);
      else if (schemaLines.length === 1 && !strict)
        add("FAIL", "L24", `${rel} has a malformed SCHEMA declaration ${JSON.stringify(schemaLines[0])} — it must read exactly "SCHEMA: <value>" at column 0`);
      // A FOURTH place had spelled the version set out. The declared value is checked against the
      // schema table, so a version exists everywhere or nowhere — spelling it here again is how a
      // new schema passes provenance, passes its key grammar, and is then rejected for existing.
      else if (schemaVal !== null && !AGENT_SCHEMAS.includes((/^collab-board\/agent\/(\S+)$/.exec(schemaVal) || [])[1]))
        add("FAIL", "L24", `${rel} declares SCHEMA ${JSON.stringify(schemaVal)} — an actor file must declare one of ${AGENT_SCHEMAS.map((v) => "collab-board/agent/" + v).join(", ")}`);

      // An unclosed comment that swallowed the delimiter is checked INDEPENDENTLY of the resolved
      // version. Gating it behind "is v2" was itself an escape: the same comment hides the schema
      // line, so the version never resolves and the guard never runs.
      if (markerLf < 0 && inComment)
        add("FAIL", "L24", `${rel} has an unclosed <!-- comment and no live PRIVATE_NOTES: delimiter — the notes region is undelimited`);

      // APPLICABILITY. When the log carries provenance it is authoritative and the file must
      // agree with it — a file cannot select its own grammar, which is exactly the escape that
      // let a v2 file downgrade itself to v1 and drop every mandatory key with no finding.
      if (boardSchema.provenance && schemaLines.length === 0)
        add("FAIL", "L24", `${rel} has no SCHEMA: declaration but the log records this board as agent/${boardSchema.schema}`);
      else if (boardSchema.provenance && schemaVal !== null && schemaVal !== `collab-board/agent/${boardSchema.schema}`)
        add("FAIL", "L24", `${rel} declares SCHEMA ${JSON.stringify(schemaVal)} but the log records this board as agent/${boardSchema.schema} — an actor file does not choose its own grammar; migrate the board instead`);

      // With NO provenance the board is legacy: the file's own declaration still selects the
      // grammar, exactly as before. That is strictly weaker, and the WARN says so rather than
      // leaving the residual hole undocumented — on such a board the grammar can still be
      // disabled by editing the declaration, and `migrate` is what closes it.
      const effectiveSchema = boardSchema.provenance ? boardSchema.schema
        : (AGENT_SCHEMAS.includes(declaredVer(schemaVal)) ? declaredVer(schemaVal) : "v1");
      // Any version WITH a closed grammar, not one named by hand. This was the FIFTH place to
      // spell a version literal, and the hostile-input sweep caught it the honest way: a board
      // declaring the newest schema with no provenance stopped being warned at all, so the
      // residual hole the WARN exists to document went undocumented on exactly the boards most
      // likely to have it.
      if (!boardSchema.provenance && schemaVal !== null
          && AGENT_SCHEMA_TABLE[declaredVer(schemaVal)] && AGENT_SCHEMA_TABLE[declaredVer(schemaVal)].keys)
        add("WARN", "L24", `${rel} declares agent/${declaredVer(schemaVal)} but log.md records no agent-schema provenance — run \`migrate --session ${id} --to agent/${declaredVer(schemaVal)}\` so the closed grammar cannot be disabled by editing this file`);

      // Every version with a declared key list is validated against ITS list. This is what makes
      // an `OPEN agent_schema=v3` board carrying v2-shaped five-key files FAIL immediately: the
      // board's provenance selects v3 and the extra two keys are not in v3's grammar. Accepting
      // them would be shape inference re-entering through the back door.
      if (AGENT_SCHEMA_TABLE[effectiveSchema] && AGENT_SCHEMA_TABLE[effectiveSchema].keys)
        for (const problem of headerProblems(effectiveSchema, headerLines, markerLf))
          add("FAIL", "L24", `${rel} ${problem}`);

      // Size ladder applies to BOTH schema versions — the runaway file this check exists for is v1.
      if (disc > FAIL_AT)
        add("FAIL", "L24", `${rel} discretionary notes ${disc} B exceed ${FAIL_AT} B — move prose to the current shard or points.md and leave an id@pointer (never truncate)`);
      else if (disc > WARN_AT)
        add("WARN", "L24", `${rel} discretionary notes ${disc} B exceed ${WARN_AT} B — consider moving settled prose out and leaving an id@pointer`);
    }
  }


  // L25 PRIMARY-RELAY — in a PRIMARY_ONLY session the SECONDARY does not write, so every SECONDARY
  // TURN_COMMIT must carry the relay provenance. This is the mechanical check the plan insists on:
  // the next-turn audit cannot protect the gate path because a gate-setting relay may be the LAST
  // secondary turn, so the audit that would catch a bad transcription may never be scheduled.
  {
    const bw = boardWriteMode(sessText);
    if (bw.problem) add("FAIL", "L25", `SESSION.md ${bw.problem}`);
    if (bw.mode === "PRIMARY_ONLY") {
      const prim = head.byRole.PRIMARY && head.byRole.PRIMARY.name;
      const sec = head.byRole.SECONDARY && head.byRole.SECONDARY.name;
      for (const e of events) {
        if (e.type !== "TURN_COMMIT") continue;
        const am = e.rest.match(/\bactor=([A-Za-z0-9_]+)/);
        if (!am || !sec || am[1].toUpperCase() !== sec.toUpperCase()) continue;
        const tid = e.rest.split(/\s+/)[0];
        const by = e.rest.match(/\brelayed_by=([A-Za-z0-9_]+)/);
        if (!by)
          add("FAIL", "L25", `TURN_COMMIT ${tid} is a ${sec} turn in a PRIMARY_ONLY session but carries no relayed_by= — under this mode the SECONDARY never writes, so an unrelayed turn means something wrote the board that was not supposed to`);
        else if (prim && by[1].toUpperCase() !== prim.toUpperCase())
          add("FAIL", "L25", `TURN_COMMIT ${tid} claims relayed_by=${by[1]} but this board's PRIMARY is ${prim}`);
        if (!/\battempt=[1-9][0-9]*(?:\s|$)/.test(e.rest))
          add("FAIL", "L25", `TURN_COMMIT ${tid} has no well-formed attempt=<n> — the attempt number is what distinguishes a retried relay from a duplicated one`);
        const shas = [...e.rest.matchAll(/\bcapture_sha=([0-9a-f]{8,64})(?=\s|$)/g)].map((m) => m[1]);
        if (!shas.length)
          add("FAIL", "L25", `TURN_COMMIT ${tid} has no well-formed capture_sha=<hex> — without it the shard cannot be checked against the capture it came from`);

        // FAN-OUT PROVENANCE. Every capture retained for this turn must be accounted for by the
        // TURN_COMMIT, and every declared hash must match a retained capture. This cannot detect a
        // finding dropped from WITHIN a contributor, but it does detect a contributor dropped
        // whole — which is the failure a fuser is most likely to commit and least likely to notice.
        const caps = captureFiles(dir, tid);
        const onDisk = new Map();
        for (const f of caps) onDisk.set(sha256(fs.readFileSync(path.join(captureDir(dir), f))), f);
        for (const want of shas)
          if (![...onDisk.keys()].some((h) => h.startsWith(want)))
            add("FAIL", "L25", `TURN_COMMIT ${tid} declares capture_sha=${want} but no retained capture in captures/ hashes to it — the capture was edited after the relay, or never existed`);
        for (const [h, f] of onDisk)
          if (!shas.some((want) => h.startsWith(want)))
            add("FAIL", "L25", `captures/${f} was retained for ${tid} but its hash is not declared on the TURN_COMMIT — a contributor that reached the board and is not cited has been dropped whole`);
        // A fused turn must SAY it is one, and name its contributors, or a reader cannot tell
        // whose words they are reading. Keyed on the DECLARED `fused=yes`, not on how many
        // captures happen to survive on disk — a deleted capture would otherwise switch the
        // check off, which is the wrong direction for a check about dropped contributors.
        const declaredFused = /\bfused=yes(?:\s|$)/.test(e.rest);
        if (declaredFused || caps.length > 1) {
          const shard = turnFiles.find((f) => f.startsWith(tid + "-"));
          const body = shard ? cached(path.join(turnsDir, shard)) : "";
          for (const f of caps) {
            const who = f.slice(tid.length + 1).replace(/\.relay$/, "");
            if (!new RegExp("\\b" + who + "\\b", "i").test(body))
              add("FAIL", "L25", `${tid} fuses ${caps.length} captures but its shard never names ${who} — every contributor to a fused turn must be attributed in it, or the fusion is unattributable prose`);
          }
          const declaredN = (e.rest.match(/\bcontributors=([0-9]+)(?:\s|$)/) || [])[1];
          if (declaredFused && declaredN !== undefined && Number(declaredN) !== caps.length)
            add("FAIL", "L25", `${tid} declares contributors=${declaredN} but ${caps.length} capture(s) are retained for it — the count and the evidence disagree`);
        }
        // THE FAN-OUT TOKENS ARE NOW READ BACK. `scopes=`, `contributors_declared=` and `absent=`
        // were engine-written and consulted by nothing — a record, not a constraint. `relay`
        // enforces the product's completeness at WRITE time, so the tokens are honest today only
        // because one writer emits them; that is a property of there being one writer, not of the
        // design. This is the read-time twin: the sweep a TURN_COMMIT CLAIMS must equal the
        // evidence retained for it, exactly as `contributors=` is checked above.
        const scopesTok = (e.rest.match(/\bscopes=([0-9]+)(?:\s|$)/) || [])[1];
        const declTok = (e.rest.match(/\bcontributors_declared=([0-9]+)(?:\s|$)/) || [])[1];
        // KEYED ON THE EVIDENCE, NOT ON THE CLAIM. Gating this on "did the line carry the tokens"
        // meant DELETING them switched the check off — the escape is always from outside the rule
        // the check reasons in, and a token whose absence disables its own validation is the purest
        // form of it. The captures decide: a turn whose retained captures name scope cells IS a
        // sweep, whether or not its TURN_COMMIT says so, and one that says nothing about a sweep it
        // demonstrably ran is a turn no reader can weigh.
        const sweepCaps = caps.filter((f) => /_S[0-9]+\.relay$/.test(f));
        if (sweepCaps.length && (scopesTok === undefined || declTok === undefined))
          add("FAIL", "L25", `${tid} retains ${sweepCaps.length} capture(s) naming scope cells but its TURN_COMMIT carries no scopes=/contributors_declared= tokens — the sweep it ran is unrecorded, and a check keyed on a token a writer may omit is a check anyone may switch off`);
        if (scopesTok !== undefined && declTok !== undefined) {
          const absentTok = (e.rest.match(/\babsent=(\S+)/) || [])[1];
          const absentN = absentTok ? absentTok.split(",").filter(Boolean).length : 0;
          const want = Number(scopesTok) * Number(declTok);
          if (caps.length + absentN !== want)
            add("FAIL", "L25", `${tid} claims a ${declTok} x ${scopesTok} sweep (${want} cells) but ${caps.length} capture(s) are retained and ${absentN} absence(s) declared — a turn that claims a wider sweep than its evidence supports reads as a fuller review than happened`);
        }
      }

      // ORPHANED CAPTURES. The loop above is keyed per TURN_COMMIT, so a relay that died between
      // retaining the captures (its first write) and committing the turn is structurally invisible
      // to it: captures/ populated, turns/ empty, lint PASS. The retention-first ordering exists so
      // that a crash leaves the evidence — and nothing was ever looking at the evidence.
      const committed = new Set(events.filter((ev) => ev.type === "TURN_COMMIT").map((ev) => ev.rest.split(/\s+/)[0]));
      const orphanTurns = [...new Set(allCaptureFiles(dir).map(captureTurnOf).filter(Boolean))]
        .filter((t) => !committed.has(t));
      for (const t of orphanTurns)
        add("FAIL", "L25", `captures/ retains ${captureFiles(dir, t).join(", ")} for ${t} but no TURN_COMMIT ${t} was ever logged — a relay died between retaining the evidence and committing the turn; reconcile per recovery.md before retrying`);
    }
  }

  // L26 CONVERGENCE — Rule 11. Rule 5 measures a SILENT actor and Rule 6 a single stuck point;
  // neither can see the board that is busy, polite and going nowhere. The longest IMPL phase on
  // record advanced a commit on nearly every one of its 29 turns and ended with its whole approach
  // rejected, so ACTIVITY is not the signal — what a converging board produces is SETTLEMENTS: a
  // point moved off OPEN, a gate, a DECISION, the phase advancing. This counts turns since the last
  // one, which is why a limit wait or an overnight pause can never trip it (those are Rule 5's
  // instrument, and time is the wrong unit here).
  {
    const conv = convergeThresholds(sessText);
    if (conv.problem) add("FAIL", "L26", `SESSION.md ${conv.problem}`);
    const { BARREN, CHURN } = conv.problem ? CONVERGE_DEFAULTS : conv;
    const primaryName = head.byRole.PRIMARY?.name;
    // Payload grammar, checked on every REFRAME whether or not a streak is open. An off-form
    // event that lint merely skipped would still LOOK like a step-back to a reader while buying
    // no window at all — the one place a lenient read silences the check it satisfies.
    for (const e of events) {
      if (e.type !== "REFRAME") continue;
      const m = REFRAME_FORM.exec(e.rest);
      if (!m) {
        addGated("L26_REFRAME_FORM", "L26", `log.md REFRAME ${JSON.stringify(e.rest)} is not the documented "by=<PRIMARY> in=<turn-id> trigger=<${REFRAME_TRIGGERS.join("|")}> outcome=<${REFRAME_OUTCOMES.join("|")}>" form — it records no step-back and buys no convergence window`);
        continue;
      }
      const [, by, inTurn, , outcome] = m;
      const shard = turnFiles.find((f) => f.startsWith(`${inTurn}-`));
      // Same reasoning as SCHEMA_SET: a step-back can ABORT the session or rewrite its approach,
      // and provenance anyone may write is not provenance.
      if (primaryName && by.toUpperCase() !== primaryName.toUpperCase())
        addGated("L26_REFRAME_AUTHOR", "L26", `log.md REFRAME by=${by} but this board's PRIMARY is ${primaryName} — the step-back is the PRIMARY's to record (Rule 11); a SECONDARY asks for one in its turn body`);
      if (!knownTurnIds.has(inTurn))
        add("FAIL", "L26", `log.md REFRAME in=${inTurn} names a turn that has no TURN_COMMIT and no shard — a step-back must be written down somewhere a reader can find it`);
      // A named turn with no shard at all is already an L14 orphan; repeating that here would be
      // noise. This asks the narrower question: the shard exists, does it show the step-back?
      else if (shard && !REFRAME_LINE.test(cached(path.join(turnsDir, shard))))
        add("WARN", "L26", `log.md REFRAME names ${inTurn} but that shard carries no "- REFRAME:" line — the event says a step-back happened and the turn does not show one (token check, not a reading)`);
      // The token DECLARES an escalation, so a missing USER_QUESTION is a broken record rather
      // than a judgment call — and Rule 9's whole point is that the user actually gets asked.
      if (outcome === "ESCALATE" && !events.some((u) => u.type === "USER_QUESTION" && new RegExp(`\\bin=${inTurn}\\b`).test(u.rest)))
        add("FAIL", "L26", `log.md REFRAME in=${inTurn} outcome=ESCALATE but no USER_QUESTION names that turn — an escalation nobody was asked is not an escalation (Rule 9)`);
    }
    // A step-back written but never logged leaves the window open, so the barren FAIL keeps
    // re-firing with no hint as to why. Counted, not matched — the same limit L12 states.
    const reframeShards = turnFiles.filter((f) => REFRAME_LINE.test(cached(path.join(turnsDir, f)))).length;
    const reframeEvents = events.filter((e) => e.type === "REFRAME").length;
    if (reframeShards > reframeEvents)
      add("WARN", "L26", `${reframeShards} turn shard(s) carry a REFRAME: line but the log has ${reframeEvents} REFRAME event(s) — an unlogged step-back buys no window and the barren count keeps running`);

    // A terminal board has stopped; measuring its convergence is measuring a finished race.
    if (!TERMINALS.includes(head.status)) {
      // The window is the CURRENT phase. It resets on the same PHASE_SET the projector accepts, so
      // the phase this check reports and the phase HEAD shows can never be two different answers.
      const { barren, streakFrom, reopens, reframesSinceSettlement, uqSinceLastReframe,
        lastReframeOutcome, offFormDecisions } = convergenceScan(events);
      const where = `phase ${head.phase}`;
      // A DECISION that does not parse settles nothing. Say so, rather than let a line the author
      // believes is a Rule 6 decision quietly fail to buy the window it looks like it bought.
      for (const d of offFormDecisions)
        add("WARN", "L26", `log.md DECISION ${JSON.stringify(d)} is not the §8 "<point-id> -> ACCEPT|REJECT by=<ACTOR>" form, so it records no decision and settles nothing — Rule 6 needs the documented form`);
      if (barren >= BARREN)
        add("FAIL", "L26", `${where} has run ${barren} turns since anything was settled (from ${streakFrom}; BARREN=${BARREN}) — Rule 11: the next PRIMARY turn is a step-back, not another increment. Weigh at least two approaches, one materially different, and log REFRAME by=${primaryName || "<PRIMARY>"} in=<turn-id> trigger=BARREN outcome=<${REFRAME_OUTCOMES.join("|")}>`);
      else if (barren >= Math.max(1, BARREN - 2))
        add("WARN", "L26", `${where} has run ${barren} turns since anything was settled (from ${streakFrom}) — one more exchange without a point resolved, a gate set or a DECISION and Rule 11 forces a step-back at ${BARREN}`);
      for (const [id, n] of [...reopens].sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true })))
        if (n >= CHURN)
          add("FAIL", "L26", `point ${id} has been resolved and re-opened ${n} times in ${where} (CHURN=${CHURN}) — the board is re-litigating it rather than converging; Rule 11 requires a step-back (trigger=CHURN), and Rule 6 a DECISION if it stays open`);
      // Re-framing that itself settles nothing is the loop one level up, which is exactly the
      // failure the step-back exists to break. It may not be answered with a third step-back.
      if (reframesSinceSettlement >= 2 && !uqSinceLastReframe)
        add("FAIL", "L26", `${reframesSinceSettlement} REFRAME events with nothing settled between them (last outcome=${lastReframeOutcome}) — re-framing is not converging either, so Rule 11 allows only outcome=ESCALATE (with its USER_QUESTION) or outcome=ABORT here, never a third re-frame`);
    }
  }

  // L16 CATALOG-SYNC
  const idx = path.join(collabDir(root), "index.md");
  if (exists(idx)) {
    // LIVE: commenting the catalog row out made the drift check read it as present and report
    // nothing, which is precisely the drift the check exists to surface.
    const row = liveText(cached(idx)).split(/\r?\n/).find((l) => l.split("|").map((c) => c.trim())[1] === id);
    if (row) {
      const cells = row.split("|").map((c) => c.trim());
      if (cells[3] !== head.status || cells[4] !== head.phase)
        add("WARN", "L16", `index.md row [${cells[3]}/${cells[4]}] ≠ HEAD [${head.status}/${head.phase}] — HEAD is authoritative and the catalog is a derived view; update the index.md row to HEAD's values, never HEAD to match the row`);
    } else add("WARN", "L16", `no index.md catalog row for ${id} — the catalog is a derived view of HEAD; add the session's row (| ${id} | <type> | ${head.status} | ${head.phase} | ... |) to index.md's table`);
  }

  return F;
}

// Point state IS derivable from the log, which makes recovery.md ROLLBACK performable:
// existence comes from TURN_COMMIT `points=`, Status from the latest POINT_SET naming the id, and
// `Resolved In` from that event's `in=`. No prior POINT_SET means OPEN and unresolved. Before this,
// recovery instructed the PRIMARY to restore rows "from pre-turn log replay" while replay carried
// no point state at all - a procedure that could not be carried out as written.
const SCHEMA_SHAPED = /^\s*SCHEMA\b/;
const declaredVer = (v) => (/^collab-board\/agent\/(\S+)$/.exec(v || "") || [])[1];
// ---------- the agent/v2 header grammar ----------
// ONE judgement of what a valid agent/v2 header is. `migrate` decides whether a file still needs
// rewriting and lint decides whether it is acceptable; when those were two implementations they
// disagreed, and migrate committed a SCHEMA_SET for a board whose very next lint FAILed — it
// checked key NAMES and called the file done while lint checked key VALUES and rejected it.
// Returns the findings as plain sentences; the caller supplies the file it is talking about.
  // NOT the module-level HANDS: an actor file may also declare the explicit NONE form.
const V2_HANDS = new Set(["START", "WORKING", "ON_HOLD", "DONE", "NONE"]);
  const ID_RE = /^[PI][1-9][0-9]*$/;
  const POS_INT = /^[1-9][0-9]*$/;
  const SAFE_TOKEN = /^[A-Za-z0-9._:\/\\-]{1,512}$/;
  const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

  const isPointer = (s) => {
    if (s.length < 1 || s.length > 512) return false;
    if (!/^[A-Za-z0-9._:\/\\#-]+$/.test(s)) return false;
    const hash = s.indexOf("#");
    const body = hash === -1 ? s : s.slice(0, hash);
    if (hash !== -1) {
      const frag = s.slice(hash + 1);
      if (frag === "" || frag.includes("#")) return false;
    }
    if (!/\.md$/.test(body)) return false;
    if (/^[\/\\]/.test(body) || /^[A-Za-z]:/.test(body)) return false; // no absolute paths
    if (body.split(/[\/\\]/).some((seg) => seg === "..")) return false; // no traversal
    return true;
  };
  const okConcerns = (v) => {
    if (v === "NONE") return true;
    const items = listItems(v);
    return items !== null && items.every((item) => {
      const at = item.indexOf("@");
      return at > 0 && ID_RE.test(item.slice(0, at)) && isPointer(item.slice(at + 1));
    });
  };
  // ONE table drives both the check and the sentence the writer is shown. When the accepted form
  // and its description were separate texts, they were two things that had to agree while only one
  // ever got edited — this file's dominant defect. Deriving the grammar from the table means a new
  // field or a changed form updates the diagnostic in the same edit.
  const RECOVERY_FIELDS = [
    ["TURN", (x) => ID_RE.test(x), "<turn-id>"],
    ["ATTEMPT", (x) => POS_INT.test(x), "<n>"],
    ["START", (x) => RFC3339.test(x), "<RFC3339>"],
    ["EXPECT", (x) => POS_INT.test(x), "<seconds>"],
    ["SPAWN", (x) => x === "NONE" || SAFE_TOKEN.test(x), "<token|NONE>"],
    ["LIMIT", (x) => x === "NONE" || SAFE_TOKEN.test(x), "<token|NONE>"],
    ["RESET", (x) => x === "NONE" || RFC3339.test(x), "<RFC3339|NONE>"],
  ];
  const RECOVERY_FORM = RECOVERY_FIELDS.map(([k, , form]) => k + "=" + form).join(";");
  // Returns null when the value is fine, otherwise the FIRST failing row — or `false` when the
  // value has no field shape at all. The caller distinguishes them: a shaped value names its
  // failing field, a shapeless one gets the whole form, and neither invents anything.
  const recoveryFault = (v) => {
    if (v === "NONE") return null;
    const parts = v.split(";");
    if (parts.length !== RECOVERY_FIELDS.length) return false;
    for (let i = 0; i < RECOVERY_FIELDS.length; i++) {
      const [key, ok] = RECOVERY_FIELDS[i];
      const eq = parts[i].indexOf("=");
      if (eq <= 0 || parts[i].slice(0, eq) !== key) return false;
      if (!ok(parts[i].slice(eq + 1))) return RECOVERY_FIELDS[i];
    }
    return null;
  };
  const okRecovery = (v) => recoveryFault(v) === null;
  const okValue = (key, v) => {
    // Shape (column-0 key, exactly one space, no padding, non-empty) is enforced by KEY_LINE
    // below — this function is purely semantic. An earlier version re-checked padding here after
    // the caller had already trimmed the value, which made the guard unreachable.
    return key in VALUE_RULES ? VALUE_RULES[key].ok(v) : false;
  };
  // The accepted form of every key, beside the predicate that enforces it. A key added to one
  // half without the other is a syntax error rather than a silently unexplained finding.
  const VALUE_RULES = {
    SELF_HAND: { ok: (v) => V2_HANDS.has(v), form: () => [...V2_HANDS].join(" | ") },
    LAST_TURN_WRITTEN: { ok: (v) => v === "NONE" || ID_RE.test(v), form: () => "NONE | <turn-id>" },
    ACTIVE_RECOVERY: { ok: (v) => okRecovery(v), form: () => "NONE | " + RECOVERY_FORM },
    EXECUTOR_THREAD: { ok: (v) => v === "NONE" || SAFE_TOKEN.test(v), form: () => "NONE | <token>" },
    UNRESOLVED_CONCERNS: { ok: (v) => okConcerns(v), form: () => "NONE | <point-id>@<pointer.md>[,...]" },
  };
function headerProblems(ver, headerLines, markerLf) {
  const KEYS = AGENT_SCHEMA_TABLE[ver].keys;
  const out = [];
  if (markerLf < 0) {
    out.push(`is agent/${ver} but has no standalone PRIVATE_NOTES: delimiter line`);
    return out;
  }
  // The header is read WITHOUT trimming structural whitespace — indentation is part of the
  // grammar ("consecutive TOP-LEVEL lines"), so a leading-space key is a violation, not a
  // formatting nicety. Column-0 key, one space after the colon, value neither padded nor empty.
  const KEY_LINE = /^([A-Z_]+): (\S(?:.*\S)?)$/;
  const titles = [], schemas = [], keys = [], stray = [];
  for (const l of headerLines) {
    if (l.trim() === "") continue;
    if (/^# \S/.test(l)) { titles.push(l); continue; }
    if (SCHEMA_SHAPED.test(l)) { schemas.push(l); continue; }
    const m = KEY_LINE.exec(l);
    if (m) { keys.push(m); continue; }
    stray.push(l);
  }
  const names = keys.map((m) => m[1]);
  if (stray.length)
    out.push(`agent/${ver} header has a line that is not the title, SCHEMA, or a column-0 KEY: value line: ${JSON.stringify(stray[0])}`);
  else if (titles.length !== 1)
    out.push(`agent/${ver} header must carry exactly one title line — found ${titles.length}`);
  else if (schemas.length !== 1)
    out.push(`agent/${ver} header must carry exactly one SCHEMA: line — found ${schemas.length}`);
  else if (names.length !== KEYS.length || names.some((n, i) => n !== KEYS[i]))
    out.push(`agent/${ver} header must be exactly ${KEYS.join(", ")} — got [${names.join(", ") || "none"}]`);
  else
    for (const [, k, v] of keys)
      // Key-level, never sub-field-level. Naming "the field that failed" reads well until the value
      // cannot be split into fields at all, and then it has nothing true to say — so it states the
      // whole accepted form, which is right in both cases and is what the writer needs either way.
      if (!okValue(k, v)) {
        const form = VALUE_RULES[k] ? VALUE_RULES[k].form() : "a value this schema defines";
        const row = k === "ACTIVE_RECOVERY" ? recoveryFault(v) : false;
        out.push(Array.isArray(row)
          ? `agent/${ver} ${k} value ${JSON.stringify(v)} is malformed: ${row[0]} must be ${row[2]} - accepted form: ${form}`
          : `agent/${ver} ${k} value ${JSON.stringify(v)} is malformed: must be ${form}`);
      }
  return out;
}

function secondaryPanel(sessText, primaryName) {
  const raw = (SESSION.SecondaryPanel(sessText) || "").trim();
  if (!raw) return { panel: null };                    // absent: single-secondary, unchanged
  // `filter(Boolean)` used to absorb `a,,b` and a trailing comma as a panel of two. A doubled or
  // stray comma is a writing error, not an omission, and this is the side of the shared rule that
  // gets STRICTER — so it carries its own fixture and a legitimate-panel control.
  const parts = listItems(raw);
  if (parts === null)
    return { panel: null, problem: `SecondaryPanel ${JSON.stringify(raw)} has an empty entry — every item is one executor id, so a doubled or trailing comma is a writing error; remove it` };
  if (parts.length < 2)
    return { panel: null, problem: `SecondaryPanel lists ${parts.length} executor(s) — a panel is two or more; use SecondaryAdapter for one` };
  const bad = parts.filter((a) => !CLI_EXECUTORS[a]);
  if (bad.length)
    return { panel: null, problem: `SecondaryPanel names ${bad.join(", ")}, which ${bad.length > 1 ? "are" : "is"} not a CLI executor (${CANONICAL_ADAPTERS.join(", ")})` };
  // ROSTER MEMBERS ARE CONTRIBUTORS TO ONE SEAT, NOT ACTORS. The SECONDARY is a single seat however
  // many agents implement it; fusing them into one coherent turn is the PRIMARY's manager job. Three
  // rules here resolved each entry to an ACTOR and reasoned about that, so all three were asking a
  // question the design does not pose:
  //
  //   the CEILING was `registered executors minus one`, so the number of reviewers a board would
  //   admit came from how many CLIs happen to be compiled into this file — wrong in BOTH directions.
  //   It capped a legitimately wide review at the vendor count, and licensed any panel under that
  //   count without ever asking what the extra members were FOR. Replaced by nothing: the bound is the work's decomposition.
  //
  //   the OWN-PRIMARY refusal rejected a member driving the PRIMARY's own model as "the PRIMARY
  //   agreeing with itself". OVERRULED by the owner: the core is model-agnostic, so the same model
  //   may contribute beside other vendors. What that guard PROTECTED is kept and stated where it
  //   belongs — a same-family contributor is the weakest reviewer available, and `doctor`/`new` say
  //   so — but as advice, never as a structural refusal.
  //
  //   the DUPLICATE rule survives, re-cut. What must never repeat is a CONTRIBUTOR LABEL: it is what
  //   a capture filename carries, what L25 rediscovers a retained capture by, and what every count
  //   keyed on the contributor set reads. Two entries resolving to one label are one contributor
  //   listed twice whatever models they name — and `codex-cli,codex`, the alias pair that motivated
  //   the original rule, is still refused by exactly this test.
  const labels = parts.map((a) => CLI_EXECUTORS[a]);
  const dupeAt = labels.findIndex((s, i) => labels.indexOf(s) !== i);
  if (dupeAt > 0)
    return { panel: null, problem: `SecondaryPanel resolves ${parts[labels.indexOf(labels[dupeAt])]} and ${parts[dupeAt]} to the same contributor label ${labels[dupeAt]} — one contributor listed twice is not two contributors, and every count keyed on that label would read it as two` };
  return { panel: parts };
}

// Rule 11's counters as a PURE function over parsed events, so `lint` and the `replay` harness
// cannot compute different numbers. A harness that reimplements the counter proves nothing: it can
// agree with a bug or disagree with a fix, and there is no way to tell which from the output.
// Rule 11's thresholds were calibrated by replaying all 14 real boards ONCE, by hand, against
// gitignored data — so the standing rule that a check must be diffed against the pre-change
// engine had no tool behind it for this check. This is that tool's half of the contract.
function convergenceScan(events) {
  let barren = 0, reframesSinceSettlement = 0, uqSinceLastReframe = false;
  let streakFrom = null, lastReframeOutcome = null;
  const status = new Map();          // every point's status, tracked across the whole log
  const reopens = new Map();         // ...but re-openings counted only within this phase
  const gatesSet = new Set();        // gates already YES — re-asserting one settles nothing
  const decided = new Set();         // <point>-><verb> already decided — likewise
  const exposed = new Set();         // points a STRICTLY EARLIER turn committed by name...
  const pendingIntro = new Set();    // ...vs those this turn is naming for the first time
  const offFormDecisions = [];
  const settle = () => { barren = 0; reframesSinceSettlement = 0; };
  for (const e of events) {
    if (e.type === "PHASE_SET" && PHASE_SET_FORM.test(e.rest)) { settle(); reopens.clear(); streakFrom = null; }
    else if (e.type === "TURN_COMMIT") {
      if (!barren) streakFrom = e.rest.split(/\s+/)[0];
      barren++;
      // A point becomes EXPOSED once a turn has committed naming it. Fold the previous turn's
      // `points=` in here, at the start of the next turn, so "exposed" means "raised by a strictly
      // earlier turn" — resolving a point in the same turn that first names it is a decision no
      // other actor ever had the chance to see.
      for (const id of pendingIntro) exposed.add(id);
      pendingIntro.clear();
      for (const id of pointsIds(e.rest)) pendingIntro.add(id);
    }
    // A settlement is a TRANSITION, not an event type. Three of the five settlement kinds already
    // required a state change; GATE_SET and DECISION did not, so re-asserting a gate that was
    // already YES — a legal, well-formed, entirely no-op line — reset the counter. One such line
    // every seventh turn suppressed the barren FAIL, the WARN and the REPEAT arm indefinitely, and
    // drew no finding from any check. Twenty barren turns, measured, reported clean.
    else if (e.type === "GATE_SET") {
      const g = gateSetName(e.rest);
      if (g && !gatesSet.has(g)) { gatesSet.add(g); settle(); }
    } else if (e.type === "DECISION") {
      const m = DECISION_FORM.exec(e.rest);
      if (!m) { offFormDecisions.push(e.rest); continue; }
      const k = `${m[1]}->${m[2]}`;                    // keyed on the VERB too: DEFER then ACCEPT
      if (!decided.has(k)) { decided.add(k); settle(); }  // is a real second decision, not a repeat
    }
    else if (e.type === "USER_QUESTION") { barren = 0; uqSinceLastReframe = true; }
    else if (e.type === "REFRAME" && REFRAME_FORM.test(e.rest)) {
      barren = 0; reframesSinceSettlement++; uqSinceLastReframe = false;
      lastReframeOutcome = REFRAME_FORM.exec(e.rest)[4];
      // The CHURN arm clears here too, and it did not before — `reopens` was cleared only on
      // PHASE_SET. So a point that churned to the threshold FAILed L26 for the rest of the phase
      // with NO satisfying action: L26 blocks every phase and terminal transition, and Rule 11's
      // only remedy is the step-back, which did nothing for it. A forcing signal whose remedy does
      // not clear it is not a forcing signal, it is a dead end — and the board this shipped on
      // reproduced it on itself, one turn after taking exactly the step-back Rule 11 asks for.
      // Rule 11 already SAYS this ("a REFRAME resets the streak, which is how a FAIL clears: take
      // the step-back, log the event"); only the barren arm implemented it. The REPEAT arm still
      // catches two REFRAMEs with no settlement between them, so this cannot be run indefinitely.
      //
      // ONLY a trigger=CHURN step-back clears the churn counts. A REFRAME names no point, so
      // clearing them on ANY step-back let a board churn P1, take a step-back about something else
      // entirely (trigger=BARREN or MANUAL), and have P1's re-open count silently reset without
      // that churn ever being addressed. The remedy must be tied to the signal that demanded it:
      // a barren step-back answers a barren streak, a churn step-back answers churn.
      if (REFRAME_FORM.exec(e.rest)[3] === "CHURN") reopens.clear();
    } else if (e.type === "POINT_SET") {
      const m = POINT_SET_FORM.exec(e.rest);
      if (!m) continue;
      for (const [id, st] of m[1].split(" ").map((tok) => tok.split("="))) {
        const prev = status.get(id) || "OPEN";
        if (prev === st) continue;
        status.set(id, st);
        // Resolving buys a convergence window only for a point that was EXPOSED first. A point
        // raised and closed inside one turn is a decision the other actor never had a chance to
        // see, and counting it as a settlement let a board hold the barren streak at zero forever
        // while nothing was ever actually put up for review — the routine shape under a fusing
        // manager, not the adversarial one. It stays legal; it just buys nothing.
        if (st !== "OPEN") { if (exposed.has(id)) settle(); }
        else if (prev !== "OPEN") reopens.set(id, (reopens.get(id) || 0) + 1);
      }
    }
  }
  return { barren, streakFrom, reopens, reframesSinceSettlement, uqSinceLastReframe,
    lastReframeOutcome, offFormDecisions };
}

// ---------- sole-writer mode (part (a) of 2026-08-03-orchestrator-fanout) ----------
// OPT-IN and strictly additive: a session with no `BoardWriteMode` behaves exactly as before, so
// every existing board is untouched and migration is explicit. Under PRIMARY_ONLY the SECONDARY
// never writes the board — it returns a capture and the PRIMARY relays it. The plan's first
// refuted claim is why L25 exists at all: prose cannot prove who wrote bytes, so a sole-writer
// rule with no mechanical check is an honour system.
const BOARD_WRITE_MODES = ["PRIMARY_ONLY"];
function boardWriteMode(sessText) {
  const v = (SESSION.BoardWriteMode(sessText) || "").trim();
  if (!v) return { mode: null };                       // legacy: exempt entirely
  if (!BOARD_WRITE_MODES.includes(v))
    return { mode: null, problem: `BoardWriteMode=${JSON.stringify(v)} is not one of ${BOARD_WRITE_MODES.join(", ")}` };
  return { mode: v };
}

// A relay/v1 capture is what a read-only SECONDARY returns instead of writing. It is deliberately
// strict: the relay COPIES the turn block byte for byte and must never reconstruct it, so anything
// ambiguous is a refusal rather than a best guess.
const RELAY_SCHEMA = "collab-board/relay/v1";
function parseRelay(text) {
  const t = text.replace(/^\uFEFF/, "");
  const head = /^RELAY:[ \t]*(\S+)[ \t]*$/m.exec(t);
  if (!head) return { problem: 'capture has no "RELAY: <schema>" line' };
  if (head[1] !== RELAY_SCHEMA) return { problem: `capture declares ${JSON.stringify(head[1])}, expected ${RELAY_SCHEMA}` };
  const field = (k) => { const m = new RegExp('^' + k + ':[ \\t]*(.*)$', 'm').exec(t); return m ? m[1].trim() : null; };
  const out = { session: field("SESSION"), actor: field("ACTOR"), turn: field("TURN") };
  for (const k of ["session", "actor", "turn"])
    if (!out[k]) return { problem: `capture has no ${k.toUpperCase()}: line` };
  // Markers are located ONCE, and the sequence they form is validated before any of it is sliced.
  // The old scan closed each section at the first following marker, so a turn body that QUOTED a
  // marker line terminated its own block: everything after it — Evidence and Handoff included —
  // was dropped, at exit 0, while capture_sha went on certifying the full capture as faithful.
  // The comment here claimed the opposite ("its own content can contain anything") and no fixture
  // used a body with a marker in it. Quoting board syntax in prose is exactly what a real board
  // does and a fixture does not, which is why the live boards, not the fixtures, catch it.
  //
  // The rule is a refusal, not a repair: an out-of-order or repeated marker makes the capture
  // ambiguous, and this parser must never guess which occurrence was syntax.
  const ORDER = ["TURN", "LOG", "POINTS", "HEAD", "END"];
  const found = [];
  for (const m of t.matchAll(/^--- (TURN|LOG|POINTS|HEAD|END) ---[ \t]*$/gm))
    found.push({ name: m[1], at: m.index, len: m[0].length });
  if (!found.length) return { problem: 'capture has no "--- TURN ---" section' };
  for (let i = 1; i < found.length; i++)
    if (ORDER.indexOf(found[i].name) <= ORDER.indexOf(found[i - 1].name))
      return { problem: `marker "--- ${found[i].name} ---" appears after "--- ${found[i - 1].name} ---", so the section markers are out of order or repeated. `
        + `A marker line at column 0 is SYNTAX, not content: if a turn body needs to quote one, indent it by one space. Refusing rather than guessing which occurrence was meant.` };
  if (found[0].name !== "TURN") return { problem: 'capture has no "--- TURN ---" section' };
  if (found[found.length - 1].name !== "END")
    return { problem: 'capture has no "--- END ---" marker, so it may be truncated' };
  const seg = (name) => {
    const i = found.findIndex((f) => f.name === name);
    if (i < 0) return null;
    const from = found[i].at + found[i].len;
    const to = i + 1 < found.length ? found[i + 1].at : t.length;
    return t.slice(from, to).replace(/^\r?\n/, "");
  };
  out.turnBlock = seg("TURN");
  out.logLines = (seg("LOG") || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // POINTS is a GRAMMAR, not free text. It was split on newlines and shovelled into the
  // `points=` token unvalidated, so "P1 and P2 = RESOLVED" became a point id of "P1 and P2 " —
  // which L10's reference counting then failed to match against any real point. Each line is
  // `<id>=<STATUS>`, optionally ` | <title>` for a point this turn is raising for the first time.
  out.points = [];
  for (const l of (seg("POINTS") || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
    // DERIVED from the WRITABLE set, not spelled again. This line was a THIRD copy of the status
    // vocabulary and it still listed DEFERRED, so a capture could propose one and the relay would
    // write it — the owner's rule (a board may not park work it needs) defeated by a regex nobody
    // updated. A capture PROPOSES a new status, so it gets POINT_STATUSES; the retired token stays
    // readable only where old LOGS are replayed.
    const m = new RegExp("^([PI][0-9]+)=(" + POINT_STATUSES.join("|") + ")(?:\\s*\\|\\s*(.+))?$").exec(l);
    if (!m) return { problem: `POINTS line ${JSON.stringify(l)} is not "<id>=<STATUS>" (optionally followed by " | <title>")` };
    out.points.push({ id: m[1], status: m[2], title: (m[3] || "").trim() });
  }
  out.head = (seg("HEAD") || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return out;
}

// FAN-OUT. The owner's requirement is that the manager may dispatch the SECONDARY side to several
// subagents at once — different models from different vendors — and fuse their outputs into one
// coherent turn. The recorded objection to that was precise and correct: a fused shard is
// byte-identical to an honest one, so no check can see which findings the fuser dropped.
//
// What IS mechanically checkable, and is what these rules enforce: that no contributor was
// dropped WHOLE, that every retained capture is cited by the shard that claims to fuse them, and
// that each capture's bytes still hash to what the log recorded. Selection WITHIN a contributor's
// findings remains invisible to lint and is therefore stated as a limit rather than papered over —
// the captures are retained precisely so an independent reader can do what lint cannot.
function captureDir(dir) { return path.join(dir, "captures"); }
// Regular files only, same discovery rule the linter uses — a directory wearing a shard name
// must not be resolved as one here either.
function turnFilesIn(dir) {
  const td = path.join(dir, "turns");
  if (!isBoardDir(td)) return [];
  return fs.readdirSync(td, { withFileTypes: true })
    .filter((e) => e.isFile() && SHARD_NAME.test(e.name)).map((e) => e.name);
}
// One grammar (CAPTURE_NAME), then a plain prefix test for the turn — never a RegExp built by
// concatenating the turn id, which is a value that reaches here from a capture file.
function allCaptureFiles(dir) {
  const cd = captureDir(dir);
  if (!isBoardDir(cd)) return [];
  return fs.readdirSync(cd, { withFileTypes: true })
    .filter((e) => e.isFile() && CAPTURE_NAME.test(e.name)).map((e) => e.name).sort();
}
function captureFiles(dir, turnId) {
  return allCaptureFiles(dir).filter((n) => n.startsWith(turnId + "-"));
}
// The turn a retained capture belongs to, read back under the same grammar that wrote it.
function captureTurnOf(name) { return (name.match(new RegExp("^(" + TURN_ID_SRC + ")-")) || [])[1] || null; }
function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

// ---------- actor identity ----------
// SESSION.md's `Roles:` line is the CONTRACT; HEAD.md ## State is live state derived from it. A
// command that takes identity from HEAD alone can be steered by editing one file: swapping the
// two role labels in HEAD made `migrate` author its provenance event as the SECONDARY, and only
// the NEXT lint reported the inconsistency — after the write had already landed. A mutator must
// fail closed on identity BEFORE it writes, not be corrected afterwards.
const ROLES_FORM = /^PRIMARY\s*=\s*([A-Za-z0-9_]+)\s*,\s*SECONDARY\s*=\s*([A-Za-z0-9_]+)$/;
function contractRoles(sessText) {
  // Counted on the LIVE view: a second declaration inside a comment is not a second declaration.
  const count = (liveText(sessText).match(/^Roles:/gm) || []).length;
  const raw = (SESSION.Roles(sessText) || "").trim();
  if (count > 1)
    return { problem: `SESSION.md carries ${count} Roles: declarations — exactly one is required, and only the first was being read; the contract is write-once (Rule 2), so repair it to the single Roles: line stating the original pairing and delete the other(s)` };
  const m = ROLES_FORM.exec(raw);
  if (!m)
    return { problem: `SESSION.md Roles is ${raw ? `malformed (${JSON.stringify(raw)})` : "missing"} — it must read exactly "PRIMARY=<actor>, SECONDARY=<actor>"` };
  if (m[1].toLowerCase() === m[2].toLowerCase())
    return { problem: `SESSION.md Roles names the same actor twice (${m[1]}, ${m[2]}) — PRIMARY and SECONDARY must be distinct, case-insensitively (their agent files and shard names collapse otherwise); set Roles to the two distinct actors the board's turn shards and agents/ files actually use` };
  return { primary: m[1], secondary: m[2] };
}

// Shared by every command that WRITES actor identity into a permanent record. SESSION.md's Roles
// line is the contract; HEAD.md ## State is live state derived from it. A mutator that trusts
// HEAD alone can be steered by editing one file, and the write it then makes is not correctable:
// it is already in the append-only log.
function requireWritableHead(cmd, id, head) {
  const problems = [];
  // Exactly ONE live `## State`. parseHead reads rows from the FIRST section only, so a second is
  // invisible to every value this command is about to act on, while lint fails the board as
  // "two sections are two truths". None of the five guards this replaces checked it.
  if (head.stateSectionCount !== 1) problems.push(`${head.stateSectionCount} live "## State" sections`);
  if (head.state.length !== 2) problems.push(`${head.state.length} actor rows, expected 2`);
  if (!head.byRole.PRIMARY) problems.push("no PRIMARY row");
  // Three of the five guards omitted this one, so the same board was refused by advance and
  // written by terminal.
  if (!head.byRole.SECONDARY) problems.push("no SECONDARY row");
  if (head.malformedActors.length) problems.push(`malformed actor name(s) ${head.malformedActors.join(", ")}`);
  if (problems.length)
    die(`${cmd}: HEAD.md ## State is malformed — ${problems.join("; ")}. Reading a malformed board is diagnostic; writing one is corruption. Run \`lint --session ${id}\` first`);
  // Reported separately because callers and fixtures key off this wording, and a duplicated key
  // is a different fault from a malformed State block.
  const keyBad = headKeyProblems(head.raw);
  if (keyBad.length)
    die(`${cmd}: HEAD.md key problems — ${keyBad.join("; ")}; each authoritative key must appear exactly once. Run lint first`);
}
function requireContractIdentity(cmd, dir, id, head) {
  const sessFile = path.join(dir, "SESSION.md");
  if (!exists(sessFile))
    die(`${cmd}: session ${id} has no SESSION.md — the actor contract is what says who holds which role`);
  const roles = contractRoles(readText(sessFile));
  if (roles.problem) die(`${cmd}: ${roles.problem}; run \`lint --session ${id}\` first`);
  const hp = head.byRole.PRIMARY, hs = head.byRole.SECONDARY;
  if (!hp || !hs || hp.name.toUpperCase() !== roles.primary.toUpperCase()
    || hs.name.toUpperCase() !== roles.secondary.toUpperCase())
    die(`${cmd}: HEAD.md ## State assigns PRIMARY=${hp ? hp.name : "none"}/SECONDARY=${hs ? hs.name : "none"} but SESSION.md Roles says PRIMARY=${roles.primary}/SECONDARY=${roles.secondary} — refusing to write under a disputed identity; run \`lint --session ${id}\` first`);
  return roles;
}

// ---------- agent-schema provenance ----------
// WHICH agent schema a board uses is a property OF THE BOARD, recorded in its append-only log.
// Resolving it from the actor file's own SCHEMA: line made the check's applicability a function
// of the very bytes it was checking: a scaffolded v2 file could rewrite its own declaration to
// v1, delete all five closed keys, and lint PASS. Provenance is written by scaffold
// (`OPEN ... agent_schema=v2`, additive so legacy OPEN lines simply lack it) and by `migrate`
// (`SCHEMA_SET agent/v1->agent/v2`). ABSENCE is legacy v1 and is the ONLY exemption.
//
// Malformed provenance is never silently read as absence — that would make the malformed
// spelling itself the escape, which is how three earlier defects here worked. It is returned
// for the caller to report and, in `migrate`, to refuse on.

// Both derived from AGENT_SCHEMA_TABLE above. They were two independent literals; the key list in
// particular existed here AND in the two agent templates AND in the protocol's schema bullet, which
// is the same must-agree shape responsible for recurring defects in this codebase.
const V2_KEYS = AGENT_SCHEMA_TABLE.v2.keys;
// `primary` is the actor HEAD names as PRIMARY. Provenance that anyone may write is not provenance:
// with only a shape check, appending `SCHEMA_SET agent/v2->agent/v1 by=STRANGER` demoted a board to
// v1 and let both actor files drop every mandatory key with no finding — the escape this whole item
// exists to close, reopened one level up. Migration is therefore one-way, singly-declared, and
// authored by the board's own PRIMARY.
function boardAgentSchema(events, primary) {
  let schema = null, provenance = false, opens = 0;
  const malformed = [];
  for (const e of events) {
    if (e.type === "OPEN") {
      opens++;
      const m = e.rest.match(/\bagent_schema=(\S+)/);
      if (!m) continue;
      provenance = true;
      // A second OPEN would give the board two origins; whichever won would be an accident of order.
      if (opens > 1) malformed.push("a second OPEN event declares agent_schema — a board has one origin");
      else if (AGENT_SCHEMAS.includes(m[1])) schema = m[1];
      else malformed.push(`OPEN agent_schema=${JSON.stringify(m[1])} is not one of ${AGENT_SCHEMAS.join(", ")}`);
    } else if (e.type === "SCHEMA_SET") {
      // An origin event cannot coherently follow its own migration. Without this the OPEN that
      // establishes the board's starting schema could be appended AFTER the SCHEMA_SET that
      // claims to move it, and the later OPEN then re-declared the origin.
      if (!opens) {
        provenance = true;
        malformed.push(`SCHEMA_SET appears before the OPEN event that establishes the board's schema`);
        continue;
      }
      provenance = true;
      const m = schemaSetEdge(e.rest);
      if (m) {
        const { from, to, by } = m;
        // The form now parses ONLY declared edges, so `from === to` and "not a supported migration"
        // are unreachable through it — a downgrade or a version skip fails to parse rather than
        // parsing and then being rejected. That is deliberate: one predicate decides what a
        // migration event IS, and the append path and this replay path both use it, so a hand-edit
        // cannot get past the writer and land somewhere the reader tolerates.
        if (primary && by !== primary)
          malformed.push(`SCHEMA_SET by=${by} but this board's PRIMARY is ${primary} — only the PRIMARY migrates the board`);
        // A migration that does not start where the board actually is would silently relabel it.
        else if ((schema || "v1") !== from)
          malformed.push(`SCHEMA_SET agent/${from}->agent/${to} does not follow from agent/${schema || "v1"}`);
        else schema = to;
        continue;
      }
      const shape = SCHEMA_SET_SHAPE.exec(e.rest);
      if (shape) {
        const [, sFrom, sTo] = shape;
        const legal = AGENT_SCHEMA_EDGES.map(([f, t2]) => `agent/${f}->agent/${t2}`).join(", ");
        malformed.push(sFrom === sTo
          ? `SCHEMA_SET agent/${sFrom}->agent/${sTo} is not a migration`
          : `SCHEMA_SET agent/${sFrom}->agent/${sTo} is not a supported migration (only ${legal})`);
        continue;
      }
      malformed.push(`SCHEMA_SET ${JSON.stringify(e.rest)} is not the documented "agent/<from>-\u003eagent/<to> by=<ACTOR>" form`);
    }
  }
  return { schema: schema || "v1", provenance, malformed };
}
function projectPoints(events) {
  const pts = new Map();
  const touch = (id) => { if (!pts.has(id)) pts.set(id, { id, status: "OPEN", resolvedIn: null }); return pts.get(id); };
  for (const e of events) {
    if (e.type === "TURN_COMMIT") {
      for (const id of pointsIds(e.rest)) touch(id);
    } else if (e.type === "POINT_SET") {
      // The projector and the check read ONE form. When the projector was the looser of the two,
      // it applied state from payloads the check had never approved.
      const m = POINT_SET_FORM.exec(e.rest);
      if (!m) continue;
      const inM = m[2] ? [null, m[2]] : null;
      for (const hit of m[1].split(" ").map((tok) => tok.split("="))) {
        const row = touch(hit[0]);
        // Only a TRANSITION resolves a point. Re-asserting a status already held leaves both the
        // status and the resolving turn where they are.
        if (row.status !== hit[1]) {
          row.status = hit[1];
          row.resolvedIn = hit[1] === "OPEN" ? null : (inM ? inM[1] : null);
        }
      }
    }
  }
  return [...pts.values()].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
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
    } else if (e.type === "STALL_HANDOFF") {
      // Rule 5 recovery: force the stalled actor ON_HOLD and the next= actor to START. Carries seq=
      // like a HANDOFF (it IS the hand-flip event for the stall case) — must be replayed, or a legal
      // recovery diverges from HEAD under L2.
      activated = true;
      const st = e.rest.match(/\bstalled=(\w+)/);
      const nx = e.rest.match(/\bnext=[^/\s]+\/(\w+)/);
      const sq = e.rest.match(/\bseq=(\d+)/);
      if (st && names.includes(st[1])) hands[st[1]] = "ON_HOLD";
      if (nx && names.includes(nx[1])) hands[nx[1]] = "START";
      if (sq) seq = Number(sq[1]);
    } else if (e.type === "GATE_SET") {
      const g = gateSetName(e.rest); if (g && g in gates) gates[g] = "YES";
    } else if (e.type === "PHASE_SET") {
      // §8 defines exactly one form. Treating ANY PHASE_SET as a move to IMPL meant a malformed or
      // reversed line advanced the phase anyway — the payload was documented and never read.
      if (PHASE_SET_FORM.test(e.rest)) phase = "IMPL";
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
// Rule 11's thresholds, or the reason the declared ones cannot be used. ABSENCE is the documented
// default and costs an existing board nothing. A MALFORMED value is NOT read as absence: a
// threshold that silently reads as "the default" when it is really a typo hands the operator a
// number they never set, and the misspelling becomes the way to move a limit without saying so.
function convergeThresholds(sessText) {
  const dup = duplicateKeys(sessText, ["Converge"]);
  if (dup.length)
    return { problem: `declares Converge ${dup[0].split(" ")[1]} — exactly one declaration is read, and the others sit there contradicting it` };
  const raw = SESSION.Converge(sessText);
  if (raw === null || raw === "") return { ...CONVERGE_DEFAULTS };
  const m = CONVERGE_FORM.exec(raw);
  if (!m)
    return { problem: `Converge is ${JSON.stringify(raw)} — it must read exactly "BARREN=<n>, CHURN=<n>" with both counts present` };
  const BARREN = Number(m[1]), CHURN = Number(m[2]);
  // A zero threshold is not "disabled", it is a check that fires on a board with no turns at all.
  // Whoever wants Rule 11 out of the way sets a large number and leaves the intent visible.
  if (BARREN < 1 || CHURN < 1)
    return { problem: `Converge declares BARREN=${BARREN}, CHURN=${CHURN} — both are counts of things that must happen, so neither can be zero` };
  return { BARREN, CHURN };
}
// A projector with no caller cannot be used by a manual recovery, so it is exposed as a read-only
// command. `recovery.md` ROLLBACK cites this instead of describing a replay that does not exist.
// ---------- migrate ----------
// Migration is EXPLICIT, never implicit: a board changes agent schema only when someone runs this,
// and the change is recorded in the log so the new grammar cannot afterwards be switched off by
// editing an actor file. It is ATOMIC BY RECOVERY rather than by transaction — the appended
// SCHEMA_SET is the commit point, so a crash after the file rewrites but before the event leaves a
// board that re-running completes, and a crash after the event leaves one that re-running no-ops.
// Nothing here truncates or reflows an actor's notes: every byte from the live PRIVATE_NOTES:
// delimiter onward is carried across verbatim.
function v2Header(headerLines) {
  // The header AS LINT WILL SEE IT — title, schema, and the ordered key names. Used both to detect
  // an already-migrated file and to refuse a file whose header cannot be mapped.
  const KEY_LINE = /^([A-Z_]+): (\S(?:.*\S)?)$/;
  const out = { title: null, schema: null, keys: new Map(), stray: [], schemaLines: 0 };
  for (const l of headerLines) {
    if (l.trim() === "") continue;
    if (/^# \S/.test(l)) { if (out.title === null) out.title = l; continue; }
    if (/^\s*SCHEMA\b/.test(l)) {
      out.schemaLines++;
      const m = /^SCHEMA: (\S(?:.*\S)?)$/.exec(l);
      if (m) out.schema = m[1];
      continue;
    }
    const m = KEY_LINE.exec(l);
    if (m) { if (!out.keys.has(m[1])) out.keys.set(m[1], m[2]); else out.stray.push(l); continue; }
    out.stray.push(l);
  }
  return out;
}

// ARCHIVE — move settled rows out of the file every turn reads. The rows do not leave the board;
// they leave the ACTOR's read-set. Every decision still reads the union, so nothing a gate, a
// citation or a reconciliation can see changes. That is the whole claim, and the gate-neutrality
// fixture proves it rather than asserting it.
function cmdArchive(opts) {
  const id = requireSession(opts);
  const root = opts.root;
  const dir = sessionDir(root, id);
  if (!exists(dir)) die(`archive: session ${id} not found`);
  const head = parseHead(readText(path.join(dir, "HEAD.md")));
  requireWritableHead("archive", id, head);
  const events = parseLog(readText(path.join(dir, "log.md")));
  const pts = loadPoints(dir);
  if (pts.duplicates.length)
    die(`archive: ${pts.duplicates.join(", ")} appears in both ${POINTS_HOT} and ${POINTS_COLD} - reconcile the two files before moving anything`);

  const age = pointAge(events);
  const eligible = pts.hot.filter((r) => {
    if (r.status === "OPEN") return false;                  // open work never leaves the hot file
    const n = age.turnsSettled(r.id);
    return n !== null && n >= ARCHIVE_AFTER_TURNS;
  });
  if (!eligible.length) {
    console.log(`Nothing to archive in ${id}: no settled row is older than ${ARCHIVE_AFTER_TURNS} turns.`);
    return;
  }

  const move = new Set(eligible.map((r) => r.id));
  const nl = /\r\n/.test(pts.hotText) ? "\r\n" : "\n";
  const kept = [], moved = [];
  for (const line of pts.hotText.split(/\r?\n/)) {
    const m = line.match(POINT_ROW_RE);
    if (m && move.has(m[1])) { moved.push(line); continue; }
    kept.push(line);
  }
  const header = [
    `# Point Archive — ${id}`,
    "SCHEMA: collab-board/points/v1",
    "",
    "<!-- Settled rows moved out of points.md so a turn does not re-read them. NOT a second tracker:",
    "     every decision - gates, citations, the log reconciliation - reads points.md and this file",
    "     together. An OPEN row here is a lint failure, and so is an id in both files. -->",
    "",
    "| ID | Part | Title | Status | Resolved In |",
    "|----|------|-------|--------|-------------|",
  ].join(nl);
  const existing = pts.coldText
    ? pts.coldText.split(/\r?\n/).filter((l) => POINT_ROW_RE.test(l))
    : [];
  const cold = header + nl + existing.concat(moved).join(nl) + nl;
  atomicWrite(pts.coldPath, cold);
  atomicWrite(pts.hotPath, kept.join(nl).replace(/(\r?\n)+$/, "") + nl);

  const before = Buffer.byteLength(pts.hotText, "utf8");
  const after = Buffer.byteLength(readText(pts.hotPath), "utf8");
  console.log(`Archived ${moved.length} settled row(s) from ${id}.`);
  console.log(`  ${POINTS_HOT}: ${before} -> ${after} B (-${before - after} B off every turn's read-set)`);
  console.log(`  moved: ${eligible.map((r) => r.id).join(", ")}`);
  console.log(`  verify: node "${process.argv[1]}" lint --session ${id}`);
}

function cmdMigrate(opts) {
  const id = requireSession(opts);
  const root = opts.root;
  const dir = sessionDir(root, id);
  if (!exists(dir)) die(`migrate: session ${id} not found`);
  const to = String(opts.to || "").replace(/^collab-board\//, "");
  const TARGETS = AGENT_SCHEMA_EDGES.map(([, x]) => "agent/" + x);
  if (!TARGETS.includes(to))
    die("migrate: --to must be one of " + TARGETS.join(", ") + " (got " + JSON.stringify(opts.to || "") + ")");
  const toVer = to.slice("agent/".length);

  const logFile = path.join(dir, "log.md");
  if (!exists(logFile)) die(`migrate: session ${id} has no log.md`);

  // HEAD is read FIRST: provenance is only provenance if its author is this board's PRIMARY, so
  // the check cannot run before we know who that is.
  const head = parseHead(readText(path.join(dir, "HEAD.md")));
  requireWritableHead("migrate", id, head);

  requireContractIdentity("migrate", dir, id, head);

  const prov = boardAgentSchema(parseLog(readText(logFile)), head.byRole.PRIMARY.name);
  // Ambiguous provenance is not a starting point for a migration — writing a SCHEMA_SET on top of
  // it would make the ambiguity permanent.
  if (prov.malformed.length)
    die("migrate: log.md agent-schema provenance is malformed - " + prov.malformed.join("; ") + "; fix log.md first");

  // Refuse an undeclared migration BEFORE touching anything. Every other refusal in this command is
  // per-file and happens before its own write; this one is about the BOARD, so it belongs here.
  if (!(prov.provenance && prov.schema === toVer)
      && !schemaSetEdge(`agent/${prov.schema}->${to} by=${head.byRole.PRIMARY.name}`))
    die(`migrate: agent/${prov.schema} -> ${to} is not a declared migration (only ${AGENT_SCHEMA_EDGES.map(([f, x]) => "agent/" + f + "->agent/" + x).join(", ")})`);

  const targets = head.state.map((st) => ({ actor: st.name, file: path.join(dir, "agents", `${st.name.toLowerCase()}.md`) }));
  for (const t of targets)
    if (!exists(t.file)) die(`migrate: agents/${path.basename(t.file)} is missing - every actor in HEAD.md must have an actor file`);

  const pending = [];
  for (const t of targets) {
    const reg = actorRegions(t.file);
    const h = v2Header(reg.headerLines);
    // "Already migrated" must mean exactly what LINT means by it. Deciding it on key NAMES while
    // lint decided it on key VALUES let migrate skip a file with SELF_HAND: BUSY, commit the
    // SCHEMA_SET, and produce a board whose very next lint FAILed on that file.
    if (h.schema === "collab-board/agent/" + toVer
        && !headerProblems(toVer, reg.headerLines, reg.markerLf).length)
      continue;
    if (reg.markerLf < 0)
      die(`migrate: agents/${path.basename(t.file)} has no live PRIVATE_NOTES: delimiter - add one first so the discretionary region is unambiguous; migrating without it would have to guess where the notes begin`);
    if (h.schemaLines > 1 || (h.schema !== null && h.schema !== "collab-board/agent/v1" && h.schema !== "collab-board/agent/v2"))
      die(`migrate: agents/${path.basename(t.file)} has an unresolvable SCHEMA declaration - run \`lint --session ${id}\` and fix it first`);

    // v1 wrote "-" for "nothing yet"; v2 spells it NONE so every key has a parseable value.
    const rawHand = h.keys.get("SELF_HAND");
    const hand = rawHand === undefined || rawHand === "-" ? "NONE" : rawHand;
    if (!["START", "WORKING", "ON_HOLD", "DONE", "NONE"].includes(hand))
      die(`migrate: agents/${path.basename(t.file)} SELF_HAND=${JSON.stringify(rawHand)} is not a hand - refusing to guess`);
    const rawLast = h.keys.get("LAST_TURN_WRITTEN");
    const last = rawLast === undefined || rawLast === "-" ? "NONE" : rawLast;
    if (last !== "NONE" && !/^[PI][1-9][0-9]*$/.test(last))
      die(`migrate: agents/${path.basename(t.file)} LAST_TURN_WRITTEN=${JSON.stringify(rawLast)} is not a turn id - refusing to guess`);
    // Any key beyond the two v1 carried is content this migration has no mapping for. Dropping it
    // silently would lose state; the operator decides.
    // Lines that are not keys at all are content this migration also has no mapping for. Refusing
    // on unknown KEYS while silently dropping unknown LINES is the same loss with a narrower door.
    if (h.stray.length)
      die(`migrate: agents/${path.basename(t.file)} has header line(s) agent/v2 has no place for, e.g. ${JSON.stringify(h.stray[0].trim().slice(0, 60))} - move them into PRIVATE_NOTES first rather than have this command discard them`);
    const unknown = [...h.keys.keys()].filter((k) => !V2_KEYS.includes(k));
    if (unknown.length)
      die(`migrate: agents/${path.basename(t.file)} carries key(s) [${unknown.join(", ")}] that agent/v2 has no place for - move them into PRIVATE_NOTES first rather than have this command discard them`);

    const title = h.title || `# ${t.actor} self-state — ${id}`;
    if (toVer !== "v2") {
      // The source must be EXACTLY the predecessor grammar. That single requirement carries every
      // refusal this migration owes: a malformed retained value, a missing key, a stray line and a
      // wrong-shaped header are all already failures of the v2 grammar, so there is no second list
      // of refusal rules here to drift from the first.
      const from = AGENT_SCHEMA_TABLE[toVer].from;
      const bad = headerProblems(from, reg.headerLines, reg.markerLf);
      if (bad.length)
        die(`migrate: agents/${path.basename(t.file)} is not exactly agent/${from} - ${bad[0]}; run \`lint --session ${id}\` and fix it first, this command will not guess`);
      const header = [title, `SCHEMA: collab-board/agent/${toVer}`, ""]
        .concat(AGENT_SCHEMA_TABLE[toVer].keys.map((k) => `${k}: ${h.keys.get(k)}`))
        .concat(["", ""]).join("\n");
      const keepFrom0 = reg.raw.lastIndexOf(Buffer.from("PRIVATE_NOTES:"), reg.markerLf);
      pending.push({ file: t.file, buf: Buffer.concat([Buffer.from(header, "utf8"), retireBoilerplate(reg.raw.slice(keepFrom0))]) });
      continue;
    }
    const header = [
      title,
      "SCHEMA: collab-board/agent/v2",
      "",
      `SELF_HAND: ${hand}`,
      `LAST_TURN_WRITTEN: ${last}`,
      `ACTIVE_RECOVERY: ${h.keys.get("ACTIVE_RECOVERY") || "NONE"}`,
      `EXECUTOR_THREAD: ${h.keys.get("EXECUTOR_THREAD") || "NONE"}`,
      `UNRESOLVED_CONCERNS: ${h.keys.get("UNRESOLVED_CONCERNS") || "NONE"}`,
      "",
      "",
    ].join("\n");
    // Everything from the delimiter line onward is the actor's own bytes, copied not re-encoded.
    const keepFrom = reg.raw.lastIndexOf(Buffer.from("PRIVATE_NOTES:"), reg.markerLf);
    pending.push({ file: t.file, buf: Buffer.concat([Buffer.from(header, "utf8"), reg.raw.slice(keepFrom)]) });
  }

  if (prov.provenance && prov.schema === toVer) {
    // Already committed to v2. A file that still is not v2-shaped is a lint finding to fix, not
    // something to rewrite behind the operator's back on a board that already declared itself.
    if (pending.length)
      die(`migrate: session ${id} is already ${to}, but ${pending.map((x) => "agents/" + path.basename(x.file)).join(", ")} does not match the ${toVer} grammar - run \`lint --session ${id}\` and fix the file(s); migrate will not overwrite them`);
    console.log(`Session ${id} is already ${to} (log records the migration); nothing to do.`);
    return;
  }

  for (const x of pending) atomicWrite(x.file, x.buf);
  // The event is appended LAST and is the commit point. A death before it leaves provenance where
  // it was and the files in the target shape, which the idempotent skip above completes on a rerun.
  // The edge was validated before the first write, so there is no second check here to disagree.
  appendEvent(logFile, `${nowIso()} SCHEMA_SET agent/${prov.schema}->${to} by=${head.byRole.PRIMARY.name}`);
  console.log(`Session ${id} migrated agent/${prov.schema} -> ${to}.`);
  console.log(pending.length
    ? `  rewrote ${pending.length} actor file(s); PRIVATE_NOTES preserved byte-for-byte`
    : `  actor files were already ${toVer}-shaped; recorded the migration in log.md`);
  console.log(`  verify: node "${process.argv[1]}" lint --session ${id}`);
}
// ---------- relay ----------
// The PRIMARY does not RE-AUTHOR a secondary's prose. For a single capture this command copies the
// TURN block byte for byte; for several it writes the fused shard the manager composed, and its
// job becomes proving that every contributor is present and unedited. In both cases the PRIMARY
// owns the timestamps — the secondary's clock ran earlier, and log timestamps must stay monotonic
// with the actual writes.
function cmdRelay(opts) {
  const id = requireSession(opts);
  const root = opts.root;
  const dir = sessionDir(root, id);
  if (!exists(dir)) die(`relay: session ${id} not found`);

  const head = parseHead(readText(path.join(dir, "HEAD.md")));
  requireWritableHead("relay", id, head);
  requireContractIdentity("relay", dir, id, head);

  const sessText = readText(path.join(dir, "SESSION.md"));
  const bw = boardWriteMode(sessText);
  if (bw.problem) die(`relay: ${bw.problem}`);
  // A MALFORMED ROSTER IS NOT AN ABSENT ONE. `secondaryPanel` reports `problem` for a panel of one,
  // a name that is not an executor, or two entries resolving to one label — and every caller read
  // the null `panel` and threw the reason away, so a broken declaration became "no roster
  // declared". After the absence rules landed that is load-bearing: no-roster is the branch where
  // the product's contributor axis falls back to whoever arrived, and where the gate denominator
  // falls back to the captures the PRIMARY chose to supply. lint sees the malformation, but only
  // after the relay has written the turn and the gate.
  const panelCheck = secondaryPanel(sessText, null);
  if (panelCheck.problem)
    die(`relay: ${panelCheck.problem}. Fix SESSION.md before relaying — a malformed roster would otherwise be read as no roster at all, which is the branch where the product axis and the gate denominator both fall back to whatever was supplied.`);
  if (bw.mode !== "PRIMARY_ONLY")
    die(`relay: session ${id} is not a PRIMARY_ONLY session. Relay is the write path for sole-writer mode; add \`BoardWriteMode: PRIMARY_ONLY\` to SESSION.md to opt in, or let the secondary write its own turn as usual.`);

  const files = (opts.capture || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!files.length) die("relay: --capture <file>[,<file>...] is required (one relay/v1 capture per contributing secondary)");
  const fused = opts.fused || null;
  if (files.length > 1 && !fused)
    die("relay: several captures were given, so --fused <file> is required. The PRIMARY composes the fused shard; this command will not invent one, and will not silently relay only the first contributor.");

  // A single capture is COPIED, never re-authored (see the note above cmdRelay). `--fused` with
  // one capture is therefore not a fusion, it is the PRIMARY substituting its own words for the
  // secondary's under the secondary's name — and it produced a shard byte-for-byte as
  // well-attested as an honest one, on the DEFAULT single-secondary path. The old guard here
  // (`body !== caps[0].turnBlock`) could never fire: inside `if (!fused)`, body IS that value.
  if (fused && files.length === 1)
    die("relay: --fused takes two or more captures. With one capture the turn block is copied byte for byte; supplying a fused body would substitute the PRIMARY's words for the secondary's under the secondary's name. Re-delegate instead, or relay the capture as it stands.");

  const caps = [];
  for (const f of files) {
    if (!isBoardFile(f)) die(`relay: capture is not a readable file: ${f}`);
    const raw = fs.readFileSync(f);
    const r = parseRelay(raw.toString("utf8"));
    if (r.problem) die(`relay: ${f}: ${r.problem}`);
    if (r.session !== id) die(`relay: ${f} declares SESSION ${r.session} but this is ${id}`);
    caps.push({ file: f, raw, sha: sha256(raw), ...r });
  }
  const turn = caps[0].turn;
  // The turn id is a SECONDARY-supplied string that this command is about to put in a filesystem
  // path and (previously) in a RegExp. Unvalidated it accepted `../../../../ESCAPED`, which wrote
  // a shard clean outside the board at exit 0; `P2(` threw an uncaught SyntaxError so the command
  // reported nothing at all; and `T2` produced a turn no id-keyed check could ever see.
  if (!TURN_ID.test(turn))
    die(`relay: capture declares TURN ${JSON.stringify(turn)}, which is not a turn id (${TURN_ID_SRC}). A turn id names a file and keys every check; anything else is not a turn.`);
  for (const c of caps)
    if (c.turn !== turn) die(`relay: captures disagree about the turn id (${caps.map((x) => x.turn).join(", ")}) — a fused turn is ONE turn`);
  const sec = head.byRole.SECONDARY.name;
  for (const c of caps)
    if (c.actor.toUpperCase() !== sec.toUpperCase())
      die(`relay: ${c.file} declares ACTOR ${c.actor} but this board's SECONDARY is ${sec}`);

  // A capture may carry only the events its own author is entitled to record. Everything else in
  // §8 belongs to the PRIMARY: a capture carrying `REFRAME by=<PRIMARY>` relayed at exit 0 and
  // landed a PRIMARY-attributed step-back that bought the SECONDARY a fresh convergence window —
  // the one event Rule 11 reserves, authored by the party whose loop is under review.
  for (const c of caps)
    for (const line of c.logLines) {
      const type = (line.match(/^([A-Z_]+)\b/) || [])[1] || line.split(/\s+/)[0];
      if (type === "POINT_SET") continue;
      if (type === "GATE_SET") {
        // ONE reader decides what a GATE_SET names, and it is `gateSetName` — the same predicate
        // the log projector and Rule 11's counter share. This site and the partition below each
        // had their OWN regex, and they did not even agree with each other (`[A-Z_]+` vs
        // `[A-Za-z_]+`); neither checked membership in GATE_NAMES, so `FOO_SECONDARY=YES` passed
        // entitlement here, passed the partition, landed in the log, and was silently ignored by
        // the projector — a gate event that no gate check could ever see.
        const rest = line.replace(/^GATE_SET\s+/, "");
        const name = gateSetName(rest);
        const by = /\bby=([A-Za-z0-9_]+)/.exec(rest);
        // A capture may consent only for the phase the board is IN. A unanimous
        // IMPL_AGREE_SECONDARY offered during PLAN would pre-consent to a review that has not
        // happened, and `advance` would cross into IMPL with the far side already agreed.
        const forPhase = name && name.startsWith(head.phase + "_");
        if (name && forPhase && /_SECONDARY$/.test(name) && by && by[1].toUpperCase() === c.actor.toUpperCase()) continue;
        if (name && !forPhase)
          die(`relay: ${c.file} offers ${name} while the board is in phase ${head.phase}. A capture may consent only for the phase the board is in — an IMPL gate offered during PLAN pre-consents a review that has not happened.`);
        die(`relay: ${c.file} LOG line ${JSON.stringify(line)} is not this contributor's own SECONDARY gate. A capture may set only \`GATE_SET <gate>_SECONDARY=YES by=${c.actor}\`; the PRIMARY's gates are the PRIMARY's to set.`);
      }
      die(`relay: ${c.file} LOG line ${JSON.stringify(line)} is a ${type} event. A capture may carry only POINT_SET and its own *_SECONDARY GATE_SET — every other event type is the PRIMARY's to write.`);
    }

  // The START token is the mutex (§3), and a relay writes a SECONDARY turn — so the SECONDARY must
  // be the actor holding it, exactly as `advance` requires the PRIMARY to hold it before crossing
  // the phase. Without this the command would write a secondary turn onto a board where it was
  // never that actor's turn: on a freshly scaffolded board (both hands ON_HOLD) every probe above
  // relayed happily. The mode changes who WRITES the bytes, never whose TURN it is.
  const secHand = head.byRole.SECONDARY.hand;
  if (secHand !== "START" && secHand !== "WORKING")
    die(`relay: HEAD.md has ${sec} at ${secHand}, not START — a relay writes ${sec}'s turn, so it is only legal while ${sec} holds the turn. Run \`lint --session ${id}\` and check whose turn it is.`);

  const shardName = `${turn}-${sec.toLowerCase()}.md`;
  const shardPath = path.join(dir, "turns", shardName);
  if (exists(shardPath)) die(`relay: turns/${shardName} already exists — a relay never overwrites a turn`);

  // Resolve every retained-capture name and refuse a collision BEFORE anything is written. Two
  // contributors whose capture files shared a basename silently retained as one file: the second
  // overwrote the first, and the lost contributor's bytes were the only record of what it said.
  for (const c of caps) {
    c.who = path.basename(c.file).replace(/\.relay$/, "");
    if (c.who.startsWith(turn + "-")) c.who = c.who.slice(turn.length + 1);
    if (!ACTOR_TOKEN.test(c.who))
      die(`relay: capture ${c.file} yields contributor name ${JSON.stringify(c.who)}, which is not ${TOKEN_SRC}. Name each capture <TURN_ID>-<contributor>.relay — that is the grammar lint re-discovers retained captures by, and a name outside it is retained but invisible to the check.`);
    c.retainAs = `${turn}-${c.who}.relay`;
  }
  for (const c of caps) {
    // Compared CASE-INSENSITIVELY, because `retainAs` becomes a FILENAME and the filesystems this
    // runs on are not case-sensitive (Windows always; macOS by default). `P2-agy.relay` and
    // `P2-AGY.relay` are two distinct STRINGS and one FILE, so an exact comparison saw no twin,
    // both passed, and the second atomicWrite destroyed the first contributor's bytes — the exact
    // loss this guard was written to prevent, reached from outside the comparison it reasoned in.
    // Refusing the pair is right even on a case-sensitive filesystem: a board whose captures
    // survive or vanish depending on the host is not a fidelity record.
    const twin = caps.find((o) => o !== c && o.retainAs.toLowerCase() === c.retainAs.toLowerCase());
    if (twin) die(`relay: ${c.file} and ${twin.file} would both be retained as captures/${c.retainAs}, so one contributor's bytes would be destroyed by the other. Give each capture a distinct <TURN_ID>-<contributor>.relay name (names differing only in CASE are the same file on Windows and macOS).`);
    const already = path.join(captureDir(dir), c.retainAs);
    // A re-run after a crash must still succeed, so an existing capture with IDENTICAL bytes is
    // fine; only differing bytes are a collision.
    if (exists(already) && sha256(fs.readFileSync(already)) !== c.sha)
      die(`relay: captures/${c.retainAs} already exists with different content. Reconcile the earlier attempt before relaying over it.`);
  }
  // Two captures with IDENTICAL bytes are one contributor's work filed twice, not two contributors.
  // Every count derived from the contributor set — `contributors=`, the fusion attribution check,
  // and above all the gate denominator — read the number of FILES, so the same capture under two
  // names presented as a 2-of-2 seat. `L25` could not see it either: its retained-capture map is
  // keyed by hash, so the duplicate collapses there and the count it compares against does not.
  for (const c of caps) {
    const twin = caps.find((o) => o !== c && o.sha === c.sha);
    if (twin)
      die(`relay: ${c.file} and ${twin.file} are byte-identical, so they are one contributor's capture filed under two names, not two contributors. Every count derived from the contributor set — including whether a gate is unanimous — would read them as two.`);
  }

  // THE CROSS PRODUCT, enforced rather than declared. The SECONDARY fan-out for a turn is
  // |disjoint scopes| x |roster contributors|: every contributor works every scope, independently.
  // The two axes buy different things and the product is the only arrangement that spends nothing
  // on the pair that buys neither — different scopes with one model is COVERAGE, the same scope
  // across models is DECORRELATION, and the same model on the same scope twice is one reviewer
  // billed twice, which the product never produces.
  //
  // A contributor opts in by NAMING its cell: `<MODEL>_S<n>` (CODEX_S1, CLAUDE_S2). The suffix is
  // `_S` plus digits, so a FAMILY name like CLAUDE_2 is not mistaken for a scope. If no capture
  // carries a cell, the turn is an ordinary one-scope turn and nothing below applies — the
  // degenerate case stays byte-identical, which is the same rule the whole refactor runs on.
  //
  // The product must be COMPLETE: every model x every scope is present, or explicitly declared
  // absent with `--absent`. A hole nobody declared is a contributor that silently did not run, and
  // the fused turn would read as a full sweep. `--absent` is what makes a usage limit or a failed
  // dispatch cost ONE CELL instead of the turn — and it is recorded on the TURN_COMMIT, so the gap
  // is in the log rather than only in the PRIMARY's memory.
  const cellOf = (w) => { const m = /^(.+)_S(\d+)$/.exec(w); return m ? { model: m[1], scope: m[2] } : null; };
  const cells = caps.map((c) => ({ who: c.who, cell: cellOf(c.who) }));
  const scoped = cells.filter((x) => x.cell);
  let fanTok = "";
  if (scoped.length) {
    if (scoped.length !== cells.length)
      die(`relay: ${scoped.length} of ${cells.length} captures name a scope cell (<MODEL>_S<n>) and the rest do not (${cells.filter((x) => !x.cell).map((x) => x.who).join(", ")}). A turn is either a cross-product sweep or a single scope; a mixture means some contributor's coverage is unstated.`);
    // THE MODEL AXIS COMES FROM THE DECLARED ROSTER, NOT FROM THE CAPTURES THAT ARRIVED. Deriving
    // it from the captures made the product's shape depend on who actually ran — so a contributor
    // that did not run was removed from the product it was supposed to be in, and `--absent` for it
    // was rejected as "not a cell of this turn". Measured on the exact scenario the feature exists
    // for: a usage-limited CODEX on a `codex-cli,claude-cli` board could not be declared absent,
    // because its absence had already shrunk the product to 1x1. Same class as the gate denominator
    // — a shape derived from what the checked party supplied is not a check on it. Scopes stay
    // capture-derived: the decomposition IS a per-turn property, and nothing else declares it.
    // A MALFORMED ROSTER IS NOT AN ABSENT ONE. `secondaryPanel` reports `problem` for a panel of
    // one, a non-executor name, or two entries resolving to one label - and every caller here threw
    // it away and read the null `panel` as "no roster declared". After the absence rules landed
    // that became load-bearing: a board whose declaration is broken silently became a board with no
    // declaration, which is the branch where the product axis falls back to whoever arrived. lint
    // catches the malformation, but only AFTER the relay has written the turn and the gate.
    const rosterHere = secondaryPanel(sessText, head.byRole.PRIMARY && head.byRole.PRIMARY.name).panel;
    const declaredLabels = rosterHere ? [...new Set(rosterHere.map((a) => CLI_EXECUTORS[a]))] : null;
    const models = declaredLabels && declaredLabels.length
      ? declaredLabels
      : [...new Set(scoped.map((x) => x.cell.model))];
    const scopes = [...new Set(scoped.map((x) => x.cell.scope))].sort();
    for (const x of scoped)
      if (!models.includes(x.cell.model))
        die(`relay: capture ${x.who} names contributor ${x.cell.model}, which this board's SecondaryPanel does not declare (${models.join(", ")}). A contributor that is not on the roster has no cell in the product.`);
    const absent = String(opts.absent === undefined ? "" : opts.absent).split(",").map((s) => s.trim()).filter(Boolean);
    // THE MIRROR OF THE PLAIN-RELAY RULE, and it was left open one branch over. Without a declared
    // roster the model axis falls back to the contributors that ARRIVED, so the PRIMARY shapes the
    // product AND punches the holes in it: every absence is then checked against a shape derived
    // from the same choice it is meant to constrain, and no declaration exists that could falsify
    // it. A null roster is the absence of a rule, never permission — the same sentence that closed
    // the plain half, which is why leaving this one open was a symmetry half-fixed rather than a
    // separate defect. Note what stays legal: a sweep with no roster still relays, because the
    // product it declares is checked against its own retained captures by L25. Only the ABSENCE,
    // whose whole meaning is "a contributor the board expected did not come", needs the board to
    // have expected someone.
    if (absent.length && !(declaredLabels && declaredLabels.length))
      die(`relay: --absent names ${absent.join(", ")}, but this board declares no SecondaryPanel, so the product's contributor axis is derived from the captures that arrived. An absence would then be checked against a shape chosen by the same party it constrains. Declare the roster the sweep was meant to cover, or relay without an absence.`);
    const present = new Set(scoped.map((x) => x.who));
    for (const a of absent) {
      const c = cellOf(a);
      if (!c || !models.includes(c.model) || !scopes.includes(c.scope))
        die(`relay: --absent names ${JSON.stringify(a)}, which is not a cell of this turn's ${models.length} x ${scopes.length} product. Declare an absence only for a cell the sweep was meant to cover.`);
      if (present.has(a))
        die(`relay: --absent names ${a}, but a capture for it was supplied. An absence and a capture are contradictory claims about the same cell.`);
    }
    const absentSet = new Set(absent);
    const holes = [];
    for (const m of models) for (const s of scopes) {
      const label = `${m}_S${s}`;
      if (!present.has(label) && !absentSet.has(label)) holes.push(label);
    }
    if (holes.length)
      die(`relay: the ${models.length} x ${scopes.length} product has ${holes.length} cell(s) with neither a capture nor a declared absence: ${holes.join(", ")}. Every contributor works every scope; an undeclared hole makes a partial sweep read as a full one. Supply the capture, or declare it with --absent ${holes[0]}.`);
    fanTok = ` scopes=${scopes.length} contributors_declared=${models.length}`
      + (absent.length ? ` absent=${absent.slice().sort().join(",")}` : "");
  }

  // The plain-relay half of `--absent`: name a DECLARED contributor that did not run. The cross
  // product above owns the cell form; this owns the ordinary roster turn, and between them there
  // is no shape of fan-out where a blocked contributor has to go unrecorded.
  if (!fanTok) {
    const plainAbsent = String(opts.absent === undefined ? "" : opts.absent).split(",").map((s) => s.trim()).filter(Boolean);
    if (plainAbsent.length) {
      const roster = secondaryPanel(sessText, head.byRole.PRIMARY && head.byRole.PRIMARY.name).panel;
      const labels = roster ? [...new Set(roster.map((a) => CLI_EXECUTORS[a]))] : null;
      const here = new Set(caps.map((c) => String(c.who).toUpperCase()));
      for (const a of plainAbsent) {
        if (!/^[A-Za-z0-9_]+$/.test(a))
          die(`relay: --absent ${JSON.stringify(a)} is not a contributor label. On a turn that is not a cross-product sweep, --absent names a DECLARED contributor that did not run.`);
        // AN UNDECLARED BOARD HAS NO CONTRIBUTOR TO BE ABSENT. Accepting any label there let a
        // relay log an absence for a contributor the board never expected - a free token that
        // reads as a declared roster member having been blocked, on the one kind of board where
        // no roster exists to check it against. `labels` being null is the absence of a rule,
        // never permission.
        if (!labels)
          die(`relay: --absent names ${a}, but this board declares no SecondaryPanel, so it expected no contributor by that name. An absence is only meaningful against a declared roster.`);
        if (!labels.some((l) => String(l).toUpperCase() === a.toUpperCase()))
          die(`relay: --absent names ${a}, which this board's SecondaryPanel does not declare (${labels.join(", ")}). An absence is only meaningful for a contributor the board expected.`);
        if (here.has(a.toUpperCase()))
          die(`relay: --absent names ${a}, but a capture from it was supplied. An absence and a capture are contradictory claims about the same contributor.`);
      }
      fanTok = " absent=" + plainAbsent.slice().sort().join(",");
    }
  }

  // Read and check the fused body before retaining anything. `--fused` pointing at a directory
  // used to surface a raw EISDIR from deep inside fs — after the captures were already on disk,
  // leaving exactly the orphan state nothing looks for.
  let body;
  if (fused) {
    if (!isBoardFile(fused)) die(`relay: --fused is not a readable file: ${fused}`);
    body = readText(fused);
    for (const c of caps)
      if (!new RegExp("\\b" + c.who + "\\b", "i").test(body))
        die(`relay: the fused shard never names ${c.who}, whose capture is being relayed. Every contributor must be attributed, or the fusion is unattributable prose.`);
  } else {
    body = caps[0].turnBlock;
  }
  // A point the table has no row for needs a title, and that is a VALIDATION — it belongs above
  // the first write with everything else. Putting the check next to the points.md write left it
  // firing after the shard was already on disk and the captures already retained, which is the
  // half-written board this command's whole structure exists to prevent. My own new code broke
  // the invariant I had just added; the fixture that caught it is the one asserting a refusal
  // leaves captures/ empty.
  // A point Status is a single adjudicated DECISION, not mergeable data. Contributors PROPOSE one;
  // only the PRIMARY's fused turn DECIDES. Reducing N disagreeing proposals with a last-wins Map
  // made ARRIVAL ORDER the adjudicator, and the discarded ruling was invisible to EVERY check —
  // because the Map and the log replay both took the last and therefore agreed, so lint PASSED on
  // a board that had silently dropped a contributor's verdict. Measured on this repo's own board:
  // three contributors, two disputed points, no finding anywhere.
  const proposals = new Map();                       // id -> [{ who, status, title }]
  const propose = (who, id, status, title) => {
    if (!proposals.has(id)) proposals.set(id, []);
    proposals.get(id).push({ who, status, title: title || "" });
  };
  for (const c of caps) {
    for (const p of c.points) propose(c.who, p.id, p.status, p.title);
    // A capture may ALSO state a proposal as a POINT_SET line in `--- LOG ---`, which the grammar
    // has always permitted. Both sections are the SAME contributor speaking, so both are folded in
    // here — if they disagree, that contributor contradicted itself and the dispute check below
    // refuses rather than picking a section to believe. Reading only `--- POINTS ---` (what this
    // did before) meant a capture declaring its points ONLY in the LOG got its event appended and
    // NO points.md row: measured on the old engine, that relayed at exit 0 and left
    // `FAIL L2 log projects point P1 but points.md has no such row`.
    for (const line of c.logLines) {
      const m = /^POINT_SET\s+(.*)$/.exec(line);
      if (!m) continue;
      const f = POINT_SET_FORM.exec(m[1]);
      if (!f) die(`relay: ${c.file} LOG line ${JSON.stringify(line)} is not the §8 POINT_SET form ("<id>=<STATUS> [...] [in=<turn-id>]"), so the statuses it proposes cannot be read.`);
      for (const tok of f[1].split(" ")) { const kv = tok.split("="); propose(c.who, kv[0], kv[1], ""); }
    }
  }
  // `--resolve <id>=<STATUS>` is the PRIMARY adjudicating a dispute EXPLICITLY. It is accepted ONLY
  // for a genuinely disputed id: an unrestricted override would be a silent channel for restating a
  // contributor's ruling under its own name, which is exactly what `--fused` already refuses to let
  // the relay do to a turn BODY. The same reasoning applied to the status field.
  const resolved = new Map();
  for (const tok of String(opts.resolve === undefined ? "" : opts.resolve).split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([PI][0-9]+)=(\w+)$/.exec(tok);
    if (!m) die(`relay: --resolve ${JSON.stringify(tok)} is not "<id>=<STATUS>".`);
    if (!POINT_STATUSES.includes(m[2]))
      die(`relay: --resolve ${tok} names status ${m[2]}, which is not one of ${POINT_STATUSES.join(", ")}.`);
    resolved.set(m[1], m[2]);
  }
  // AN ID IS AN IDENTITY, AND MERGING TWO IDENTITIES DESTROYS A FINDING. Contributors run in
  // parallel and each takes the next free id, so two of them raise DIFFERENT findings under the
  // same new id — three times on the board that added this. The relay kept the FIRST title and
  // dropped the rest, which is arrival order deciding what a review found. That is the same defect
  // class as letting arrival order decide a status, and it gets the same shape: refuse, and make
  // the PRIMARY adjudicate explicitly. Renumbering moves an id, never a ruling or a title — the
  // contributor's own words stay in its retained capture and its finding survives under a free id.
  const renumbered = new Map();                                   // "<id>:<who>" -> newId
  for (const tok of String(opts.renumber === undefined ? "" : opts.renumber).split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([PI][0-9]+):([A-Za-z0-9_]+)=([PI][0-9]+)$/.exec(tok);
    if (!m) die(`relay: --renumber ${JSON.stringify(tok)} is not "<id>:<contributor>=<newid>".`);
    if (m[1][0] !== m[3][0])
      die(`relay: --renumber ${tok} moves ${m[1]} to a ${m[3][0] === "P" ? "PLAN" : "IMPL"} id while the point was raised as ${m[1][0] === "P" ? "PLAN" : "IMPL"}. A renumber frees an id; it does not move a point between phases.`);
    if (renumbered.has(`${m[1]}:${m[2]}`))
      die(`relay: --renumber names ${m[1]}:${m[2]} more than once.`);
    renumbered.set(`${m[1]}:${m[2]}`, m[3]);
  }
  // THE OTHER HALF OF THE SAME ADJUDICATION. A collision is refused because the relay cannot tell
  // two findings filed under one id from ONE finding two contributors worded differently — and the
  // second is the more common case, because independent reviewers reaching the same conclusion
  // almost never phrase it identically. Refusing was right; offering only `--renumber` was not,
  // because it forced genuine corroboration to be recorded as two points. `--merge <id>:<who>`
  // says: this contributor's proposal is the SAME finding as the one the id keeps. Its status still
  // counts (a merged contributor can still dispute), only its wording is dropped, and `merged=`
  // records that a PRIMARY judged two wordings to be one finding rather than a rule discovering it.
  const merged = new Set();
  for (const tok of String(opts.merge === undefined ? "" : opts.merge).split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([PI][0-9]+):([A-Za-z0-9_]+)$/.exec(tok);
    if (!m) die(`relay: --merge ${JSON.stringify(tok)} is not "<id>:<contributor>".`);
    if (renumbered.has(`${m[1]}:${m[2]}`))
      die(`relay: --merge and --renumber both name ${m[1]}:${m[2]}. They are contradictory claims about one proposal — either it is the same finding as the id's, or it is a different one needing its own id.`);
    merged.add(`${m[1]}:${m[2]}`);
  }
  // A DISPUTE is two CONTRIBUTORS disagreeing. One contributor disagreeing with ITSELF between its
  // `--- POINTS ---` and its `--- LOG ---` is a MALFORMED capture, and conflating the two let a
  // SINGLE capture unlock `--resolve` — landing a status neither of its own sections stated, under
  // the SECONDARY's name, on the path whose entire doctrine is copy-never-re-author. Refused here,
  // before `distinct` is computed, so the adjudication path can only ever be reached by a genuine
  // cross-contributor disagreement. The precedent is this board's own: a contributor's illegal
  // capture is RE-DELEGATED, never repaired.
  for (const [id, props] of proposals) {
    const byWho = new Map();
    for (const p of props) {
      if (!byWho.has(p.who)) byWho.set(p.who, new Set());
      byWho.get(p.who).add(p.status);
    }
    for (const [who, statuses] of byWho)
      if (statuses.size > 1)
        die(`relay: capture ${who} contradicts itself about ${id}, proposing ${[...statuses].sort().join(" and ")} in its own two sections. That is a malformed capture, not a dispute to adjudicate — re-delegate the turn rather than resolving it here.`);
    // The same rule for TITLES, which comparing statuses alone missed. The cross-contributor
    // collision check disentangles two findings filed under one id by two contributors; a capture
    // naming one id twice under two titles has the second dropped by first-wins, one scope down
    // from where that was fixed. Same defect, same answer: re-delegate, never repair.
    const titleByWho = new Map();
    for (const p of props) {
      if (!p.title) continue;
      if (!titleByWho.has(p.who)) titleByWho.set(p.who, new Set());
      titleByWho.get(p.who).add(p.title);
    }
    for (const [who, titles] of titleByWho)
      if (titles.size > 1)
        die(`relay: capture ${who} gives ${id} two different titles in its own sections (${[...titles].map((x) => JSON.stringify(x)).join(" and ")}). One capture naming one id twice is two findings under one name, and keeping the first would drop the second. Re-delegate the turn rather than choosing for it.`);
  }
  // Read points.md ONCE, here, through the CANONICAL reader — the collision test below needs to
  // know whether an id already names a point, and the row-creation check further down needs the
  // same answer. Two readers of one question is the defect class this codebase keeps producing.
  const pFile = path.join(dir, "points.md");
  const pText = exists(pFile) ? readText(pFile) : "";
  const liveRows = parsePoints(pText);
  const liveIds = new Set(liveRows.map((r) => r.id));                        // taken
  const liveNamed = new Set(liveRows.filter((r) => (r.title || "").trim()).map((r) => r.id));   // named
  const relayPoints = [], disputed = [], collided = [], renumberUsed = new Set(), mergeUsed = new Set();
  for (const [id, props] of proposals) {
    const decided = resolved.get(id);
    // A COLLISION is two contributors giving one NEW id two different titles — they are not ruling
    // on one point, they are filing two findings under one name. On an id that already names a
    // point there is nothing to collide: the row exists and its title is not a capture's to
    // restate. Empty titles are not evidence — a contributor ruling on an existing point supplies
    // none — so only DISTINCT non-empty titles count.
    //
    // THIS RUNS BEFORE THE DISPUTE TEST, and the order is load-bearing. While two findings share an
    // id, "the contributors disagree about P27" is not a true statement about anything: there is no
    // single P27 for them to disagree about. Testing status first sent the PRIMARY to adjudicate a
    // disagreement that did not exist, and whichever status it picked, one of the two findings was
    // destroyed by the title-merge further down. Disentangle identity, THEN read agreement.
    const titlesBy = new Map();
    for (const p of props) if (p.title && !titlesBy.has(p.who)) titlesBy.set(p.who, p.title);
    // ON A NEW ID EVERY PROPOSER MUST NAME IT. Contributors run blind to each other, so one cannot
    // be corroborating a point it has no way to have read: an untitled proposal for an id no row
    // exists for is either a second finding whose title was omitted, or a contributor ruling on
    // something it invented. Both were silently filed under whichever title arrived first, and the
    // distinct-title set of size 1 meant no collision fired. This is the same loss the collision
    // check exists to prevent, reached from outside its condition.
    if (!liveNamed.has(id) && titlesBy.size) {
      const mute = [...new Set(props.map((p) => p.who))].filter((w) => !titlesBy.has(w));
      if (mute.length)
        die(`relay: ${mute.join(", ")} propose${mute.length > 1 ? "" : "s"} a status for ${id}, which points.md has no row for, without naming it, while ${[...titlesBy.keys()].join(", ")} raise${titlesBy.size > 1 ? "" : "s"} it as "${[...titlesBy.values()][0]}". Contributors work blind to each other, so an untitled proposal for a NEW id cannot be read as agreement with a title it never saw. Have each contributor name the point it is raising, or renumber them apart.`);
    }
    const collides = !liveNamed.has(id) && new Set(titlesBy.values()).size > 1;
    const moved = collides ? [...titlesBy.keys()].filter((w) => renumbered.has(`${id}:${w}`)) : [];
    const same = collides ? [...titlesBy.keys()].filter((w) => merged.has(`${id}:${w}`)) : [];
    let keeper = null;
    if (collides) {
      same.forEach((w) => mergeUsed.add(`${id}:${w}`));
      const rest = [...titlesBy.keys()].filter((w) => !moved.includes(w) && !same.includes(w));
      if (rest.length > 1) {
        collided.push(`  ${id}: ` + [...titlesBy.entries()].map(([w, ti]) => `${w}="${ti}"`).join(" vs "));
        continue;
      }
      // ONE CONTRIBUTOR MUST BE LEFT TO KEEP THE ID. Merging every titled contributor left `rest`
      // empty and fell back to `same[0]`, whose order is `titlesBy` order, which is `props` order,
      // which is the order of the `--capture` argument — so the surviving wording was chosen by
      // ARGUMENT ORDER, inside the one code path built to abolish arrival-order decisions, and on
      // the exact branch whose fixture had been re-cut to tell those two apart. Both the refusal
      // message and relay.md promise the id keeps the wording of whoever is LEFT; when nobody is
      // left, the honest answer is to say so rather than to substitute a silent default.
      if (!rest.length)
        die(`relay: --merge names every contributor that titled ${id} (${same.join(", ")}), so none is left to keep it. A merge folds one wording into another; it cannot fold them all into nothing. Leave the contributor whose wording the point should carry unmerged.`);
      keeper = rest[0];
      for (const who of moved) {
        const newId = renumbered.get(`${id}:${who}`);
        renumberUsed.add(`${id}:${who}`);
        if (liveIds.has(newId) || proposals.has(newId))
          die(`relay: --renumber ${id}:${who}=${newId} targets an id that is already taken (${liveIds.has(newId) ? "points.md has a row for it" : "a capture proposes it"}). Renumbering onto a live id would merge the two findings it exists to keep apart — choose a free id.`);
        const mine = props.filter((p) => p.who === who);
        relayPoints.push({ id: newId, status: [...new Set(mine.map((p) => p.status))][0], title: titlesBy.get(who) });
      }
    }
    // What is left under this id after any renumbering: the contributors who still claim it. A
    // dispute is read from THOSE, never from the pre-disentangled set.
    const held = props.filter((p) => !moved.includes(p.who));
    const distinct = [...new Set(held.map((p) => p.status))];
    if (distinct.length > 1 && decided === undefined) {
      // One line per CONTRIBUTOR, not per proposal. A capture that states its ruling in BOTH of its
      // sections proposes twice, and listing both printed the same contributor twice in the very
      // message a reader uses to decide who disagreed with whom.
      const byContributor = [...new Map(held.map((p) => [p.who, p.status])).entries()];
      disputed.push(`  ${id}: ` + byContributor.map(([w, st]) => `${w}=${st}`).join(", "));
      continue;
    }
    if (decided !== undefined && distinct.length === 1)
      die(`relay: --resolve ${id}=${decided} but the contributors do not disagree about ${id} (all proposed ${distinct[0]}). --resolve adjudicates a DISPUTE; accepting it anywhere else would let the relay restate a contributor's ruling under that contributor's name.`);
    // The title belongs to whichever contributor RAISED the point; the relay copies, never invents.
    relayPoints.push({ id, status: decided === undefined ? distinct[0] : decided, title: keeper ? titlesBy.get(keeper) : (held.find((p) => p.title) || {}).title || "" });
  }
  for (const id of resolved.keys())
    if (!proposals.has(id)) die(`relay: --resolve names ${id}, which no capture sets. A status may only be adjudicated for a point some contributor actually proposed one for.`);
  for (const key of renumbered.keys())
    if (!renumberUsed.has(key))
      die(`relay: --renumber names ${key}, which is not a colliding id — either no capture from that contributor raises it, or the contributors do not give it conflicting titles. A renumber resolves a COLLISION; accepting it anywhere else would let the relay re-file a contributor's finding under an id nobody raised.`);
  for (const key of merged)
    if (!mergeUsed.has(key))
      die(`relay: --merge names ${key}, which is not a colliding id — either no capture from that contributor raises it, or the contributors do not give it conflicting titles. --merge resolves a COLLISION; there is nothing to merge where nothing collided.`);
  if (collided.length)
    die(`relay: ${collided.length} new point id(s) carry two different findings, because contributors run in parallel and each takes the next free id:\n${collided.join("\n")}\nKeeping the first title would silently destroy the other contributor's finding, so this refuses instead of letting arrival order decide what the review found. Where they are genuinely two findings, give each its own id with --renumber <id>:<contributor>=<newid>. Where two contributors reached ONE finding and worded it differently, say so with --merge <id>:<contributor> and the id keeps the wording of whoever is left. Then write the fused shard against the ids you assign.`);
  if (disputed.length)
    die(`relay: the captures disagree about the status of ${disputed.length} point(s), and a status is an adjudicated decision rather than mergeable data — so this refuses instead of letting arrival order decide:\n${disputed.join("\n")}\nAdjudicate each explicitly with --resolve <id>=<STATUS>[,...] and record a "- DISSENT:" line naming the overruled contributor (PROTOCOL §5). Every contributor's own ruling stays in its retained capture either way.`);
  {
    const pFile = path.join(dir, "points.md");
    const pText = exists(pFile) ? readText(pFile) : "";
    // "Does a row for this id exist?" is answered by the CANONICAL reader, the same one the write
    // below uses. Testing raw text here was the third of three readers disagreeing about one
    // question: it matched a commented-out row and a trailing-space row that `parsePoints` does not
    // read, so the refusal stayed silent and the title fell through to a literal "-".
    const liveIds = new Set(parsePoints(pText).map((r) => r.id));
    for (const p of relayPoints) {
      if (!p.title && !liveIds.has(p.id))
        die(`relay: the capture sets ${p.id}, which points.md has no row for, and gives it no title. Write the POINTS line as "${p.id}=${p.status} | <title>" so the row can be created without the relay inventing one.`);
      // Refused at the BOUNDARY, because the point-row grammar is pipe-free by construction: the
      // canonical reader `POINT_ROW_RE` does not support an escaped `\|` either, and test.mjs
      // requires lint to FLAG a row containing one. Teaching the writer to emit an escape would
      // therefore produce rows the reader rejects — the fix is to refuse the title, not to escape it.
      if (p.title.includes("|"))
        die(`relay: the title for ${p.id} contains a "|", which the point-row grammar cannot carry — the canonical reader does not support an escaped pipe, so such a row is reported as malformed rather than read. Reword the title without a pipe.`);
    }
  }
  const attempt = String(opts.attempt === undefined || opts.attempt === null ? "1" : opts.attempt);
  if (!/^[1-9][0-9]*$/.test(attempt))
    die(`relay: --attempt ${JSON.stringify(String(opts.attempt))} is not a positive integer. The attempt number is what distinguishes a retried relay from a duplicated one; coercing a malformed one to 1 would erase that distinction silently.`);

  // ---- everything above validates; everything below writes ----
  // Retain every capture BEFORE writing the turn, so a crash between the two leaves the evidence
  // rather than an unexplained shard. Lint reports such an orphan (L25) rather than passing it.
  fs.mkdirSync(captureDir(dir), { recursive: true });
  for (const c of caps) atomicWrite(path.join(captureDir(dir), c.retainAs), c.raw);

  const LF = String.fromCharCode(10);
  const preExistingDivergence = [];
  // The chain links belong to the writer, not the contributor. A capture that already supplies
  // them is left alone, so a secondary that knows the chain is not overridden.
  let shardBody = body.endsWith(LF) ? body : body + LF;
  const prevTarget = head.cursor.TURN_CURSOR && head.cursor.TURN_CURSOR !== "-"
    ? (turnFilesIn(dir).find((f) => f.startsWith(head.cursor.TURN_CURSOR + "-")) || null)
    : null;
  // PREV is DERIVED, always, overriding anything the capture supplied. The comment above has
  // claimed the chain links belong to the writer since 8d3561f, while the code let a
  // contributor-supplied `PREV: NEW` stand — and the scoped-prompt template hands the secondary
  // exactly that string to fill in. Two turns then both declared themselves the root and the chain
  // silently had no order, which no check looked for (it does now: see L14 below).
  const prevLine = prevTarget ? `PREV: [${head.cursor.TURN_CURSOR}](${prevTarget})` : "PREV: NEW";
  shardBody = /^PREV:.*$/m.test(shardBody)
    ? shardBody.replace(/^PREV:.*$/m, prevLine)
    : shardBody + prevLine + LF;
  if (!/^NEXT:/m.test(shardBody)) shardBody += "NEXT: pending" + LF;
  atomicWrite(shardPath, shardBody);

  // The PREVIOUS shard's NEXT still says pending; the writer owns that link too.
  if (prevTarget) {
    const prevPath = path.join(dir, "turns", prevTarget);
    const prevText = readText(prevPath);
    if (/^NEXT: pending[ \t]*$/m.test(prevText))
      atomicWrite(prevPath, prevText.replace(/^NEXT: pending[ \t]*$/m, `NEXT: [${turn}](${shardName})`));
  }

  const shaTokens = caps.map((c) => `capture_sha=${c.sha.slice(0, 16)}`).join(" ");
  const pts = relayPoints;
  const ptsTok = pts.length ? pts.map((p) => p.id).join(",") : "-";
  // Partition the captures' log lines ONCE, here, so the TURN_COMMIT can carry what the partition
  // found. A gate offered by some contributors and not all is not the seat's agreement (see the
  // append site below); it is recorded rather than either forged or silently dropped.
  // ---------- THE GATE RATIO, DERIVED ONCE ----------
  //
  // This block is a REWRITE, not a patch: a ratio computed piecemeal keeps drifting. The
  // ratio was corrected four times in four commits — numerator keyed by cell, denominator counting
  // capture files, cell absences not subtracted, and a seat marked as agreeing when ANY one of its
  // cells offered — and each correction was right where it looked while breaking the field beside
  // it. Every one of those was found by a reviewer, at a SEAM: the place where one rule meets its
  // neighbour and nobody re-read the neighbour. So the parts are no longer separately maintained
  // rules that must be kept consistent by whoever edits next; they are one derivation, in order,
  // where a change to any step is visibly a change to the ratio.
  //
  // THE DERIVATION. A gate is the SEAT's agreement, and a seat is a CONTRIBUTOR — never a
  // contributor-scope pair, never a capture file, never a filename.
  //
  //   1. Every capture resolves to its seat through `cellOf`: CODEX_S1 and CODEX_S2 are one seat.
  //   2. A seat is LIVE if it supplied a capture, or is declared and was not declared absent. An
  //      absence is a recorded non-participation, not silence — counting an absent contributor
  //      would let a quota-blocked vendor veto every remaining gate, which is the failure the whole
  //      usage-limit path exists to prevent. Both absence forms subtract identically, and only when
  //      the seat supplied no capture at all; missing SOME scopes leaves a seat live.
  //   3. The DENOMINATOR is the LARGER of two counts of live seats — the declared roster minus
  //      absences, and the seats that actually arrived. Not their union, deliberately: see the note
  //      at the assignment. Each is a floor and neither is a ceiling, so a declaration cannot be
  //      shrunk by relaying a subset of it, and a lone undeclared arrival cannot read as unanimous.
  //   4. A seat OFFERS a gate only if EVERY capture it supplied carries it. Marking a seat as
  //      offering because one of its cells did meant a present cell that WITHHELD was voted for by
  //      its sibling, and left no trace of the dissent anywhere — the numerator's own version of
  //      letting arrival order decide.
  //   5. The gate is written iff numerator >= denominator > 0, and the ratio is RECORDED either
  //      way: `gate_set=` when written, `gate_partial=` when not. Recording k/n only on the
  //      withheld branch made a written 1/1 and a written 3/3 byte-identical to a later reader.
  //
  // The denominator is not chosen by the party it constrains, and where that cannot be enforced by
  // arithmetic it is closed by record instead: dispatch-three-relay-one reads as the 1/1 it is.
  const seatKey = (w) => String((cellOf(w) || {}).model || w).toUpperCase();
  const seatName = (w) => (cellOf(w) || {}).model || w;

  const nonGateLines = [];
  const seatCaps = new Map();                          // SEAT -> total captures from that seat
  const seatGate = new Map();                          // gate -> Map(SEAT -> [lines])
  for (const c of caps) {
    const k = seatKey(c.who);
    seatCaps.set(k, (seatCaps.get(k) || 0) + 1);
    for (const line of c.logLines) {
      if (/^POINT_SET\b/.test(line)) continue;          // folded into the adjudicated event above
      const name = gateSetName(line.replace(/^GATE_SET\s+/, ""));   // ONE reader, shared with the projector
      if (!/^GATE_SET\b/.test(line) || !name) {
        if (!nonGateLines.includes(line)) nonGateLines.push(line);
        continue;
      }
      // KEYED BY CAPTURE, NOT COUNTED BY LINE. Step 4 compares what a seat OFFERED against what
      // it SUPPLIED, and counting gate LINES made those two different units: one capture repeating
      // its own GATE_SET twice reached the count of a two-capture seat, so a sibling cell that
      // withheld was carried by its neighbour saying the same thing twice. A capture name is unique
      // per turn - the relay refuses two captures that would retain under one name - so keying on it
      // makes the numerator count CAPTURES on both sides of the comparison.
      if (!seatGate.has(name)) seatGate.set(name, new Map());
      const per = seatGate.get(name);
      if (!per.has(k)) per.set(k, new Map());
      per.get(k).set(c.who, line);
    }
  }

  const declaredPanel = secondaryPanel(sessText, head.byRole.PRIMARY && head.byRole.PRIMARY.name).panel;
  const declaredSeatNames = (declaredPanel ? declaredPanel.map((a) => CLI_EXECUTORS[a] || a)
    : [head.byRole.SECONDARY && head.byRole.SECONDARY.name]).filter(Boolean);
  const absentSeats = new Set(String(opts.absent === undefined ? "" : opts.absent)
    .split(",").map((s) => s.trim()).filter(Boolean).map(seatKey));
  for (const k of seatCaps.keys()) absentSeats.delete(k);   // it turned up: not absent

  // THE DENOMINATOR IS THE LARGER OF TWO FLOORS, not their union. A declaration cannot be shrunk
  // by relaying a subset of it; a contributor nobody declared still counts once it arrives.
  //
  // Not the union, and that is a RULING rather than an arithmetic preference: the union makes a
  // capture label that does not match its declared label inflate every count, which would turn
  // 'must an unscoped capture resolve to a declared label' from an open question into an enforced
  // rule. That question is routed to a successor board, so taking the union here would decide it
  // by the back door.
  //
  // The seed is the declared panel alone. The family record's list is NOT reused here: it falls
  // back to the dyad SECONDARY, which answers a different question. (Under this MAX the two
  // seedings happen to be indistinguishable, so no fixture can pin the difference — the lists are
  // separate because the questions are, not because the denominator could tell.)
  const liveDeclared = (declaredPanel ? declaredPanel.map((x) => CLI_EXECUTORS[x] || x) : [])
    .filter((l) => !absentSeats.has(String(l).toUpperCase()));
  const denominator = Math.max(liveDeclared.length, seatCaps.size);

  // THE FAMILY RECORD IS COMPUTED SEPARATELY FROM THE RATIO, and this comment deliberately makes
  // no claim about how the two relate. Four earlier versions each asserted a relation — that they
  // could never disagree, then that absence was the only divergence, then that absence and
  // combination were — and a reviewer found a further mode every time. A claim about a relation
  // between two computations is stale the moment either changes, so what follows states only what
  // THIS set is, and the divergences are pinned by fixtures instead of described here.
  //
  // The record's seats: every DECLARED panel member, resolved through `CLI_EXECUTORS`; or the
  // SECONDARY actor from HEAD when no panel is declared, so a one-model board still discloses;
  // UNIONED with every contributor that actually arrived, resolved through `cellOf`. Declared
  // absences are NOT subtracted.
  //
  // Each of those choices answers the same question: what is this seat COMPOSED of. It is not the
  // ratio's question — who could PARTICIPATE — and the two must not be made to agree. Subtracting
  // absences here would let the disclosure be switched off by declaring absent the very
  // contributor it discloses; dropping the dyad fallback would silence it on exactly the
  // one-model board it exists for; dropping the union would let a rename erase it. The record is
  // the one that must not shrink, and it never gates: no check reads it.
  const primaryName = head.byRole.PRIMARY && head.byRole.PRIMARY.name;
  const familySeats = new Map(declaredSeatNames.map((s) => [String(s).toUpperCase(), s]));
  for (const c of caps) if (!familySeats.has(seatKey(c.who))) familySeats.set(seatKey(c.who), seatName(c.who));
  const kinSeats = [...familySeats.values()].filter((s) => inFamily(s, primaryName));

  const unanimousGates = [], partialGates = [], gateCounts = [], familyTok = [];
  for (const [gate, per] of seatGate) {
    // Step 4: unanimity WITHIN a seat before unanimity ACROSS seats.
    const offering = [...per.entries()].filter(([k, byCap]) => byCap.size >= (seatCaps.get(k) || 0));
    if (kinSeats.length) familyTok.push(`gate_family=${gate}:${kinSeats.length}/${familySeats.size}`);
    if (denominator > 0 && offering.length >= denominator) {
      unanimousGates.push([...offering[0][1].values()][0]);
      gateCounts.push(`gate_set=${gate}:${offering.length}/${denominator}`);
    } else partialGates.push(`gate_partial=${gate}:${offering.length}/${denominator}`);
  }
  // `adjudicated=` makes a PRIMARY-settled dispute visible in the log. Without it an adjudicated
  // POINT_SET is byte-indistinguishable from a unanimous one, so the log could not tell a reader
  // that a contributor had been overruled — recoverable from `captures/` but only by someone who
  // already suspected it, and the `- DISSENT:` obligation covering it is prose that nothing checks.
  // `adjudicated=` names, per id, WHOSE ruling was adopted — a contributor, or the PRIMARY itself.
  // Recording only the ids left "the PRIMARY picked a contributor's ruling" and "the PRIMARY wrote
  // its own third status into the SECONDARY's POINT_SET" byte-indistinguishable, which is the very
  // distinction the token was added to make. A third status is not forbidden — two contributors
  // deadlocked at AGREED and REJECTED may genuinely warrant OUT_OF_SCOPE, and that is a decision the
  // PRIMARY is entitled to make — but it is a different act from picking a winner and it is now
  // recorded as one.
  const adjTok = resolved.size ? " adjudicated=" + [...resolved.keys()].sort().map((id) => {
    const props = proposals.get(id) || [];
    const backer = props.find((p) => p.status === resolved.get(id));
    return `${id}:${backer ? backer.who : "PRIMARY"}`;
  }).join(",") : "";
  // Like `adjudicated=`, this makes a PRIMARY decision visible in the log rather than only in the
  // captures. Without it a renumbered finding is byte-indistinguishable from one the contributor
  // filed under that id itself.
  const renTok = renumberUsed.size ? " renumbered=" + [...renumberUsed].sort().map((k) => k + "->" + renumbered.get(k)).join(",") : "";
  const mrgTok = mergeUsed.size ? " merged=" + [...mergeUsed].sort().join(",") : "";
  const gateTok = [...partialGates, ...gateCounts, ...familyTok].sort().join(" ");

  // points.md, BEFORE the TURN_COMMIT. relay.md calls TURN_COMMIT the content-durability
  // point and lists the points rows among the writes that precede it — but relay wrote the
  // POINT_SET log line and never the row, so an honest relay that opened a point left the board at
  // `FAIL L2 log projects point P1 but points.md has no such row`, and the command's own closing
  // line tells you to run that lint. A capture must supply a title for an id the table does not
  // already carry: the relay copies, it does not invent, and a row needs a name only its author
  // can give.
  if (pts.length) {
      // Before ANY read of the tracker for this write: a capture may set a point that was archived,
    // and every read below must see the row in the file it is about to rewrite.
    const rehotted = rehotPoints(dir, pts.map((p) => p.id));
    if (rehotted.length) console.log(`  moved ${rehotted.join(", ")} back to points.md (a point in play is not settled)`);
  const pFile = path.join(dir, "points.md");
    let pText = readText(pFile);
    // points.md is a RENDERING, and this writer is not entitled to an opinion about what it says.
    // STATUS and `Resolved In` come from `projectPoints` — the SAME derivation L2 checks the table
    // against — so the writer cannot mean something its own reader rejects. TITLES are the one
    // thing the log does not carry, so they come from the existing row (read with `parsePoints`,
    // the canonical reader) or from the capture that raised the point.
    //
    // Three separate defects on one board came from this block having private semantics: it split
    // rows on a raw "|" instead of using POINT_ROW_RE, it stamped `Resolved In` with the CURRENT
    // turn for every id in the capture, and it took its status from a last-wins merge. The second
    // contradicted projectPoints' explicit rule that only a TRANSITION resolves a point, so an
    // honest RE-ASSERTION of an unchanged status produced a row lint rejected outright:
    // `points.md P3 Resolved In=P4 but log projects P2`.
    // Complete rendering REPAIRS a row that disagreed with the projection before this turn, and
    // that value then exists nowhere — an L2 FAIL a reader would have seen becomes nothing. The
    // rendering stays (a partial rendering is not a rendering), so the repair is REPORTED instead:
    // computed from the projection over the log WITHOUT this turn's events, so it describes what
    // was already wrong rather than what this turn changed. Deliberately stdout and not a log
    // event — §8's vocabulary is closed, and a divergence is an observation, not a board decision.
    const priorProj = new Map(projectPoints(parseLog(readText(path.join(dir, "log.md")))).map((r) => [r.id, r]));
    for (const r of parsePoints(pText)) {
      const pp = priorProj.get(r.id);
      if (!pp) continue;
      const had = (r.resolved || "-").trim(), wantId = pp.resolvedIn;
      const linkId = (cell) => (/^\[([PI]\d+)\]/.exec(cell) || [])[1] || null;
      if (pp.status !== r.status || (wantId || null) !== linkId(had))
        preExistingDivergence.push(`  ${r.id}: table ${r.status}/${linkId(had) || "-"} vs log ${pp.status}/${wantId || "-"}`);
    }
    const projected = new Map(projectPoints(parseLog(readText(path.join(dir, "log.md"))).concat([
      { type: "TURN_COMMIT", rest: `${turn} actor=${sec} points=${ptsTok}` },
      { type: "POINT_SET", rest: `${pts.map((p) => `${p.id}=${p.status}`).join(" ")} in=${turn}` },
    ])).map((r) => [r.id, r]));
    const prevRows = new Map(parsePoints(pText).map((r) => [r.id, r]));
    const shardOf = (tid) => (tid === turn ? shardName
      : turnFilesIn(dir).find((f) => f.startsWith(tid + "-")) || null);
    // EVERY projected point, not only the ids this capture happened to mention. Rendering the
    // subset left every other row free to disagree with the projection: measured, a corrupted row
    // for an unmentioned point survived a relay and the board linted
    // `FAIL L2 points.md P1=REJECTED but log projects AGREED`. A rendering of a derivation is
    // either the whole derivation or it is not a rendering. A projected point with NEITHER an
    // existing row NOR a capture-supplied title is skipped rather than invented — the relay copies,
    // and L2 reports that pre-existing gap, which is the correct division of labour.
    const titles = new Map(pts.map((p) => [p.id, p.title]));
    for (const pr of projected.values()) {
      const prev = prevRows.get(pr.id);
      const capTitle = titles.get(pr.id) || "";
      if (!prev && !capTitle) continue;
      const part = prev ? prev.part : (pr.id.startsWith("P") ? "PLAN" : "IMPL");
      // THE TITLE A POINT WAS RAISED UNDER IS ITS IDENTITY, and a later capture does not get to
      // restate it. The capture's title won here, so any contributor ruling on an existing point
      // could rewrite what that point had been about — silently, in the one file every turn reads,
      // leaving every earlier shard's reference to it wrong. A capture-supplied title is used only
      // where the row has none to keep: creating the row, or filling a title the table lost.
      const title = (prev && prev.title) ? prev.title : capTitle;
      // Guard the value being WRITTEN, not the one that arrived. The capture-side check cannot see
      // a title reaching this line through the `prev.title` fallback, and the canonical reader DOES
      // produce pipe-bearing titles: a 7-pipe row parses as title="a" status="b", so rendering from
      // it would repair the visible L4 finding while destroying the title.
      if (title.includes("|"))
        die(`relay: the row for ${pr.id} would be written with a title containing a "|", which the point-row grammar cannot carry. Its existing row in points.md is malformed — reword it before relaying, rather than letting this write repair the status while truncating the title.`);
      const dest = pr.resolvedIn ? shardOf(pr.resolvedIn) : null;
      const resolvedIn = dest ? `[${pr.resolvedIn}](turns/${dest})` : "-";
      const row = `| ${pr.id} | ${part} | ${title} | ${pr.status} | ${resolvedIn} |`;
      if (prev) {
        // ONE reader decides which row this is, and it is the LIVE view — the same view
        // `parsePoints` read `prev` from. Selecting the target with a raw regex while reading the
        // title through `liveText` meant a commented-out row was chosen as the write target and the
        // new row landed INSIDE its own comment: the log then projected a point the live table had
        // no row for. `replaceLiveLine` splices into the original bytes at the live match's offset
        // and returns null when the match is absent or ambiguous, so this refuses rather than
        // writing to a guessed target.
        const rowRe = new RegExp("^[ \\t]*\\|\\s*" + pr.id + "\\s*\\|.*$", "m");
        const next = replaceLiveLine(pText, rowRe, row);
        if (next === null)
          die(`relay: points.md has no single unambiguous live row for ${pr.id} to rewrite, though one was read. Reconcile the table by hand before relaying — writing to a guessed target is how a row lands inside a comment.`);
        pText = next;
      } else {
        // The missing-title case was refused during validation, above the first write.
        pText = pText.trimEnd() + LF + row + LF;
      }
    }
    atomicWrite(pFile, pText);
  }

  const logFile = path.join(dir, "log.md");
  // `fused=yes` makes the fusion visible in the log rather than inferable from how many captures
  // happen to survive on disk, so the attribution check keys off what the relay DECLARED.
  const fusedTok = fused ? ` fused=yes contributors=${caps.length}` : "";
  appendEvent(logFile, `${nowIso()} TURN_COMMIT ${turn} actor=${sec} responds_to=${head.cursor.TURN_CURSOR} points=${ptsTok} via=relay relayed_by=${head.byRole.PRIMARY.name} attempt=${attempt}${fusedTok}${fanTok}${adjTok}${renTok}${mrgTok}${gateTok ? " " + gateTok : ""} ${shaTokens}`);
  // A contributor's POINT_SET is a PROPOSAL; the adjudicated decision is ONE event, written by the
  // writer that made it and carrying the `in=` this turn resolves under. Appending each
  // contributor's line verbatim put N conflicting events in the log and left the replay to settle
  // them by arrival order — the same defect as the merge above, one layer down, and the reason the
  // two agreed with each other while both disagreed with what the captures said. Nothing is lost:
  // every proposal survives in its retained capture, bound by `capture_sha`. This formats the
  // event; it never decides it.
  for (const line of nonGateLines) appendEvent(logFile, `${nowIso()} ${line}`);
  if (pts.length)
    appendEvent(logFile, `${nowIso()} POINT_SET ${pts.map((p) => `${p.id}=${p.status}`).join(" ")} in=${turn}`);
  // The seat's gate is UNANIMOUS or it is not the seat's. Appending it verbatim let ONE contributor
  // of N set it while the others' silence was neither consulted nor recorded — the same defect as
  // the status merge, on the decision that actually unlocks `advance` (§4). It is not adjudicable
  // by the PRIMARY either: L20 reserves a `*_SECONDARY` gate to its own actor, so a `--resolve`
  // twin here would be forgery. Unanimity is therefore the only rule that neither forges nor
  // invents, and a partial gate is simply not agreement — the turn still lands (its objections are
  // its value), the gate does not, and `gate_partial=` records on the TURN_COMMIT that agreement
  // was offered and not reached, so silence leaves a trace instead of none.
  for (const g of unanimousGates) appendEvent(logFile, `${nowIso()} ${g}`);

  // Complete the state transfer. TURN_COMMIT makes the content durable; HANDOFF is the commit
  // point for the turn. The original relay stopped above, so it could report success with a shard
  // and clean lint while HEAD still gave START to the SECONDARY and SEQ still named the old turn.
  // That is an unlanded turn by the adapter contract. Sole-writer mode changes who writes these
  // bytes, never which state transition the turn owes.
  const primary = head.byRole.PRIMARY;
  const nextTurn = turn[0] + (Number(turn.slice(1)) + 1);
  const nextSeq = Number(head.cursor.SEQ) + 1;
  const handoffAt = nowIso();

  const actorFile = path.join(dir, "agents", sec.toLowerCase() + ".md");
  let actorText = readText(actorFile);
  // WHICH mirrors exist is decided by the board's PROVENANCE, never by which lines happen to be in
  // the file. Writing on shape is how a mirror gets recreated on a board that retired it, and
  // reading on shape is the inference the schema rules forbid — the writer and the reader answer
  // this question the same way or they will disagree about the same bytes.
  const relaySchema = boardAgentSchema(parseLog(readText(logFile)),
    head.byRole.PRIMARY && head.byRole.PRIMARY.name).schema;
  const relayKeys = (AGENT_SCHEMA_TABLE[relaySchema] && AGENT_SCHEMA_TABLE[relaySchema].keys) || [];
  const MIRRORS = [
    [/^SELF_HAND:.*$/m, "SELF_HAND: ON_HOLD", "SELF_HAND"],
    [/^LAST_TURN_WRITTEN:.*$/m, "LAST_TURN_WRITTEN: " + turn, "LAST_TURN_WRITTEN"],
  ].filter(([, , what]) => relayKeys.includes(what));
  for (const [re, to, what] of MIRRORS) {
    const next = replaceLiveLine(actorText, re, to);
    if (next === null)
      die(`relay: agents/${sec.toLowerCase()}.md has no single live ${what} declaration to update - run lint and reconcile the partial turn before retrying`);
    actorText = next;
  }
  atomicWrite(actorFile, actorText);

  let headText = head.raw;
  const headEdits = [
    [new RegExp("^-\\s*" + primary.name + ":.*$", "m"), "- " + primary.name + ": START - PRIMARY", primary.name + " State row", stateSectionRange],
    [new RegExp("^-\\s*" + sec + ":.*$", "m"), "- " + sec + ": ON_HOLD - SECONDARY", sec + " State row", stateSectionRange],
    [/^TURN_CURSOR:.*$/m, "TURN_CURSOR: " + turn, "TURN_CURSOR"],
    [/^RESPONDS_TO:.*$/m, "RESPONDS_TO: turns/" + shardName, "RESPONDS_TO"],
    [/^NEXT_TURN_ID:.*$/m, "NEXT_TURN_ID: " + nextTurn, "NEXT_TURN_ID"],
    [/^NEXT_ACTOR:.*$/m, "NEXT_ACTOR: " + primary.name, "NEXT_ACTOR"],
    [/^SEQ:.*$/m, "SEQ: " + nextSeq, "SEQ"],
    [/^PLAN_OPEN_POINTS:.*$/m, "PLAN_OPEN_POINTS: " + loadPoints(dir).union.filter((p) => p.id.startsWith("P") && p.status === "OPEN").length, "PLAN_OPEN_POINTS"],
    [/^LAST_UPDATE:.*$/m, "LAST_UPDATE: " + handoffAt, "LAST_UPDATE"],
  ];
  for (const line of unanimousGates) {
    const gate = gateSetName(line.replace(/^GATE_SET\s+/, ""));
    if (gate) headEdits.push([new RegExp("^" + gate + ":.*$", "m"), gate + ": YES", gate]);
  }
  for (const [re, to, what, within] of headEdits) {
    const next = replaceLiveLine(headText, re, to, within);
    if (next === null)
      die(`relay: HEAD.md has no single live ${what} declaration to update - run lint and reconcile the partial turn before retrying`);
    headText = next;
  }
  atomicWrite(path.join(dir, "HEAD.md"), headText);
  appendEvent(logFile,
    `${handoffAt} HANDOFF ${sec}:WORKING->ON_HOLD ${primary.name}:ON_HOLD->START next=${nextTurn}/${primary.name} seq=${nextSeq}`);

  console.log(`Relayed ${turn} from ${caps.length} capture(s) into turns/${shardName}.`);
  if (preExistingDivergence.length) {
    console.log(`  NOTE: ${preExistingDivergence.length} points.md row(s) disagreed with the log BEFORE this turn and were re-rendered from it:`);
    for (const d of preExistingDivergence) console.log(d);
    console.log(`  The log is the authoritative derivation, so the rendering is correct — but the divergence is now gone from the board, and this is the only place it was reported.`);
  }
  for (const c of caps) console.log(`  ${path.basename(c.file)}  sha=${c.sha.slice(0, 16)}`);
  console.log(`  captures retained under captures/ — they are the only record of what each contributor actually said.`);
  console.log(`  verify: node "${process.argv[1]}" lint --session ${id}`);
}
// ---------- fanout ----------
// The delegated-PRIMARY manager fans work out to subagents on both sides and is the SOLE writer of
// the board. "Subagents do not write the board" is an instruction, and this tree's whole L24 lesson
// is that escapes arrive from outside the rules — so the rule needs a check. Tool-level
// confinement is not available (verified 2026-07-31: an allowedTools list does not confine a
// subagent), which leaves detection, and detection is cheap because the board is small.
//
//   seal   -> print a digest over every byte of .collab-board/ before spawning
//   verify -> recompute after they return and BEFORE the manager writes; any difference is a
//             subagent that wrote to the board
//
// Stated as a limit rather than a guarantee: this DETECTS a write, it cannot PREVENT one. Given
// that confinement is unavailable, an unmissable alarm is the strongest true claim, and claiming
// more would be the overclaim shape this repo keeps removing.
//
// The digest goes to stdout and no file is written by default, so nothing is left at rest to clean
// up and there is no on-disk artifact for a subagent to edit into agreement. `--manifest` is the
// opt-in diagnostic path, and the caller names a location OUTSIDE the board — sealing the manifest
// into the thing it measures would change what it measures.
function boardManifest(root) {
  const base = collabDir(root);
  const out = [];
  if (!isBoardDir(base)) return out;
  // EVERY entry produces a line, including directories and anything that is neither a regular file
  // nor a directory. Hashing only regular files left two silent holes, both measured: a new empty
  // directory moved nothing, and — the serious one — a Windows junction planted inside the board
  // was invisible, because a junction is reported as a symlink and so satisfied neither isFile()
  // nor isDirectory(). Content reachable THROUGH the board did not register at all.
  //
  // A link is RECORDED, never followed: following one would take the digest outside the board and
  // hash whatever the link points at, which is the traversal this project rejects elsewhere. So
  // the seal reports its presence and refuses to pretend it read it — the appearance or
  // disappearance of a link is itself a board change worth catching.
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name), r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) { out.push(`dir       ${"-".padStart(9)}  ${r}/`); walk(p, r); }
      else if (e.isFile()) { const b = fs.readFileSync(p); out.push(`${sha256(b)}  ${b.length.toString().padStart(9)}  ${r}`); }
      // The link's TARGET is part of what the board exposes, so it is part of the record. Hashing
      // only "a link exists here" left a repoint invisible: a junction inside the board was swung
      // from a harmless directory to an attacker-controlled one, the content reachable THROUGH the
      // board changed completely, and the digest did not move. Found by the agy panel member on
      // the fix's first review, missed by the other; reproduced before it was believed.
      else {
        let target = "?";
        try { target = fs.readlinkSync(p); } catch { target = "<unreadable>"; }
        out.push(`nonfile   ${"-".padStart(9)}  ${r} -> ${target}   (not a regular file — recorded, never followed)`);
      }
    }
  };
  walk(base, "");
  return out;
}
function cmdFanout(opts) {
  const root = opts.root;
  const lines = boardManifest(root);
  const digest = sha256(Buffer.from(lines.join("\n"), "utf8"));
  if (opts.manifest) atomicWrite(opts.manifest, lines.join("\n") + "\n");
  if (opts.verify) {
    const want = String(opts.expect || "").trim().toLowerCase();
    if (!want) die("fanout --verify needs --expect <digest> (the value `--seal` printed before the fan-out)");
    if (want === digest) {
      console.log(`fanout OK — ${lines.length} board file(s) unchanged since the seal (${digest.slice(0, 16)})`);
      return;
    }
    console.error(`fanout FAILED — the board changed while the subagents were running.`);
    console.error(`  sealed:  ${want}`);
    console.error(`  now:     ${digest}`);
    console.error(`  ${lines.length} board file(s) hashed.`);
    if (opts.manifest) {
      console.error(`  manifest written to ${opts.manifest}; diff it against the sealed one to name the file.`);
    } else {
      console.error(`  re-run seal/verify with --manifest <path outside the board> to name the file that changed.`);
    }
    console.error(`  Under the delegated-PRIMARY architecture only the manager writes the board. A difference here`);
    console.error(`  means a subagent wrote to it: discard the affected turn rather than building on it, and see`);
    console.error(`  the partial-turn recovery procedure in the skill's references/recovery.md.`);
    process.exit(1);
  }
  console.log(`SEAL ${digest}`);
  console.log(`  ${lines.length} board file(s) under ${collabDir(root)}`);
  console.log(`  after the subagents return and BEFORE writing the turn:`);
  console.log(`    node "${process.argv[1]}" fanout --verify --expect ${digest}`);
}
// ---------- replay ----------
// Read-only. Walks log.md prefix by prefix and reports the FIRST prefix at which each Rule 11 arm
// would fire. This exists because a check must be diffed against the pre-change
// engine on the real boards, and for L26 — the one check whose thresholds are calibrated numbers —
// there was no committed way to do it. The calibration behind BARREN=8/CHURN=2 was performed once,
// by hand, against gitignored data, so every later session had to re-improvise it non-comparably.
// Changing a threshold or a settlement rule means running this before and after and diffing.
function cmdReplay(opts) {
  const root = opts.root;
  const ids = opts.all ? listSessions(root) : [requireSession(opts)];
  if (!ids.length) { console.log("no sessions"); return; }
  let any = false;
  for (const id of ids) {
    const dir = sessionDir(root, id);
    const logFile = path.join(dir, "log.md");
    if (!exists(logFile)) { console.log(`── replay ${id} ──\n  no log.md`); continue; }
    const events = parseLog(readText(logFile));
    const sessText = exists(path.join(dir, "SESSION.md")) ? readText(path.join(dir, "SESSION.md")) : "";
    const conv = convergeThresholds(sessText);
    const { BARREN, CHURN } = conv.problem ? CONVERGE_DEFAULTS : conv;
    const head = exists(path.join(dir, "HEAD.md")) ? parseHead(readText(path.join(dir, "HEAD.md"))) : null;
    const terminal = head && TERMINALS.includes(head.status);

    // The arms, each as a predicate over a scan. Kept in one list so the report cannot describe an
    // arm the check does not have, or miss one it does.
    const ARMS = [
      ["BARREN", (s) => s.barren >= BARREN, (s) => `${s.barren} turns since a settlement (from ${s.streakFrom})`],
      // The WARN arm is part of the check, so it is part of the report. Leaving it out made this
      // harness disagree with the calibration it exists to reproduce (11 boards "clean" against
      // the 9 recorded) — a harness that models only some arms measures a check that does not exist.
      ["BARREN-W", (s) => s.barren >= Math.max(1, BARREN - 2), (s) => `${s.barren} turns since a settlement (WARN at ${Math.max(1, BARREN - 2)})`],
      ["CHURN", (s) => [...s.reopens.values()].some((n) => n >= CHURN),
        (s) => [...s.reopens].filter(([, n]) => n >= CHURN).map(([i, n]) => `${i} re-opened ${n}x`).join(", ")],
      ["REPEAT", (s) => s.reframesSinceSettlement >= 2 && !s.uqSinceLastReframe,
        (s) => `${s.reframesSinceSettlement} REFRAMEs with nothing settled between them`],
    ];
    // Report the TURN the arm fires at, not just the event index: the calibration this harness
    // exists to reproduce is stated in turns ("would have failed at I8"), and an event ordinal
    // cannot be compared against it.
    const first = new Map();
    let turn = "-";
    for (let k = 1; k <= events.length; k++) {
      const e = events[k - 1];
      if (e.type === "TURN_COMMIT") turn = String(e.rest).split(/\s+/)[0] || turn;
      const s = convergenceScan(events.slice(0, k));
      for (const [name, fires, why] of ARMS)
        if (!first.has(name) && fires(s))
          first.set(name, { k, turn, at: `${e.type} ${String(e.rest).split(/\s+/)[0] || ""}`.trim(), why: why(s) });
    }
    console.log(`── replay ${id} ──  ${events.length} events, BARREN=${BARREN} CHURN=${CHURN}${terminal ? " (terminal: lint skips this board)" : ""}`);
    for (const [name] of ARMS) {
      const f = first.get(name);
      if (f) { any = true; console.log(`  ${name.padEnd(7)} first fires at turn ${f.turn} (event ${f.k}, ${f.at}) — ${f.why}`); }
      else console.log(`  ${name.padEnd(7)} clean`);
    }
  }
  if (opts.all) console.log(`\n${any ? "some" : "no"} board reaches a Rule 11 arm; re-run after any change to the counter or its thresholds and DIFF this output.`);
}
function cmdPoints(opts) {
  const id = requireSession(opts);
  const dir = sessionDir(opts.root, id);
  if (!exists(path.join(dir, "log.md"))) die(`points: session ${id} has no log.md`);
  const rows = projectPoints(parseLog(readText(path.join(dir, "log.md"))));
  if (!rows.length) { console.log(`no points projected for ${id}`); return; }
  console.log(`── points projected from log.md — ${id} ──`);
  for (const r of rows) console.log(`${r.id.padEnd(5)} ${r.status.padEnd(12)} ${r.resolvedIn || "-"}`);
}
function requireSession(opts) {
  if (!opts.session) die("this command requires --session <id> (or --all where supported)");
  return opts.session;
}
function die(msg) { console.error(msg); process.exit(1); }

// ---------- arg parsing ----------
// ONE table of which flags are boolean, shared by parseArgs and the positional scan below —
// written twice they are two readers of "does this flag consume a value", and a flag added to one
// makes the other silently misparse (a value-taking flag's VALUE would read as a positional).
const BOOL_FLAGS = new Set(["all", "quick", "force", "seal", "verify"]);
// The positional arguments, with flag/value pairs skipped under the same rule parseArgs applies.
// Without this, `explain --root X` read X as the check code: not wrong loudly, wrong confusingly.
function positionals(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { if (!BOOL_FLAGS.has(argv[i].slice(2))) i++; }
    else out.push(argv[i]);
  }
  return out;
}
function parseArgs(argv) {
  const opts = { root: "." };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (BOOL_FLAGS.has(key)) opts[key] = true;
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

// ---------- the user's panel preference: ECHOED, never parsed, never a gate ----------
// collab-board prefers several vendors from several vendors, works identically with copies of one
// model, and must ask which the user has ONCE — not every session. That needs one durable fact,
// and this is the whole of it.
//
// THE ENGINE NEVER WRITES THIS FILE AND NEVER READS ITS MEANING. It checks whether the file exists
// and echoes its lines verbatim. Both halves are deliberate:
//
//   never writes — persisting requires judging whether a user's words were PERMANENT ("always use
//   Codex") or momentary ("Codex hit its limit today"). Nothing can mechanize that judgement, so
//   the model that heard the words writes the file, and records the words it heard.
//
//   never parses — the moment the engine branches on this value it becomes a MODE flag, and the
//   one-model case stops falling out of the general rule and becomes a special case again. That is
//   the exact construct this refactor removed. A fixture pins that a scaffolded board is
//   byte-identical with and without a preference file, so the engine CANNOT act on it.
//
// It is also read at `new` and `doctor` ONLY, never during a turn. collab-board's per-turn read-set
// is bounded and that is a load-bearing property — a long session costs what a short one does. A
// preference consulted per turn would trade that for a one-time convenience.
function preferenceFile() {
  // COLLAB_BOARD_HOME keeps the self-test off the developer's real preference, and gives a
  // sandboxed host (which may not read the home directory) somewhere it can.
  const home = process.env.COLLAB_BOARD_HOME || process.env.HOME || process.env.USERPROFILE || ".";
  return path.join(home, ".collab-board", "preference.md");
}
// ONE text, so `new` and `doctor` cannot say different things about the same fact — the same rule
// `vendorAdvice` follows for the multi-vendor advisory beside it.
function preferenceNotice() {
  const f = preferenceFile();
  let raw = null, unreadable = null;
  // ABSENT and UNREADABLE are different answers and must not share a branch. One bare catch
  // swallowed EACCES, EISDIR and a locked file alike, so a preference the user HAD recorded read as
  // "none stored" and the question was asked again — the exact nag this exists to prevent, and it
  // would recur every session while looking like first-run.
  try { raw = fs.readFileSync(f, "utf8"); }
  catch (e) { if (e && e.code === "ENOENT") raw = null; else unreadable = (e && e.code) || "unknown error"; }
  if (unreadable !== null) return [
    `A panel preference exists at ${f} but could not be read (${unreadable}).`,
    "  This is NOT the same as having none: do not ask the question and do not overwrite the file.",
    "  Tell the user, and use their session instructions for this session.",
  ];
  if (raw === null) return [
    "No stored panel preference. Ask the user ONCE, unless their request already implies it:",
    '  "collab-board works best with several models (e.g. Claude + Codex).',
    '   Add other models to the panel, or use copies of the same model?"',
    `  Record a clearly permanent answer at ${f} (see references/manager.md, "Permanent panel preference").`,
    "  A one-off choice for this session is NOT recorded there.",
  ];
  const line = (k) => (new RegExp("^" + k + ":.*$", "m").exec(raw) || [""])[0].trim();
  const panel = line("Panel") || "Panel: (unreadable — the file is the user's, edit it by hand)";
  const when = line("Recorded");
  return [
    `Stored panel preference: ${panel}${when ? "   (" + when + ")" : ""}`,
    "  Session instructions override it for this session only; they do not rewrite it.",
  ];
}

// ---------- executor detection: ADVISORY, fs-only, never a gate ----------
// collab-board PREFERS several vendors and says so; it never REQUIRES them, because a user with one
// model is better served by a weak adversarial gate than by none. Three properties are load-bearing,
// and each is a rule this repo learned the hard way:
//
//   fs-ONLY. Stats PATH entries; never spawns. A spawn would break the sandbox contract the
//   self-test depends on (`canSpawnNode`) and would fail on the machines least able to afford a
//   false alarm.
//
//   NEVER A GATE. Nothing in `new`, `lint` or `advance` consults this. A false negative is the
//   NORMAL case: an installer writes its bin directory into the PERSISTED environment, which a
//   long-running shell has not inherited. Verified live on the development machine, where `agy`
//   was absent from the inherited PATH while installed and working.
//
//   "NOT VISIBLE" IS NEVER REPORTED AS "NOT INSTALLED". It means re-probe by absolute path. The
//   wording matters more than the check: advice that overstates itself is how a correct board gets
//   abandoned.
function detectExecutors(env) {
  const raw = (env && (env.PATH || env.Path)) || "";
  const dirs = raw.split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  return CLI_EXECUTOR_SPECS.map((e) => {
    let at = null;
    for (const d of dirs) {
      for (const x of exts) {
        const p = path.join(d, e.bin + x);
        try { if (fs.statSync(p).isFile()) { at = p; break; } } catch { /* unreadable PATH entry */ }
      }
      if (at) break;
    }
    return { adapter: e.adapter, actor: e.secondary, bin: e.bin, visible: !!at, at };
  });
}
// ONE advisory text, so `doctor` and `new` cannot say different things about the same fact.
function vendorAdvice(found) {
  const seen = found.filter((f) => f.visible);
  // TWO OR MORE VENDORS VISIBLE, and the board about to run may still name only one. That is the
  // gap a reviewer found in the usage-limit story: a limit costs ONE CELL on a roster board, but a
  // single-secondary board has nothing to fall back to and can only wait — even with a second model
  // installed and idle. Saying so at `new` is the whole fix; the engine still decides nothing, and
  // a board that wants one secondary keeps one.
  if (seen.length >= 2) return [
    `  ${seen.length} vendors visible (${seen.map((f) => f.bin).join(", ")}). Consider declaring a roster:`,
    "    BoardWriteMode: PRIMARY_ONLY",
    `    SecondaryPanel: ${seen.slice(0, 2).map((f) => f.adapter).join(",")}`,
    "  On a roster board a usage limit costs ONE contributor's cell (--absent) and the turn still",
    "  lands. With a single secondary the only honest answer to a limit is to wait for it.",
  ];
  const missing = found.filter((f) => !f.visible).map((f) => f.bin).join(", ");
  return [
    seen.length === 1
      ? `  Only one CLI executor is visible on PATH (${seen[0].bin}). collab-board PREFERS several vendors.`
      : `  No CLI executor is visible on PATH. collab-board PREFERS several vendors.`,
    `  A second vendor buys DECORRELATION, the only thing a second reviewer buys: a fresh context`,
    `  removes anchoring on the conversation, not a blind spot the model holds by construction.`,
    `  Install one if you can - ${missing}.`,
    `  If you cannot, the board still runs: give the SECONDARY a distinct actor name in the same`,
    `  family (e.g. --primary CLAUDE --secondary CLAUDE_2 --adapter claude-cli). That is an ordinary`,
    `  board, not a mode - and the weakest adversarial gate available, so prefer a second vendor.`,
    `  A CLI missing here may still be INSTALLED: an installer writes its bin directory into the`,
    `  persisted environment, which this shell did not inherit. Re-probe by absolute path first.`,
  ];
}
function cmdDoctor() {
  const found = detectExecutors(process.env);
  console.log("CLI executors (ADVISORY - fs-only, never a gate on any command):");
  for (const f of found)
    console.log(`  ${f.visible ? "visible" : "not on PATH"}  ${f.adapter.padEnd(12)} ${f.bin.padEnd(9)} ${f.visible ? f.at : "(may still be installed - re-probe by absolute path)"}`);
  // `vendorAdvice` speaks on EVERY branch — below two visible vendors it says connect one, at two
  // or more it recommends declaring a roster — so there is no empty case and an `else` here was a
  // branch no input could reach, kept alive by a comment claiming the advice is conditional.
  console.log("");
  for (const l of vendorAdvice(found)) console.log(l);
  console.log("");
  for (const l of preferenceNotice()) console.log(l);
}

// ---------- explain: the by-code consult path for one lint finding ----------
// The lint spec is one flat table whose check rows are SINGLE physical lines starting `| Lnn `,
// and the consult is triggered by ONE code in a `FAIL Lnn ...` line — so the read should cost that
// code's row(s), not the whole file. Rows are selected with the SAME predicate the suite's
// per-code row guard uses (test.mjs, MUST-token block: `l.startsWith("| " + code + " ")`), so what
// this command retrieves and what the guard pins can never be two different rows. FAIL-CLOSED on
// an unknown code, loudly: the mechanical selection (`grep "^| L99 "`) returns EMPTY, and silence
// is indistinguishable from "no such check" — the observed failure mode this command exists to
// remove. The closing remediation paragraph rides along because it applies to every code, and its
// absence is also an error: a consult that silently lost its second half would read as complete.
function cmdExplain(args) {
  const code = (positionals(args)[0] || "").trim().toUpperCase();
  if (!/^L\d+$/.test(code))
    die(`explain: expects one check code, e.g. \`explain L26\`${code ? ` (got ${JSON.stringify(code)})` : ""}`);
  const spec = readText(path.join(SCRIPT_DIR, "..", "references", "lint-spec.md"));
  const lines = spec.split(/\r?\n/);
  const rows = lines.filter((l) => l.startsWith("| " + code + " "));
  if (!rows.length) {
    const known = [...new Set(lines.filter((l) => /^\| L\d+ /.test(l)).map((l) => l.split(" ")[1]))];
    die(`explain: no such check ${code} — lint-spec.md documents: ${known.join(" ")}`);
  }
  for (const r of rows) console.log(r);
  const at = lines.findIndex((l) => l.startsWith("**Remediation, in general:**"));
  if (at < 0)
    die(`explain: lint-spec.md no longer carries its "**Remediation, in general:**" paragraph — the spec surface moved; fix the spec (or this command) before trusting the consult`);
  console.log("");
  console.log(lines.slice(at).join("\n").trimEnd());
}

const [cmd, ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);
try {
  switch (cmd) {
    case "new": cmdNew(opts); break;
    case "lint": cmdLint(opts); break;
    case "explain": cmdExplain(rest); break;
    case "status": cmdStatus(opts); break;
    case "advance": cmdAdvance(opts); break;
    case "activate": cmdActivate(opts); break;
    case "terminal": cmdTerminal(opts); break;
    case "reset": cmdReset(opts); break;
    case "points": cmdPoints(opts); break;
    case "replay": cmdReplay(opts); break;
    case "fanout": cmdFanout(opts); break;
    case "archive": cmdArchive(opts); break;
    case "migrate": cmdMigrate(opts); break;
    case "relay": cmdRelay(opts); break;
    case "doctor": cmdDoctor(); break;
    default:
      // Derived from the header Usage block, not typed out again — the hand-kept copy had already
      // fallen two commands behind (`replay`, `fanout`) while claiming to list them all. The block
      // is printed, not pointed at: a pointer to "the file header" of a 300 KB script documents
      // nothing, and SKILL.md routes its situational commands here.
      console.log(`collab-board — commands: ${COMMANDS.join(" | ")}`);
      console.log("Usage:");
      process.stdout.write(USAGE);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}

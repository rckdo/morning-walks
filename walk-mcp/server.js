/*
  POSTITPA — BOARD SERVER
  v121.0 — 13/08/2026
  (Supersedes every earlier server file in this build — deploy this one.)

  This server reads and writes the board. It does not think. There is no
  model call in this file and no API key on the service.

  Changelog:
  v121.1 — Vocabulary. The review tools called the document "the store" in
           every description and reply, and chats picked the word up from the
           connector. It is THE DOCUMENT (the board is the board; the strategy
           page is the record). Wording only — tool names, node paths and
           behaviour untouched. Node stays /reviewStore: paths are plumbing,
           not vocabulary.
  v121.0 — Third document: the review store (/reviewStore). A long, evolving
           written document held as STRUCTURE — parts, sections, subsections,
           threads, spine, facts — instead of as markdown files that describe
           each other and have to be kept in sync by hand. One store, one
           truth, no sync step. Full design: review/SPEC.md.

           Three tools on the same server, so the connector Richard already
           has serves all three documents: get_review, patch_review,
           export_review.

           The central decision (spec §3.1): NUMBERS ARE NEVER STORED. A
           section's number is computed from its position at render time.
           Inserting between positions 70 and 80 writes one row at 75 and
           nothing else changes — no renumbering pass, no downstream edits,
           no more "9a". Cross-references hold the target's id
           ({{ref:sec_3}}) and resolve to the current number, so an insert
           above the target cannot break them. Facts work the same way
           ({{fact:matchdays}}): each recurring figure lives once and
           resolves at render, so a correction is one write.

           No hard delete anywhere — status transitions only, and every
           write archives a delta (reviewStoreOps, capped 200). Exports
           freeze their numbering: export_review stores the rendered
           markdown plus the numbering as it stood (reviewStoreExports,
           capped 20) and takes a full snapshot (reviewStoreHistory, capped
           20), because "Section 7" means something to a reader holding a
           copy and a later insert must not silently invalidate it. Private
           material (visibility 'private' on sections, subsections and
           threads) never enters an export and carries no number — so the
           numbering on the page and the numbering in an export agree.

           The store starts EMPTY and is seeded conversationally, by the
           owner, through these tools — patch_review bootstraps the skeleton
           on its first write. One divergence from the board's patch
           behaviour, per the spec: a write carrying a stale
           expectedLastUpdated is REFUSED here, not applied-and-flagged.
           The board's patches are small annotations where applying to live
           state is safe; a structural edit to a document is worth stopping.
  v120.0 — removeScratch. The pad had two exits and needed three: ingest
           promotes an item into an observation, clearScratch empties the lot,
           and there was no way to bin ONE piece of junk sitting among things
           worth keeping. The two bad workarounds that leaves are ingesting it
           somewhere it does not belong — which quietly corrupts the record the
           whole design exists to protect — or leaving it on the pad until
           everything else has been dealt with. Mirrors removeEvidence and
           removeQuestion, including refusing an unknown id rather than
           silently succeeding.
  v119.0 — The strategy record gains a third settled section and two evidence
           qualifiers, all from one addendum that would not fit v118's shape.

           analysis[] — a working explanation of WHY a pattern persists is
           neither an observation nor evidence. The page's one rule is that
           everything has exactly one right place; filing reasoning as an
           observation makes it look like a finding, and filing it as evidence
           dates something that has no date. So it gets its own section, and
           it deliberately takes no evidence table.

           quote:true on evidence — some evidence is strongest as the exact
           words someone wrote down at the time (a risk register entry, a
           written policy). Paraphrasing it loses the point, so the flag marks
           it verbatim and the page sets it as a quotation.

           foundational:true on an observation — marks substrate the others are
           downstream of, rather than a peer. Rare by definition: if everything
           is foundational, nothing is.

           Observation text may now contain blank lines, rendered as paragraphs.
           A substrate observation has to explain what it is upstream of, and
           that does not fit in one paragraph.
  v118.0 — Second document: the strategic observations page (/strategyReference).
           Three tools alongside the board's three — get_strategy,
           update_strategy, patch_strategy — on the SAME MCP server, so the
           connector Richard already has serves both without new plumbing.

           It is a separate node, not a corner of the board, because the two
           documents have opposite clocks. The board turns over daily and its
           job is to be current. This one accumulates for years and its job is
           to hold a pattern still — an observation written in August must
           survive every compile between now and the day it stops being true.
           Mixing them would let the daily rewrite eat the durable record.

           Two tiers, and the split is the whole design. Tier 1 observations
           are settled structural truths, each with a dated evidence table
           under it. Tier 2 is a scratch pad that anything can be thrown at
           mid-conversation. appendScratch is cheap and constant; `ingest`
           (evidence onto an observation + drop the pad item, atomically) is
           deliberate and happens only on an explicit go-ahead. Keeping
           capture and committing apart is what stops the page silting up.

           Evidence and solutions can be REMOVED — unlike the board's notes,
           which are append-only. That asymmetry is deliberate too: the ingest
           step is also an editing step, and a page nobody prunes becomes a
           wall of text nobody reads.
  v117.0 — The server stops thinking. Deleted /review (the scheduled watcher),
           /answer (the Q&A pass), /assist (the email composer), the
           ANTHROPIC_API_KEY they ran on, the /apiUsage spend tally and
           REVIEW_SECRET. 478 lines gone, and with them every paid call and
           the twice-daily staleness they caused.

           Two reasons, and the second is the one that mattered.

           Cost: those three endpoints were the only paid plumbing. Judgement
           now happens in a Claude client on the Max subscription, in the same
           conversational turn as the request — so filing is instant instead
           of waiting for a timer, and free instead of metered.

           Honesty: a server that thinks has no way of knowing what it is. On
           05/08 the answer pass was asked eight questions about the tool's own
           construction and got six materially wrong — including a flat denial
           that it cost money, written by a paid call, and a description of
           itself as unbuilt issued from inside itself. It could not have known
           better: nothing in its payload said what it was. Claude in a client
           can read this repo. Deleting the thinking here is what makes the
           self-knowledge requirements (SELF-KNOWLEDGE.md, R1-R8) achievable
           rather than aspirational.

           Kept whole: the read/write spine (get/patch/update_reference), the
           v114 concurrency fix, the v116.1 bounded archive, the v3 object
           model. The board's shape is unchanged — this is a removal, not a
           migration, and every existing board keeps working.
  v116.1 — Bounded archive. Every write used to stash a full copy of the
           board under walkReferenceHistory with nothing pruning it — 7.66 MB
           across 153 snapshots against a live board of 133 KB, 98% of the
           database, growing without bound. Now only whole-document writes
           (compile, review pass, answer pass) take a full snapshot, capped at
           the newest 20; patch_reference records a DELTA under
           walkReferenceOps instead — the ops, what they did, and the prior
           state of just the objects they name (~2.9 KB against 133 KB, and a
           readable audit trail rather than another copy of the board), capped
           at the newest 200. Pruning walks a small key index so it never
           reads a snapshot back to decide what to drop; the index backfills
           itself once from a pre-v116.1 archive. Archive keys are nudged
           forward on collision so two writes in the same millisecond can no
           longer overwrite each other. Ceiling ~3.2 MB, flat.
  v116.0 — The board architecture redesign (v3 spec, a64). Three object types
           kept clean: TASKS do, PROJECTS think, WIDGETS present. Additive —
           every v2 board keeps working untouched; v3 fields are read where
           present and derived where absent.
           Tasks gain: body (content, not just a one-liner), status
           open|part|done (done stays the source of truth — done ===
           status==='done', synced server-side on every write), updates[]
           (append-only progress log), bucket agenda|progress|waiting|done,
           owners {primary, secondary[]} at task AND subtask level,
           subtasks[], blockedBy[] (dependency links — a task blocked by an
           unfinished predecessor reads as Waiting).
           New ops: setStatus, appendActionUpdate, setBucket, setTaskBody,
           setOwner, addSubtask, tickSubtask, setBlockedBy, addPerson,
           askQuestion, answerQuestion, setConversationState, addWidget,
           retireWidget. addAction extended (status/bucket/body/owners/
           blockedBy/subtasks). tickAction now keeps status+bucket in sync.
           conversations[] is first-class: a question is NEVER silently
           resolved — it stays open until an answer is written into its
           thread. Answers come from a chat or the new on-demand
           /answer/<secret> pass, never the silent hourly file pass (which
           has no channel to reply). Change-detection widened from the tick
           map to per-task status+bucket, so a mid-state move or a refile
           wakes a review the way a tick does.
  v115.0 — The light-file pass. patch_reference gains addAction (create an
           action under a project, server-assigned id, optional drop onto
           today's plan) and setTake (replace the take in one op) — so a
           mid-day or scheduled run can FILE a note into an action and state
           what it did without a full-document write. addAction + resolveNote
           in one call is atomic (fixes "resolved but no action created").
           Notes gain a 'parked' state (open = file me, parked = live trigger
           skip me, resolved = done): appendNote accepts state:'parked' and a
           new setNoteState op moves open<->parked (never touches resolved).
           New meta.directive field (setDirective op) is the single file-held
           instruction naming which mode the automation runs (file | tidy |
           off) — the hourly task, the chat trigger and the desk button all
           read it, so behaviour changes by editing the board, not the prompt.
           Change-detection unchanged: only OPEN notes count, so parked
           triggers never wake a review.
  v114.0 — Concurrency-safe writes. New patch_reference tool applies small
           surgical ops (tickAction, setUrgency, appendNote, resolveNote,
           appendRichardNote, setPlan, appendDiff) to the FRESHLY-READ live
           board rather than a stale snapshot — so a mid-day edit can never
           clobber a desk-app or scheduled write. update_reference (the daily
           full compile) gains an optional expectedLastUpdated guard that
           refuses the write if the board moved since the caller read it.
           Notes remain append-only: no patch op deletes or rewrites an
           existing note. Fixes the eaten-tick defect (a26).
  v94.0 — reviewState carries a basis (tick map + per-open-note hashes +
          plan date) alongside the signature, so the desk app can count
          exactly how many changes are waiting since the last mark.
  v90.0 — Live spend tally: every API response's token usage accumulated
          into /apiUsage (calls, in/out tokens, since) for the desk app's
          meter. Composer ASK-FIRST rule: central context gaps produce
          NEED: questions instead of a draft; placeholders reserved for
          peripheral gaps.
  v88.0 — Fabrication rule broadened from personal details to ALL context:
          no invented events, agreements, dates, figures or history in
          composer output; unknowns are written around or left as
          [bracketed placeholders], never guessed.
  v87.0 — Mark It goes live on v2: reviewer rewritten for the Director/
          Author board (replace take, tick evidence-complete actions,
          resolve answerable open notes with one-liners + diff entry; no
          restructuring; change-detection so unchanged boards cost
          nothing). Composer hardened: never invent personal details
          (names, surnames, genders, honorifics) — write around unknowns.
  v82.0 — Assist engine: /assist endpoint with a function registry —
          first function compose_email (board-aware, style-encoded).
          Authenticated by Firebase ID token (must verify as Richard's
          account); CORS for the desk app. Board context sent minus the
          v1 mirror. Requires ANTHROPIC_API_KEY.
  v78.0 — v2 cutover: update_reference validates the v2 schema (requires
          notes / projects / plan; legacy mirror keys accepted as unknown
          keys during transition; archive behaviour unchanged). Ambient
          /review guarded off once the board is v2 — its merge logic is
          v1-shaped and will be rewritten separately.
  v74.0 — CORS on the review endpoint (allows the desk app's Mark It button
          to trigger a review directly from rckdo.github.io).
  v72.0 — Task commentary is thread-based: review marks append to each
          task's thread[] (sticky conversations) with a new-or-reply bar,
          legacy notes/claudeNote folded in; signature includes Richard's
          thread entries.
  v65.0 — The watcher: /review/<REVIEW_SECRET> endpoint for Cloud Scheduler.
          Compares Richard-authored content (tasks, notes, idea thread
          entries) against the last review signature; exits free if nothing
          changed; otherwise calls the Anthropic API and writes back a
          headline take, per-task claudeNote marks, and replies into idea
          threads (never twice in a row per idea). Reviews do NOT bump
          meta.lastUpdated (the "Compiled" stamp stays honest) — they stamp
          meta.lastReviewed instead. Ideas are now first-class in the schema:
          ideas[] = {id, title, seed, state: thrashing|parked|graduated,
          opened, thread[]: {ts, who: richard|claude, text}}. Requires
          ANTHROPIC_API_KEY env var on the Cloud Run service. Front-level
          claudeNote marks retired per 31/07 decision.
  v20.0 — Initial build: get_reference / update_reference MCP tools,
          archive-before-write, wipe guardrail, capability-URL auth.
*/

const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");
const admin = require("firebase-admin");

const SECRET = "wR7kPm2ZqXv9TnE4bYcH8dLsJ3fA";        // MCP capability URL — unchanged from v20.0
const PATH = "/mcp/" + SECRET;
const NODE = "walkReference";
const HISTORY = "walkReferenceHistory";

// The strategic observations page. Separate node, separate clock — see the
// v118.0 changelog for why it is not a corner of the board.
const SNODE = "strategyReference";
const SHISTORY = "strategyReferenceHistory";
const SOPS = "strategyReferenceOps";

// The review store — the third document. A long written document held as
// structure rather than as files, so nothing needs keeping in sync. Same
// clock as the strategy record (accumulates; never turned over), same access
// model (readable by one uid, writable only through here). See review/SPEC.md.
const RNODE = "reviewStore";
const RHISTORY = "reviewStoreHistory";
const ROPS = "reviewStoreOps";
const REXPORTS = "reviewStoreExports";
const EXPORTS_KEEP = 20;

// There is no API key here, and there must never be one again. This server
// reads and writes the board; it does not think. Every judgement call is made
// by Claude in a client Richard is actually talking to, on the subscription.
// See SELF-KNOWLEDGE.md for what the thinking-server cost us.

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://morning-walks-42eb6-default-rtdb.europe-west1.firebasedatabase.app"
});
const db = admin.database();
const asArray = v => Array.isArray(v) ? v : Object.values(v || {});

/* ===================== v3 object model (shared helpers) =====================
   Three object types, kept clean:
     tasks    — the DOING layer  (an action inside a project; status, buckets,
                updates, owners, subtasks, dependencies)
     projects — the THINKING layer (a binder + rolling summary; no ticks, ever)
     widgets  — the PRESENTATION layer (own no data; point at a task/project)
   Everything below is additive: a v2 action with only {id,text,urgency,done}
   reads correctly, because status and bucket are DERIVED when absent. */

const STATUSES = ["open", "part", "done"];
const BUCKETS  = ["agenda", "progress", "waiting", "done"];

const taskStatus = a => STATUSES.includes(a?.status) ? a.status : (a?.done ? "done" : "open");

// done is the source of truth: done === (status === 'done'). Called after every
// write that could move either one, so the two can never drift apart.
function syncStatus(a, status) {
  const was = taskStatus(a);
  a.status = (status && STATUSES.includes(status)) ? status : was;
  a.done = a.status === "done";
  if (a.done) {
    a.bucket = "done";
    // Stamp only on the transition — re-syncing a board full of historic
    // completions must not make them all look freshly done on the ribbon.
    if (was !== "done" && !a.doneTs) a.doneTs = new Date().toISOString();
  } else {
    if (a.bucket === "done") delete a.bucket;
    delete a.doneTs;
  }
  return a;
}

// Initials for the ownership circle: "Tom Blake" -> TB, "tom" -> T.
const initialsOf = name => String(name || "").trim().split(/\s+/)
  .map(w => w.charAt(0).toUpperCase()).join("").slice(0, 2) || "?";
const personId = name => String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// People are registered on first use so the desk can render a consistent
// circle for each person without the board carrying a hand-maintained roster.
function ensurePerson(ref, nameOrId) {
  const raw = String(nameOrId || "").trim();
  if (!raw) return null;
  const id = personId(raw);
  ref.people = asArray(ref.people);
  let p = ref.people.find(x => x && (x.id === id || personId(x.name) === id));
  if (!p) { p = { id, name: raw, initials: initialsOf(raw) }; ref.people.push(p); }
  return p.id;
}

/* ========================== Archive & pruning ==========================
   Before v116.1 EVERY write — including a two-field surgical patch — stashed a
   full copy of the board under walkReferenceHistory, and nothing ever pruned it.
   Five days of use produced 7.66 MB against a live board of 133 KB: 98% of the
   database was archive, growing without bound.

   Two changes, cause then symptom:

   (1) Only a write that REPLACES THE WHOLE DOCUMENT still takes a full snapshot
       — the daily compile, the review pass, the answer pass. Those are the ones
       you would actually roll back to. patch_reference applies only its listed
       ops, so it records a DELTA instead: the ops, what they did, and the prior
       state of just the objects they touched. Same recoverability, a fraction of
       the bytes, and a far more readable audit trail.

   (2) Both stores are capped. Pruning walks a tiny key index rather than the
       archive itself, so working out what to delete never reads a snapshot back.
       The index is backfilled once from a pre-v116.1 archive that hasn't got one. */

const OPS = "walkReferenceOps";
const HISTORY_KEEP = 20;    // full snapshots — ~2.6 MB ceiling at today's board size
const OPS_KEEP = 200;       // delta records — kilobytes each

const idxPath = node => node + "Index";

// Keys are timestamps so they sort oldest-first, but two writes inside the same
// millisecond would land on the same key and one would silently overwrite the
// other. Nudge forward instead: strictly increasing, still sorts correctly.
let lastArchiveKey = 0;
function archiveKey() {
  const now = Date.now();
  lastArchiveKey = now > lastArchiveKey ? now : lastArchiveKey + 1;
  return String(lastArchiveKey);
}

// Append `value` at `node/<key>`, then drop the oldest so `keep` survive.
async function remember(node, key, value, keep) {
  await db.ref(node + "/" + key).set(value);
  let idx = (await db.ref(idxPath(node)).get()).val();
  if (!idx) {
    // One-time backfill: a pre-v116.1 archive has no index, so read it once to
    // learn its keys (the values are discarded) and let the cap start applying.
    idx = {};
    (await db.ref(node).get()).forEach(child => { idx[child.key] = true; });
  }
  idx[key] = true;
  const keys = Object.keys(idx).sort();
  const drop = keys.slice(0, Math.max(0, keys.length - keep));
  for (let i = 0; i < drop.length; i += 20) {
    await Promise.all(drop.slice(i, i + 20).map(k => db.ref(node + "/" + k).remove()));
  }
  drop.forEach(k => { delete idx[k]; });
  await db.ref(idxPath(node)).set(idx);
}

const archiveFull = board => remember(HISTORY, archiveKey(), board, HISTORY_KEEP)
  .catch(e => console.error("archiveFull failed", e));

// The prior state of only what the ops name — enough to reverse a patch by hand.
function touchedBefore(board, operations) {
  const ids = new Set();
  operations.forEach(o => ["actionId", "taskId", "noteId", "convId", "widgetId"]
    .forEach(k => { if (o && o[k]) ids.add(String(o[k])); }));
  const before = {};
  asArray(board.projects).forEach(p => asArray(p.actions).forEach(a => {
    if (a && ids.has(String(a.id))) before[a.id] = a; }));
  asArray(board.notes).forEach(n => { if (n && ids.has(String(n.id))) before[n.id] = n; });
  asArray(board.conversations).forEach(c => { if (c && ids.has(String(c.id))) before[c.id] = c; });
  asArray(board.widgets).forEach(w => { if (w && ids.has(String(w.id))) before[String(w.id)] = w; });
  if (operations.some(o => o && o.op === "setPlan")) before._plan = board.plan || null;
  if (operations.some(o => o && o.op === "setTake")) before._take = board.take || null;
  return before;
}

const archiveDelta = (board, operations, applied) =>
  remember(OPS, archiveKey(), {
    ts: new Date().toISOString(),
    priorStamp: board?.meta?.lastUpdated || null,
    applied: applied.slice(0, 40),
    ops: operations.slice(0, 40),
    before: touchedBefore(board, operations)
  }, OPS_KEEP).catch(e => console.error("archiveDelta failed", e));


/* ============================== MCP tools ============================== */

function buildServer() {
  const server = new McpServer({ name: "walk-reference", version: "121.1" });

  server.tool(
    "get_reference",
    "Read the Morning Walk rolling reference. v3 board: projects[] (the THINKING layer — a binder with a rolling ~75-word summary; no tick boxes, ever) each holding actions[] (the DOING layer — tasks with title/body, status open|part|done, bucket agenda|progress|waiting|done, updates[] progress log, owners {primary, secondary[]}, subtasks[], blockedBy[] dependency links); widgets[] (the PRESENTATION layer — own no data, they point at a task or project and render it a particular way); conversations[] (Q&A threads — a question stays 'open' until an answer is written into its thread); notes[] (the in tray), plan {date, actionIds}, people[], take, diffs, meta. Legacy v1 keys (fronts, todaysPlan, ideas, richardsNotes, claudesTake) may still be present as mirrors. Call at the start of every morning-walk chat.",
    {},
    async () => {
      const snap = await db.ref(NODE).get();
      if (!snap.exists()) return { content: [{ type: "text", text: "ERROR: /walkReference is empty." }] };
      return { content: [{ type: "text", text: JSON.stringify(snap.val(), null, 2) }] };
    }
  );

  server.tool(
    "update_reference",
    "Write the complete new state of the rolling reference — use for the DAILY COMPILE (a full rewrite), NOT for small mid-day edits (use patch_reference for those). Pass the ENTIRE document as a JSON string — replaces the node wholesale; previous state is archived automatically and meta.lastUpdated/updatedBy are stamped by the server. v3 schema: notes[], projects[] (each with actions: id/text/body/urgency/done/status/bucket/updates[]/owners{primary,secondary[]}/subtasks[]/blockedBy[]/provenance), plan {date, actionIds}, widgets[] (presentation only — lifespan permanent|invoked), conversations[] ({id, topic, state open|answered|closed, thread[{author,text,ts}]}), people[], take, diffs[] — legacy mirror keys (fronts, todaysPlan) accepted during transition. done is the source of truth (done === status==='done') and is re-synced server-side on write. Refused if notes, projects or plan are missing. OPTIONAL CONFLICT GUARD: pass expectedLastUpdated (the meta.lastUpdated value you saw when you read the board); if the live board has moved since, the write is refused so you can re-read rather than clobber a desk-app or scheduled edit.",
    {
      referenceJson: z.string().describe("Full reference document as a JSON string"),
      expectedLastUpdated: z.string().optional().describe("The meta.lastUpdated you read; write is refused if the live board has moved past it")
    },
    async ({ referenceJson, expectedLastUpdated }) => {
      let next;
      try { next = JSON.parse(referenceJson); }
      catch (e) { return { content: [{ type: "text", text: "ERROR: invalid JSON — " + e.message }] }; }
      if (!next || typeof next !== "object" || !next.notes || !next.projects || !next.plan)
        return { content: [{ type: "text", text: "ERROR: refused — v2 payload must contain 'notes', 'projects' and 'plan'. Unknown/legacy keys (fronts, todaysPlan mirrors) are accepted. Node unchanged." }] };

      const current = await db.ref(NODE).get();

      // Conflict guard: if caller told us what they read, refuse when the board has moved on.
      if (expectedLastUpdated && current.exists()) {
        const liveStamp = current.val()?.meta?.lastUpdated || "";
        if (liveStamp && liveStamp !== expectedLastUpdated) {
          return { content: [{ type: "text", text:
            "CONFLICT: the board moved since you read it (live meta.lastUpdated=" + liveStamp +
            ", you expected " + expectedLastUpdated + "). Nothing written — re-read with get_reference and re-apply your change." }] };
        }
      }

      // Full rewrite — this is exactly the write worth a full snapshot.
      if (current.exists()) await archiveFull(current.val());

      // v3: done is the source of truth. A full rewrite that sets one and not the
      // other would let them drift, so re-sync every task before the write.
      asArray(next.projects).forEach(p => asArray(p.actions).forEach(a => {
        if (a && a.id) syncStatus(a, a.status);
      }));

      next.meta = next.meta || {};
      next.meta.lastUpdated = new Date().toISOString();
      next.meta.updatedBy = "claude";
      await db.ref(NODE).set(next);
      return { content: [{ type: "text", text: "OK: reference updated at " + next.meta.lastUpdated + " (previous state archived)." }] };
    }
  );

  server.tool(
    "patch_reference",
    "Apply SMALL, SURGICAL edits to the board without rewriting the whole document — use this for every mid-day change (tick an action, append a note, add a diff, change an urgency). Concurrency-safe: it reads the board fresh, applies only your listed operations to the live state, and writes back — so it can never clobber a desk-app or scheduled edit the way a full-document write can. Operations are applied in order. Supported ops:\n" +
    "  { op:'tickAction', actionId:'a3', done:true }  — set an action's done flag\n" +
    "  { op:'setUrgency', actionId:'a5', urgency:'now' }  — change an action's urgency (now|soon|later)\n" +
    "  { op:'appendNote', text:'...', anchor:'sam' }  — add a NEW open note (server assigns id + ISO ts). anchor optional. NEVER rewrites existing notes.\n" +
    "  { op:'resolveNote', noteId:'n7', text:'answered — ...' }  — mark an open note resolved with a one-line resolution (server stamps ts + links a diff)\n" +
    "  { op:'appendRichardNote', text:'...' }  — add to richardsNotes (server stamps ts)\n" +
    "  { op:'setPlan', date:'04/08/2026', actionIds:['a2','a4'] }  — replace today's plan actionIds/date\n" +
    "  { op:'appendDiff', what:'...', why:'...' }  — add a diff entry (server assigns id + ts)\n" +
    "  { op:'addAction', projectId:'dazn', text:'...', urgency:'now', provenance:['...'], toPlan:true }  — create a NEW action under a project (server assigns the id; urgency defaults now; toPlan drops it onto today's plan). Batch with resolveNote in the SAME call to file a note into an action atomically.\n" +
    "  { op:'setTake', text:'...' }  — replace the take with a single fresh entry (state what this pass did)\n" +
    "  { op:'appendNote', text:'...', state:'parked' }  — appendNote also accepts state:'parked' to file a live-trigger note that a file pass skips\n" +
    "  { op:'setNoteState', noteId:'n7', state:'parked' }  — move a note between open (file me) and parked (live trigger, skip me); cannot touch a resolved note\n" +
    "  { op:'setDirective', directive:'file' }  — set meta.directive, the single file-held instruction naming which mode the automation runs (file | tidy | off)\n" +
    "v3 ops — the DOING layer (tasks):\n" +
    "  { op:'setStatus', taskId:'a3', status:'part' }  — open | part | done. 'part' is the mid-state: not done, but legitimately in flight (carryable-not-ignored). done stays the source of truth and is synced for you.\n" +
    "  { op:'appendActionUpdate', taskId:'a3', text:'...' }  — append a progress note to the task's update log WITHOUT ticking it (server stamps ts). This is 'send an update on this item'.\n" +
    "  { op:'setBucket', taskId:'a3', bucket:'waiting' }  — refile across the columns: agenda (on the agenda) | progress (in progress, MINE — signal: act) | waiting (blocked on someone else — signal: chase) | done. Setting 'done' also sets status done.\n" +
    "  { op:'setTaskBody', taskId:'a3', body:'...' }  — set the task's body/content (a task is a title AND a body, not just a one-liner)\n" +
    "  { op:'setOwner', taskId:'a3', subtaskId:'s1', primary:'Tom', secondary:['Richard'] }  — ownership is LAYERED: one primary owner (the person actually doing it) plus any number of secondary associates. subtaskId optional — a person can own a specific subtask inside a task someone else owns. Pass clear:true to strip ownership. A primary owner who isn't Richard reads as a chase, not a do.\n" +
    "  { op:'addSubtask', taskId:'a3', text:'...', primary:'Tom' }  — add a subtask (server assigns the id); primary optional\n" +
    "  { op:'tickSubtask', taskId:'a3', subtaskId:'s1', done:true }  — tick a subtask\n" +
    "  { op:'setBlockedBy', taskId:'a61', blockedBy:['a60'] }  — dependency link: this task can't start until those are done. Not a Gantt — dependency-aware ordering. A task blocked by an unfinished predecessor reads as Waiting until the predecessor is done. Pass [] to clear.\n" +
    "  { op:'addPerson', name:'Tom Blake', initials:'TB' }  — register a person (done automatically on first setOwner, so rarely needed)\n" +
    "Q&A — a question is NEVER silently resolved:\n" +
    "  { op:'askQuestion', topic:'...', text:'...' }  — open a conversation. It stays 'open' and shows prominently until an answer is written into its thread.\n" +
    "  { op:'answerQuestion', convId:'c1', text:'...' }  — write the reply into the thread and set state 'answered'. Use this from a chat or an on-demand answer pass — never leave a question resolved without a written answer.\n" +
    "  { op:'setConversationState', convId:'c1', state:'closed' }  — open | answered | closed\n" +
    "Widgets — presentation only, they own no data (Claude curates them; Richard narrates):\n" +
    "  { op:'addWidget', type:'countdown', props:{...}, anchor:'top', lifespan:'invoked', expiry:'2026-08-18' }  — spin one up. lifespan: 'permanent' (standing — always on the shelf) or 'invoked' (has a trigger and an expiry; retire it when it goes stale).\n" +
    "  { op:'retireWidget', widgetId:'w12' }  — take one off the shelf. Safe: widgets own no data.\n" +
    "Notes are append-only; there is no op that deletes or rewrites an existing note's text. Returns the new meta.lastUpdated.",
    {
      ops: z.string().describe("JSON array of operation objects, applied in order (see tool description for shapes)"),
      expectedLastUpdated: z.string().optional().describe("Optional: the meta.lastUpdated you last saw; if set and the board has moved, the patch is still applied safely to live state, but the response flags that the board had changed")
    },
    async ({ ops, expectedLastUpdated }) => {
      let operations;
      try { operations = JSON.parse(ops); }
      catch (e) { return { content: [{ type: "text", text: "ERROR: invalid ops JSON — " + e.message }] }; }
      if (!Array.isArray(operations) || !operations.length)
        return { content: [{ type: "text", text: "ERROR: ops must be a non-empty JSON array." }] };

      // Read the LIVE board — patches always apply to current state, never a stale snapshot.
      const snap = await db.ref(NODE).get();
      if (!snap.exists()) return { content: [{ type: "text", text: "ERROR: /walkReference is empty — nothing to patch." }] };
      const ref = snap.val();
      const priorStamp = ref?.meta?.lastUpdated || "";
      const now = new Date().toISOString();

      const findAction = id => {
        for (const p of asArray(ref.projects)) {
          for (const a of asArray(p.actions)) if (a.id === id) return a;
        }
        return null;
      };
      const nextNoteId = () => {
        const ids = asArray(ref.notes).map(n => String(n.id));
        let n = ids.length + 1;
        while (ids.includes("n" + n)) n++;
        return "n" + n;
      };
      const findProject = id => asArray(ref.projects).find(p => p.id === id) || null;
      const nextConvId = () => {
        const ids = asArray(ref.conversations).map(c => String(c.id));
        let n = ids.length + 1;
        while (ids.includes("c" + n)) n++;
        return "c" + n;
      };
      const nextWidgetId = () => {
        let max = 0;
        asArray(ref.widgets).forEach(w => {
          const m = /^w(\d+)$/.exec(String(w?.id || ""));
          if (m) max = Math.max(max, parseInt(m[1], 10));
        });
        return "w" + (max + 1);
      };
      const nextSubId = a => {
        const ids = asArray(a.subtasks).map(s => String(s.id));
        let n = ids.length + 1;
        while (ids.includes("s" + n)) n++;
        return "s" + n;
      };
      // Ownership is layered: one primary (the doer), any number of secondaries.
      const applyOwners = (target, o) => {
        if (o.clear) { delete target.owners; return "cleared"; }
        const owners = target.owners || {};
        if (o.primary !== undefined)
          owners.primary = o.primary === null || o.primary === "" ? null : ensurePerson(ref, o.primary);
        if (Array.isArray(o.secondary))
          owners.secondary = o.secondary.map(s => ensurePerson(ref, s)).filter(Boolean);
        if (!owners.primary) delete owners.primary;
        if (!asArray(owners.secondary).length) delete owners.secondary;
        if (Object.keys(owners).length) target.owners = owners; else delete target.owners;
        return (owners.primary || "—") + (asArray(owners.secondary).length ? "+" + owners.secondary.length : "");
      };
      const nextActionId = () => {
        // Highest existing aN across ALL projects + 1, so ids never collide even
        // if a project was deleted or actions were moved between projects.
        let max = 0;
        asArray(ref.projects).forEach(p => asArray(p.actions).forEach(a => {
          const m = /^a(\d+)$/.exec(String(a.id));
          if (m) max = Math.max(max, parseInt(m[1], 10));
        }));
        return "a" + (max + 1);
      };

      const applied = [];
      const errors = [];
      let pendingDiffId = null;

      for (let i = 0; i < operations.length; i++) {
        const o = operations[i] || {};
        try {
          switch (o.op) {
            case "tickAction": {
              const a = findAction(o.actionId);
              if (!a) { errors.push("op " + i + ": action " + o.actionId + " not found"); break; }
              // v116: a tick moves status and bucket with it, so the three can never drift.
              syncStatus(a, o.done !== false ? "done" : "open");
              applied.push("tick " + o.actionId + "=" + a.done);
              break;
            }
            case "setUrgency": {
              const a = findAction(o.actionId);
              if (!a) { errors.push("op " + i + ": action " + o.actionId + " not found"); break; }
              if (!["now", "soon", "later"].includes(o.urgency)) { errors.push("op " + i + ": bad urgency"); break; }
              a.urgency = o.urgency;
              applied.push("urgency " + o.actionId + "=" + o.urgency);
              break;
            }
            case "appendNote": {
              if (!o.text) { errors.push("op " + i + ": appendNote needs text"); break; }
              const st = o.state === "parked" ? "parked" : "open";
              ref.notes = asArray(ref.notes);
              const note = { id: nextNoteId(), text: String(o.text), state: st, ts: now };
              if (o.anchor) note.anchor = String(o.anchor);
              ref.notes.push(note);
              applied.push("note+ " + note.id + (st === "parked" ? " (parked)" : ""));
              break;
            }
            case "resolveNote": {
              if (!o.noteId || !o.text) { errors.push("op " + i + ": resolveNote needs noteId+text"); break; }
              const note = asArray(ref.notes).find(n => n.id === o.noteId);
              if (!note) { errors.push("op " + i + ": note " + o.noteId + " not found"); break; }
              if (note.state === "resolved") { errors.push("op " + i + ": note " + o.noteId + " already resolved"); break; }
              if (!pendingDiffId) pendingDiffId = "d" + (asArray(ref.diffs).length + 1);
              note.state = "resolved";
              note.resolution = { ts: now, text: String(o.text), diffId: pendingDiffId };
              applied.push("resolve " + o.noteId);
              break;
            }
            case "appendRichardNote": {
              if (!o.text) { errors.push("op " + i + ": appendRichardNote needs text"); break; }
              ref.richardsNotes = asArray(ref.richardsNotes);
              ref.richardsNotes.push({ text: String(o.text), ts: now });
              applied.push("richardNote+");
              break;
            }
            case "setPlan": {
              ref.plan = ref.plan || {};
              if (o.date) ref.plan.date = String(o.date);
              if (Array.isArray(o.actionIds)) ref.plan.actionIds = o.actionIds.map(String);
              applied.push("plan set");
              break;
            }
            case "appendDiff": {
              if (!o.what) { errors.push("op " + i + ": appendDiff needs what"); break; }
              const diffs = asArray(ref.diffs);
              const id = pendingDiffId || ("d" + (diffs.length + 1));
              diffs.push({ id, ts: now, changes: [{ what: String(o.what), why: String(o.why || "mid-day patch") }] });
              ref.diffs = diffs.slice(-8);
              applied.push("diff+ " + id);
              break;
            }
            case "addAction": {
              // Create a NEW action under an existing project. Server assigns the id.
              // Batch with resolveNote in the same ops array to file a note into an
              // action as ONE atomic write (kills the "resolved but no action created" defect).
              if (!o.projectId || !o.text) { errors.push("op " + i + ": addAction needs projectId+text"); break; }
              const proj = findProject(o.projectId);
              if (!proj) { errors.push("op " + i + ": project " + o.projectId + " not found"); break; }
              const urgency = ["now", "soon", "later"].includes(o.urgency) ? o.urgency : "now";
              const id = nextActionId();
              const action = {
                id, text: String(o.text), urgency, done: false,
                provenance: (Array.isArray(o.provenance) ? o.provenance.map(String) : [])
              };
              // v3 fields, all optional — a task is a title AND a body, carries a
              // status, sits in a bucket, and may be owned or blocked from birth.
              if (o.body) action.body = String(o.body);
              if (Array.isArray(o.blockedBy)) action.blockedBy = o.blockedBy.map(String);
              if (o.primary !== undefined || Array.isArray(o.secondary)) applyOwners(action, o);
              if (Array.isArray(o.subtasks)) action.subtasks = o.subtasks.map((s, si) => {
                const st = { id: "s" + (si + 1), text: String(typeof s === "string" ? s : s.text), done: false };
                if (typeof s === "object" && s && s.primary) applyOwners(st, { primary: s.primary });
                return st;
              });
              syncStatus(action, o.status);
              if (BUCKETS.includes(o.bucket)) { action.bucket = o.bucket; if (o.bucket === "done") syncStatus(action, "done"); }
              proj.actions = asArray(proj.actions);
              proj.actions.push(action);
              // Optionally drop onto today's plan (end of the list).
              if (o.toPlan) {
                ref.plan = ref.plan || {};
                ref.plan.actionIds = asArray(ref.plan.actionIds).map(String);
                if (!ref.plan.actionIds.includes(id)) ref.plan.actionIds.push(id);
              }
              applied.push("action+ " + id + "@" + o.projectId + (o.toPlan ? " (on plan)" : ""));
              break;
            }
            case "setTake": {
              // Replace the take with a single fresh entry — lets a run state what it did
              // instead of filing silently or forcing a full-document write for two lines.
              if (!o.text) { errors.push("op " + i + ": setTake needs text"); break; }
              ref.take = [{ ts: now, text: String(o.text) }];
              applied.push("take set");
              break;
            }
            case "setNoteState": {
              // Move a note between open and parked. 'parked' = live trigger, skip me on a
              // file pass; 'open' = file me. Resolving is resolveNote's job (it stamps a diff).
              if (!o.noteId || !["open", "parked"].includes(o.state)) {
                errors.push("op " + i + ": setNoteState needs noteId + state(open|parked)"); break;
              }
              const note = asArray(ref.notes).find(n => n.id === o.noteId);
              if (!note) { errors.push("op " + i + ": note " + o.noteId + " not found"); break; }
              if (note.state === "resolved") { errors.push("op " + i + ": note " + o.noteId + " is resolved — cannot reopen"); break; }
              note.state = o.state;
              applied.push("note " + o.noteId + "=" + o.state);
              break;
            }
            case "setDirective": {
              // The single file-held instruction naming which mode the automation runs:
              // 'file' (light hourly file pass), 'tidy'/'compile' (full pass), or 'off'.
              // The xx:36 task, the chat trigger and the desk button all read this — so
              // behaviour changes by editing the BOARD, never the task prompt.
              if (o.directive === undefined || o.directive === null) { errors.push("op " + i + ": setDirective needs directive"); break; }
              ref.meta = ref.meta || {};
              ref.meta.directive = String(o.directive);
              applied.push("directive=" + ref.meta.directive);
              break;
            }

            /* ---------------- v3: the doing layer ---------------- */
            case "setStatus": {
              // The mid-state fix (a55): binary done/not-done had nowhere to record
              // progress that isn't completion. 'part' is not done, but in flight.
              if (!STATUSES.includes(o.status)) { errors.push("op " + i + ": status must be open|part|done"); break; }
              const a = findAction(o.taskId || o.actionId);
              if (!a) { errors.push("op " + i + ": task " + (o.taskId || o.actionId) + " not found"); break; }
              syncStatus(a, o.status);
              applied.push("status " + a.id + "=" + a.status);
              break;
            }
            case "appendActionUpdate": {
              // Attach a progress note WITHOUT a tick. Append-only.
              if (!o.text) { errors.push("op " + i + ": appendActionUpdate needs text"); break; }
              const a = findAction(o.taskId || o.actionId);
              if (!a) { errors.push("op " + i + ": task " + (o.taskId || o.actionId) + " not found"); break; }
              a.updates = asArray(a.updates);
              a.updates.push({ text: String(o.text), ts: now });
              applied.push("update+ " + a.id + " (" + a.updates.length + ")");
              break;
            }
            case "setBucket": {
              if (!BUCKETS.includes(o.bucket)) { errors.push("op " + i + ": bucket must be agenda|progress|waiting|done"); break; }
              const a = findAction(o.taskId || o.actionId);
              if (!a) { errors.push("op " + i + ": task " + (o.taskId || o.actionId) + " not found"); break; }
              if (o.bucket === "done") syncStatus(a, "done");
              else { if (taskStatus(a) === "done") syncStatus(a, "open"); a.bucket = o.bucket; }
              // The chase radar counts days — the clock starts when the wait does.
              if (a.bucket === "waiting") { if (!a.waitingSince) a.waitingSince = now; }
              else delete a.waitingSince;
              applied.push("bucket " + a.id + "=" + (a.bucket || "done"));
              break;
            }
            case "setTaskBody": {
              const a = findAction(o.taskId || o.actionId);
              if (!a) { errors.push("op " + i + ": task " + (o.taskId || o.actionId) + " not found"); break; }
              if (o.body) a.body = String(o.body); else delete a.body;
              applied.push("body " + a.id);
              break;
            }
            case "setOwner": {
              // Ownership is a property of the DOING layer only — tasks and
              // subtasks. Projects are binders; they are not owned this way.
              const a = findAction(o.taskId || o.actionId);
              if (!a) { errors.push("op " + i + ": task " + (o.taskId || o.actionId) + " not found"); break; }
              let target = a, label = a.id;
              if (o.subtaskId) {
                const st = asArray(a.subtasks).find(s => s.id === o.subtaskId);
                if (!st) { errors.push("op " + i + ": subtask " + o.subtaskId + " not found on " + a.id); break; }
                target = st; label = a.id + "/" + st.id;
              }
              applied.push("owner " + label + "=" + applyOwners(target, o));
              // Handing a task to someone else starts the chase clock too —
              // "owned by someone else" and "waiting on someone else" are cousins.
              if (!o.subtaskId) {
                const me = String(ref.meta?.me || "richard");
                const p = a.owners?.primary;
                if (p && p !== me) { if (!a.waitingSince) a.waitingSince = now; }
                else delete a.waitingSince;
              }
              break;
            }
            case "addSubtask": {
              if (!o.text) { errors.push("op " + i + ": addSubtask needs text"); break; }
              const a = findAction(o.taskId || o.actionId);
              if (!a) { errors.push("op " + i + ": task " + (o.taskId || o.actionId) + " not found"); break; }
              a.subtasks = asArray(a.subtasks);
              const st = { id: nextSubId(a), text: String(o.text), done: false };
              if (o.primary || Array.isArray(o.secondary)) applyOwners(st, o);
              a.subtasks.push(st);
              applied.push("subtask+ " + a.id + "/" + st.id);
              break;
            }
            case "tickSubtask": {
              const a = findAction(o.taskId || o.actionId);
              if (!a) { errors.push("op " + i + ": task " + (o.taskId || o.actionId) + " not found"); break; }
              const st = asArray(a.subtasks).find(s => s.id === o.subtaskId);
              if (!st) { errors.push("op " + i + ": subtask " + o.subtaskId + " not found on " + a.id); break; }
              st.done = o.done !== false;
              applied.push("subtask " + a.id + "/" + st.id + "=" + st.done);
              break;
            }
            case "setBlockedBy": {
              // Dependency-aware ordering, not a Gantt: the desk reads a task with
              // an unfinished predecessor as Waiting, and surfaces what's unblocked.
              if (!Array.isArray(o.blockedBy)) { errors.push("op " + i + ": setBlockedBy needs blockedBy array"); break; }
              const a = findAction(o.taskId || o.actionId);
              if (!a) { errors.push("op " + i + ": task " + (o.taskId || o.actionId) + " not found"); break; }
              const ids = o.blockedBy.map(String).filter(x => x !== a.id);
              const missing = ids.filter(x => !findAction(x));
              if (missing.length) { errors.push("op " + i + ": unknown predecessor(s) " + missing.join(",")); break; }
              if (ids.length) a.blockedBy = ids; else delete a.blockedBy;
              applied.push("blockedBy " + a.id + "=[" + ids.join(",") + "]");
              break;
            }
            case "addPerson": {
              if (!o.name) { errors.push("op " + i + ": addPerson needs name"); break; }
              const pid = ensurePerson(ref, o.name);
              if (o.initials) {
                const p = asArray(ref.people).find(x => x.id === pid);
                if (p) p.initials = String(o.initials).slice(0, 3).toUpperCase();
              }
              applied.push("person+ " + pid);
              break;
            }

            /* ---------------- v3: conversations (Q&A) ---------------- */
            case "askQuestion": {
              // The a56 fix: a question dropped in the tray used to be filed-and-
              // resolved silently, so the answer was invisible. A conversation
              // stays 'open' until an answer is written into its thread.
              if (!o.text) { errors.push("op " + i + ": askQuestion needs text"); break; }
              ref.conversations = asArray(ref.conversations);
              const conv = {
                id: nextConvId(), topic: String(o.topic || String(o.text).slice(0, 60)),
                state: "open", opened: now,
                thread: [{ author: o.author === "claude" ? "claude" : "richard", text: String(o.text), ts: now }]
              };
              ref.conversations.push(conv);
              applied.push("question+ " + conv.id);
              break;
            }
            case "answerQuestion": {
              if (!o.convId || !o.text) { errors.push("op " + i + ": answerQuestion needs convId+text"); break; }
              const conv = asArray(ref.conversations).find(c => c.id === o.convId);
              if (!conv) { errors.push("op " + i + ": conversation " + o.convId + " not found"); break; }
              conv.thread = asArray(conv.thread);
              conv.thread.push({ author: o.author === "richard" ? "richard" : "claude", text: String(o.text), ts: now });
              conv.state = "answered";
              applied.push("answer " + conv.id);
              break;
            }
            case "setConversationState": {
              if (!o.convId || !["open", "answered", "closed"].includes(o.state)) {
                errors.push("op " + i + ": setConversationState needs convId + state(open|answered|closed)"); break;
              }
              const conv = asArray(ref.conversations).find(c => c.id === o.convId);
              if (!conv) { errors.push("op " + i + ": conversation " + o.convId + " not found"); break; }
              // Guard the whole point of the feature: nothing gets marked answered
              // without an answer actually sitting in the thread.
              if (o.state === "answered" && !asArray(conv.thread).some(t => t.author === "claude")) {
                errors.push("op " + i + ": " + conv.id + " has no answer in its thread — use answerQuestion"); break;
              }
              conv.state = o.state;
              applied.push("conv " + conv.id + "=" + o.state);
              break;
            }

            /* ---------------- v3: widgets (presentation only) ---------------- */
            case "addWidget": {
              if (!o.type) { errors.push("op " + i + ": addWidget needs type"); break; }
              ref.widgets = asArray(ref.widgets);
              const w = {
                id: o.id ? String(o.id) : nextWidgetId(),
                type: String(o.type),
                anchor: o.anchor ? String(o.anchor) : "top",
                lifespan: o.lifespan === "invoked" ? "invoked" : "permanent",
                props: (o.props && typeof o.props === "object") ? o.props : {}
              };
              if (o.expiry) w.expiry = String(o.expiry);
              if (Array.isArray(o.provenance)) w.provenance = o.provenance.map(String);
              ref.widgets.push(w);
              applied.push("widget+ " + w.id + " (" + w.type + ", " + w.lifespan + ")");
              break;
            }
            case "retireWidget": {
              // Safe to delete outright: widgets own no data, they only point at it.
              if (!o.widgetId) { errors.push("op " + i + ": retireWidget needs widgetId"); break; }
              const ws = asArray(ref.widgets);
              const before = ws.length;
              ref.widgets = ws.filter(w => String(w?.id) !== String(o.widgetId));
              if (ref.widgets.length === before) { errors.push("op " + i + ": widget " + o.widgetId + " not found"); break; }
              applied.push("widget- " + o.widgetId);
              break;
            }

            default:
              errors.push("op " + i + ": unknown op '" + o.op + "'");
          }
        } catch (e) {
          errors.push("op " + i + ": " + e.message);
        }
      }

      if (!applied.length) {
        return { content: [{ type: "text", text: "ERROR: no operations applied. " + errors.join("; ") }] };
      }

      // Archive prior state, stamp, and write back the (freshly-read, now-mutated) board.
      // Surgical: record what changed, not another copy of the whole board.
      await archiveDelta(snap.val(), operations, applied);
      ref.meta = ref.meta || {};
      ref.meta.lastUpdated = now;
      ref.meta.updatedBy = "claude";
      await db.ref(NODE).set(ref);

      const moved = expectedLastUpdated && priorStamp && priorStamp !== expectedLastUpdated;
      return { content: [{ type: "text", text:
        "OK: patched at " + now + " — " + applied.join(", ") +
        (errors.length ? " | SKIPPED: " + errors.join("; ") : "") +
        (moved ? " | NOTE: board had moved since you last read it (was " + expectedLastUpdated + ", found " + priorStamp + ") — your patch applied safely to the live state." : "") +
        " (previous state archived)." }] };
    }
  );

  /* ==================== Strategic observations (tier 1 + 2) ====================
     A second, much simpler document on the same server. Shape:

       observations[] { id, letter, title, text, state: live|retired, opened,
                        foundational,
                        evidence[] { id, date, text, confirm, quote },
                        solutions[] { id, text, brief } }
       analysis[]     { id, title, points[], consequence }
       scratch[]      { id, ts, text, anchor }
       questions[]    { id, text, state: open|answered, answer, answeredTs }
       meta           { lastUpdated, updatedBy }

     `date` on evidence is a free-text string on purpose. Half of what belongs
     here is "Ongoing" or "c. 2024-25" — forcing it into an ISO date would mean
     inventing precision the evidence does not have. `confirm: true` marks a
     date Richard still has to verify, and the page renders it as such.

     `quote: true` marks evidence reproduced verbatim from a source document
     rather than described. Some evidence is strongest as the exact words that
     were written down at the time, and paraphrasing it loses the point.

     `analysis[]` exists because a working explanation is neither an observation
     nor evidence, and the page's one rule is that everything has exactly one
     right place. An observation says what is true; analysis says why it persists
     and takes no dated evidence. Forcing the second into the first would make
     reasoning look like a finding.

     `foundational: true` marks an observation the others are downstream of —
     substrate rather than a peer. Rare by definition: if everything is
     foundational, nothing is. */

  const nextStratId = (list, prefix) => {
    let max = 0;
    asArray(list).forEach(x => {
      const m = new RegExp("^" + prefix + "(\\d+)$").exec(String(x?.id || ""));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return prefix + (max + 1);
  };

  // A, B, C ... then 27+ falls back to a number rather than inventing AA.
  const nextLetter = obs => {
    const used = new Set(asArray(obs).map(o => String(o?.letter || "")));
    for (let i = 0; i < 26; i++) {
      const c = String.fromCharCode(65 + i);
      if (!used.has(c)) return c;
    }
    return String(asArray(obs).length + 1);
  };

  const findObservation = (doc, id) =>
    asArray(doc.observations).find(o => String(o?.id) === String(id)) || null;

  // The observation owning a given evidence/solution id, so a removal op only
  // needs the child id — the caller shouldn't have to know the parent.
  const findOwner = (doc, key, childId) => {
    for (const o of asArray(doc.observations)) {
      if (asArray(o[key]).some(c => String(c?.id) === String(childId))) return o;
    }
    return null;
  };

  const stratTouchedBefore = (doc, operations) => {
    const ids = new Set();
    operations.forEach(o => ["observationId", "evidenceId", "solutionId", "scratchId", "questionId", "analysisId"]
      .forEach(k => { if (o && o[k]) ids.add(String(o[k])); }));
    const before = {};
    asArray(doc.observations).forEach(o => {
      if (ids.has(String(o?.id))) before[o.id] = o;
      asArray(o?.evidence).forEach(e => { if (ids.has(String(e?.id))) before[e.id] = e; });
      asArray(o?.solutions).forEach(s => { if (ids.has(String(s?.id))) before[s.id] = s; });
    });
    asArray(doc.analysis).forEach(a => { if (ids.has(String(a?.id))) before[a.id] = a; });
    asArray(doc.scratch).forEach(s => { if (ids.has(String(s?.id))) before[s.id] = s; });
    asArray(doc.questions).forEach(q => { if (ids.has(String(q?.id))) before[q.id] = q; });
    // clearScratch drops the lot, so the pad's prior contents ARE the delta.
    if (operations.some(o => o && o.op === "clearScratch")) before._scratch = doc.scratch || null;
    return before;
  };

  server.tool(
    "get_strategy",
    "Read the strategic observations page — the durable record of how the organisation actually works. This is a documentation of PROBLEMS, not a to-do list, and it is a different document from the Morning Walk board (that is get_reference). Two tiers: observations[] are settled structural truths, each kept GENERAL (it should stay true after the incident that prompted it has faded) and each carrying an evidence[] table of dated specifics plus any labelled solutions[]; scratch[] is the uncommitted pad of loose items not yet folded in. Also analysis[] (working explanations of WHY the pattern persists — reasoning, not findings, and they take no evidence) and questions[] (open questions in prose). An observation flagged foundational:true is substrate the others are downstream of. Call at the START of every Strategy session and present the current state before discussing anything.",
    {},
    async () => {
      const snap = await db.ref(SNODE).get();
      if (!snap.exists()) return { content: [{ type: "text", text:
        "EMPTY: /strategyReference does not exist yet. Seed it by reading strategy/seed.json from the morning-walks repo and passing it to update_strategy." }] };
      return { content: [{ type: "text", text: JSON.stringify(snap.val(), null, 2) }] };
    }
  );

  server.tool(
    "update_strategy",
    "Write the COMPLETE new state of the strategic observations page — use for the initial seed and for a genuine restructure (merging two observations, rewriting a diagnosis, a pruning pass). NOT for ordinary capture: appendScratch and the ingest ops on patch_strategy cover everything a normal session does. Pass the entire document as a JSON string; it replaces the node wholesale, the previous state is archived, and meta.lastUpdated/updatedBy are stamped by the server. Must contain 'observations'. Ids and letters are assigned where missing. OPTIONAL CONFLICT GUARD: pass expectedLastUpdated (the meta.lastUpdated you saw when you read it); if the live document has moved since, the write is refused so you re-read rather than clobber.",
    {
      strategyJson: z.string().describe("Full strategy document as a JSON string"),
      expectedLastUpdated: z.string().optional().describe("The meta.lastUpdated you read; write is refused if the live document has moved past it")
    },
    async ({ strategyJson, expectedLastUpdated }) => {
      let next;
      try { next = JSON.parse(strategyJson); }
      catch (e) { return { content: [{ type: "text", text: "ERROR: invalid JSON — " + e.message }] }; }
      if (!next || typeof next !== "object" || !next.observations)
        return { content: [{ type: "text", text: "ERROR: refused — payload must contain 'observations'. Node unchanged." }] };

      const current = await db.ref(SNODE).get();
      if (expectedLastUpdated && current.exists()) {
        const liveStamp = current.val()?.meta?.lastUpdated || "";
        if (liveStamp && liveStamp !== expectedLastUpdated) {
          return { content: [{ type: "text", text:
            "CONFLICT: the page moved since you read it (live meta.lastUpdated=" + liveStamp +
            ", you expected " + expectedLastUpdated + "). Nothing written — re-read with get_strategy and re-apply." }] };
        }
      }
      if (current.exists()) await remember(SHISTORY, archiveKey(), current.val(), HISTORY_KEEP)
        .catch(e => console.error("strategy archiveFull failed", e));

      // Backfill ids/letters so a hand-written seed doesn't have to carry them.
      // EVERY list gets ids, not just observations: a question or a scratch item
      // written without one is invisible to answerQuestion / ingest afterwards,
      // which is how a seeded page ends up with items nothing can address.
      next.observations = asArray(next.observations);
      next.observations.forEach((o, i) => {
        if (!o.id) o.id = "o" + (i + 1);
        if (!o.letter) o.letter = nextLetter(next.observations.slice(0, i));
        if (!o.state) o.state = "live";
        asArray(o.evidence).forEach((e, j) => { if (!e.id) e.id = o.id + "e" + (j + 1); });
        asArray(o.solutions).forEach((s, j) => { if (!s.id) s.id = o.id + "s" + (j + 1); });
      });
      next.analysis = asArray(next.analysis);
      next.analysis.forEach((a, i) => { if (!a.id) a.id = "an" + (i + 1); });
      next.scratch = asArray(next.scratch);
      next.scratch.forEach((s, i) => { if (!s.id) s.id = "x" + (i + 1); if (!s.ts) s.ts = new Date().toISOString(); });
      next.questions = asArray(next.questions);
      next.questions.forEach((q, i) => { if (!q.id) q.id = "q" + (i + 1); if (!q.state) q.state = "open"; });

      next.meta = next.meta || {};
      next.meta.lastUpdated = new Date().toISOString();
      next.meta.updatedBy = "claude";
      await db.ref(SNODE).set(next);
      return { content: [{ type: "text", text:
        "OK: strategy page updated at " + next.meta.lastUpdated + " — " + next.observations.length +
        " observation(s) (previous state archived)." }] };
    }
  );

  server.tool(
    "patch_strategy",
    "Apply SMALL, SURGICAL edits to the strategic observations page. Concurrency-safe: reads the page fresh, applies your ops to live state, writes back. Ops are applied in order.\n" +
    "THE RITUAL — capture is constant, committing is deliberate. Keep them apart:\n" +
    "  { op:'appendScratch', text:'...', anchor:'<short tag>' }  — throw a loose item on the pad. Cheap, low-ceremony, do this freely all session. Server assigns id + ts. NEVER needs permission.\n" +
    "  { op:'ingest', scratchId:'x3', observationId:'o2', date:'w/c 10/08/2026', text:'...', confirm:true }  — fold ONE pad item up into an observation as dated evidence and drop it from the pad, atomically. ONLY on Richard's explicit go-ahead. text defaults to the scratch item's own text; date defaults to 'Ongoing'.\n" +
    "  { op:'removeScratch', scratchId:'x3' }  — BIN one pad item without touching the others. For junk sitting among things worth keeping: the alternative is ingesting it somewhere it does not belong, or leaving it until the whole pad is cleared. Note the id prefix is 'x' (x1, x2, x3), not 's' — 's' ids are solutions.\n" +
    "  { op:'clearScratch' }  — empty the pad once everything on it has been ingested or judged not worth keeping.\n" +
    "TIER 1 — observations stay GENERAL; specific incidents are evidence, never observations:\n" +
    "  { op:'addObservation', title:'...', text:'...', foundational:true }  — promote a genuinely distinct new structural truth (server assigns id + next letter). Use sparingly: prefer new evidence under an existing observation. foundational:true marks substrate the other observations are downstream of — rare by definition, because if everything is foundational nothing is. text may contain blank lines; the page renders them as paragraphs.\n" +
    "  { op:'setObservation', observationId:'o2', title:'...', text:'...', foundational:false }  — sharpen the diagnosis. All fields optional.\n" +
    "  { op:'setObservationState', observationId:'o2', state:'retired' }  — live | retired. Retired observations stay on the page for the record, below the live ones. Nothing is deleted.\n" +
    "  { op:'addEvidence', observationId:'o2', date:'13/08/2026', text:'...', confirm:false, quote:false }  — date is free text ('Ongoing', 'c. 2024-25', 'w/c 10/08/2026'); confirm:true flags a date Richard still has to verify; quote:true marks text reproduced VERBATIM from a source document (a risk register entry, a written policy) rather than described, and the page sets it as a quotation. Never paraphrase something marked quote — the exact wording is the evidence.\n" +
    "  { op:'setEvidence', evidenceId:'o2e1', date:'...', text:'...', confirm:false, quote:false }  — used mostly to clear a [confirm] flag once a date is verified.\n" +
    "  { op:'removeEvidence', evidenceId:'o2e1' }  — pruning is expected. The ingest step is also an editing step; a page that only ever grows stops being read.\n" +
    "PROPOSED SOLUTIONS — labelled, never mixed into the diagnosis:\n" +
    "  { op:'addSolution', observationId:'o3', text:'...', brief:'separate build brief' }  — a fix attached to its observation. brief optional: name the separate document if it graduates into a real build.\n" +
    "  { op:'removeSolution', solutionId:'o3s1' }\n" +
    "ANALYSIS — why the pattern persists. Reasoning, NOT findings, and it takes no dated evidence:\n" +
    "  { op:'addAnalysis', title:'Why systems are resisted', points:['...','...'], consequence:'...' }  — a working explanation sitting alongside the observations. Use when something explains WHY several observations hold rather than asserting a new one. consequence optional: what the reasoning means for how to act. Keep it general, like everything else here.\n" +
    "  { op:'setAnalysis', analysisId:'an1', title:'...', points:[...], consequence:'...' }  — all fields optional\n" +
    "  { op:'removeAnalysis', analysisId:'an1' }\n" +
    "OPEN QUESTIONS — prose, not a table:\n" +
    "  { op:'addQuestion', text:'...' }\n" +
    "  { op:'answerQuestion', questionId:'q1', text:'...' }  — writes the answer and marks it answered\n" +
    "  { op:'removeQuestion', questionId:'q1' }\n" +
    "WHAT DOES NOT BELONG HERE: emails, tasks and tactical moves are actions — they go on the Morning Walk board via patch_reference, not here. Positives may be logged, but only genuine ones: firefighting caused by poor planning upstream is evidence for the reactive-culture observation, not a win.",
    {
      ops: z.string().describe("JSON array of operation objects, applied in order (see tool description for shapes)"),
      expectedLastUpdated: z.string().optional().describe("Optional: the meta.lastUpdated you last saw; the patch still applies safely to live state, but the response flags that the page had moved")
    },
    async ({ ops, expectedLastUpdated }) => {
      let operations;
      try { operations = JSON.parse(ops); }
      catch (e) { return { content: [{ type: "text", text: "ERROR: invalid ops JSON — " + e.message }] }; }
      if (!Array.isArray(operations) || !operations.length)
        return { content: [{ type: "text", text: "ERROR: ops must be a non-empty JSON array." }] };

      const snap = await db.ref(SNODE).get();
      if (!snap.exists()) return { content: [{ type: "text", text:
        "ERROR: /strategyReference is empty — seed it with update_strategy (from strategy/seed.json) before patching." }] };
      const doc = snap.val();
      const priorStamp = doc?.meta?.lastUpdated || "";
      const now = new Date().toISOString();
      doc.observations = asArray(doc.observations);
      doc.analysis = asArray(doc.analysis);
      doc.scratch = asArray(doc.scratch);
      doc.questions = asArray(doc.questions);

      const applied = [], errors = [];

      operations.forEach((o, i) => {
        try {
          switch (o && o.op) {

            case "appendScratch": {
              if (!o.text) { errors.push("op " + i + ": appendScratch needs text"); break; }
              const item = { id: nextStratId(doc.scratch, "x"), ts: now, text: String(o.text) };
              if (o.anchor) item.anchor = String(o.anchor);
              doc.scratch.push(item);
              applied.push("scratch+ " + item.id);
              break;
            }

            case "ingest": {
              // The commit step. Deliberately atomic: evidence lands and the pad
              // item disappears in one write, so a half-ingested pad is impossible.
              if (!o.scratchId || !o.observationId) { errors.push("op " + i + ": ingest needs scratchId and observationId"); break; }
              const item = doc.scratch.find(s => String(s?.id) === String(o.scratchId));
              if (!item) { errors.push("op " + i + ": scratch item " + o.scratchId + " not found"); break; }
              const obs = findObservation(doc, o.observationId);
              if (!obs) { errors.push("op " + i + ": observation " + o.observationId + " not found"); break; }
              obs.evidence = asArray(obs.evidence);
              const ev = {
                id: nextStratId(obs.evidence, obs.id + "e"),
                date: String(o.date || "Ongoing"),
                text: String(o.text || item.text)
              };
              if (o.confirm) ev.confirm = true;
              obs.evidence.push(ev);
              doc.scratch = doc.scratch.filter(s => String(s?.id) !== String(o.scratchId));
              applied.push("ingest " + o.scratchId + " -> " + obs.id + " (" + ev.id + ")");
              break;
            }

            case "removeScratch": {
              // Bin one item without touching the rest. Until this existed the
              // only exits from the pad were ingest (which promotes) and
              // clearScratch (which empties), so a single piece of junk sitting
              // among good items could not be dropped — it had to be ingested
              // into somewhere it did not belong, or survive until the whole pad
              // was cleared. Mirrors removeEvidence and removeQuestion.
              const before = doc.scratch.length;
              doc.scratch = doc.scratch.filter(s => String(s?.id) !== String(o.scratchId));
              if (doc.scratch.length === before) { errors.push("op " + i + ": scratch item " + o.scratchId + " not found"); break; }
              applied.push("scratch- " + o.scratchId);
              break;
            }

            case "clearScratch": {
              const n = doc.scratch.length;
              doc.scratch = [];
              applied.push("scratch cleared (" + n + " item(s))");
              break;
            }

            case "addObservation": {
              if (!o.title || !o.text) { errors.push("op " + i + ": addObservation needs title and text"); break; }
              const obs = {
                id: nextStratId(doc.observations, "o"),
                letter: nextLetter(doc.observations),
                title: String(o.title),
                text: String(o.text),
                state: "live",
                opened: now,
                evidence: [],
                solutions: []
              };
              if (o.foundational) obs.foundational = true;
              doc.observations.push(obs);
              applied.push("observation+ " + obs.letter + " (" + obs.id + ")");
              break;
            }

            case "setObservation": {
              const obs = findObservation(doc, o.observationId);
              if (!obs) { errors.push("op " + i + ": observation " + o.observationId + " not found"); break; }
              if (o.title) obs.title = String(o.title);
              if (o.text) obs.text = String(o.text);
              if (o.foundational !== undefined) { if (o.foundational) obs.foundational = true; else delete obs.foundational; }
              if (!o.title && !o.text && o.foundational === undefined) {
                errors.push("op " + i + ": setObservation needs title, text or foundational"); break;
              }
              applied.push("observation~ " + obs.id);
              break;
            }

            case "setObservationState": {
              const obs = findObservation(doc, o.observationId);
              if (!obs) { errors.push("op " + i + ": observation " + o.observationId + " not found"); break; }
              if (!["live", "retired"].includes(o.state)) { errors.push("op " + i + ": state must be live or retired"); break; }
              obs.state = o.state;
              applied.push("observation " + obs.id + " -> " + o.state);
              break;
            }

            case "addEvidence": {
              const obs = findObservation(doc, o.observationId);
              if (!obs) { errors.push("op " + i + ": observation " + o.observationId + " not found"); break; }
              if (!o.text) { errors.push("op " + i + ": addEvidence needs text"); break; }
              obs.evidence = asArray(obs.evidence);
              const ev = {
                id: nextStratId(obs.evidence, obs.id + "e"),
                date: String(o.date || "Ongoing"),
                text: String(o.text)
              };
              if (o.confirm) ev.confirm = true;
              if (o.quote) ev.quote = true;
              obs.evidence.push(ev);
              applied.push("evidence+ " + ev.id);
              break;
            }

            case "setEvidence": {
              const obs = findOwner(doc, "evidence", o.evidenceId);
              if (!obs) { errors.push("op " + i + ": evidence " + o.evidenceId + " not found"); break; }
              const ev = asArray(obs.evidence).find(e => String(e.id) === String(o.evidenceId));
              if (o.date) ev.date = String(o.date);
              if (o.text) ev.text = String(o.text);
              // confirm is a flag being cleared as often as set, so an explicit
              // false must actually remove it — hence the undefined check.
              if (o.confirm !== undefined) { if (o.confirm) ev.confirm = true; else delete ev.confirm; }
              if (o.quote !== undefined) { if (o.quote) ev.quote = true; else delete ev.quote; }
              applied.push("evidence~ " + ev.id);
              break;
            }

            case "removeEvidence": {
              const obs = findOwner(doc, "evidence", o.evidenceId);
              if (!obs) { errors.push("op " + i + ": evidence " + o.evidenceId + " not found"); break; }
              obs.evidence = asArray(obs.evidence).filter(e => String(e.id) !== String(o.evidenceId));
              applied.push("evidence- " + o.evidenceId);
              break;
            }

            case "addSolution": {
              const obs = findObservation(doc, o.observationId);
              if (!obs) { errors.push("op " + i + ": observation " + o.observationId + " not found"); break; }
              if (!o.text) { errors.push("op " + i + ": addSolution needs text"); break; }
              obs.solutions = asArray(obs.solutions);
              const sol = { id: nextStratId(obs.solutions, obs.id + "s"), text: String(o.text) };
              if (o.brief) sol.brief = String(o.brief);
              obs.solutions.push(sol);
              applied.push("solution+ " + sol.id);
              break;
            }

            case "removeSolution": {
              const obs = findOwner(doc, "solutions", o.solutionId);
              if (!obs) { errors.push("op " + i + ": solution " + o.solutionId + " not found"); break; }
              obs.solutions = asArray(obs.solutions).filter(s => String(s.id) !== String(o.solutionId));
              applied.push("solution- " + o.solutionId);
              break;
            }

            case "addAnalysis": {
              if (!o.title || !Array.isArray(o.points) || !o.points.length) {
                errors.push("op " + i + ": addAnalysis needs title and a non-empty points array"); break;
              }
              const an = {
                id: nextStratId(doc.analysis, "an"),
                title: String(o.title),
                points: o.points.map(String)
              };
              if (o.consequence) an.consequence = String(o.consequence);
              doc.analysis.push(an);
              applied.push("analysis+ " + an.id);
              break;
            }

            case "setAnalysis": {
              const an = doc.analysis.find(x => String(x?.id) === String(o.analysisId));
              if (!an) { errors.push("op " + i + ": analysis " + o.analysisId + " not found"); break; }
              if (o.title) an.title = String(o.title);
              if (Array.isArray(o.points) && o.points.length) an.points = o.points.map(String);
              if (o.consequence !== undefined) {
                if (o.consequence) an.consequence = String(o.consequence); else delete an.consequence;
              }
              applied.push("analysis~ " + an.id);
              break;
            }

            case "removeAnalysis": {
              const before = doc.analysis.length;
              doc.analysis = doc.analysis.filter(x => String(x?.id) !== String(o.analysisId));
              if (doc.analysis.length === before) { errors.push("op " + i + ": analysis " + o.analysisId + " not found"); break; }
              applied.push("analysis- " + o.analysisId);
              break;
            }

            case "addQuestion": {
              if (!o.text) { errors.push("op " + i + ": addQuestion needs text"); break; }
              const q = { id: nextStratId(doc.questions, "q"), text: String(o.text), state: "open" };
              doc.questions.push(q);
              applied.push("question+ " + q.id);
              break;
            }

            case "answerQuestion": {
              const q = doc.questions.find(x => String(x?.id) === String(o.questionId));
              if (!q) { errors.push("op " + i + ": question " + o.questionId + " not found"); break; }
              if (!o.text) { errors.push("op " + i + ": answerQuestion needs text"); break; }
              q.answer = String(o.text);
              q.state = "answered";
              q.answeredTs = now;
              applied.push("question~ " + q.id);
              break;
            }

            case "removeQuestion": {
              const before = doc.questions.length;
              doc.questions = doc.questions.filter(x => String(x?.id) !== String(o.questionId));
              if (doc.questions.length === before) { errors.push("op " + i + ": question " + o.questionId + " not found"); break; }
              applied.push("question- " + o.questionId);
              break;
            }

            default:
              errors.push("op " + i + ": unknown op '" + (o && o.op) + "'");
          }
        } catch (e) {
          errors.push("op " + i + ": " + e.message);
        }
      });

      if (!applied.length)
        return { content: [{ type: "text", text: "ERROR: no operations applied. " + errors.join("; ") }] };

      await remember(SOPS, archiveKey(), {
        ts: now,
        priorStamp,
        applied: applied.slice(0, 40),
        ops: operations.slice(0, 40),
        before: stratTouchedBefore(snap.val(), operations)
      }, OPS_KEEP).catch(e => console.error("strategy archiveDelta failed", e));

      doc.meta = doc.meta || {};
      doc.meta.lastUpdated = now;
      doc.meta.updatedBy = "claude";
      await db.ref(SNODE).set(doc);

      const moved = expectedLastUpdated && priorStamp && priorStamp !== expectedLastUpdated;
      return { content: [{ type: "text", text:
        "OK: strategy patched at " + now + " — " + applied.join(", ") +
        (errors.length ? " | SKIPPED: " + errors.join("; ") : "") +
        (moved ? " | NOTE: the page had moved since you last read it (was " + expectedLastUpdated + ", found " + priorStamp + ") — your patch applied safely to live state." : "") +
        " (previous state archived)." }] };
    }
  );

  /* ===================== Review store (the document) =====================
     The third document. Shape (spec: review/SPEC.md):

       parts[]    { id, position, title }
       sections[] { id, position, partId, title, body, status, visibility,
                    notes, lengthTarget,
                    subsections[] { id, position, title, body, visibility } }
       threads[]  { id, text, targets[], framing, status, resolution,
                    resolvedTs, visibility }
       spine      { title, thesis, principles[], decisions[] {ts, what, why} }
       facts[]    { id, label, value, updated }
       meta       { lastUpdated, updatedBy, counters }

     Numbers are never stored — computed from position at render, here and in
     review/index.html, identically. Ids are server-assigned off monotonic
     counters and never reused, so an id in a {{ref:...}} marker or an old
     export stays unambiguous forever. Positions are sparse (10, 20, 30…) and
     go fractional on insert; nothing ever renumbers.

     Visibility is a FIELD, not a convention: 'private' material renders only
     to the owner on the window, carries no number, and never enters an
     export. The numbering readers see is therefore the numbering exports
     freeze. */

  const RV_STATUSES = ["empty", "outlined", "drafted", "refined"];
  const RV_VIS = ["include", "private"];
  const RV_THREAD_STATES = ["open", "resolved", "superseded"];
  const RV_REF = /\{\{ref:([A-Za-z0-9_-]+)\}\}/g;
  const RV_FACT = /\{\{fact:([A-Za-z0-9_-]+)\}\}/g;

  const emptyReview = () => ({
    parts: [], sections: [], threads: [],
    spine: { title: "", thesis: "", principles: [], decisions: [] },
    facts: [],
    meta: { counters: {} }
  });

  // Monotonic, never reused. The counter is belt-and-braces re-derived from
  // the highest id actually present, so even a hand-restored snapshot with a
  // stale counter cannot mint a duplicate.
  const rvNextId = (doc, kind, prefix, lists) => {
    doc.meta = doc.meta || {};
    doc.meta.counters = doc.meta.counters || {};
    let max = parseInt(doc.meta.counters[kind], 10) || 0;
    lists.forEach(l => asArray(l).forEach(x => {
      const m = new RegExp("^" + prefix + "_(\\d+)$").exec(String(x?.id || ""));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }));
    doc.meta.counters[kind] = max + 1;
    return prefix + "_" + (max + 1);
  };

  const rvByPos = list => asArray(list).slice()
    .sort((a, b) => (Number(a?.position) || 0) - (Number(b?.position) || 0));

  // Position maths is the server's job — a caller names a sibling (after /
  // before), never a number. Omit both to land at the end.
  const rvPositionAmong = (siblings, o) => {
    const list = rvByPos(siblings);
    if (!list.length) return 10;
    const at = id => {
      const i = list.findIndex(x => String(x.id) === String(id));
      if (i < 0) throw new Error("no sibling '" + id + "' to anchor on");
      return i;
    };
    if (o.after) {
      const i = at(o.after);
      return i === list.length - 1 ? Number(list[i].position) + 10
        : (Number(list[i].position) + Number(list[i + 1].position)) / 2;
    }
    if (o.before) {
      const i = at(o.before);
      return i === 0 ? Number(list[0].position) / 2
        : (Number(list[i - 1].position) + Number(list[i].position)) / 2;
    }
    return Number(list[list.length - 1].position) + 10;
  };

  const rvParts = doc => asArray(doc.parts);
  const rvSecs = doc => asArray(doc.sections);
  const rvFindPart = (doc, id) => rvParts(doc).find(p => String(p?.id) === String(id)) || null;
  const rvFindSection = (doc, id) => rvSecs(doc).find(s => String(s?.id) === String(id)) || null;
  const rvFindSub = (doc, id) => {
    for (const s of rvSecs(doc)) {
      const sub = asArray(s.subsections).find(x => String(x?.id) === String(id));
      if (sub) return { section: s, sub };
    }
    return null;
  };
  const rvFindThread = (doc, id) => asArray(doc.threads).find(t => String(t?.id) === String(id)) || null;
  const rvSectionsOf = (doc, partId) =>
    rvSecs(doc).filter(s => String(s?.partId) === String(partId));

  // The one computation the whole design leans on. Private material is
  // skipped, not numbered-then-hidden, so page and export always agree.
  const rvNumbering = doc => {
    const map = {};
    let n = 0;
    rvByPos(doc.parts).forEach((part, pi) => {
      map[part.id] = String(pi + 1);
      rvByPos(rvSectionsOf(doc, part.id)).forEach(s => {
        if (s.visibility === "private") return;
        map[s.id] = String(++n);
        let m = 0;
        rvByPos(asArray(s.subsections)).forEach(sub => {
          if (sub.visibility === "private") return;
          map[sub.id] = n + "." + (++m);
        });
      });
    });
    return map;
  };

  // Derived index: which sections point at a given target. Not stored —
  // recomputed on read, which is what keeps it truthful.
  const rvReferencedBy = doc => {
    const idx = {};
    const scan = (text, fromId) => {
      let m;
      RV_REF.lastIndex = 0;
      while ((m = RV_REF.exec(String(text || "")))) {
        const list = idx[m[1]] = idx[m[1]] || [];
        if (!list.includes(fromId)) list.push(fromId);
      }
    };
    rvSecs(doc).forEach(s => {
      scan(s.body, s.id);
      scan(s.notes, s.id);
      asArray(s.subsections).forEach(sub => scan(sub.body, s.id));
    });
    asArray(doc.threads).forEach(t => scan(t.framing, t.id));
    return idx;
  };

  const rvResolve = (text, doc, numbering) => String(text || "")
    .replace(RV_REF, (_, id) => {
      if (!rvFindSection(doc, id) && !rvFindSub(doc, id)) return "[unresolved reference: " + id + "]";
      const num = numbering[id];
      // The target exists but is private: a real authoring fault, surfaced
      // loudly (an included body must not lean on omitted material) — but
      // without printing the id into a document a reader might hold.
      return num === undefined ? "[reference to private material]" : "§" + num;
    })
    .replace(RV_FACT, (_, id) => {
      const f = asArray(doc.facts).find(x => String(x?.id) === String(id));
      return f ? String(f.value) : "[unknown fact: " + id + "]";
    });

  // Markdown export: sections in position order, numbers computed, references
  // and facts resolved, private material and drafting notes omitted. Threads
  // are working state, not document body — they never export.
  const rvExportMarkdown = (doc, numbering) => {
    const lines = [];
    const stamp = new Date().toLocaleDateString("en-GB",
      { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/London" });
    lines.push("# " + ((doc.spine && doc.spine.title) || "Working document"), "");
    lines.push("_Exported " + stamp + ". Numbering is frozen as it stood on this date; " +
      "a later insert renumbers the live document, not this copy._", "");
    rvByPos(doc.parts).forEach(part => {
      const sections = rvByPos(rvSectionsOf(doc, part.id)).filter(s => s.visibility !== "private");
      if (!sections.length) return;
      lines.push("## Part " + numbering[part.id] + " — " + (part.title || ""), "");
      sections.forEach(s => {
        lines.push("### " + numbering[s.id] + ". " + (s.title || ""), "");
        if (String(s.body || "").trim()) lines.push(rvResolve(s.body, doc, numbering).trim(), "");
        rvByPos(asArray(s.subsections)).filter(x => x.visibility !== "private").forEach(sub => {
          lines.push("#### " + numbering[sub.id] + " " + (sub.title || ""), "");
          if (String(sub.body || "").trim()) lines.push(rvResolve(sub.body, doc, numbering).trim(), "");
        });
      });
    });
    return lines.join("\n");
  };

  const rvTouchedBefore = (doc, operations) => {
    const ids = new Set();
    operations.forEach(o => ["partId", "sectionId", "subsectionId", "threadId", "factId", "targetId"]
      .forEach(k => { if (o && o[k]) ids.add(String(o[k])); }));
    const before = {};
    rvParts(doc).forEach(p => { if (ids.has(String(p?.id))) before[p.id] = p; });
    rvSecs(doc).forEach(s => {
      if (ids.has(String(s?.id))) before[s.id] = s;
      asArray(s.subsections).forEach(x => { if (ids.has(String(x?.id))) before[x.id] = x; });
    });
    asArray(doc.threads).forEach(t => { if (ids.has(String(t?.id))) before[t.id] = t; });
    asArray(doc.facts).forEach(f => { if (ids.has(String(f?.id))) before[f.id] = f; });
    if (operations.some(o => o && ["update_spine", "add_decision"].includes(o.op)))
      before._spine = doc.spine || null;
    return before;
  };

  server.tool(
    "get_review",
    "Read the review document — the department's long working document held as structure (a THIRD document, separate from the Morning Walk board and the strategy record). Call it THE DOCUMENT or THE REVIEW in conversation — never 'the store'. Returns parts[], sections[] (each: id, position, partId, title, body markdown, status empty|outlined|drafted|refined, visibility include|private, notes, lengthTarget, subsections[]), threads[] (open questions and revision rules: text, targets[] of section ids, framing, status open|resolved|superseded, resolution), spine (title, thesis, principles[] read at the start of every session, decisions[] append-only log of what was cut and why), facts[] (recurring figures stored once, referenced as {{fact:id}}), meta. Plus _derived (computed, never stored): numbering — the number each part/section/subsection renders as right now — and referencedBy, which sections point at a given id via {{ref:id}} markers. NUMBERS ARE NEVER STORED; never write one into a body — reference sections as {{ref:<sectionId>}} and figures as {{fact:<factId>}}, resolved at render. At ~15k words the full read is cheap and is the normal way a session starts; pass sectionId to read just one section with its subsections, references resolved, and what points at it. Reads return meta.lastUpdated — pass it back to patch_review as expectedLastUpdated to guard structural edits.",
    { sectionId: z.string().optional().describe("Read one section (with subsections, resolved references, and its referenced-by list) instead of the whole document") },
    async ({ sectionId }) => {
      const snap = await db.ref(RNODE).get();
      if (!snap.exists()) return { content: [{ type: "text", text:
        "EMPTY: the review document has not been started yet. It is seeded conversationally, not imported — start with patch_review: insert_part for each part, then insert_section under it, with Richard adjudicating every conflict between the old files. The first write creates it." }] };
      const doc = snap.val();
      const numbering = rvNumbering(doc);
      if (sectionId) {
        const s = rvFindSection(doc, sectionId);
        if (!s) return { content: [{ type: "text", text: "ERROR: section " + sectionId + " not found." }] };
        return { content: [{ type: "text", text: JSON.stringify({
          section: s,
          _derived: {
            number: numbering[s.id] || null,
            referencedBy: (rvReferencedBy(doc)[s.id] || []),
            resolvedBody: rvResolve(s.body, doc, numbering),
            resolvedSubsections: rvByPos(asArray(s.subsections)).map(sub => ({
              id: sub.id, number: numbering[sub.id] || null, title: sub.title,
              resolvedBody: rvResolve(sub.body, doc, numbering)
            }))
          },
          lastUpdated: doc.meta && doc.meta.lastUpdated
        }, null, 2) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(
        { ...doc, _derived: { numbering, referencedBy: rvReferencedBy(doc) } }, null, 2) }] };
    }
  );

  server.tool(
    "patch_review",
    "Write to the review document. The ONLY write path — there is no whole-document write and no hard delete anywhere; structure changes op by op, status transitions do the retiring, and every write archives a delta. The server owns id assignment and position maths: never supply an id or a position — name a sibling with after/before (section ids, e.g. after:'sec_3') or omit both to land at the end. The first write on an empty document bootstraps the skeleton, which is how seeding starts (insert_part, then insert_section). Ops, applied in order:\n" +
    "STRUCTURE:\n" +
    "  { op:'insert_part', title:'...', after:'part_1' }  — a new part (after/before optional)\n" +
    "  { op:'update_part', partId:'part_1', title:'...' }\n" +
    "  { op:'move_part', partId:'part_2', before:'part_1' }\n" +
    "  { op:'insert_section', partId:'part_1', title:'...', after:'sec_7', body:'...', notes:'...', status:'outlined', visibility:'include', lengthTarget:'~600 words' }  — everything after partId+title optional; status defaults empty, visibility include. Inserting between two sections writes ONE row at a fractional position — nothing renumbers, every {{ref:...}} to every other section stays correct.\n" +
    "  { op:'update_section', sectionId:'sec_7', title:'...', body:'...', notes:'...', lengthTarget:'...' }  — replaces the fields you pass; body is markdown; reference other sections as {{ref:<id>}} and figures as {{fact:<id>}}, NEVER as literal numbers (spec §3.3: storing references as text is the single most damaging thing to do here)\n" +
    "  { op:'move_section', sectionId:'sec_7', after:'sec_2', partId:'part_2' }  — reposition; partId only to move it into a different part\n" +
    "  { op:'insert_subsection', sectionId:'sec_7', title:'...', body:'...', after:'sub_3', visibility:'include' }  — the third semantic tier lives here as structure, never as heading syntax or bold run-ins inside a body\n" +
    "  { op:'update_subsection', subsectionId:'sub_3', title:'...', body:'...' }\n" +
    "  { op:'move_subsection', subsectionId:'sub_3', before:'sub_1' }  — within its section\n" +
    "  { op:'set_status', sectionId:'sec_7', status:'drafted' }  — empty | outlined | drafted | refined\n" +
    "  { op:'set_visibility', targetId:'sec_7', visibility:'private' }  — works on a section, subsection or thread id. Private material renders to the owner clearly marked, carries no number, and NEVER enters an export. This is the field for calibrations about named individuals — it is not a naming convention.\n" +
    "THREADS — open questions, unresolved points, document-wide revision rules:\n" +
    "  { op:'add_thread', text:'...', targets:['sec_7','sec_9'], framing:'...', visibility:'include' }  — targets are section ids; ZERO targets is valid and meaningful (a document-wide rule)\n" +
    "  { op:'update_thread', threadId:'th_4', text:'...', targets:[...], framing:'...' }\n" +
    "  { op:'resolve_thread', threadId:'th_4', resolution:'...', status:'resolved' }  — status resolved (default) or superseded. Resolution is a STATUS CHANGE, never a deletion: resolved threads stay, rendered below the open ones, and the resolution text is the audit trail.\n" +
    "SPINE — the most valuable thing in the project; principles and thesis are read at the start of every session:\n" +
    "  { op:'update_spine', title:'...', thesis:'...', principles:['...','...'] }  — replaces the fields you pass\n" +
    "  { op:'add_decision', what:'...', why:'...' }  — the decisions log is APPEND-ONLY; what was cut and why, stamped by the server\n" +
    "FACTS — each recurring figure lives once; correcting it is one write:\n" +
    "  { op:'set_fact', factId:'matchdays', value:'72', label:'League matchdays per season' }  — factId is a slug you choose; reference it from bodies as {{fact:matchdays}}\n" +
    "CONCURRENCY: pass expectedLastUpdated (from your read). If the document has moved since, the write is REFUSED — re-read and re-apply. Unlike the board's patch, nothing is applied on a stale read: these are structural edits to a document, worth stopping.",
    {
      ops: z.string().describe("JSON array of operation objects, applied in order (see tool description for shapes)"),
      expectedLastUpdated: z.string().optional().describe("The meta.lastUpdated you read; the write is refused if the document has moved past it")
    },
    async ({ ops, expectedLastUpdated }) => {
      let operations;
      try { operations = JSON.parse(ops); }
      catch (e) { return { content: [{ type: "text", text: "ERROR: invalid ops JSON — " + e.message }] }; }
      if (!Array.isArray(operations) || !operations.length)
        return { content: [{ type: "text", text: "ERROR: ops must be a non-empty JSON array." }] };

      const snap = await db.ref(RNODE).get();
      // Spec §4: writes carrying a stale read are refused, not merged.
      const priorStamp = snap.exists() ? (snap.val()?.meta?.lastUpdated || "") : "";
      if (expectedLastUpdated && priorStamp && priorStamp !== expectedLastUpdated) {
        return { content: [{ type: "text", text:
          "CONFLICT: the document moved since you read it (live meta.lastUpdated=" + priorStamp +
          ", you expected " + expectedLastUpdated + "). Nothing written — re-read with get_review and re-apply." }] };
      }
      // The builder ships this empty; the owner's first insert is what creates
      // the node. Bootstrapping here is deliberate, not defensive.
      const doc = snap.exists() ? snap.val() : emptyReview();
      doc.parts = asArray(doc.parts);
      doc.sections = asArray(doc.sections);
      doc.sections.forEach(s => { if (s) s.subsections = asArray(s.subsections); });
      doc.threads = asArray(doc.threads);
      doc.facts = asArray(doc.facts);
      doc.spine = doc.spine || { title: "", thesis: "", principles: [], decisions: [] };
      const now = new Date().toISOString();

      const applied = [], errors = [];

      operations.forEach((o, i) => {
        try {
          switch (o && o.op) {

            case "insert_part": {
              if (!o.title) { errors.push("op " + i + ": insert_part needs title"); break; }
              const part = {
                id: rvNextId(doc, "part", "part", [doc.parts]),
                position: rvPositionAmong(doc.parts, o),
                title: String(o.title)
              };
              doc.parts.push(part);
              applied.push("part+ " + part.id + " @" + part.position);
              break;
            }

            case "update_part": {
              const p = rvFindPart(doc, o.partId);
              if (!p) { errors.push("op " + i + ": part " + o.partId + " not found"); break; }
              if (!o.title) { errors.push("op " + i + ": update_part needs title"); break; }
              p.title = String(o.title);
              applied.push("part~ " + p.id);
              break;
            }

            case "move_part": {
              const p = rvFindPart(doc, o.partId);
              if (!p) { errors.push("op " + i + ": part " + o.partId + " not found"); break; }
              p.position = rvPositionAmong(doc.parts.filter(x => x !== p), o);
              applied.push("part> " + p.id + " @" + p.position);
              break;
            }

            case "insert_section": {
              if (!o.partId || !o.title) { errors.push("op " + i + ": insert_section needs partId+title"); break; }
              if (!rvFindPart(doc, o.partId)) { errors.push("op " + i + ": part " + o.partId + " not found"); break; }
              const s = {
                id: rvNextId(doc, "section", "sec", [doc.sections]),
                position: rvPositionAmong(rvSectionsOf(doc, o.partId), o),
                partId: String(o.partId),
                title: String(o.title),
                body: String(o.body || ""),
                status: RV_STATUSES.includes(o.status) ? o.status : "empty",
                visibility: RV_VIS.includes(o.visibility) ? o.visibility : "include",
                subsections: []
              };
              if (o.notes) s.notes = String(o.notes);
              if (o.lengthTarget) s.lengthTarget = String(o.lengthTarget);
              doc.sections.push(s);
              applied.push("section+ " + s.id + " @" + o.partId + "/" + s.position);
              break;
            }

            case "update_section": {
              const s = rvFindSection(doc, o.sectionId);
              if (!s) { errors.push("op " + i + ": section " + o.sectionId + " not found"); break; }
              if (o.title !== undefined) s.title = String(o.title);
              if (o.body !== undefined) s.body = String(o.body);
              if (o.notes !== undefined) { if (o.notes) s.notes = String(o.notes); else delete s.notes; }
              if (o.lengthTarget !== undefined) { if (o.lengthTarget) s.lengthTarget = String(o.lengthTarget); else delete s.lengthTarget; }
              applied.push("section~ " + s.id);
              break;
            }

            case "move_section": {
              const s = rvFindSection(doc, o.sectionId);
              if (!s) { errors.push("op " + i + ": section " + o.sectionId + " not found"); break; }
              const partId = o.partId ? String(o.partId) : s.partId;
              if (!rvFindPart(doc, partId)) { errors.push("op " + i + ": part " + partId + " not found"); break; }
              s.position = rvPositionAmong(rvSectionsOf(doc, partId).filter(x => x !== s), o);
              s.partId = partId;
              applied.push("section> " + s.id + " @" + partId + "/" + s.position);
              break;
            }

            case "insert_subsection": {
              const s = rvFindSection(doc, o.sectionId);
              if (!s) { errors.push("op " + i + ": section " + o.sectionId + " not found"); break; }
              if (!o.title) { errors.push("op " + i + ": insert_subsection needs title"); break; }
              s.subsections = asArray(s.subsections);
              const sub = {
                id: rvNextId(doc, "subsection", "sub", doc.sections.map(x => x.subsections)),
                position: rvPositionAmong(s.subsections, o),
                title: String(o.title),
                body: String(o.body || ""),
                visibility: RV_VIS.includes(o.visibility) ? o.visibility : "include"
              };
              s.subsections.push(sub);
              applied.push("subsection+ " + sub.id + " @" + s.id + "/" + sub.position);
              break;
            }

            case "update_subsection": {
              const hit = rvFindSub(doc, o.subsectionId);
              if (!hit) { errors.push("op " + i + ": subsection " + o.subsectionId + " not found"); break; }
              if (o.title !== undefined) hit.sub.title = String(o.title);
              if (o.body !== undefined) hit.sub.body = String(o.body);
              applied.push("subsection~ " + hit.sub.id);
              break;
            }

            case "move_subsection": {
              const hit = rvFindSub(doc, o.subsectionId);
              if (!hit) { errors.push("op " + i + ": subsection " + o.subsectionId + " not found"); break; }
              hit.sub.position = rvPositionAmong(
                asArray(hit.section.subsections).filter(x => x !== hit.sub), o);
              applied.push("subsection> " + hit.sub.id + " @" + hit.sub.position);
              break;
            }

            case "set_status": {
              const s = rvFindSection(doc, o.sectionId);
              if (!s) { errors.push("op " + i + ": section " + o.sectionId + " not found"); break; }
              if (!RV_STATUSES.includes(o.status)) { errors.push("op " + i + ": status must be empty|outlined|drafted|refined"); break; }
              s.status = o.status;
              applied.push("status " + s.id + "=" + o.status);
              break;
            }

            case "set_visibility": {
              if (!RV_VIS.includes(o.visibility)) { errors.push("op " + i + ": visibility must be include|private"); break; }
              const target = rvFindSection(doc, o.targetId)
                || (rvFindSub(doc, o.targetId) || {}).sub
                || rvFindThread(doc, o.targetId);
              if (!target) { errors.push("op " + i + ": no section, subsection or thread " + o.targetId); break; }
              target.visibility = o.visibility;
              applied.push("visibility " + o.targetId + "=" + o.visibility);
              break;
            }

            case "add_thread": {
              if (!o.text) { errors.push("op " + i + ": add_thread needs text"); break; }
              const targets = Array.isArray(o.targets) ? o.targets.map(String) : [];
              const missing = targets.filter(id => !rvFindSection(doc, id));
              if (missing.length) { errors.push("op " + i + ": unknown target section(s) " + missing.join(",")); break; }
              const t = {
                id: rvNextId(doc, "thread", "th", [doc.threads]),
                text: String(o.text),
                targets,
                status: "open",
                opened: now,
                visibility: RV_VIS.includes(o.visibility) ? o.visibility : "include"
              };
              if (o.framing) t.framing = String(o.framing);
              doc.threads.push(t);
              applied.push("thread+ " + t.id + (targets.length ? "" : " (document-wide)"));
              break;
            }

            case "update_thread": {
              const t = rvFindThread(doc, o.threadId);
              if (!t) { errors.push("op " + i + ": thread " + o.threadId + " not found"); break; }
              if (o.text !== undefined) t.text = String(o.text);
              if (Array.isArray(o.targets)) {
                const targets = o.targets.map(String);
                const missing = targets.filter(id => !rvFindSection(doc, id));
                if (missing.length) { errors.push("op " + i + ": unknown target section(s) " + missing.join(",")); break; }
                t.targets = targets;
              }
              if (o.framing !== undefined) { if (o.framing) t.framing = String(o.framing); else delete t.framing; }
              applied.push("thread~ " + t.id);
              break;
            }

            case "resolve_thread": {
              const t = rvFindThread(doc, o.threadId);
              if (!t) { errors.push("op " + i + ": thread " + o.threadId + " not found"); break; }
              if (!o.resolution) { errors.push("op " + i + ": resolve_thread needs resolution — closure is written, never silent"); break; }
              if (t.status !== "open") { errors.push("op " + i + ": thread " + t.id + " is already " + t.status); break; }
              t.status = o.status === "superseded" ? "superseded" : "resolved";
              t.resolution = String(o.resolution);
              t.resolvedTs = now;
              applied.push("thread " + t.id + "=" + t.status);
              break;
            }

            case "update_spine": {
              if (o.title === undefined && o.thesis === undefined && !Array.isArray(o.principles)) {
                errors.push("op " + i + ": update_spine needs title, thesis or principles"); break;
              }
              if (o.title !== undefined) doc.spine.title = String(o.title);
              if (o.thesis !== undefined) doc.spine.thesis = String(o.thesis);
              if (Array.isArray(o.principles)) doc.spine.principles = o.principles.map(String);
              applied.push("spine~");
              break;
            }

            case "add_decision": {
              if (!o.what) { errors.push("op " + i + ": add_decision needs what"); break; }
              doc.spine.decisions = asArray(doc.spine.decisions);
              const d = { ts: now, what: String(o.what) };
              if (o.why) d.why = String(o.why);
              doc.spine.decisions.push(d);
              applied.push("decision+ (" + doc.spine.decisions.length + ")");
              break;
            }

            case "set_fact": {
              if (!o.factId || o.value === undefined) { errors.push("op " + i + ": set_fact needs factId+value"); break; }
              if (!/^[a-z0-9][a-z0-9_-]*$/i.test(String(o.factId))) {
                errors.push("op " + i + ": factId must be a slug (letters, digits, - _)"); break;
              }
              let f = asArray(doc.facts).find(x => String(x?.id) === String(o.factId));
              if (!f) { f = { id: String(o.factId) }; doc.facts.push(f); }
              f.value = String(o.value);
              if (o.label !== undefined) { if (o.label) f.label = String(o.label); else delete f.label; }
              f.updated = now;
              applied.push("fact " + f.id + "=" + f.value);
              break;
            }

            default:
              errors.push("op " + i + ": unknown op '" + (o && o.op) + "'");
          }
        } catch (e) {
          errors.push("op " + i + ": " + e.message);
        }
      });

      if (!applied.length)
        return { content: [{ type: "text", text: "ERROR: no operations applied. " + errors.join("; ") }] };

      await remember(ROPS, archiveKey(), {
        ts: now,
        priorStamp,
        applied: applied.slice(0, 40),
        ops: operations.slice(0, 40),
        before: snap.exists() ? rvTouchedBefore(snap.val(), operations) : {}
      }, OPS_KEEP).catch(e => console.error("review archiveDelta failed", e));

      doc.meta = doc.meta || {};
      doc.meta.lastUpdated = now;
      doc.meta.updatedBy = "claude";
      await db.ref(RNODE).set(doc);

      return { content: [{ type: "text", text:
        "OK: review document patched at " + now + " — " + applied.join(", ") +
        (errors.length ? " | SKIPPED: " + errors.join("; ") : "") +
        " (delta archived)." }] };
    }
  );

  server.tool(
    "export_review",
    "Render the document to markdown and FREEZE it: sections in position order, numbers computed from current positions, {{ref:...}} and {{fact:...}} resolved, private material and drafting notes and threads omitted. The rendered markdown, the date and the numbering as it stood are stored under /reviewStoreExports (newest " + EXPORTS_KEEP + " kept), and a full snapshot of the document is archived — because once a copy has gone to a reader, 'Section 7' means something to a human holding it, and a later insert must renumber the live document without silently invalidating theirs. Returns the markdown. Optional label names the version (e.g. 'CEO draft 1').",
    { label: z.string().optional().describe("Short name for this version, stored with the export record") },
    async ({ label }) => {
      const snap = await db.ref(RNODE).get();
      if (!snap.exists()) return { content: [{ type: "text", text: "ERROR: the review document is empty — nothing to export." }] };
      const doc = snap.val();
      const numbering = rvNumbering(doc);
      const markdown = rvExportMarkdown(doc, numbering);
      const now = new Date().toISOString();
      const record = {
        ts: now,
        numbering,
        markdown,
        sections: rvSecs(doc).filter(s => s.visibility !== "private").length,
        words: markdown.split(/\s+/).filter(Boolean).length
      };
      if (label) record.label = String(label);
      await remember(REXPORTS, archiveKey(), record, EXPORTS_KEEP)
        .catch(e => console.error("review export archive failed", e));
      await remember(RHISTORY, archiveKey(), doc, HISTORY_KEEP)
        .catch(e => console.error("review archiveFull failed", e));
      return { content: [{ type: "text", text:
        "OK: exported at " + now + (label ? " ('" + label + "')" : "") + " — " + record.sections +
        " section(s), ~" + record.words + " words. Numbering frozen with the record.\n\n" + markdown }] };
    }
  );

  return server;
}

/* ================================ HTTP ================================ */

const app = express();
app.use(express.json({ limit: "2mb" }));

app.post(PATH, async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  }
});
app.get(PATH, (_req, res) => res.status(405).send("POST only"));

app.get("/", (_req, res) => res.send("walk-reference MCP: ok"));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("postitpa board server v121 listening on " + port));

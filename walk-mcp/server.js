/*
  MORNING WALK — MCP SERVER + AMBIENT REVIEWER
  v116.0 — 05/08/2026
  (Supersedes v78 / v82 / v87 / v88 / v90 / v94 / v114 / v115 — deploy this
   one; earlier server files from this build are obsolete. See VERSIONING.md.)

  Changelog:
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
const crypto = require("crypto");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");
const admin = require("firebase-admin");

const SECRET = "wR7kPm2ZqXv9TnE4bYcH8dLsJ3fA";        // MCP capability URL — unchanged from v20.0
const REVIEW_SECRET = "qT4nXw8bKm2ZpV6cRj9dLsY5hB3";   // separate secret for the scheduler endpoint
const PATH = "/mcp/" + SECRET;
const REVIEW_PATH = "/review/" + REVIEW_SECRET;
const NODE = "walkReference";
const HISTORY = "walkReferenceHistory";
const REVIEW_STATE = "reviewState";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";

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

// Self-kept spend tally: every Anthropic response reports its own token usage;
// accumulate it in /apiUsage so the desk app can show a live meter.
function recordUsage(u) {
  if (!u) return;
  db.ref("apiUsage").transaction(cur => {
    cur = cur || { calls: 0, inTok: 0, outTok: 0, since: new Date().toISOString() };
    cur.calls += 1;
    cur.inTok += u.input_tokens || 0;
    cur.outTok += u.output_tokens || 0;
    return cur;
  }).catch(e => console.error("usage tally failed", e));
}

/* ============================== MCP tools ============================== */

function buildServer() {
  const server = new McpServer({ name: "walk-reference", version: "116.0" });

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

      if (current.exists()) await db.ref(HISTORY + "/" + Date.now()).set(current.val());

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
      await db.ref(HISTORY + "/" + Date.now()).set(snap.val());
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

  return server;
}

/* ============================ Ambient review ============================ */

// Signature of Richard-authored content only — Claude's own outputs are
// excluded so a review never triggers the next review.
function richardSignature(ref) {
  const tasks = asArray(ref.todaysPlan?.tasks).map(t => ({
    id: t.id, text: t.text, done: !!t.done,
    notes: asArray(t.notes).map(n => ({ ts: n.ts, text: n.text })),
    thread: asArray(t.thread).filter(e => e.who === "richard").map(e => ({ ts: e.ts, text: e.text }))
  }));
  const ideas = asArray(ref.ideas).map(i => ({
    id: i.id, title: i.title, state: i.state,
    thread: asArray(i.thread).filter(e => e.who === "richard").map(e => ({ ts: e.ts, text: e.text }))
  }));
  const payload = JSON.stringify({
    date: ref.todaysPlan?.date || "",
    tasks, ideas,
    notes: asArray(ref.richardsNotes).map(n => ({ ts: n.ts, text: n.text }))
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

const REVIEW_SYSTEM = `You are the ambient reviewer for Richard's Morning Walk rolling reference — a candid colleague glancing at his live board because something on it just changed. Richard is Digital & Broadcast Manager at the National League.

Return ONLY a JSON object, no markdown fences, no prose outside it:
{
  "take": "2-4 sentence headline verdict on the day's shape right now",
  "taskNotes": { "<taskId>": "<mark, max 12 words>", ... },
  "ideaReplies": { "<ideaId>": "<steer, 1-3 sentences>", ... }
}

Rules:
- taskNotes: a proposed sticky reply per task where warranted (appended to the task thread only if new, or answering Richard's latest sticky). Verdict-flavoured, useful, max 12 words. Hard deadlines and unrecoverable items always outrank the merely urgent. Repeat carry-overs get named as such. Done tasks get brief acknowledgement. Weekends: judge accordingly — do not manufacture weekday urgency on a Saturday.
- ideaReplies: ONLY for ideas listed as eligible in the user message, and ONLY when you have genuine steer — an angle, a risk, a sharpener, a connection to his fronts. Substance over cheerleading. Omit an idea entirely if you have nothing real to add. Never summarise the idea back at him.
- take: teeth, earned. If nothing material changed or the day is on track, say so in one line — a clean bill is a valid verdict. Never invent urgency.
- Judge the work, never the people. Fronts contain frank notes on named colleagues; do not extend or editorialise on personal assessments.
- If the state doesn't show it, it didn't happen.`;

async function runReview() {
  if (!ANTHROPIC_KEY) return { status: 500, body: "ANTHROPIC_API_KEY not set on the service." };

  const snap = await db.ref(NODE).get();
  if (!snap.exists()) return { status: 404, body: "walkReference is empty." };
  const ref = snap.val();

  if (ref.projects) return runReviewV2(ref);

  const sig = richardSignature(ref);
  const prevState = (await db.ref(REVIEW_STATE).get()).val() || {};
  if (prevState.sig === sig) return { status: 200, body: "No change since last review — skipped." };

  // Ideas eligible for a reply: last thread entry is Richard's (never reply twice in a row).
  const eligibleIdeas = asArray(ref.ideas).filter(i => {
    const th = asArray(i.thread);
    return th.length && th[th.length - 1].who === "richard" && i.state !== "parked";
  }).map(i => i.id);

  const userMsg =
    "Current time: " + new Date().toISOString() + " (UK)\n" +
    "Ideas eligible for a reply (last word was Richard's): " + JSON.stringify(eligibleIdeas) + "\n\n" +
    "Full reference state:\n" + JSON.stringify(ref);

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      system: REVIEW_SYSTEM,
      messages: [{ role: "user", content: userMsg }]
    })
  });
  if (!resp.ok) {
    const errText = await resp.text();
    console.error("Anthropic API error:", resp.status, errText);
    return { status: 502, body: "Anthropic API error " + resp.status };
  }
  const data = await resp.json();
  recordUsage(data.usage);
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");

  let verdict;
  try { verdict = JSON.parse(text.replace(/```json|```/g, "").trim()); }
  catch (e) {
    console.error("Unparseable review output:", text);
    return { status: 502, body: "Review output was not valid JSON — nothing written." };
  }

  const now = new Date().toISOString();

  // Archive, then merge the verdict into the reference.
  await db.ref(HISTORY + "/" + Date.now()).set(ref);

  const tasks = asArray(ref.todaysPlan?.tasks);
  tasks.forEach(t => {
    // fold legacy fields into the unified thread, then append the new mark
    const th = asArray(t.thread).map(e => ({ ts: e.ts || "", who: e.who === "claude" ? "claude" : "richard", text: e.text || "" }));
    asArray(t.notes).forEach(n => th.push({ ts: n.ts || "", who: "richard", text: n.text || "" }));
    if (t.claudeNote && t.claudeNote.text) th.push({ ts: t.claudeNote.ts || "", who: "claude", text: t.claudeNote.text });
    th.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const mark = verdict.taskNotes && verdict.taskNotes[t.id];
    const last = th[th.length - 1];
    const lastClaude = [...th].reverse().find(e => e.who === "claude");
    if (mark && (!last || last.who === "richard" || !lastClaude || lastClaude.text !== String(mark))) {
      th.push({ ts: now, who: "claude", text: String(mark) });
    }
    t.thread = th;
    delete t.notes; delete t.claudeNote;
  });
  if (ref.todaysPlan) ref.todaysPlan.tasks = tasks;

  const ideas = asArray(ref.ideas);
  ideas.forEach(i => {
    const reply = verdict.ideaReplies && verdict.ideaReplies[i.id];
    const th = asArray(i.thread);
    if (reply && th.length && th[th.length - 1].who === "richard") {   // enforced server-side too
      th.push({ ts: now, who: "claude", text: String(reply) });
      i.thread = th;
    }
  });
  if (ideas.length) ref.ideas = ideas;

  if (verdict.take) {
    const takes = asArray(ref.claudesTake);
    takes.push({ ts: now, take: String(verdict.take) });
    ref.claudesTake = takes.slice(-10);
  }

  ref.meta = ref.meta || {};
  ref.meta.lastReviewed = now;          // deliberately NOT lastUpdated — "Compiled" stamp stays honest

  await db.ref(NODE).set(ref);
  await db.ref(REVIEW_STATE).set({ sig, ts: now });

  return { status: 200, body: "Review written at " + now + " (" +
    Object.keys(verdict.taskNotes || {}).length + " task marks, " +
    Object.keys(verdict.ideaReplies || {}).length + " idea replies)." };
}

/* ------------------------- v2 (Director/Author) ------------------------ */

// v116: the tick map alone missed the mid-states. A task moving open -> part, or
// being refiled from In progress to Waiting, is a real change and must wake a
// review the way a tick does. The desk mirrors this exactly (clientSignature).
function v3Maps(ref) {
  const done = {}, status = {}, bucket = {};
  asArray(ref.projects).forEach(p => asArray(p.actions).forEach(a => {
    done[a.id] = !!a.done;
    status[a.id] = taskStatus(a);
    bucket[a.id] = a.bucket || "";
  }));
  return { done, status, bucket };
}
function v2Signature(ref) {
  const notes = asArray(ref.notes).filter(n => n.state === "open")
    .map(n => ({ id: n.id, text: n.text }));
  const { done, status, bucket } = v3Maps(ref);
  return crypto.createHash("sha256")
    .update(JSON.stringify({ notes, done, status, bucket, date: ref.plan?.date || "" })).digest("hex");
}

const REVIEW_V2_SYSTEM = `You are the mid-day reviewer of Richard's v2 Walk Reference (Director/Author board). This is judgement, not compile: actions and resolutions only — no restructuring, no new projects or actions, no summary rewrites. Richard is Digital & Broadcast Manager at The National League.

Return ONLY a JSON object, no fences:
{
  "take": "2-4 sentence verdict on the day's shape right now",
  "tickActionIds": ["a3"],
  "partActionIds": ["a5"],
  "actionUpdates": { "a5": "progress note, one line" },
  "noteResolutions": { "n7": "answered — one line" },
  "diffWhat": "one line describing any changes made, or null"
}

Rules:
- take: teeth, earned. Hard dates and unrecoverable items outrank everything. If nothing has changed, say so in one line — a clean bill is a valid verdict.
- tickActionIds: ONLY actions the board itself evidences as complete. No fabricated completions — if the state doesn't show it, it didn't happen.
- partActionIds: tasks the board evidences as genuinely in flight but NOT finished (status 'part'). Treat 'part' as carryable-not-ignored — surface the latest update rather than reading the item as untouched.
- actionUpdates: a progress note attached to a task WITHOUT ticking it, when the board shows movement short of completion. One line each, evidenced.
- noteResolutions: ONLY for open notes you can genuinely answer or action from the board. One line each (answered / actioned / pushed back — with why). Leave notes you cannot resolve untouched — compile will take them.
- Do NOT touch conversations[]. An open question is answered by a chat or the on-demand answer pass, never here — a question is never silently resolved.
- Never edit Richard's words. Judge the work, never the people; do not extend assessments of named colleagues.
- Weekend/evening: judge accordingly; do not manufacture office-hours urgency.`;

async function runReviewV2(ref) {
  const sig = v2Signature(ref);
  const prevState = (await db.ref(REVIEW_STATE).get()).val() || {};
  if (prevState.sig === sig) return { status: 200, body: "No change since last review — skipped." };

  const ctx = { ...ref };
  delete ctx.todaysPlan; delete ctx.fronts; delete ctx.richardsNotes;
  delete ctx.ideas; delete ctx.claudesTake;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1200,
      system: REVIEW_V2_SYSTEM,
      messages: [{ role: "user", content:
        "Current time: " + new Date().toISOString() + " (UK)\n\nBoard:\n" + JSON.stringify(ctx) }] })
  });
  if (!resp.ok) {
    console.error("Anthropic API error:", resp.status, await resp.text());
    return { status: 502, body: "Anthropic API error " + resp.status };
  }
  const data = await resp.json();
  recordUsage(data.usage);
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  let v;
  try { v = JSON.parse(text.replace(/```json|```/g, "").trim()); }
  catch { return { status: 502, body: "Review output was not valid JSON — nothing written." }; }

  const now = new Date().toISOString();
  await db.ref(HISTORY + "/" + Date.now()).set(ref);

  let changed = 0;
  const diffs = asArray(ref.diffs);
  const diffId = "d" + (diffs.length + 1);

  asArray(v.tickActionIds).forEach(id => {
    asArray(ref.projects).forEach(p => asArray(p.actions).forEach(a => {
      if (a.id === id && !a.done) { syncStatus(a, "done"); changed++; }
    }));
  });
  // Mid-states: a task the board evidences as in-flight but not finished.
  if (v.partActionIds) asArray(v.partActionIds).forEach(id => {
    asArray(ref.projects).forEach(p => asArray(p.actions).forEach(a => {
      if (a.id === id && taskStatus(a) === "open") { syncStatus(a, "part"); changed++; }
    }));
  });
  // Progress logged without a tick — the op whose absence forced logging
  // progress as brand-new actions.
  if (v.actionUpdates && typeof v.actionUpdates === "object") {
    Object.keys(v.actionUpdates).forEach(id => {
      asArray(ref.projects).forEach(p => asArray(p.actions).forEach(a => {
        if (a.id !== id) return;
        a.updates = asArray(a.updates);
        const text = String(v.actionUpdates[id]);
        if (a.updates.some(u => u.text === text)) return;     // never log the same update twice
        a.updates.push({ text, ts: now });
        changed++;
      }));
    });
  }
  if (v.noteResolutions && typeof v.noteResolutions === "object") {
    asArray(ref.notes).forEach(n => {
      const r = v.noteResolutions[n.id];
      if (r && n.state === "open") {
        n.state = "resolved";
        n.resolution = { ts: now, text: String(r), diffId };
        changed++;
      }
    });
  }
  if (changed && v.diffWhat) {
    diffs.push({ id: diffId, ts: now, changes: [{ what: String(v.diffWhat), why: "mid-day judgement (server review)" }] });
    ref.diffs = diffs.slice(-5);
  }
  if (v.take) ref.take = [{ ts: now, text: String(v.take) }];

  ref.meta = ref.meta || {};
  ref.meta.lastReviewed = now;

  await db.ref(NODE).set(ref);

  const maps = v3Maps(ref);
  const basisNotes = {};
  asArray(ref.notes).filter(n => n.state === "open").forEach(n => {
    basisNotes[n.id] = crypto.createHash("sha256").update(String(n.text || "")).digest("hex");
  });
  await db.ref(REVIEW_STATE).set({ sig: v2Signature(ref), ts: now,
    basis: { done: maps.done, status: maps.status, bucket: maps.bucket,
             notes: basisNotes, date: ref.plan?.date || "" } });

  return { status: 200, body: "Marked at " + now + " (" + changed + " change(s)" +
    (v.take ? ", take replaced" : "") + ")." };
}

/* ==================== Open questions — on-demand pass ====================
   Section 8 of the v3 spec: a question is NEVER silently resolved. It stays
   open and shows prominently until an answer is written into its thread.
   Answers come from a chat or from THIS pass — deliberately not from the
   silent hourly file pass, which has no channel to reply. */

const ANSWER_SYSTEM = `You are answering the open questions on Richard's Walk Reference board. Richard is Digital & Broadcast Manager at The National League (English football's fifth tier).

You receive the live board and the list of open conversations. Answer each one you can actually answer from the board and your own judgement.

Return ONLY a JSON object, no fences:
{ "answers": { "<convId>": "<the answer, 1-6 sentences>" } }

Rules:
- Answer the question that was asked. No summarising it back, no restating the board.
- Where the answer is a workflow or a rule, state the rule plainly and say why it is the rule.
- If you genuinely cannot answer one from the board, OMIT it — leaving it open is correct and honest. Never write a non-answer to clear the badge; an unanswered question that stays open is the feature, not the failure.
- Fabricate nothing. If the answer depends on a fact the board does not hold, say exactly which fact you need.
- British English. Concise, direct, no filler. Judge the work, never the people.`;

async function runAnswerPass() {
  if (!ANTHROPIC_KEY) return { status: 500, body: "ANTHROPIC_API_KEY not set on the service." };
  const snap = await db.ref(NODE).get();
  if (!snap.exists()) return { status: 404, body: "walkReference is empty." };
  const ref = snap.val();

  const open = asArray(ref.conversations).filter(c => c && c.state === "open");
  if (!open.length) return { status: 200, body: "No open questions — nothing to answer." };

  const ctx = { ...ref };
  delete ctx.todaysPlan; delete ctx.fronts; delete ctx.richardsNotes;
  delete ctx.ideas; delete ctx.claudesTake; delete ctx.diffs;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 2000,
      system: ANSWER_SYSTEM,
      messages: [{ role: "user", content:
        "Current time: " + new Date().toISOString() + " (UK)\n\n" +
        "Open questions:\n" + JSON.stringify(open.map(c => ({ id: c.id, topic: c.topic, thread: c.thread }))) +
        "\n\nBoard:\n" + JSON.stringify(ctx) }] })
  });
  if (!resp.ok) {
    console.error("Anthropic API error:", resp.status, await resp.text());
    return { status: 502, body: "Anthropic API error " + resp.status };
  }
  const data = await resp.json();
  recordUsage(data.usage);
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  let v;
  try { v = JSON.parse(text.replace(/```json|```/g, "").trim()); }
  catch { return { status: 502, body: "Answer output was not valid JSON — nothing written." }; }

  const now = new Date().toISOString();
  await db.ref(HISTORY + "/" + Date.now()).set(ref);

  let answered = 0;
  const convs = asArray(ref.conversations);
  Object.keys(v.answers || {}).forEach(cid => {
    const c = convs.find(x => x.id === cid);
    if (!c || c.state !== "open") return;
    const body = String(v.answers[cid] || "").trim();
    if (!body) return;                                  // no answer written = stays open
    c.thread = asArray(c.thread);
    c.thread.push({ author: "claude", text: body, ts: now });
    c.state = "answered";
    answered++;
  });
  if (!answered) return { status: 200, body: "Nothing answerable from the board — " + open.length + " question(s) left open." };

  ref.conversations = convs;
  ref.meta = ref.meta || {};
  ref.meta.lastReviewed = now;
  await db.ref(NODE).set(ref);
  return { status: 200, body: "Answered " + answered + " of " + open.length + " open question(s) at " + now + "." };
}

/* ============================ Assist tools ============================ */

const ASSIST_PATH = "/assist/" + REVIEW_SECRET;   // same capability segment; real auth is the Firebase ID token

const ASSIST_FUNCTIONS = {
  compose_email: {
    boardContext: true,
    maxTokens: 1500,
    system: `You are the email composer inside Richard's Morning Walk desk app. Richard is Digital & Broadcast Manager at The National League (English football's fifth tier).

You receive the live walk board (JSON) as context. Use it to resolve names, situations, dates and stakes the request refers to — but never leak board contents the email's recipient shouldn't see (internal candour, colleague assessments, Claude commentary). The board informs you; it is not quotable material.

HARD RULE — fabricate nothing. Every factual element of the draft must come from the board or the request: no invented personal details (surnames, genders, pronouns, honorifics, roles), and equally no invented events, meetings, conversations, agreements, dates, deadlines, figures, prices, quotes or history. If a fact would strengthen the email but you do not have it, either write around it or leave an explicit [bracketed placeholder] for Richard to fill in. A plausible invention is a failed draft — an obvious gap is a successful one.

ASK FIRST when the gap is central: if the request lacks context essential to a credible draft (who it is actually to, what it must achieve, a key fact the email hinges on), do NOT draft. Instead output up to four lines, each starting "NEED: ", asking the specific questions. Richard adds the answers to his request and resubmits. Placeholders are for peripheral gaps; questions are for central ones.

House style: British English. Concise — short paragraphs, no padding, lead with the point. Warm but direct. No corporate filler ("I hope this finds you well", "please don't hesitate"). Sign off as Richard.

Output EXACTLY this format and nothing else:
Subject: <subject line>

<email body>`
  }
};

async function verifyRichard(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(h.slice(7));
    return decoded.email === "rckdorman@gmail.com" ? decoded : null;
  } catch { return null; }
}

async function runAssist(fnName, input) {
  if (!ANTHROPIC_KEY) return { status: 500, body: "ANTHROPIC_API_KEY not set on the service." };
  const fn = ASSIST_FUNCTIONS[fnName];
  if (!fn) return { status: 404, body: "Unknown function: " + fnName };
  if (!input || typeof input !== "string" || !input.trim())
    return { status: 400, body: "Empty input." };

  let userMsg = "Request:\n" + input.trim();
  if (fn.boardContext) {
    const snap = await db.ref(NODE).get();
    if (snap.exists()) {
      const board = snap.val();
      delete board.todaysPlan; delete board.fronts;   // v1 mirror adds tokens, not context
      delete board.richardsNotes; delete board.ideas; delete board.claudesTake;
      userMsg = "Current walk board (context):\n" + JSON.stringify(board) + "\n\n" + userMsg;
    }
  }

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: fn.maxTokens || 1200,
      system: fn.system, messages: [{ role: "user", content: userMsg }] })
  });
  if (!resp.ok) {
    console.error("Anthropic API error:", resp.status, await resp.text());
    return { status: 502, body: "Anthropic API error " + resp.status };
  }
  const data = await resp.json();
  recordUsage(data.usage);
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  return { status: 200, body: text || "(empty response)" };
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

const cors = res => {
  res.set("Access-Control-Allow-Origin", "https://rckdo.github.io");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
};
const reviewHandler = async (_req, res) => {
  cors(res);
  try { const r = await runReview(); res.status(r.status).send(r.body); }
  catch (e) { console.error(e); res.status(500).send("review failed: " + e.message); }
};
app.options(REVIEW_PATH, (_req, res) => { cors(res); res.status(204).end(); });
app.post(REVIEW_PATH, reviewHandler);
app.get(REVIEW_PATH, reviewHandler);

// On-demand "answer open questions" pass — driven by the desk's Q&A panel.
const ANSWER_PATH = "/answer/" + REVIEW_SECRET;
const answerHandler = async (_req, res) => {
  cors(res);
  try { const r = await runAnswerPass(); res.status(r.status).send(r.body); }
  catch (e) { console.error(e); res.status(500).send("answer pass failed: " + e.message); }
};
app.options(ANSWER_PATH, (_req, res) => { cors(res); res.status(204).end(); });
app.post(ANSWER_PATH, answerHandler);
app.get(ANSWER_PATH, answerHandler);

const assistCors = res => {
  res.set("Access-Control-Allow-Origin", "https://rckdo.github.io");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "content-type, authorization");
};
app.options(ASSIST_PATH, (_req, res) => { assistCors(res); res.status(204).end(); });
app.post(ASSIST_PATH, async (req, res) => {
  assistCors(res);
  try {
    if (!(await verifyRichard(req))) { res.status(401).send("Not authorised."); return; }
    const r = await runAssist(req.body?.function, req.body?.input);
    res.status(r.status).send(r.body);
  } catch (e) { console.error(e); res.status(500).send("assist failed: " + e.message); }
});

app.get("/", (_req, res) => res.send("walk-reference MCP: ok"));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("walk-reference MCP + reviewer listening on " + port));

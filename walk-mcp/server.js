/*
  MORNING WALK — MCP SERVER + AMBIENT REVIEWER
  v65.0 — 01/08/2026

  Changelog:
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
  const server = new McpServer({ name: "walk-reference", version: "65.0" });

  server.tool(
    "get_reference",
    "Read the Morning Walk rolling reference: meta, fronts (status/liveEdge/detail), todaysPlan (tasks with done flags, Richard's timestamped notes, and Claude's claudeNote marks), ideas (first-class concepts, each with a state and a richard/claude discussion thread), richardsNotes, claudesTake. Call at the start of every morning-walk chat.",
    {},
    async () => {
      const snap = await db.ref(NODE).get();
      if (!snap.exists()) return { content: [{ type: "text", text: "ERROR: /walkReference is empty." }] };
      return { content: [{ type: "text", text: JSON.stringify(snap.val(), null, 2) }] };
    }
  );

  server.tool(
    "update_reference",
    "Write the complete new state of the rolling reference (post-walk compile or mid-day edit). Pass the ENTIRE document as a JSON string — replaces the node wholesale; previous state is archived automatically and meta.lastUpdated/updatedBy are stamped by the server. v2 schema: notes[], projects[] (each with actions: id/text/urgency/done/provenance), plan {date, actionIds}, take, diffs[] — legacy mirror keys (fronts, todaysPlan) accepted during transition. Refused if notes, projects or plan are missing.",
    { referenceJson: z.string().describe("Full reference document as a JSON string") },
    async ({ referenceJson }) => {
      let next;
      try { next = JSON.parse(referenceJson); }
      catch (e) { return { content: [{ type: "text", text: "ERROR: invalid JSON — " + e.message }] }; }
      if (!next || typeof next !== "object" || !next.notes || !next.projects || !next.plan)
        return { content: [{ type: "text", text: "ERROR: refused — v2 payload must contain 'notes', 'projects' and 'plan'. Unknown/legacy keys (fronts, todaysPlan mirrors) are accepted. Node unchanged." }] };

      const current = await db.ref(NODE).get();
      if (current.exists()) await db.ref(HISTORY + "/" + Date.now()).set(current.val());

      next.meta = next.meta || {};
      next.meta.lastUpdated = new Date().toISOString();
      next.meta.updatedBy = "claude";
      await db.ref(NODE).set(next);
      return { content: [{ type: "text", text: "OK: reference updated at " + next.meta.lastUpdated + " (previous state archived)." }] };
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

function v2Signature(ref) {
  const notes = asArray(ref.notes).filter(n => n.state === "open")
    .map(n => ({ id: n.id, text: n.text }));
  const done = {};
  asArray(ref.projects).forEach(p => asArray(p.actions).forEach(a => { done[a.id] = !!a.done; }));
  return crypto.createHash("sha256")
    .update(JSON.stringify({ notes, done, date: ref.plan?.date || "" })).digest("hex");
}

const REVIEW_V2_SYSTEM = `You are the mid-day reviewer of Richard's v2 Walk Reference (Director/Author board). This is judgement, not compile: actions and resolutions only — no restructuring, no new projects or actions, no summary rewrites. Richard is Digital & Broadcast Manager at The National League.

Return ONLY a JSON object, no fences:
{
  "take": "2-4 sentence verdict on the day's shape right now",
  "tickActionIds": ["a3"],
  "noteResolutions": { "n7": "answered — one line" },
  "diffWhat": "one line describing any changes made, or null"
}

Rules:
- take: teeth, earned. Hard dates and unrecoverable items outrank everything. If nothing has changed, say so in one line — a clean bill is a valid verdict.
- tickActionIds: ONLY actions the board itself evidences as complete. No fabricated completions — if the state doesn't show it, it didn't happen.
- noteResolutions: ONLY for open notes you can genuinely answer or action from the board. One line each (answered / actioned / pushed back — with why). Leave notes you cannot resolve untouched — compile will take them.
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
      if (a.id === id && !a.done) { a.done = true; changed++; }
    }));
  });
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

  const basisDone = {};
  asArray(ref.projects).forEach(p => asArray(p.actions).forEach(a => { basisDone[a.id] = !!a.done; }));
  const basisNotes = {};
  asArray(ref.notes).filter(n => n.state === "open").forEach(n => {
    basisNotes[n.id] = crypto.createHash("sha256").update(String(n.text || "")).digest("hex");
  });
  await db.ref(REVIEW_STATE).set({ sig: v2Signature(ref), ts: now,
    basis: { done: basisDone, notes: basisNotes, date: ref.plan?.date || "" } });

  return { status: 200, body: "Marked at " + now + " (" + changed + " change(s)" +
    (v.take ? ", take replaced" : "") + ")." };
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

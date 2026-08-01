/*
  MORNING WALK — MCP SERVER + AMBIENT REVIEWER
  v65.0 — 01/08/2026

  Changelog:
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
    "Write the complete new state of the rolling reference (post-walk compile or mid-day edit). Pass the ENTIRE document as a JSON string — replaces the node wholesale; previous state is archived automatically and meta.lastUpdated/updatedBy are stamped by the server. Ideas live in ideas[] ({id, title, seed, state: thrashing|parked|graduated, opened, thread[]: {ts, who: richard|claude, text}}) — preserve threads append-only. Refused if 'fronts' or 'todaysPlan' are missing.",
    { referenceJson: z.string().describe("Full reference document as a JSON string") },
    async ({ referenceJson }) => {
      let next;
      try { next = JSON.parse(referenceJson); }
      catch (e) { return { content: [{ type: "text", text: "ERROR: invalid JSON — " + e.message }] }; }
      if (!next || typeof next !== "object" || !next.fronts || !next.todaysPlan)
        return { content: [{ type: "text", text: "ERROR: refused — payload must contain 'fronts' and 'todaysPlan'. Node unchanged." }] };

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
    notes: asArray(t.notes).map(n => ({ ts: n.ts, text: n.text }))
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
- taskNotes: a mark for EVERY task. Verdict-flavoured, useful, max 12 words. Hard deadlines and unrecoverable items always outrank the merely urgent. Repeat carry-overs get named as such. Done tasks get brief acknowledgement. Weekends: judge accordingly — do not manufacture weekday urgency on a Saturday.
- ideaReplies: ONLY for ideas listed as eligible in the user message, and ONLY when you have genuine steer — an angle, a risk, a sharpener, a connection to his fronts. Substance over cheerleading. Omit an idea entirely if you have nothing real to add. Never summarise the idea back at him.
- take: teeth, earned. If nothing material changed or the day is on track, say so in one line — a clean bill is a valid verdict. Never invent urgency.
- Judge the work, never the people. Fronts contain frank notes on named colleagues; do not extend or editorialise on personal assessments.
- If the state doesn't show it, it didn't happen.`;

async function runReview() {
  if (!ANTHROPIC_KEY) return { status: 500, body: "ANTHROPIC_API_KEY not set on the service." };

  const snap = await db.ref(NODE).get();
  if (!snap.exists()) return { status: 404, body: "walkReference is empty." };
  const ref = snap.val();

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
    const mark = verdict.taskNotes && verdict.taskNotes[t.id];
    if (mark) t.claudeNote = { ts: now, text: String(mark) };
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

const reviewHandler = async (_req, res) => {
  try { const r = await runReview(); res.status(r.status).send(r.body); }
  catch (e) { console.error(e); res.status(500).send("review failed: " + e.message); }
};
app.post(REVIEW_PATH, reviewHandler);
app.get(REVIEW_PATH, reviewHandler);

app.get("/", (_req, res) => res.send("walk-reference MCP: ok"));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("walk-reference MCP + reviewer listening on " + port));

/*
  MORNING WALK — MCP SERVER
  v20.0 — 31/07/2026

  Changelog:
  v20.0 — Initial build. Streamable-HTTP MCP server exposing two tools:
          get_reference  — returns the full /walkReference node as JSON
          update_reference — archives current state to /walkReferenceHistory,
                             then writes the new state; server stamps
                             meta.lastUpdated and meta.updatedBy itself.
          Auth: secret path segment (capability URL, same pattern as NL Data).
          Firebase auth: Application Default Credentials — deploy to Cloud Run
          INSIDE the morning-walks-42eb6 project and no key file is needed.
          Guardrail: update refuses payloads missing fronts or todaysPlan,
          so a malformed write can never blank the node.
*/

const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");
const admin = require("firebase-admin");

const SECRET = "wR7kPm2ZqXv9TnE4bYcH8dLsJ3fA";   // capability-URL secret — rotate by redeploying with a new value
const PATH = "/mcp/" + SECRET;
const NODE = "walkReference";
const HISTORY = "walkReferenceHistory";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://morning-walks-42eb6-default-rtdb.europe-west1.firebasedatabase.app"
});
const db = admin.database();

function buildServer() {
  const server = new McpServer({ name: "walk-reference", version: "20.0" });

  server.tool(
    "get_reference",
    "Read the Morning Walk rolling reference: meta (lastUpdated, changelog), fronts (each with status, liveEdge, detail), todaysPlan (tasks with done flags and timestamped notes Richard added during the day), richardsNotes, longerTerm. Call at the start of every morning-walk chat.",
    {},
    async () => {
      const snap = await db.ref(NODE).get();
      if (!snap.exists()) {
        return { content: [{ type: "text", text: "ERROR: /walkReference is empty." }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(snap.val(), null, 2) }] };
    }
  );

  server.tool(
    "update_reference",
    "Write the complete new state of the rolling reference after the post-walk chat. Pass the ENTIRE document as a JSON string (same shape get_reference returns) — this replaces the node wholesale. The previous state is archived automatically, and meta.lastUpdated / meta.updatedBy are stamped by the server, so you may omit them. The write is refused if 'fronts' or 'todaysPlan' are missing, to prevent accidental wipes.",
    { referenceJson: z.string().describe("Full reference document as a JSON string") },
    async ({ referenceJson }) => {
      let next;
      try {
        next = JSON.parse(referenceJson);
      } catch (e) {
        return { content: [{ type: "text", text: "ERROR: referenceJson is not valid JSON — " + e.message }] };
      }
      if (!next || typeof next !== "object" || !next.fronts || !next.todaysPlan) {
        return { content: [{ type: "text", text: "ERROR: refused — payload must contain 'fronts' and 'todaysPlan'. Node unchanged." }] };
      }

      const current = await db.ref(NODE).get();
      if (current.exists()) {
        await db.ref(HISTORY + "/" + Date.now()).set(current.val());
      }

      next.meta = next.meta || {};
      next.meta.lastUpdated = new Date().toISOString();
      next.meta.updatedBy = "claude";

      await db.ref(NODE).set(next);
      return { content: [{ type: "text", text: "OK: reference updated at " + next.meta.lastUpdated + " (previous state archived)." }] };
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.post(PATH, async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
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
app.listen(port, () => console.log("walk-reference MCP listening on " + port));

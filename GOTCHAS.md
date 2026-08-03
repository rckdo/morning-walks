# Walk Reference — Gotchas & Operating Notes

Operational reference for the Morning Walk planner (desk app + walk-mcp server + Walk Reference MCP connector). Read this when a session misbehaves before re-diagnosing from scratch. Last updated 03/08/2026.

---

## 1. Writes from chat don't land — diagnosis order

**Symptom:** You ask Claude in a chat to update the board (tick a task, add a note, change today's plan) and nothing appears on the desk app. Claude may say "landing it now" repeatedly without anything happening.

This has **two independent causes** that look identical from the outside. Check them in this order:

### (a) Connector permission not granted — CHECK THIS FIRST
The Walk Reference write tools (`patch_reference`, `update_reference`) run over the MCP connector, which can require you to **approve access** before Claude can call them. Until you approve, the call is **blocked at your end** and returns nothing — which is indistinguishable from Claude stalling.

- Look for a **permission prompt** in the interface and allow it.
- Once granted, permission generally persists for the connector, but a new surface (different device/app) may prompt again.

### (b) Claude narrating instead of calling the tool
A separate failure: Claude describes the write ("landing it now", "writing this back") and ends the turn **without emitting the tool call**. This produces the same visible result — nothing lands.

- The fix is behavioural: one fresh `get_reference`, one write call, one line of confirmation.
- If Claude replies about your update **without** a tool result attached, that's this failure — say "did it land?"

### The proof of a real write
Every successful write returns a line like:

```
OK: patched at 2026-08-03T06:04:31.757Z — note+ n12, diff+ d6 (previous state archived).
```

**No `OK:` line = the write did not happen.** Do not trust "done" without it.

### What this is NOT
Document size / latency is a **separate** issue (see §2). A big document makes writes *slow*; it does not make them *silently fail*. If nothing landed at all, suspect permission or narration first — not size.

---

## 2. Document size / latency — the concurrency bug and its fix

**Background:** the board is a single ~70k-character document. Before v114, every write (chat *and* scheduled judgement passes) read the whole document, edited a copy in memory, and wrote the whole thing back. Two problems followed:

- **Slow** reads and writes.
- **Stale-write / eaten-tick bug:** if the desk app or a scheduled pass wrote to the board while Claude was composing a full-document write, Claude's write — built from an older snapshot — clobbered those changes. This is what ate the RTMP feed-test tick on 02/08.

**Fix — server v114 (`patch_reference`):**
- Mid-day edits use `patch_reference`, which reads the board **fresh**, applies only the listed ops to the **live** state, and writes back. It cannot clobber a concurrent edit the way a full-document write can.
- The daily compile still uses `update_reference` (a full rewrite) but now takes an optional `expectedLastUpdated` guard that refuses the write if the board moved since it was read.
- Notes are **append-only** — no patch op deletes or rewrites an existing note's text.

**Rule of thumb:** small mid-day change → `patch_reference`. End-of-walk full compile → `update_reference`.

---

## 3. `patch_reference` operations (quick reference)

Pass `ops` as a JSON array; operations apply in order. The server assigns ids and ISO timestamps.

| op | shape | effect |
|----|-------|--------|
| `tickAction` | `{op:'tickAction', actionId:'a3', done:true}` | set an action's done flag |
| `setUrgency` | `{op:'setUrgency', actionId:'a5', urgency:'now'}` | change urgency (`now`/`soon`/`later`) |
| `appendNote` | `{op:'appendNote', text:'…', anchor:'sam'}` | add a NEW open note (`anchor` optional) |
| `resolveNote` | `{op:'resolveNote', noteId:'n7', text:'answered — …'}` | mark an open note resolved + link a diff |
| `appendRichardNote` | `{op:'appendRichardNote', text:'…'}` | add to `richardsNotes` |
| `setPlan` | `{op:'setPlan', date:'04/08/2026', actionIds:['a2','a4']}` | replace today's plan |
| `appendDiff` | `{op:'appendDiff', what:'…', why:'…'}` | add a diff entry |

Optional `expectedLastUpdated` on any patch: if set and the board moved since you read it, the patch still applies safely to live state but the response flags that it had changed.

---

## 4. Standing rules for any session (compile or mid-day)

- **Always `get_reference` immediately before any write.** The desk app and scheduled passes write too; a stale snapshot clobbers their edits.
- **Notes are append-only.** Never delete or rewrite an existing note unless explicitly asked.
- **Confirm with the `OK:` line.** Never report success without it.
- **Check permission before blaming size.** (§1.)

---

## 5. Repo / infrastructure quick facts

- **GitHub user:** `rckdo`
- **Repo:** `morning-walks` (GitHub Pages serves the desk app `index.html` from the root)
- **Server folder:** `walk-mcp/` inside that repo — holds `server.js`, deployed to Cloud Run
- **Desk app (live):** https://rckdo.github.io/morning-walks/
- **Firebase RTDB node:** `walkReference` (history archived under `walkReferenceHistory`)
- **Server deploys via Cloud Run** using Application Default Credentials — no key file needed when deployed inside the project.
- **After editing `walk-mcp/server.js`:** commit → Cloud Run redeploys. Rules/app changes are separate.

---

## 6. Current known open items (as of 03/08/2026)

- **a26 (server v114):** built and — per this session — the connector already exposes `patch_reference`, so it appears deployed. Confirm end-to-end on the next real patch (watch the desk app update).
- **Summary drifts queued for compile:** Cup summary calls the YIR fixture-list question open against a ticked action; well-being summary still reads "Martin" (should be **Martyn**); content-strategy capacity line (n5) not yet folded into the summary.

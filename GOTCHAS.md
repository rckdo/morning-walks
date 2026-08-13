# Walk Reference — Gotchas & Operating Notes

Operational reference for the Morning Walk planner (desk app + walk-mcp server + Walk Reference MCP connector). Read this when a session misbehaves before re-diagnosing from scratch. Last updated 05/08/2026 (server v116 / desk v118 — the v3 board architecture).

> **Partly superseded, 06/08/2026 (server v117).** The server no longer thinks: `/review`, `/answer` and `/assist` are deleted, along with `ANTHROPIC_API_KEY` and the spend meter. Judgement now happens in a Claude client on the subscription. Everything here about the **board** — the patch ops, the RTDB paths, the rules, the write-diagnosis order in §1 — is still accurate and still the place to look. Anything about scheduled or server-side passes is history. See `POSTITPA.md` for the architecture and `SELF-KNOWLEDGE.md` for why.
>
> Also corrected 06/08: this file described `/review` as "scheduled". **It never was.** Cloud Scheduler was never enabled on the project, so no job existed and the hourly pass never ran. The desk's countdown was computing a time from a hardcoded constant, not reading a schedule.

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

## 3a. The three object types (v3, server v116 / desk v118)

The whole point of the redesign: when something new arrives there is **exactly one right place for it**, and it's obvious.

| type | layer | rule | has ticks? |
|---|---|---|---|
| **task** (an action inside a project) | doing | *if it can be ticked, it's a task* | yes — the only ticks on the page |
| **project** | thinking | *if it's a standing state-of-play, it's a project* | **never** |
| **widget** | presentation | *if it's just a view, it's a widget* | owns no data at all |

A project stands on its own: it keeps its summary card even with nothing in its buckets.

### Buckets

`On the agenda → In progress → Done`, with **In progress split in two** because they are different signals:

- **In progress (mine)** — the ball is in Richard's court. Signal: **act**.
- **Waiting** — blocked on someone else. Signal: **chase**.

`bucket` is stored where a task has been refiled, and **derived** otherwise. The two derivations that matter: a task **blocked by an unfinished predecessor**, or one whose **primary owner isn't Richard**, both read as Waiting. So an old v2 action with no v3 fields still lands in the right column.

`done` remains the **source of truth**: `done === (status === 'done')`, re-synced server-side on every write, so status/done/bucket can't drift.

### v3 patch ops

| op | shape | effect |
|----|-------|--------|
| `setStatus` | `{op:'setStatus', taskId:'a3', status:'part'}` | `open` / `part` / `done`. `part` = not done but genuinely in flight |
| `appendActionUpdate` | `{op:'appendActionUpdate', taskId:'a3', text:'…'}` | progress note **without** a tick (append-only) |
| `setBucket` | `{op:'setBucket', taskId:'a3', bucket:'waiting'}` | refile; starts the chase clock on `waiting` |
| `setTaskBody` | `{op:'setTaskBody', taskId:'a3', body:'…'}` | a task is a title **and** a body |
| `setOwner` | `{op:'setOwner', taskId:'a3', subtaskId:'s1', primary:'Tom', secondary:['Richard']}` | layered ownership — one primary (the doer) + any number of secondaries. Works at task **or** subtask level. `clear:true` strips it |
| `addSubtask` / `tickSubtask` | `{op:'addSubtask', taskId:'a3', text:'…', primary:'Tom'}` | subtasks, individually ownable |
| `setBlockedBy` | `{op:'setBlockedBy', taskId:'a61', blockedBy:['a60']}` | dependency-aware ordering (not a Gantt). `[]` clears |
| `askQuestion` | `{op:'askQuestion', topic:'…', text:'…'}` | opens a conversation; stays **open** until answered |
| `answerQuestion` | `{op:'answerQuestion', convId:'c1', text:'…'}` | writes the reply into the thread, sets `answered` |
| `setConversationState` | `{op:'setConversationState', convId:'c1', state:'closed'}` | refuses `answered` if no answer is in the thread |
| `addWidget` / `retireWidget` | `{op:'addWidget', type:'countdown', props:{…}, lifespan:'invoked', expiry:'2026-08-18'}` | Claude curates the shelf; `invoked` widgets expire off it |
| `addPerson` | `{op:'addPerson', name:'Tom Beere'}` | rarely needed — `setOwner` registers people on first use |

### Questions are never silently resolved

A question filed as a conversation stays `open`, ageing in red on the desk, until an answer is **written into its thread**. Nothing marks one answered without an answer — `setConversationState` refuses it, and the answer pass leaves anything it can't genuinely answer open.

Answers come from **a chat**, or the on-demand **`/answer/<REVIEW_SECRET>`** pass (the desk's "answer open questions" button). Deliberately **not** the silent hourly file pass, which has no channel to reply.

### Change detection widened

The review signature now covers per-task **status and bucket**, not just the tick map — so moving a task to `part`, or refiling it into Waiting, wakes a review the way a tick does. The desk mirrors the signature exactly; if you change one, change both (`v2Signature` in `server.js`, `clientSignature` in `index.html`).

---

## 3b. Database rules — `database.rules.json` (v118)

**The rules are deny-by-default and granted leaf by leaf. A field the app writes that isn't listed returns `permission_denied`.** The file in the repo root is the source of record; deploy it by pasting into console → Realtime Database → Rules → Publish (or `firebase deploy --only database`). Editing it here changes nothing on its own.

What the granularity is protecting: **Claude authors, the app annotates.** A task's text, urgency and provenance, a project's title and summary, the plan, the take, the diffs and a note's resolution are read-only to the desk and only ever written by the server through the admin SDK, which bypasses rules entirely. The desk may only touch what Richard did (`done`, `status`, `bucket`, `updates`, subtask ticks), who holds it (`owners`), and what he wrote himself (`notes`, `conversations`).

**The trap:** a multi-path `update()` is checked **per child key**. `ref(action).update({done, status})` needs *both* `done` and `status` granted or the whole update is refused — which is why v118's tick, writing `status`/`done`/`doneTs` together, fails outright under pre-v118 rules that only granted `done`. Adding a field to the desk means adding a line to the rules.

---

## 3c. Archive growth — why history is capped

Every write used to stash a full copy of the board under `walkReferenceHistory`, and nothing pruned it. By 05/08 that was **7.66 MB across 153 snapshots against a live board of 133 KB — 98% of the database**, growing without bound.

Server v116.1 fixes cause and symptom:

- **Only whole-document writes take a full snapshot** — the daily compile (`update_reference`), the review pass and the answer pass. Those are what you'd actually roll back to.
- **`patch_reference` records a delta instead** under `walkReferenceOps`: the ops, what they did, and the prior state of just the objects they name. ~2.9 KB against 133 KB, and a far more readable audit trail than another copy of the board.
- **Both are capped** — newest 20 snapshots, newest 200 deltas. Pruning walks a small key index (`…Index` nodes), so working out what to delete never reads a snapshot back.

Ceiling is now ~3.2 MB and flat. The index backfills itself on the first archive after the upgrade, which is also when the existing 153 snapshots get trimmed to 20 — expect one slower write, once.

Archive keys are timestamps nudged forward on collision, so two writes in the same millisecond can't overwrite each other.

---

## 4. Standing rules for any session (compile or mid-day)

- **Always `get_reference` immediately before any write.** The desk app and scheduled passes write too; a stale snapshot clobbers their edits.
- **Notes are append-only.** Never delete or rewrite an existing note unless explicitly asked.
- **Confirm with the `OK:` line.** Never report success without it.
- **Check permission before blaming size.** (§1.)

---

## 4a. The strategy record — a second document on the same server (v118)

`/strategyReference` is the strategic observations page: durable structural observations with dated evidence under each. **It is not part of the board.** Tools: `get_strategy`, `patch_strategy`, `update_strategy`, on the same MCP endpoint, so the connector already installed serves both.

- **Why a separate node.** The two documents have opposite clocks. The board turns over daily and must be current; this accumulates for years and must hold a pattern still. On the same node the daily compile would eventually eat the durable record.
- **Two tiers, and the split is the design.** `observations[]` are settled and general; `scratch[]` is a pad anything can be thrown at. `appendScratch` is free and constant. `ingest` (evidence onto an observation + drop the pad item, atomically) happens **only on Richard's explicit go-ahead**. Do not ingest because the pad looks full.
- **Evidence is deletable** — `removeEvidence`, `removeSolution` — unlike the board's notes, which are append-only. Deliberate: the ingest step is also an editing step.
- **Evidence dates are free text** ("Ongoing", "c. 2024–25", "w/c 10/08/2026"). `confirm: true` renders as `[confirm]` until verified with `setEvidence`. `quote: true` marks evidence reproduced **verbatim** from a source document and the page sets it as a quotation — never paraphrase one, the exact wording is the evidence.
- **`analysis[]` is a third settled section** (v119), sitting between the observations and the pad. A working explanation of *why* a pattern persists is neither an observation nor evidence: filed as an observation it reads as a finding, filed as evidence it acquires a date it hasn't got. It carries no evidence table, and the absence of that table is what tells you which kind of thing you're reading.
- **`foundational: true`** marks an observation the others are downstream of — substrate, not a peer. Rare by definition. Observation text breaks on blank lines into paragraphs, because substrate has to explain what it sits underneath.
- **The page writes nothing.** `strategy/index.html` is read-only, so the rules grant read and no write at all. Nothing to add when a field is added — there is no desk-owned field here.
- **Archive:** `strategyReferenceHistory` (full snapshots, capped 20) and `strategyReferenceOps` (patch deltas, capped 200), same pruning mechanism as the board.
- **Seeding:** `get_strategy` returns `EMPTY` until the node exists. The seed document is **not in the repo** (see below) — pass it to `update_strategy` from wherever Richard keeps it. Ids, letters and `state` are backfilled server-side.

**The exposure rule, and it is the important one.** `morning-walks` is a **public** repository — GitHub Pages serves it, so anything committed is world-readable. The content of this record is candid assessment of colleagues. **No observation, evidence item, scratch item or seed file is ever committed.** The page, the server, the rules and the skill are committed; the record itself lives only in RTDB, behind Richard's Google account. `strategy/seed.json` is in `.gitignore` so a copy dropped into the repo cannot be committed by accident. If you find yourself writing this content to a file inside the repo, stop.

---

## 5. Repo / infrastructure quick facts

- **GitHub user:** `rckdo`
- **Repo:** `morning-walks` (GitHub Pages serves the desk app `index.html` from the root)
- **Server folder:** `walk-mcp/` inside that repo — holds `server.js`, deployed to Cloud Run
- **Desk app (live):** https://rckdo.github.io/morning-walks/
- **Strategy page (live):** https://rckdo.github.io/morning-walks/strategy/ — read-only, separate node, see §4a
- **Repo is PUBLIC.** Everything committed is world-readable. Nothing from the strategy record goes in it.
- **Firebase RTDB node:** `walkReference`. Full snapshots archive under `walkReferenceHistory` (capped at 20), patch deltas under `walkReferenceOps` (capped at 200), each with a small `…Index` sibling used for pruning. Rules live in `database.rules.json` at the repo root — see §3b; a Firebase data export never contains them.
- **Server deploys via Cloud Run** using Application Default Credentials — no key file needed when deployed inside the project.
- **After editing `walk-mcp/server.js`:** commit → Cloud Run redeploys. Rules/app changes are separate.
- **Endpoints on the service (v117):** `/mcp/<SECRET>` — the MCP tools, and the only endpoint left. `/review`, `/answer` and `/assist` are deleted and now 404. There is no API key on the service and no model call in `server.js`.
- **RTDB paths the desk writes directly:** `walkReference/projects/<i>/actions/<j>` (status, bucket, updates, owners, subtasks, waitingSince), `walkReference/notes`, `walkReference/conversations`, `walkReference/people`, `walkReference/widgets/<i>/props/...`, `walkReference/meta`. If a write returns `permission_denied`, check the rules cover the path — `conversations` and `people` are new in v118.

---

## 6. Current known open items (as of 05/08/2026)

- **a26 (server v114):** built and — per this session — the connector already exposes `patch_reference`, so it appears deployed. Confirm end-to-end on the next real patch (watch the desk app update).
- **Summary drifts queued for compile:** Cup summary calls the YIR fixture-list question open against a ticked action; well-being summary still reads "Martin" (should be **Martyn**); content-strategy capacity line (n5) not yet folded into the summary.
- **v3 rollout (server v116 / desk v118):** additive — no migration is required and nothing needs rewriting. The board renders correctly as-is; `status`, `bucket`, `owners`, `updates`, `subtasks` and `blockedBy` fill in as tasks are touched. Two things do want a compile pass to land properly:
  1. **Register the people** (`setOwner` on the tasks that are actually someone else's — Tom's portals, Phil's decisions) so the ownership circles and the chase radar carry real names rather than deriving from the Waiting rule alone.
  2. **Project summaries are long** — the spec calls for a rolling ~75 words per binder; several currently run to a paragraph or more. That's an authoring job at compile, not a desk change.
- **a62 — "mark as done" in the contacts-pages editor:** NOT built here. That editor is part of the NL Tools portal, a different codebase; nothing in this repo touches it. It remains outstanding as a task on the board.
- **Deferred, unchanged:** archive the v1 mirrors (`fronts`, `todaysPlan`, `ideas`, `richardsNotes`, `claudesTake` still sit on the node); diff-id collisions (`d<n>` derived from array length can repeat after trimming).

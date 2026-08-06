# PostItPA — Redesign Spec (v2)

**Author:** Richard, walk of 2026-08-06. Refined against the repo, same day.
**Supersedes:** the walk draft, and the entire existing tool.
**Status:** Architecture settled. Ready to build.

---

## 0. What changed from the walk draft, and why

The walk draft made one technical claim that turned out to be half wrong, and correcting it simplifies almost everything downstream.

**The claim (§3.1 of the draft):** *"the current question-and-answer mechanism already runs on the Max subscription and responds instantly."*

**What's actually there:** the desk's "answer open questions" button POSTs to `/answer` on Cloud Run, which calls `api.anthropic.com` on a paid key (`walk-mcp/server.js:1100`). So do the scheduled watcher `/review` (`:837`) and the email composer `/assist` (`:1192`). Three features, three paid calls, all metered into `/apiUsage`.

The thing that *is* subscription-billed and genuinely instant is the **MCP connector** — Richard in a Claude chat, Claude calling `patch_reference` against the board. That's the model to copy, and it carries a hard constraint:

> **No webpage of Richard's can invoke Claude on the Max subscription.** Subscription inference exists only inside Anthropic's own clients — the Claude app, claude.ai, Claude Code.

Therefore "remove all paid-API plumbing" has exactly one resolution, and it is the spine of this document:

> **The PA thinks inside a Claude client. The desk shows what it did.**

---

## 1. The one idea everything hangs off

**This is a personal assistant you brief. It is not a to-do board you maintain.**

Richard narrates; it organises. He never operates machinery. Every decision below serves that. When in doubt: *"Is this what a brilliant human PA would do?"*

---

## 2. Architecture

Four parts. Only two need building.

| Part | What it is | Build? |
|---|---|---|
| **The PA** | A skill: character, operating rules, the desk's vocabulary. Loaded in Claude. Runs on the subscription. | **Build** |
| **The board** | Firebase RTDB, reached over the existing MCP server — with every API-calling endpoint deleted. | **Strip and reshape** |
| **The desk** | A static page that renders the board live and handles direct manipulation only. No inference, ever. | **Build** |
| **The channels** | The Claude app, voice mode, and chat thread. | **Nothing to build** |

### 2.1 The channels are already built

The draft's §4 described three ways to talk to the PA. All three already exist, for free, as Claude clients:

- **Post-it** — a short message to Claude. Phone app, share sheet, Claude Code, typed or dictated.
- **Voice chat** — Claude voice mode. Ephemeral, no transcript kept. Exactly as the draft specified, and exactly how voice mode already behaves.
- **Messenger thread** — the Claude chat thread itself. Typing indicator, persistent scrollable history, built for a reply.

This deletes an entire build phase. Do not rebuild a chat UI.

### 2.2 What the desk may and may not do

The desk is a **display surface with hands, not a brain.**

- **May write directly:** ticking, dragging a post-it to a place, binning, expanding a briefing. Direct manipulation — no thinking required, so it goes straight to the database and appears instantly.
- **May never do:** file, interpret, prioritise, answer, or decide. Anything requiring judgement is the PA's, in the chat.

The test for any new desk feature: *does this need to think?* If yes, it belongs in the chat, not on the page.

### 2.3 Why this kills the timer

The old failure was structural: the page could capture, but only a twice-daily server sweep could think. Post-its sat unread; confirmation arrived hours late or not at all; trust broke.

Here there is no sweep, because filing happens **in the same conversational turn as the scribble.** Richard says "done the directory", Claude patches the board, the red pen appears on the desk within seconds. Not a faster timer — no timer.

---

## 3. Governing principles

### 3.1 Everything on the subscription
Zero paid API calls. Enforced by construction: nothing in the system except a Claude client is capable of inference. Delete `ANTHROPIC_API_KEY` and every code path that reads it.

### 3.2 Radical simplicity — the ponytail ladder
Before adding anything, walk the ladder and stop at the first rung that works: *Does this need to exist? → Already in the codebase? → Stdlib? → Native platform? → An existing dependency? → Can it be one line? → Only then, the minimum.*

Applies to both planes: least wiring in the back end, fewest surfaces and controls on the screen. The old tool died of accretion; the antidote is subtraction.

**One deliberate exception:** the tactile feel (§3.4) is where a proven library is the right call, not laziness. Native and minimal everywhere else.

### 3.3 Stand on the shoulders of existing tools
Don't hand-craft what mature libraries do better — drag physics, calendars, charts, timelines. Save bespoke effort for the genuinely unique bit: **the PA itself and how it thinks.**

### 3.4 Tactile and alive
The current interface is wooden — hard cuts, things smashing open. The rebuild must feel physical and warm: post-its that curl, drag that sticks with a bit of glue, motion instead of snapping. Core principle, not a nice-to-have.

### 3.5 Plain English, no jargon
No leaked internals. No action numbers, no bucket-speak, no schema words. Names are the words a person would use. Because it's plain by construction, no tutorial is needed.

### 3.6 Honesty over pretending
Never fail silently, never fabricate, never guess when it should ask.

**This includes the tool's account of itself, and that is not a footnote.** On 05/08/2026 the desk's Q&A panel was asked eight questions, all about its own construction, and got six materially wrong answers — including a flat denial that it cost money, written by a paid API call. See **[SELF-KNOWLEDGE.md](SELF-KNOWLEDGE.md)** for the incident, the root cause in code, and requirements R1–R8, which are binding on this build. The short version: **the PA knows what it is, reads the code before saying "I can't", and leaves a question open rather than closing it with a guess.**

---

## 4. Post-its — the object model

Colour tells you who's holding the pen. **Yellow = Richard. Green = the PA's question. Red pen = the PA's record of what it did.**

1. **Yellow, live, waiting** — Richard's. On the desk, or stuck to a place, until actioned.
2. **Green note on top** — the PA needs a steer. It writes back in its own colour. The post-it stays exactly where it was put, now flagged. The reply happens in the chat thread.
3. **Red pen + holding shelf** — actioned. The PA scribbles on the post-it what it did ("done — filed under club directory") and it moves to a holding shelf for ~24 hours, where secondary amendments are still possible. **The red pen is the confirmation mechanism.**
4. **Binned, recoverable** — after the holding window. Still diggable.

**Placement.** A post-it can be dropped loose (the PA works out where it belongs) or stuck to a specific place — the calendar, a project, the blue-sky pile — which carries context and saves guessing.

**Fuzzy forgiveness.** A post-it clearly stuck in the wrong place makes the PA widen its gaze rather than blindly file against the thing it's attached to.

**Implementation notes (ponytail):** the holding shelf and the bin are a timestamp and a view filter, not a background job. The change log already exists — `walkReferenceHistory` archives every write. Reuse it.

---

## 5. The Desk

The calm, glanceable everyday view: what Richard needs to do and what's waiting, laid out the way a PA would lay out his day. Not Trello columns. Not a tool he operates.

- No buckets here — they live inside briefings.
- Shows outcomes, whichever channel produced them.
- Confirmation lives here as the red pen. Because filing is instant, a freshly-actioned post-it is red-penned within seconds. Richard is never left wondering whether something landed.

---

## 6. Briefings

A separate register from the desk. *"Give me a briefing on the club directory"* — and the PA opens the file and lays it out: the concept, the actions, who owns what, what's waiting, and **what's already done** (seeing completed work is reassuring).

**This is the one place buckets earn their keep** — in progress / waiting / done, on demand, and nowhere else.

Because the PA is in the chat, a briefing can be delivered as prose in the thread *or* rendered on the desk. Start with the thread; add the rendered version only if the thread version proves insufficient.

---

## 7. Ambiguity → clarify, don't guess

"Meeting 9:30 Thursday" on a Thursday gets one smart question, not a silent guess.

- Clean post-its file straight away.
- Ambiguous ones get a green note, and the back-and-forth happens in the chat thread, which is built for a reply.
- Lean on project memory and context first. Only ask when genuinely stuck. Not thick, not annoying.

---

## 8. Graceful failure

Asked to build a brick wall, the PA doesn't grab a biro and start troweling. It says: *"That's outside what I can do. Your options are: teach me, get me the right tool, or bring in someone who builds walls."*

Often the fix is to grow the tool itself — so a limit becomes a signpost: *"not yet, and here's what would make it possible."* The PA understands its own construction well enough to hand Richard the instruction to give Claude Code. It is the translator between what he wants and how the tool gets built.

**One face, always.** If work is delegated to sub-agents under the bonnet, that is plumbing Richard must never see.

---

## 9. Widgets, toolkit, change log, search

- **Widgets** — proven libraries for calendars, timelines, progress bars, countdowns, charts. Keep the set bounded.
- **Toolkit page** — a tucked-away reference showing every widget with its name and a small example. Teaches the vocabulary without a tutorial. *A version of this already exists in `index.html`; reuse it rather than rebuilding.*
- **Change log** — complete, searchable, exportable record of everything the PA has done. Break-glass tool, deliberately not on the everyday desk. *Backed by the existing archive.*
- **Search (v1)** — conversational. Ask the PA in the thread; get a plain-language answer weighted to recent and live things. **Zero build:** Claude reads the board over MCP. A visual scrollable search is deferred to ~v2.1.

---

## 10. Vocabulary

| Old / rejected | New |
|---|---|
| "the board" | **your Desk** |
| "in-tray" | **Post-its** |
| "compile" | **tidy-up** |
| "deep dive" | **briefing** |
| `a32`, action numbers | *(never shown)* |

**The PA's verbs:** *filing*, *ticking*, *answering*, *tidy-up*. Light jobs (file one post-it) and heavy jobs (a full tidy-up) get **distinct triggers**, so Richard always knows which he's invoking. Light is instant and conversational; heavy is asked for explicitly.

---

## 11. Design canon

Fix a small token set up front; don't make a fresh style decision per element.

- Two fonts, 3–4 text sizes, one button style, one collapse/expand behaviour.
- House desk aesthetic: paper / ink / red-pen. **Caveat, Kalam, Fraunces, IBM Plex Mono.** Every object is a recognisable desk object.
- Motion is part of the canon, not an afterthought.
- **This is a personal product, not a National League one.** Strip every NL colour, logo, token and reference from the existing repo.
- **Handcrafted, not AI-made.** Run the build past `anti-slop` before presenting any UI. The desk aesthetic is the positive system and it wins; anti-slop is a negative guardrail that strips the generic tells (purple/cyan gradients, gradient text, side-stripe cards, icon-tile feature cards, Inter/Geist, bounce easing, em-dash-heavy copy). Note: `anti-slop` was authored around an NL brand — that context does **not** apply here.

---

## 12. What gets deleted

Everything below exists today and does not survive the rebuild.

**Paid-API plumbing (all of it):**
- `/review` — the scheduled watcher (`runReview`, `runReviewV2`)
- `/answer` — the Q&A pass (`runAnswerPass`)
- `/assist` — the email composer (`runAssist`, `compose_email`)
- `ANTHROPIC_API_KEY`, `REVIEW_SECRET`, the `/apiUsage` spend tally and its desk meter
- The Cloud Scheduler job that drives `/review`

**Interface:** the current desk in full. Nothing in its structure or feature set is design precedent. All National League branding.

## 13. What survives

**Keep, because it works and rebuilding it would be waste:**
- The MCP server's read/write spine — `get_reference`, `patch_reference`, `update_reference`
- The concurrency fix: patch ops apply to a freshly-read board, so a mid-day edit can't clobber a concurrent write. This was a real bug, properly fixed. Keep it.
- Archive-before-write and the wipe guardrail
- `walkReferenceHistory` as the change log's backing store
- Firebase auth and the RTDB rules
- The widget gallery in `index.html` as the seed for the toolkit page

The patch-op vocabulary gets renamed to post-it terms, but the mechanism stands.

---

## 14. Honest assessment

The draft asked for three things to be judged plainly before building. Verdicts:

**1. Everything instant, on the subscription — achievable, but only this way.**
Not achievable with a thinking desk; fully achievable with a thinking chat. The draft's premise was wrong about which mechanism was already free (§0), but its instinct was right: the MCP path really is instant and really is on the subscription. Moving the brain into the chat is what makes the rest of the vision hold.

**2. The tactile interface — achievable, but it is real front-end craft.**
Easy to underestimate. Budget a proper session for it and use libraries: **dnd-kit** for drag, **Motion** for spring physics. Do not hand-roll drag or easing. This is the one place to spend dependency budget.

**3. Sticking notes to places with fuzzy forgiveness — now easy.**
This was subtle when a server applied rigid JSON operations against a schema. Once Claude holds the board in context, "stuck to the club directory but the text mentions Southend" is just *reading*. It becomes a line in the PA's prompt rather than a feature to engineer. **Build it in v1.**

### Accepted costs

The architecture buys instant-and-free at three prices, accepted knowingly:

1. **Capture goes through a Claude client.** No offline scribbling into a standalone app. In practice the phone app and voice mode cover the walk.
2. **The desk can't notify.** If the PA files something while Richard isn't looking, he sees it next time he opens the desk. Acceptable — it's a desk, not a pager.
3. **"Within seconds" holds while he's in the conversation** — which is exactly when he's looking for confirmation.

---

## 15. Build order

1. **The PA skill + the stripped MCP spine.** Prove one post-it goes from a spoken sentence to a red-penned line on the board, instantly and free. Nothing else is trustworthy until this works.
2. **The desk and the post-it object model**, with the tactile feel. The largest single piece of work.
3. **Briefings** — thread-delivered first.
4. **Toolkit and widgets** from libraries.
5. **Change log and conversational search** — both largely reuse what exists.

Step 3 of the draft's order (the messenger thread) is gone. It's the Claude app.

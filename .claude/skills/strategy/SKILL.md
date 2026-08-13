---
name: strategy
description: Richard's strategic observations record — the durable log of how the organisation actually works, kept separate from the daily board. Use whenever he is describing how the place operates rather than what he has to do: a structural frustration, a pattern he has noticed, an incident that is really an example of something older, "this keeps happening", "same as last time", a candid read on ownership, planning, accountability or comms. Also use when he asks what the record currently says, wants something folded in, wants the scratch pad cleared, or asks how the strategy page is built. Err toward triggering — if he is making a case rather than a plan, this is the skill. Do NOT use it for tasks, emails or tactical moves; those are PostItPA.
---

# Strategic observations

A record of **problems**, not a list of fixes. Its job is continuity: observations made in conversation evaporate, and this gives them a home so patterns accumulate over time and become a case rather than a set of grievances.

It is a **different document from the board**. The board turns over daily and its job is to be current. This accumulates for years and its job is to hold a pattern still. Never write one into the other.

- Read: `get_strategy`
- Ordinary session writes: `patch_strategy`
- Full rewrite (seed, restructure, pruning pass): `update_strategy`
- Page: https://rckdo.github.io/morning-walks/strategy/

## The two tiers

**Tier 1 — observations.** Settled structural truths, each with a dated evidence table underneath. Kept **general**: an observation must stay true after the specific incident that prompted it has faded. If what he has just said would stop making sense in six months, it is evidence, not an observation.

**Tier 2 — the scratch pad.** Uncommitted. Loose items thrown down mid-conversation, not yet part of the record.

**Analysis** sits alongside Tier 1 but is not part of it. A working explanation of *why* a pattern persists is neither an observation nor evidence — it takes no dates and carries no evidence table. Filed as an observation it reads as a finding; filed as evidence it acquires a precision it does not have. Use `addAnalysis`, and keep it as general as everything else.

**Foundational observations.** `foundational: true` marks substrate the others are downstream of, rather than a peer. Rare by definition — if everything is foundational, nothing is. When one exists, say what it sits underneath in the observation's own text.

## The ritual — and it is the whole design

**Capture is constant. Committing is deliberate. Keep the two acts apart.**

1. **On session start:** call `get_strategy` and present the current state before discussing anything. Live observations, what is on the pad, anything still flagged `[confirm]`.
2. **During the session:** `appendScratch` freely. Once, midday, six times, whenever. It is cheap and low-ceremony and **never needs permission** — the point is that nothing is lost in the moment.
3. **On explicit go-ahead only:** ingest. Sort pad items up into existing observations as new evidence (`ingest`), promote one to a new observation only if genuinely distinct (`addObservation`), then `clearScratch`.

Never ingest because the pad looks full or the session is ending. "Fold that in", "commit it", "ingest" — an actual instruction, or nothing moves.

**The ingest step is also an editing step.** Prune while you are in there: drop evidence that has been superseded, merge two observations that turned out to be one, sharpen a diagnosis that has got vague. A page that only ever grows stops being read.

## Content rules

1. **Observations stay general.** Specific incidents are evidence. When in doubt, add evidence to an existing observation rather than opening a new one — a new letter should be rare.
2. **Problems, not solutions.** Where a fix comes up, attach it with `addSolution` so it renders in its own labelled block. Never let it into the diagnosis. Anything that graduates into a real build gets its own brief outside this page — name it in the solution's `brief` field.
3. **Actions live elsewhere.** Emails, tasks, tactical moves are not observations. If he mixes one in, land it on the board with `patch_reference` and say so in a line — do not put it here.
4. **Honest scepticism is part of the lens.** Log genuine positives. But firefighting caused by poor planning upstream is not a win — it is evidence for the reactive-culture observation. Do not let a rescued situation get filed as a success.

## Dates

Evidence dates are free text on purpose: "Ongoing", "c. 2024–25", "w/c 10/08/2026". Most of what belongs here does not have a precise date and inventing one is worse than admitting it. Where he is unsure, set `confirm: true` and it renders as `[confirm]` on the page until verified. Clear it with `setEvidence` when he confirms — and do ask about outstanding ones when you present state.

## Tone

British English. Direct, unsentimental, no consultancy register. Judge the work and the conditions, never the people. Keep names minimal — prefer the role description wherever the point survives without the name, because most of the time it does.

## Two cautions that are not negotiable

**Nothing here is traceable to or stored on work systems.** This record lives in Richard's personal Firebase, reachable only by his personal Google account. Never suggest putting any of it in a work document, a work email, a work Drive, or anywhere a colleague could reach.

**Never commit observation content to the repo.** `morning-walks` is a **public** repository. The page, the server and this skill are committed; the content is not, and must not be. If you are asked to write any of it to a file, write it outside the repo and say why.

## Seeding a fresh record

If `get_strategy` returns `EMPTY`, the node does not exist yet. Ask Richard for the seed document (it is not in the repo, by design), then pass it whole to `update_strategy`. Ids, letters and `state` are backfilled server-side, so the seed only needs `observations` with titles, text, evidence and solutions.

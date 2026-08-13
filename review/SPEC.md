# Review Store — pattern and build spec

**v1.0 — 13/08/2026**

This document specifies a small system for holding a long, evolving written
document. It contains no content from that document and is safe to hand to a
builder.

---

## 1. What this replaces

The document currently lives as markdown files in a Claude Project: one file
per drafted section, plus an outline file and a loose-ends file. The problem is
not context limits or tooling. It is that the outline, the loose-ends tracker
and the section drafts all describe the same document and must be manually kept
in sync after every working session.

They have already drifted. The outline and the drafts disagree about which
sections are drafted, about counts within sections, and about at least one
figure a draft deliberately removed.

An earlier plan was to automate the sync with a repo and a commit step. This
spec takes the other route: **remove the thing that needs syncing.** One store,
one truth, no sync step.

## 2. Shape

Three pieces.

**The store.** A Firebase Realtime Database node holding the entire document —
sections, threads, spine, facts. Private, locked to the owner's personal Google
account.

**The server.** An MCP server sitting in front of the store, exposing a fixed
set of read and write operations. Claude reaches the document only through
these. The server owns all logic: id assignment, position maths, archiving on
write, timestamps.

**The window.** A static page rendering the store readable. Authenticated —
this is not a public page.

This mirrors an existing working system (Walk Reference / strategy record).
Reuse its patterns where sensible.

## 3. Data model

### 3.1 Sections

The document body. Sixteen at present, expected to grow — possibly to a hundred.

| Field | Notes |
|---|---|
| `id` | Stable, server-assigned, never reused, never displayed |
| `position` | Sparse integer (10, 20, 30…) or fractional. Sort key |
| `partId` | Parent part |
| `title` | |
| `body` | Markdown |
| `status` | `empty` \| `outlined` \| `drafted` \| `refined` |
| `visibility` | `include` \| `private` (see §3.5) |
| `notes` | Drafting notes not part of the prose |

**Numbers are never stored.** The number a reader sees is computed at render
time from position. This is the central design decision and it exists because
the current document contains a "9a" — the scar of an insert that could not
renumber.

Inserting between positions 70 and 80 writes one row at 75. Nothing else
changes. No renumbering pass, no downstream edits.

Parts are a separate collection with the same id/position treatment. Five at
present. They renumber by the same mechanism.

### 3.2 Subsections

Sections contain two real heading levels plus a third semantic tier currently
expressed as bolded run-in leads. That third tier is meaningful and is lost if
stored as inline bold.

Store subsections as an ordered child collection of a section — same
id/position/title/body/visibility shape — rather than as heading syntax inside
the body. Heading levels are then a render concern, which also fixes the
existing inconsistency where different sections start at different levels.

Note for the builder: the source files are inconsistent about heading depth.
Do not infer structure from hash counts during migration.

### 3.3 Cross-references

Cross-references appear in nearly every drafted paragraph and are directional
("connects forward to", "picked up in").

**Store them as relations, not text.** A reference holds the target's `id`; the
number renders from the target's current position. Insert a section above the
target and every reference to it stays correct.

Storing these as literal text is the single most damaging thing a builder could
do here.

Suggested shape: an inline marker in the body (`{{ref:sec_abc}}`) resolved at
render, plus a derived index so a section can show what points at it.

### 3.4 Threads

Open questions, unresolved points, trains of thought. Currently a loose-ends
file of fifteen numbered items with an inconsistent emoji tagging scheme,
non-sequential numbering, and duplicate entries.

| Field | Notes |
|---|---|
| `id` | Stable |
| `text` | The point |
| `targets[]` | Zero or more section ids — several items name two or three |
| `framing` | Note on how to handle it |
| `status` | `open` \| `resolved` \| `superseded` |
| `resolution` | Written when closed |
| `visibility` | |

Some threads are document-wide revision rules with no single target. An empty
`targets[]` is valid and meaningful.

**Resolution is a status change, never a deletion.** The existing convention is
strike-through-and-retain so the audit trail survives. Preserve that: resolved
threads stay, rendered below the open ones.

### 3.5 Visibility

Some content must never appear in an exported document — private calibrations
about named senior individuals, and examples carrying instructions not to name
people.

This is a **field on every section, subsection and thread**, not a convention
and not a naming trick. Export honours it. The window shows private material to
the owner, clearly marked as non-rendering.

Combined with the access rules in §5, this is the main reason the store is
private infrastructure rather than a shared document.

### 3.6 Spine

The outline file holds material that is neither section nor thread, and it is
the most valuable thing in the project:

- Thesis statement
- Eleven tone-and-framing principles governing every section
- Per-section drafting status and length targets
- A "key decisions during drafting" log — what was cut and why

Give this its own collection. The principles and thesis are read at the start of
every session. The decisions log is append-only.

### 3.7 Facts

Recurring figures appear in several places and have already required one
correction across multiple files.

Store each once with an id; reference it from bodies (`{{fact:matchdays}}`);
resolve at render. Correcting a figure then means editing one row.

## 4. Operations

Reads:

- `get_document` — everything. At expected size (~15k words) this is cheap and
  is the normal way a session starts.
- `get_section` — one section with its subsections and resolved references.

Writes — all archive prior state and stamp a timestamp:

- `update_section` / `update_subsection` — replace body or fields
- `insert_section` — with `after` or `before`, server computes position
- `move_section` — reposition
- `set_status`, `set_visibility`
- `add_thread`, `update_thread`, `resolve_thread`
- `update_spine`, `add_decision`
- `set_fact`
- `export` — see §6

Optimistic concurrency: reads return a `lastUpdated`; writes may pass it and are
refused if the store has moved. Follow the existing Walk Reference pattern.

**No hard delete anywhere.** Status transitions only. Every write archives.

## 5. Privacy and access

Non-negotiable, and the reason for several decisions above.

1. The store lives in a **personal** Firebase project, not a work one.
2. Database rules scope read and write to a **single uid** — the owner's
   personal Google account. Not `auth != null`.
3. The window requires sign-in and renders nothing before auth resolves. No
   scaffolding, no headings, no placeholders.
4. **The repository is public. Document content is never committed to it.**
   Code, config and this spec are committed; content is not. If sample data is
   needed, invent it.
5. The builder builds the machinery **empty**. Content is seeded afterwards, by
   the owner, through Claude. The builder has no path to the document and should
   not be given one.

## 6. Export

The main document's output format is currently unspecified. The audience is
internal leadership, CEO-primary.

Build:

- **Markdown export** — full document, sections in position order, numbers
  computed, references and facts resolved, private material omitted.

Requirement: **exports freeze their numbering.** Once a version has gone to a
reader, "Section 7" means something to a human holding a copy. A later insert
must not silently invalidate it. Stamp each export with a date and the numbering
as it stood.

**Out of scope for this build:** the slide deck. It is a render of a finished
document and building for it now would distort the schema. Revisit once the main
document is complete.

## 7. Build order

1. Firebase project, database, rules. Verify the uid scoping before anything
   else — this is the load-bearing security control.
2. MCP server: reads first, then writes, then export.
3. Window: read-only render, authenticated.
4. Hand back. Owner connects the MCP and seeds through Claude.

Migration is **not** a scripted import. The existing files disagree with each
other in known and unknown ways, and each conflict needs a human decision. The
seed happens conversationally, with the owner adjudicating.

## 8. Open decisions

- Main document export format beyond markdown (Word? PDF?) — unspecified,
  needs settling before the first real handover.
- One referenced visual asset (a diagram) exists in the prose but not as a
  file. Decide whether the store holds assets or only references them.
- Whether the window offers editing, or remains read-only with all writes
  through Claude. Read-only is simpler and is the default assumption here.

---

## Changelog

| Version | Date | Changes |
|---|---|---|
| 1.0 | 13/08/2026 | Initial spec. Schema, operations, privacy model, build order, export requirements. Deck deferred. |

# Markdown flashcard format

`leitner` reads **Flashcard Markdown 1.0**. The format is specified in its
own repository, and this document does not restate it:

- the specification: [`SPEC.md`](https://github.com/shbernal/flashcard-md-spec/blob/master/SPEC.md)
- the conformance corpus: `flashcard-md-spec`, run in
  `tests/conformance.test.ts`

What follows is what a reader of *this* project needs on top of that: the
conformance class it holds, the things it does that the format leaves to an
implementation, and the one behaviour with real consequences for editing decks
that the format deliberately says nothing about.

If this document and the specification ever disagree, the specification wins and
the disagreement is a bug here.

## Conformance class

`leitner` is a **consumer** (§3.1). That means:

- it MUST parse anything canonical or valid, correctly — not merely tolerate it;
- it MUST NOT refuse to load a file because one card in it is malformed;
- everything else it salvages, skipping the bad unit and saying so.

It is not a producer: it never writes a deck. Markdown files are **only ever
read**. Review state lives in
`~/.local/share/leitner/review-state.json`, and nothing is written back
into the notes tree. The one exception is `e` in a review session, which hands
the file to `$EDITOR` — your editor writes it, not this program.

Diagnostics are printed to stderr with their code in brackets:

```
warning: [stray-h1] /notes/flashcards/rome.md: the second `#` heading …
```

Severity is a function of class, so every one of them is a warning here. The
codes are the closed list in §8; the messages are ours and no test depends on
them.

## Discovery

The format describes one file. Finding the files is this project's business.

- Cards come from a source directory (`sourceDir` in
  `~/.config/leitner/config.json`, default `~/notes/flashcards`, or a
  positional `dir` argument).
- Every `**/*.md` under it is a candidate deck, recursively.
- Dotfiles and dot-directories are skipped. That is what lets `.images/` sit next
  to a deck holding attachments without being scanned itself.
- Files are processed in sorted path order.

## Where the format leaves a choice

| Question | What §-the-spec says | What this program does |
| --- | --- | --- |
| A file with no `#` title | A consumer MAY fall back to the filename (§4.2) | Falls back to the filename without `.md` |
| A file with no `##` headings | A deck with no cards, not an error (§4) | Warns, and the deck does not appear in `list` or the picker |
| The preamble | MAY be dropped without a diagnostic (§4.3) | Dropped, silently — it is specified non-card content |
| `type` and other frontmatter keys | User extensions; ignore, never error (§4.1) | `type` drives `--type`; every other key is ignored |
| Image rendering | Only that an unresolvable image is reported (§7) | PNG only, see below |

### `type` is a user extension, not a format key

Version 1 of the format defines exactly one frontmatter key, `tags`. `type` is a
user extension like any other, so there is **no closed set of values** to check a
file against — `--type film` and `--type reading-list` are the same kind of
filter, matched against the file's own spelling.

Absence is not a value. A file that declares no `type` is selected with
`--untyped`, not by a magic string, so a user who legitimately writes
`type: unknown` gets what they wrote.

### Image rendering is PNG only

Parsing and rendering are separate concerns. Both local relative paths and
absolute URLs are legal (§7), and relative paths resolve against the deck file's
own directory. The convention in `~/notes` is a `.images/` directory beside the
file with kebab-case filenames.

With `--images`, **only PNG is transmitted as actual pixels** — the kitty
graphics protocol defines direct file transmission for PNG, and files are checked
by magic bytes rather than by extension. A `.jpg`, a remote URL, or a `.png` that
is not really a PNG still parses fine and still appears as an attachment line;
it just is not pixels. That is a terminal constraint, correctly not a format
matter, and it is reported as `unresolved-image` rather than left to be guessed
at.

A local path with no file behind it is reported as `unresolved-image` at parse
time, whether or not `--images` was passed.

## Identity and stability

This is the part with real consequences for editing decks, and it is not visible
anywhere in the markdown itself. The specification deliberately does not mandate
a key derivation (§5.2) — how a consumer persists state is not a format
question — so this is the only written account of the scheme.

**Deck id** is the slugified path relative to the source root, minus `.md`:
`vocabulary/words.md` → `vocabulary-words`. Slugification lowercases and
collapses every non-alphanumeric run to a single `-`, so path separators become
dashes and `a/b.md` collides with `a-b.md`.

**Card id** is `sha1(relativePath : slugified-heading : headingIndex)`, where
`headingIndex` is the card's 0-based position among the `##` headings in its
file. Review history — due date, interval, ease, lapse count, suspension — is
keyed on that id and nothing else.

The format guarantees the property this relies on: editing a card's body, its
tags, or its front content below the heading MUST NOT change the card's identity
(§5.2). What it does not protect against is a change to the heading or to the
card's position:

| Edit | History survives? |
| --- | --- |
| Editing a card's body, front region included | yes |
| Adding or removing tags | yes |
| Changing frontmatter | yes |
| Reformatting, reflowing, adding images | yes |
| Renaming a `##` heading | **no** |
| Inserting or deleting a card above it | **no** — every later card shifts |
| Reordering cards | **no** |
| Renaming or moving the deck file | **no** — the whole deck resets |

Editing from inside a review session (`e`) is the exception: it pairs the cards
before and after the edit and carries the records across, so a heading rename
made there keeps its history. A rename made outside the session does not.

The orphaned records are not cleaned up automatically; `export --prune` drops
records whose cards no longer exist.

This matters most for bulk cleanup passes. Normalizing headings, merging
near-duplicates, or sorting a deck alphabetically are all history-destroying
operations on every card they touch, even though the knowledge in the file is
unchanged. Appending new cards to the **end** of a file is the one structural
edit that is always safe.

The id scheme is an implementation detail, not a promised contract — but it
cannot change without invalidating existing review state, so treat it as sticky.
The same reasoning is why the format makes any change to card-boundary rules a
major version (§9), without exception.

## Degenerate cases

Every one of these is a warning surfaced by `leitner stats`, never a hard
failure. One bad file does not stop the rest of the directory parsing.

| Input | Result |
| --- | --- |
| Empty or whitespace-only file | warning, no deck |
| Frontmatter but no `##` headings | warning, no deck |
| Prose only, no headings | warning, no deck |
| Invalid YAML frontmatter | `unrepresentable-content`, parsed as content, no type |
| A `##` heading with no text | `malformed-card-skipped`, the cards around it still load |
| Duplicate `##` headings | two distinct cards, distinct ids — valid, not a warning |
| A card with a heading and no body | a card with an empty back — valid, not a warning |
| A second `#` heading | `stray-h1`; the region below it belongs to no card |
| Unreadable file / parse crash | warning, file skipped |
| Image path pointing at a missing file | `unresolved-image`; the card still loads |

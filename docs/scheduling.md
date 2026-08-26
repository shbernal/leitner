# Scheduling and review state

[`format.md`](format.md) covers how a markdown file becomes cards. This covers
what happens to a card afterwards: how it is queued, what a grade does to it,
and where the resulting state lives. None of it touches the notes tree — the
markdown is read-only, always.

## A small SM-2 variant, not Anki

The scheduler is a deliberately minimal SM-2 descendant, not an attempt at Anki
compatibility. Anki's scheduling is a large surface — learning steps, interval
fuzz, leech thresholds, and now FSRS — and a partial imitation of it is worse
than an honest approximation: it invites the assumption that intervals match
when they don't.

What is worth having instead is determinism. Every transition is a pure function
of `(record, grade, now)`, which is what `tests/scheduler.test.ts` pins down, so
the numbers below are the whole of the behaviour and can be checked by reading
them.

The cost of that choice: state here is not interchangeable with Anki's, and
there is no `.apkg` on either side of the boundary. `export` and `import` move
*this* program's state between machines, nothing more.

## Grades

Ease starts at 2.5 and never drops below 1.3. It has no upper bound.

| Grade | Ease | Next interval | Due |
| --- | --- | --- | --- |
| `1` again | −0.2 | reset to 0 | in 10 minutes |
| `2` hard | −0.15 | 1 day, or `interval × 1.2` | after the interval |
| `3` good | unchanged | 1 day, or `interval × ease` | after the interval |
| `4` easy | +0.15 | 3 days, or `interval × ease × 1.3` | after the interval |

The two-valued interval column is the first answer versus every later one: a
card with no interval yet jumps straight to the fixed value. Intervals are
rounded and floored at one day, so no grade except `again` can schedule a card
twice in the same day.

`again` counts a lapse only when the card has been answered before. Failing a
card on first sight is the first pass, not a relapse, and a card that has never
been seen should not start life with a lapse against it.

## The queue

A session is due cards first, oldest due date first, then new cards in deck
order — deck order being sorted path order, then position in the file. `--due`
and `--new` keep one of the two halves; `--limit` truncates whatever is left,
and `review` applies `dailyLimit` when no `--limit` is given.

Suspended cards are never due and are never queued. `s` suspends the current
card, and `u` takes it back while the session lasts; after that, un-suspending
is an edit to the state file.

Records whose card no longer exists are ignored when the queue is built, and
kept in the file regardless. That is what makes moving a deck file away and back
non-destructive, since a card's id is derived from its path. Dropping those
records is a deliberate act: `export --prune`.

## State on disk

`~/.local/share/leitner/review-state.json`, honouring `XDG_DATA_HOME`, or
whatever `--state` names. A missing file is an empty state, not an error.

```json
{ "version": 1, "records": { "<card id>": { "dueAt": "…", "ease": 2.5 } } }
```

Every grade, suspend and undo writes the whole file immediately, to a `.tmp`
sibling that is then renamed over it. The rename is atomic, so an interrupted
write cannot leave a half-written state, and killing the terminal mid-session
loses nothing that was already graded.

Undo (`u`) is a session-local stack, unwound one action at a time. It restores
the record a card had before the grade, or removes the record entirely if the
card was new — so undoing back to the start of a session leaves the state file
as it was found. Quitting discards the stack; there is no undo across sessions.

## Config

`~/.config/leitner/config.json`, honouring `XDG_CONFIG_HOME`. Missing file means
defaults, unknown keys are ignored, and every key has a flag that overrides it.

The file is written by `leitner init`, which the first run that needs a
`sourceDir` and has no answer for it invokes on your behalf. It is still
optional: a hand-written file is read the same way, and a `dir` argument
overrides it. `init` writes an absolute path, and rewrites only `sourceDir`.

| Key | Default | Effect |
| --- | --- | --- |
| `sourceDir` | `~/notes/flashcards` | scanned when no `dir` argument is given; `~` is expanded |
| `dailyLimit` | `50` | queue cap for `review` when `--limit` is absent |
| `defaultDeckFilter` | `null` | a standing `--deck`; `null` opens the deck picker |

## Not here, on purpose

- **Anki interop in any direction.** No `.apkg` import or export, and no attempt
  to match Anki's intervals — see above.
- **Writing to the markdown.** Scheduling metadata stays in the state file; the
  parser is a consumer and the notes tree keeps no review history.
- **Per-deck or per-card parameters.** One global set of constants, at the top of
  `src/scheduler.ts`. Changing them re-schedules everything on the next grade,
  which is fine for a single user's notes and would not be for shared decks.

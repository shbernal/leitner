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

`review` opens the deck picker whenever the collection holds any cards at all,
even when none of them are due. A refusal there would be the one place a
practice pass cannot be reached from, since the picker is where it is offered.
Only an empty collection exits before the screen.

Records whose card no longer exists are ignored when the queue is built, and
kept in the file regardless. That is what makes moving a deck file away and back
non-destructive, since a card's id is derived from its path. Dropping those
records is a deliberate act: `export --prune`.

## A practice pass

The queue above is what the scheduler asks of you. A practice pass is the other
thing: the whole deck in deck order, suspended cards aside, with no due date
narrowing it and neither `--limit` nor `dailyLimit` truncating it. It is the
answer to an exam on Tuesday and a deck that says "not for three weeks".

There is no flag for it, and no need to leave a session to get one. `p` in the
deck picker opens the highlighted deck as a pass, `All decks` included, and `p`
on the completion screen reopens the deck just finished. That second entry is
not a convenience: `--deck` and `defaultDeckFilter` skip the picker, so the
completion screen is the only door left.

**A pass schedules nothing.** No grades, no suspend, and the state file is not
written. `space` or `enter` reveals the card and the same key moves on, which is
the whole interaction. The keys that would schedule something say why they did
nothing rather than appearing to be dropped.

The reason is that `applyGrade` is a pure function of `(record, grade, now)`
with no term for how early the answer came. Grade a card `good` three months
ahead of its due date and the interval is multiplied by ease and measured from
*now*, so one evening of last-minute revision would push a whole deck into next
year and nothing would say it had happened. Anki buys its way out of this with
an early-review interval bonus, which is a real elapsed-time model; half of one
is worse than none.

An early *failure* is honest information in a way an early success is not, and
there is a case for letting it pull a card back in. It is not taken here: a pass
is fast and graded loosely by design, and paying for one bad evening with a
wrecked schedule is the wrong trade.

Editing with `e` still works in a pass and is the one thing that can touch the
state file, because renaming a heading moves a card's id and `reconcileCardIds`
is what carries the record across. Orphaning review history to keep the rule
tidy would be the worse bug.

A pass counts as practice and never as a review. The two totals are kept apart
on screen and in the line printed after the session, and when there is a review
log to put them in, a pass writes events tagged as practice, counted for what
you did and left out of anything about retention or intervals.

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
defaults, and unknown keys are ignored. Every key but `editor` has a flag that
overrides it; `editor` is answered by the environment instead.

The file is written by `leitner init`, which the first run that needs a
`sourceDirs` and has no answer for it invokes on your behalf. It is still
optional: a hand-written file is read the same way, and `dir` arguments override
it. `init` writes absolute paths, and rewrites only `sourceDirs`.

| Key | Default | Effect |
| --- | --- | --- |
| `sourceDirs` | `["~/notes/flashcards"]` | scanned when no `dir` argument is given; `~` is expanded in each |
| `dailyLimit` | `50` | queue cap for `review` when `--limit` is absent |
| `defaultDeckFilter` | `null` | a standing `--deck`; `null` opens the deck picker |
| `editor` | `null` | the command `e` hands the card to; `null` uses `$VISUAL`, then `$EDITOR`, then `vi` |
| `hiddenDecks` | `[]` | decks the picker leaves out of its list until `.` reveals them; `H` writes it |

A plain string `sourceDir`, which older versions wrote, is read as a
one-directory list. Nothing writes it any more.

`hiddenDecks` is the one key with no flag, because the deck picker is all it
narrows. Each entry is matched the way `--deck` is — a deck slug, or a substring
of a source path — so one entry hides a whole directory, and a short one hides
more decks than it names. Blank entries are dropped: an empty string is a
substring of every path, so one left in the file would hide the collection whole.

It is also the one key a keypress writes. `H` in the picker adds the deck's
source path, or removes that entry again, and rewrites nothing else in the file:
unknown keys and the legacy `sourceDir` spelling survive it, and a file that
cannot be parsed is left alone to be fixed by hand rather than replaced. The path
rather than the slug, because two source directories can hold the same relative
path and so share a slug, and the key was pressed on one row. For the same reason
`H` will not drop an entry that is not the deck's own path — a directory entry
hides decks the cursor was never on, so it says which entry is in the way and
leaves the file alone.

A hidden deck is out of the picker's `All decks` row as well as its list, which
is the same rule the `/` filter follows: a session is the decks on screen. It
goes no further than that. The cards are parsed, `list` and `stats` count them,
`export --prune` still sees their records, and `--deck` opens one directly.
Suspending is what stops a card being scheduled; this only stops a deck being
offered.

`editor` is a command line, not a path: flags in it are passed through, and the
line-jumping argument is appended to them. It beats `$VISUAL` and `$EDITOR`
because it is an answer to "which editor for this program", where those are a
machine-wide default. A blank string counts as unset rather than as a command.

The directories are one collection: the queue mixes them, `--limit` caps the
whole thing, and there are no per-directory parameters. They may not contain one
another, and a card id is derived per directory, so two of them holding the same
relative path share one review record — grading the card in one schedules the
card in the other. `docs/format.md` has the derivation.

## Not here, on purpose

- **Anki interop in any direction.** No `.apkg` import or export, and no attempt
  to match Anki's intervals — see above.
- **Writing to the markdown.** Scheduling metadata stays in the state file; the
  parser is a consumer and the notes tree keeps no review history.
- **Cramming that reschedules.** A practice pass is deliberately inert, and
  there is no `--cram` that grades cards early into the schedule. See above.
- **Per-deck or per-card parameters.** One global set of constants, at the top of
  `src/scheduler.ts`. Changing them re-schedules everything on the next grade,
  which is fine for a single user's notes and would not be for shared decks.

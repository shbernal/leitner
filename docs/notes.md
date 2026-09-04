# Drive-by notes

A drive-by note is a thought about a card's *content*, written down at the
moment it occurs and left for later: this back conflates two rules, this front
gives the answer away, this card and the one above it are the same card. It is a
TODO about the deck, not a fact about your memory of it.

Notes are the one thing this program writes into the notes tree, and they are
kept apart from review state on purpose. The two have different lifecycles: a
review record is machine-generated and can be rebuilt by studying, while a
sentence you wrote once cannot be reconstructed at all.

## Where they live

`.leitner-notes.json`, at the root of each source directory — beside the decks,
not under `~/.local/share`.

That is deliberate. A note is about the deck's content, so it should travel with
the deck: cloned, synced and versioned alongside the markdown it talks about. A
review schedule deliberately does *not* travel that way, which is what
`leitner export` and `leitner import` are for.

The file is a dotfile, and discovery globs `**/*.md` with dotfiles switched off,
so it is skipped twice over — it is not markdown and it is not visible to the
scan. It sits beside a deck the way a `.images/` directory already does.

One file per source directory, never one shared file for a collection. A card
reference is only unique inside its own root, the same reason a card id is
derived against a single root rather than a common parent, so a sidecar only
ever holds references from the directory it sits in.

**There is no fallback location.** A collection on a read-only tree fails the
write and reports the path and the reason. Falling back to `XDG_DATA_HOME` would
create a second place for notes to be, diverging from the first, with nothing to
say which one holds yours.

## The file

```json
{
  "version": 1,
  "notes": {
    "spanish-verbs#ser-vs-estar": [
      {
        "text": "the back conflates the permanence rule with the location rule",
        "createdAt": "2026-09-04T18:22:11.031Z",
        "cardTitle": "Ser vs estar",
        "sourcePath": "spanish/verbs.md"
      }
    ]
  }
}
```

A list per card, oldest first, because drive-by notes accumulate: three passes
over a deck leave three separate remarks, and collapsing them into one field
would lose two of them.

Every write goes to a `.tmp` sibling and is renamed over the target, so an
interrupted write cannot leave the file half-written.

## Keyed by reference, not by card id

The key is the card's **reference** — `deckSlug#headingSlug`, described in
[`format.md`](format.md) — and not the sha1 card id that review state is keyed
on.

Two reasons. The reference is legible, so the file stays readable and editable
by hand, which matters for something that lives in a git repository next to the
notes. And it is the more stable of the two names: it carries no heading index,
so inserting a card above another moves the sha1 and leaves the reference alone.

What breaks a reference is a heading rename or the deck file being moved or
renamed — the same edits that break the card id, minus the positional ones.

## Writing and reading them

```bash
leitner note <ref> [text]     # add a note, or list that card's notes
leitner note <ref> --rm <n>   # remove note n, counting from 1
leitner notes [dir...]        # every note; --orphans narrows to the broken ones
```

A reference may be shortened as long as it stays unambiguous, and an ambiguous
one prints its candidates rather than guessing. A note is only ever filed
against a card that exists, and it goes into the sidecar of the root that card
was found under — which is named back to you when the collection has more than
one.

`stats` counts notes and, separately, the orphans among them.

Inside a review session, `n` opens a composer on the card in front of you and
writes to the sidecar of that card's own root — the same file, reached without
leaving the session. A practice pass can write notes even though it schedules
nothing: the rule a note follows is the one about markdown, which it is not,
not the one about review state.

## Orphans are surfaced, never pruned

A note whose reference no longer resolves stays in the file. Nothing deletes it,
now or later: no command prunes notes, and none ever will without being asked.
`leitner notes` marks it as orphaned and `--orphans` narrows to just those,
which is also why an orphaned reference is still addressable by `note <ref>` —
listing and `--rm` are how one goes away, as an explicit act.

Review state can afford to be relaxed here: an orphaned record is ignored when
the queue is built, and `export --prune` drops it on request, because the worst
case is a schedule you can rebuild. A note is not in that category. Deleting one
because a heading was renamed would silently destroy something only you could
have written.

This is what `cardTitle` and `sourcePath` are for. They are denormalized copies
of the card as it was when the note was written, never used to look anything up,
and they exist so an orphan is still readable — enough to find where the card
went and reattach the note by hand.

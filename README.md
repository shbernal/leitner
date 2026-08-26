# leitner

Terminal UI for reviewing markdown flashcards from `~/notes/flashcards`.

Named after the Leitner system (Sebastian Leitner, 1972): boxes of cards that
move forward when you get them right and back when you don't — the canonical
spaced-repetition method this scheduler is a variant of.

Each `##` heading in a markdown file is one card: the heading is the question,
everything until the next `##` is the answer, and a `***` splits a longer front
from the back. Review state is kept outside the notes folder; markdown files are
never written to.

The deck format is [Flashcard Markdown](https://github.com/shbernal/flashcard-md-spec)
1.0, which `leitner` implements as a **consumer** — it parses anything the
format calls valid and never refuses a file over one bad card. Its conformance
corpus runs in this project's test suite. [`docs/format.md`](docs/format.md)
covers what the format leaves to an implementation, and the card-identity scheme
that decides when an edit costs you review history.

## Install

Needs Node 24 or newer.

```bash
pnpm add -g leitner
```

From a clone instead — which is what the development launcher below assumes:

```bash
pnpm install
pnpm build
```

## Usage

```bash
leitner init   [dir...]  # record where your flashcards live
leitner list   [dir...]  # decks and card counts
leitner stats  [dir...]  # totals, due/new/suspended, parse warnings
leitner review [dir...]  # interactive review session
leitner export [dir...]  # review state as a portable JSON bundle
leitner import <file>    # merge a bundle into local state
```

`dir` defaults to `sourceDirs` from `~/.config/leitner/config.json`.

### More than one directory

Give as many directories as you like and they are read as one collection, in
the order written. The arguments replace the configured directories rather than
adding to them, so a one-off `leitner list ~/work/cards` studies that directory
alone without touching the config.

They may not contain one another: a file under two of them would be counted as
two cards with two separate review histories, so that is refused rather than
merged. Two directories holding the same relative path (`spanish.md` in both)
are allowed, but those two cards then share one review record and grading one
schedules the other; `list` and `stats` print a warning naming both files.

`--deck` matches a source path as well as a deck slug, so it doubles as a way
to study one of the directories: `leitner review --deck ~/work/cards`.

### First run

The first command that needs your flashcards and cannot find that setting asks
for the directory and writes the config file, reporting how many cards it found
there so a typo does not pass for an empty collection. It then carries on with
the command you asked for.

`init` is the same question on demand — run it to move a collection, or give it
the directories (`leitner init ~/notes/cards ~/work/cards`) to answer without
being asked. Asked interactively it keeps offering `Another directory?` until
the answer is blank. `leitner init ~/work/cards --add` adds to the configured
directories instead of replacing them. Every other key keeps its value.

Nothing is written into the notes tree, then or ever. Passing `dir` skips the
question, and so does any run whose stdin or stdout is not a terminal: with no
directory configured, those fail with a message rather than block on a prompt
nobody can see.

### Local command

`bin/leitner` is the development launcher: it rebuilds only when sources
changed and writes build output to stderr so `list`/`stats`/`export` stdout
stays parseable. It `exec`s node from wherever it was called, so a relative
`dir` argument means what it looks like it means. Expose it as a command with a
thin wrapper:

```bash
cat > ~/.local/bin/leitner <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

exec /path/to/leitner/bin/leitner "$@"
EOF
chmod +x ~/.local/bin/leitner
```

### Flags

```text
--add                   init: add the directories instead of replacing them
--deck <slug-or-path>   only decks matching slug or source path (skips the picker)
--type <type>           frontmatter type, matched verbatim (the format defines no set)
--untyped               only cards whose file declares no type
--due                   only due cards
--new                   only new cards
--limit <n>             cap queue size (review defaults to dailyLimit, 50)
--state <path>          state file (default ~/.local/share/leitner/review-state.json)
--images                enable inline image previews (kitty graphics protocol)
--out <path>            export: write here instead of stdout
--prune                 export: drop records whose cards no longer exist
--merge <strategy>      import: newer (default) | theirs | ours
--dry-run               import: report what would change without writing
-h, --help              show this help
```

### Review keys

`review` opens a deck picker first, unless the session is already narrowed to
one deck — by `--deck`, or by `defaultDeckFilter` in the config, which sets the
same option. Pick `All decks` to study everything.

```text
enter/space  select deck (picker) · reveal answer (review)
1 2 3 4      grade: again / hard / good / easy
j/k, arrows  move selection / scroll body
/            filter decks (picker) · search cards (review)
s            suspend card
u            undo last grade
e            edit card in $EDITOR
i            image preview (needs --images)
esc          clear an active search
q            quit
```

The session runs on the terminal's alternate screen, like `vim` or `less`, so
it leaves the scrollback untouched. The number of cards reviewed is printed on
the normal screen once it exits.

### Editing a card

`e` hands the terminal to `$VISUAL`, `$EDITOR`, or `vi`, opened on the card's
`##` heading in its source file. Editors whose line syntax is known get taken
there directly (`+N` for the vi and emacs families, `path:line` for helix,
`--goto` for VS Code); anything else opens at the top of the file. Editors that
detach by default are launched with `--wait` so the session waits for the file
rather than reparsing it unedited.

On return the file is reread and the session picks up where it left off, with
the card's new text. Because a card's id hashes its heading text and position
(so ids survive across machines without an index file), renaming a `##`
heading or inserting a card above one would otherwise orphan the review
history. The reread pairs the cards before and after the edit and carries the
records across; when two or more headings were renamed in one pass the pairing
is ambiguous, so those cards are left to come back as new rather than risk
attaching history to the wrong card.

### Scheduling

A minimal SM-2-style algorithm: `again` comes back in 10 minutes and counts a
lapse, `hard` grows the interval slowly and lowers ease, `good` multiplies the
interval by ease, `easy` grows faster and raises ease. Anki compatibility is not
a goal, and there is no `.apkg` on either side.
[`docs/scheduling.md`](docs/scheduling.md) has the exact transitions, the queue
order, the state file, and the config keys.

### Image previews

`--images` renders attachments as real pixels using the kitty graphics
protocol, so it needs kitty or ghostty. Only PNG is transmitted as pixels —
the protocol's direct file transmission is defined for PNG, and files are
checked by magic bytes rather than extension. Everything else stays a text
attachment line.

Inside tmux the escapes must be forwarded:

```bash
tmux set -g allow-passthrough on
```

`review --images` reports when passthrough is off rather than drawing nothing.

### Moving state between machines

```bash
leitner export --out review-state.json     # on the first machine
leitner import review-state.json           # on the second
```

`import` accepts an export bundle or a raw state file. The default `newer`
strategy keeps whichever copy of a card was reviewed most recently; `theirs`
always takes the incoming record, `ours` only fills in unseen cards. Pair with
`--dry-run` to see the effect first.

## Development

```bash
pnpm test          # vitest
pnpm typecheck     # tsc --noEmit over src and tests
pnpm lint          # oxlint
pnpm format:check  # oxfmt, read-only (pnpm format writes)
pnpm build         # tsc -p tsconfig.build.json, into a cleared dist/
```

`tsconfig.json` is the checking config and covers `tests/` too; `pnpm build`
uses `tsconfig.build.json`, which narrows the input to `src` so only library
code is emitted to `dist`.

`pnpm install` runs `prepare`, which installs the git hooks in `lefthook.yml`.
The only one is a shared `commit-msg` rule fetched from
[`lefthook-rules`](https://github.com/shbernal/lefthook-rules); the checks above
are not wired to a hook, so run them yourself before a commit.

Layout: `src/deck.ts` (Flashcard Markdown → parsed deck; the conformance
surface, pure and free of I/O), `src/tags.ts` and `src/diagnostics.ts` (the
format's tag grammar and its closed code list), `src/parser.ts` (files → cards:
ids, resolved image paths), `src/render.ts` (markdown →
styled terminal lines), `src/scheduler.ts` (grading), `src/state.ts` (JSON
store), `src/transfer.ts` (import/export merge), `src/queue.ts` (due/new
ordering and deck summaries), `src/images.ts` (kitty graphics), `src/editor.ts`
(`$EDITOR` invocation), `src/edit.ts` (carrying records across re-ids),
`src/cli.ts` (commands), `src/tui/` (Ink deck picker and review screen).

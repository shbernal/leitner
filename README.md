# flashcards-tui

Terminal UI for reviewing markdown flashcards from `~/notes/flashcards`.

Each `##` heading in a markdown file is one card: the heading is the question,
everything until the next `##` is the answer. YAML frontmatter
(`type: content|film|vocabulary`) is optional. Review state is kept outside
the notes folder; markdown files are never written to.

## Usage

```bash
pnpm install
pnpm build

flashcards-tui list   [dir]   # decks and card counts
flashcards-tui stats  [dir]   # totals, due/new/suspended, parse warnings
flashcards-tui review [dir]   # interactive review session
flashcards-tui export [dir]   # review state as a portable JSON bundle
flashcards-tui import <file>  # merge a bundle into local state
```

`dir` defaults to `sourceDir` from `~/.config/flashcards-tui/config.json`,
falling back to `~/notes/flashcards`.

### Local command

`bin/flashcards-tui` is the development launcher: it rebuilds only when
sources changed, keeps the caller's working directory, and writes build output
to stderr so `list`/`stats`/`export` stdout stays parseable. Expose it as a
command with a thin wrapper:

```bash
cat > ~/.local/bin/flashcards-tui <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

exec /home/shb/Work/flashcards-tui/bin/flashcards-tui "$@"
EOF
chmod +x ~/.local/bin/flashcards-tui
```

Running through `pnpm run` instead would work but pollutes stdout with
lockfile and update-check lines.

### Flags

```text
--deck <slug-or-path>   only decks matching slug or source path (skips the picker)
--type <type>           content | film | vocabulary | unknown
--due                   only due cards
--new                   only new cards
--limit <n>             cap queue size (review defaults to dailyLimit, 50)
--state <path>          state file (default ~/.local/share/flashcards-tui/review-state.json)
--images                enable inline image previews (kitty graphics protocol)
--out <path>            export: write here instead of stdout
--prune                 export: drop records whose cards no longer exist
--merge <strategy>      import: newer (default) | theirs | ours
--dry-run               import: report what would change without writing
```

### Review keys

`review` opens a deck picker first, unless `--deck` narrowed the session
already. Pick `All decks` to study everything.

```text
enter/space  select deck (picker) · reveal answer (review)
1 2 3 4      grade: again / hard / good / easy
j/k, arrows  move selection / scroll body
/            filter decks (picker) · search cards (review)
s            suspend card
u            undo last grade
i            image preview (needs --images)
esc          clear an active search
q            quit
```

Scheduling is a minimal SM-2-style algorithm: `again` comes back in 10
minutes and counts a lapse, `hard` grows the interval slowly and lowers ease,
`good` multiplies the interval by ease, `easy` grows faster and raises ease.

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
flashcards-tui export --out review-state.json     # on the first machine
flashcards-tui import review-state.json           # on the second
```

`import` accepts an export bundle or a raw state file. The default `newer`
strategy keeps whichever copy of a card was reviewed most recently; `theirs`
always takes the incoming record, `ours` only fills in unseen cards. Pair with
`--dry-run` to see the effect first.

## Development

```bash
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm lint        # oxlint
pnpm format      # oxfmt (use --check in CI via pnpm format:check)
```

Layout: `src/parser.ts` (markdown → cards), `src/render.ts` (markdown →
styled terminal lines), `src/scheduler.ts` (grading), `src/state.ts` (JSON
store), `src/transfer.ts` (import/export merge), `src/queue.ts` (due/new
ordering and deck summaries), `src/images.ts` (kitty graphics), `src/cli.ts`
(commands), `src/tui/` (Ink deck picker and review screen).

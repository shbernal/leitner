# flashcard-tui

Terminal UI for reviewing markdown flashcards from `~/notes/flashcards`.

Each `##` heading in a markdown file is one card: the heading is the question,
everything until the next `##` is the answer. YAML frontmatter
(`type: content|film|vocabulary`) is optional. Review state is kept outside
the notes folder; markdown files are never written to.

## Usage

```bash
pnpm install
pnpm build

node dist/index.js list   [dir]   # decks and card counts
node dist/index.js stats  [dir]   # totals, due/new/suspended, parse warnings
node dist/index.js review [dir]   # interactive review session
```

`dir` defaults to `sourceDir` from `~/.config/flashcard-tui/config.json`,
falling back to `~/notes/flashcards`.

### Flags

```text
--deck <slug-or-path>   only decks matching slug or source path
--type <type>           content | film | vocabulary | unknown
--due                   only due cards
--new                   only new cards
--limit <n>             cap queue size (review defaults to dailyLimit, 50)
--state <path>          state file (default ~/.local/share/flashcard-tui/review-state.json)
```

### Review keys

```text
space/enter  reveal answer
1 2 3 4      grade: again / hard / good / easy
j/k, arrows  scroll body
s            suspend card
u            undo last grade
q            quit
```

Scheduling is a minimal SM-2-style algorithm: `again` comes back in 10
minutes and counts a lapse, `hard` grows the interval slowly and lowers ease,
`good` multiplies the interval by ease, `easy` grows faster and raises ease.

## Development

```bash
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint
```

Layout: `src/parser.ts` (markdown → cards), `src/scheduler.ts` (grading),
`src/state.ts` (JSON store), `src/queue.ts` (due/new ordering), `src/cli.ts`
(commands), `src/tui/review.tsx` (Ink review screen).

# TypeScript TUI Flashcard Viewer Plan

## Goal

Build a local TypeScript terminal UI for reviewing existing markdown flashcards
from:

```text
~/notes/flashcards/**
```

The first version should be a focused review viewer, not a full Anki clone. It
should parse the existing note format, let Santiago review cards quickly from the
terminal, and persist lightweight review state locally.

## Current Input Shape

Observed source directory:

```text
/home/shb/notes/flashcards
```

Current content:

- 30 markdown files.
- 7 image assets under `.images/`:
  - 6 PNG files.
  - 1 JPG file.
- A `vocabulary/` subdirectory with language vocabulary notes.
- A hidden `.images/` folder with PNG/JPG assets.
- Some markdown files have YAML frontmatter:

```yaml
---
type: content
---
```

Known `type` values:

- `content`
- `film`
- `vocabulary`

Important compatibility note: at least one file, `afghanistan.md`, starts
directly with `# ...` and has no frontmatter. The parser must treat
frontmatter as optional.

## Card Model

Use each level-2 heading as one reviewable card:

```markdown
## Card title
- fact
- another fact
![Optional image](.images/example.png)
```

Normalized internal model:

```ts
type Flashcard = {
  id: string
  deckId: string
  deckTitle: string
  sourcePath: string
  sourceMtimeMs: number
  type: 'content' | 'film' | 'vocabulary' | 'unknown'
  title: string
  bodyMarkdown: string
  plainText: string
  images: Array<{
    alt: string
    path: string
  }>
  tags: string[]
}
```

Suggested stable ID:

```text
sha1(relativeSourcePath + ':' + headingSlug + ':' + headingIndex)
```

Reason: titles can repeat across files, but relative path plus heading index is
stable enough for local review state.

## Parser Rules

Use structured markdown parsing rather than ad hoc line splitting.

Recommended packages:

- `gray-matter` for optional frontmatter.
- `unified`, `remark-parse`, and `mdast-util-to-string` for markdown AST.
- `fast-glob` for scanning `**/*.md`.

Parsing behavior:

1. Scan `~/notes/flashcards/**/*.md`.
2. Ignore hidden directories except allow image paths referenced from markdown.
3. Parse optional frontmatter.
4. Detect deck title from first `#` heading when present, otherwise filename.
5. Split cards on `##` headings.
6. Include all content until the next `##` heading.
7. Preserve markdown body for display.
8. Extract markdown image references and resolve them relative to the source
   file path.
9. For vocabulary files, keep the same `## word` card shape. The bullets are
   definitions/examples, so no special parser is needed for v1.

Edge cases to handle:

- Files without frontmatter.
- Empty files or files with frontmatter but no cards.
- Repeated headings.
- Relative image paths such as `.images/mtgox.png`.
- Large decks such as `this-is-how-they-tell-me-the-world-ends.md`.

## TUI Stack

Recommended stack:

- TypeScript + ESM.
- Node >= 20, matching the nearby Anki package ecosystem.
- `ink` for React-style terminal UI.
- `ink-text-input` only if search/input becomes needed.
- `marked-terminal` or custom simple markdown rendering for body text.
- `terminal-image` or `kitty-img` integration later for terminal image
  preview. V1 can show image path/alt text only.

Why Ink:

- Good fit for TypeScript.
- Easier stateful UI than raw readline.
- Simple keyboard-driven screens.
- Testable components.

## CLI Shape

Potential package name:

```text
flashcard-tui
```

Initial commands:

```bash
flashcard-tui review ~/notes/flashcards
flashcard-tui list ~/notes/flashcards
flashcard-tui stats ~/notes/flashcards
```

Useful flags:

```bash
--deck <slug-or-path>
--type content|film|vocabulary
--due
--new
--limit 50
--state ~/.local/share/flashcard-tui/review-state.json
```

Default source path:

```text
~/notes/flashcards
```

## Review UX

V1 review flow:

1. Select due/new cards.
2. Show card title first.
3. Press `space` or `enter` to reveal body.
4. Grade with Anki-like keys:
   - `1`: again
   - `2`: hard
   - `3`: good
   - `4`: easy
5. Persist updated review state.
6. Move to next card.

Core keybindings:

- `j` / `down`: scroll down.
- `k` / `up`: scroll up.
- `space` / `enter`: reveal answer.
- `s`: suspend card.
- `u`: undo last grade.
- `/`: search current deck, optional v2.
- `q`: quit.

Screen layout:

```text
top bar: deck title | card 12/50 | due/new count
main:    card title, then revealed markdown body
footer:  key hints and last action
```

Keep the UI dense and calm. This is a repeated-use study tool, not a landing
page.

## Scheduling

Use a minimal SM-2-inspired scheduler for v1, not full Anki compatibility.

Review state:

```ts
type ReviewRecord = {
  cardId: string
  sourcePath: string
  sourceMtimeMs: number
  suspended: boolean
  dueAt: string
  intervalDays: number
  ease: number
  reps: number
  lapses: number
  lastReviewedAt?: string
}
```

Simple grade behavior:

- Again: due in 10 minutes, interval reset, lapse count increments.
- Hard: due tomorrow, interval grows slowly.
- Good: normal interval growth.
- Easy: larger interval growth and slight ease increase.

For a first implementation, deterministic behavior matters more than exact Anki
parity.

## Persistence

Store review state outside the notes folder:

```text
~/.local/share/flashcard-tui/review-state.json
```

Store app config at:

```text
~/.config/flashcard-tui/config.json
```

Config can include:

```json
{
  "sourceDir": "~/notes/flashcards",
  "dailyLimit": 50,
  "defaultDeckFilter": null
}
```

Do not write metadata back into the markdown files in v1.

## Project Placement

Two reasonable options:

1. Standalone project under `~/Work/flashcard-tui`.
2. New package under `~/Work/anki-md-pkgs/flashcard-tui`.

Recommendation: start standalone at `~/Work/flashcard-tui`.

Reason: the viewer consumes personal notes and has different runtime concerns
from the package/export tools. If the parser becomes generally useful, extract
it later into a shared package under `anki-md-pkgs`.

## Implementation Milestones

### Milestone 1: Parser Library

- Set up TypeScript package.
- Implement file discovery.
- Parse optional frontmatter.
- Split markdown into cards by `##`.
- Resolve image references.
- Add unit tests using small fixture markdown files.

Acceptance:

- Can parse `~/notes/flashcards/software-engineering.md`.
- Can parse `~/notes/flashcards/afghanistan.md` without frontmatter.
- Can parse `~/notes/flashcards/vocabulary/english.md`.
- Can detect image refs in files such as `age-of-crypto.md`.

### Milestone 2: Non-Interactive CLI

- Add `list` command.
- Add `stats` command.
- Add filtering by deck/type.
- Print parse errors with source file paths.

Acceptance:

- `flashcard-tui list ~/notes/flashcards` prints decks and card counts.
- `flashcard-tui stats ~/notes/flashcards` reports total cards, due cards,
  suspended cards, and parse warnings.

### Milestone 3: Review State

- Add JSON state store.
- Implement due/new card queue.
- Implement grade update logic.
- Add tests for scheduling.

Acceptance:

- Review state survives process restart.
- Changed source files do not crash existing state.
- Deleted cards are ignored but their records can remain in state.

### Milestone 4: TUI Review Mode

- Build Ink review screen.
- Add reveal/grade/scroll/quit controls.
- Add basic markdown rendering.
- Show image references as visible attachments.

Acceptance:

- `flashcard-tui review ~/notes/flashcards` opens a working terminal review
  loop.
- Grading cards updates state.
- Quit is clean and does not corrupt state.

### Milestone 5: Polish

- Add search/filter UI.
- Add deck picker.
- Add better markdown rendering.
- Add optional terminal image previews.
- Add import/export of review state.

## Testing Plan

Unit tests:

- Parser handles frontmatter and no-frontmatter files.
- Parser splits `##` cards correctly.
- Parser preserves body markdown.
- Image references resolve to absolute paths.
- Scheduler grade transitions produce expected due dates.

Integration tests:

- Run parser against fixture directory.
- Run CLI `list` and `stats` against fixture directory.
- Simulate a short review session with mocked key input if feasible.

Manual verification:

```bash
pnpm build
pnpm test
pnpm lint
pnpm typecheck
node dist/index.js list ~/notes/flashcards
node dist/index.js stats ~/notes/flashcards
node dist/index.js review ~/notes/flashcards
```

## Risks

- Markdown files are notes, not strict flashcard exports. Some sections may be
  too long for comfortable review.
- Terminal markdown rendering can get noisy with tables/code blocks.
- Image support varies by terminal. Keep image preview optional.
- Full Anki scheduling compatibility would add complexity; defer it.

## Recommended First Build

Implement a minimal standalone TypeScript project with:

- Parser.
- `list` and `stats` commands.
- Review state store.
- Ink review screen.

Skip for v1:

- Editing cards.
- Writing back to markdown.
- APKG export.
- Full Anki scheduler compatibility.
- Rich image previews.

This gives Santiago a usable local review loop quickly while keeping the parser
and state model clean enough to move into the Anki package family later.

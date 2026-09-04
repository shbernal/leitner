import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  expandHome,
  normalizeSourceDirs,
  readConfigFile,
  sourceDirsFrom,
  withDefaults,
} from './config.js'
import { detectImageSupport, isDisplayablePng, tmuxPassthroughEnabled } from './images.js'
import { isInteractive, runInit } from './onboard.js'
import {
  addNote,
  loadAllNotes,
  loadNotes,
  type Note,
  notesFor,
  notesPath,
  removeNote,
  saveNotes,
} from './notes.js'
import { parseDirectories } from './parser.js'
import { resolveRef } from './refs.js'
import { summarizeDecks } from './queue.js'
import { defaultStatePath, loadState, saveState } from './state.js'
import {
  isMergeStrategy,
  mergeRecords,
  parseBundle,
  pruneToCards,
  toBundle,
  type MergeStrategy,
} from './transfer.js'
import type { Flashcard, ParseResult } from './types.js'

const USAGE = `Usage: leitner <command> [source-dir...] [options]

Commands:
  init [dir...]      Record where your flashcards live, then exit
  review [dir...]    Interactive terminal review session
  list [dir...]      Print decks and card counts
  cards [dir...]     Print every card's reference and title
  note <ref> [text]  Add a note to a card, or list the notes it has
  notes [dir...]     Print every note, orphaned ones included
  stats [dir...]     Print card/due/suspended counts and parse warnings
  export [dir...]    Write review state as a portable JSON bundle
  import <file>      Merge a review-state bundle into the local state

The first command that needs your flashcards asks where they are and writes
~/.config/leitner/config.json. Pass [dir...], or run "leitner init", to skip or redo that.

Several directories are read as one collection, in the order given, and the
arguments replace the configured ones rather than adding to them. They may not
contain one another. --deck matches a source path, so it also picks one of them.

Options:
  --add                   init: add the directories to the configured ones
  --deck <slug-or-path>   Only include decks matching slug or source path
  --type <type>           Only include cards whose frontmatter type is exactly this
  --untyped               Only include cards whose file declares no type
  --due                   Only due cards
  --new                   Only new (never reviewed) cards
  --limit <n>             Cap the review queue size (review: dailyLimit, default 50)
  --state <path>          Review state file (default: ~/.local/share/leitner/review-state.json)
  --images                Enable inline image previews (kitty graphics protocol)
  --out <path>            export: write here instead of stdout
  --prune                 export: drop records whose cards no longer exist
  --rm <n>                note: remove the card's note number n
  --orphans               notes: only notes whose card no longer exists
  --merge <strategy>      import: newer (default) | theirs | ours
  --dry-run               import: report what would change without writing
  -h, --help              Show this help

Review keys:
  space/enter reveal · 1-4 grade · j/k scroll · s suspend · u undo
  e edit in $EDITOR · / search · i image preview · q quit
  When a deck is finished, enter goes back to the deck picker.
`

export type Command =
  | 'init'
  | 'review'
  | 'list'
  | 'cards'
  | 'note'
  | 'notes'
  | 'stats'
  | 'export'
  | 'import'

export type CliOptions = {
  command: Command
  /** One collection, read in this order. Absolute, deduplicated, never nested. */
  sourceDirs: string[]
  /** Whether `sourceDirs` was chosen by the user; 'default' is what onboarding reacts to. */
  sourceDirOrigin: 'argument' | 'config' | 'default'
  statePath: string
  deck?: string
  /** Matched against the frontmatter `type` verbatim; the format defines no set. */
  type?: string
  /** Absence is not a value, so "declared nothing" gets a flag of its own. */
  untyped: boolean
  dueOnly: boolean
  newOnly: boolean
  limit?: number
  images: boolean
  out?: string
  prune: boolean
  merge: MergeStrategy
  dryRun: boolean
  /** `import` only: the bundle to read. */
  bundlePath?: string
  /** `note` only: the card reference to act on, and the note text when given. */
  cardRef?: string
  noteText?: string
  /** `note --rm`: which of that card's notes to drop, counting from 1. */
  removeAt?: number
  /** `notes --orphans`: only the notes whose reference resolves to no card. */
  orphansOnly: boolean
  /** `init` only: keep the configured directories and add to them. */
  add: boolean
  /** The config's `editor`, if it names one; `review` only. */
  editor?: string
  /** The config's `hiddenDecks`; the deck picker's list is what they narrow. */
  hiddenDecks: string[]
}

export async function parseCli(argv: string[]): Promise<CliOptions | null> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      deck: { type: 'string' },
      type: { type: 'string' },
      untyped: { type: 'boolean', default: false },
      due: { type: 'boolean', default: false },
      new: { type: 'boolean', default: false },
      limit: { type: 'string' },
      state: { type: 'string' },
      images: { type: 'boolean', default: false },
      add: { type: 'boolean', default: false },
      out: { type: 'string' },
      prune: { type: 'boolean', default: false },
      merge: { type: 'string' },
      rm: { type: 'string' },
      orphans: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  const command = positionals[0]
  if (values.help || command === undefined) {
    process.stdout.write(USAGE)
    return null
  }
  const commands = ['init', 'review', 'list', 'cards', 'note', 'notes', 'stats', 'export', 'import']
  if (!commands.includes(command)) {
    throw new Error(`unknown command: ${command}\n\n${USAGE}`)
  }
  // `type` is a user extension the format deliberately leaves undefined, so there is
  // no closed set to validate against here — only the file's own spelling.
  if (values.type !== undefined && values.untyped) {
    throw new Error('--type and --untyped select disjoint sets; pass one or the other')
  }
  if (values.merge !== undefined && !isMergeStrategy(values.merge)) {
    throw new Error(`invalid --merge: ${values.merge} (expected newer, theirs, or ours)`)
  }
  const limit = values.limit === undefined ? undefined : Number.parseInt(values.limit, 10)
  if (limit !== undefined && (Number.isNaN(limit) || limit < 0)) {
    throw new Error(`invalid --limit: ${values.limit}`)
  }
  if (command === 'import' && positionals[1] === undefined) {
    throw new Error('import needs a bundle path: leitner import <file>')
  }
  if (command === 'note' && positionals[1] === undefined) {
    throw new Error('note needs a card reference: leitner note <ref> [text]')
  }
  const removeAt = values.rm === undefined ? undefined : Number.parseInt(values.rm, 10)
  if (removeAt !== undefined && (Number.isNaN(removeAt) || removeAt < 1)) {
    throw new Error(`invalid --rm: ${values.rm} (a note number, counting from 1)`)
  }

  const file = await readConfigFile()
  const config = withDefaults(file)
  // `import` takes a bundle path and `note` a card reference, where the other
  // commands take source directories.
  const argumentDirs = command === 'import' || command === 'note' ? [] : positionals.slice(1)
  return {
    command: command as Command,
    sourceDirs: argumentDirs.length > 0 ? normalizeSourceDirs(argumentDirs) : config.sourceDirs,
    sourceDirOrigin:
      argumentDirs.length > 0 ? 'argument' : sourceDirsFrom(file).length > 0 ? 'config' : 'default',
    statePath: values.state ? expandHome(values.state) : defaultStatePath(),
    deck: values.deck ?? config.defaultDeckFilter ?? undefined,
    type: values.type,
    untyped: values.untyped,
    dueOnly: values.due,
    newOnly: values.new,
    limit: limit ?? (command === 'review' ? config.dailyLimit : undefined),
    images: values.images,
    out: values.out ? expandHome(values.out) : undefined,
    prune: values.prune,
    merge: (values.merge ?? 'newer') as MergeStrategy,
    dryRun: values['dry-run'],
    add: values.add,
    bundlePath: positionals[1] === undefined ? undefined : expandHome(positionals[1]),
    cardRef: command === 'note' ? positionals[1] : undefined,
    // Unquoted note text arrives as several positionals; a sentence is the usual case.
    noteText:
      command === 'note' && positionals.length > 2 ? positionals.slice(2).join(' ') : undefined,
    removeAt,
    orphansOnly: values.orphans,
    editor: config.editor ?? undefined,
    hiddenDecks: config.hiddenDecks,
  }
}

export function filterCards(
  cards: Flashcard[],
  options: Partial<Pick<CliOptions, 'deck' | 'type' | 'untyped'>>,
): Flashcard[] {
  return cards.filter((card) => {
    if (options.type !== undefined && card.type !== options.type) return false
    if (options.untyped && card.type !== undefined) return false
    if (options.deck && card.deckId !== options.deck && !card.sourcePath.includes(options.deck)) {
      return false
    }
    return true
  })
}

/** `expandHome` backwards, for a column whose width is its longest path. */
function contractHome(dir: string): string {
  const home = os.homedir()
  return dir === home || dir.startsWith(`${home}${path.sep}`) ? `~${dir.slice(home.length)}` : dir
}

function printWarnings(parsed: ParseResult): void {
  for (const warning of parsed.warnings) {
    // The code names the conformance rule; the message is ours to word.
    const code = warning.code === null ? '' : ` [${warning.code}]`
    process.stderr.write(`warning:${code} ${warning.sourcePath}: ${warning.message}\n`)
  }
}

export async function runList(options: CliOptions): Promise<void> {
  const parsed = await parseDirectories(options.sourceDirs)
  printWarnings(parsed)

  const cards = filterCards(parsed.cards, options)
  const counts = new Map<string, number>()
  for (const card of cards) {
    counts.set(card.sourcePath, (counts.get(card.sourcePath) ?? 0) + 1)
  }
  const decks = parsed.decks.filter((deck) => counts.has(deck.sourcePath))

  // A deck slug is only unique inside its own source directory, so the root
  // earns a column as soon as there is a second one to confuse it with. It is
  // written back with `~`, since a collection usually lives under home and the
  // column is as wide as its longest entry.
  const roots = options.sourceDirs.length > 1 ? options.sourceDirs.map(contractHome) : []
  const rootWidth = Math.max(4, ...roots.map((root) => root.length))
  const rootColumn = (root: string) => (roots.length === 0 ? '' : `${root.padEnd(rootWidth)}  `)

  const idWidth = Math.max(4, ...decks.map((d) => d.id.length))
  process.stdout.write(`${rootColumn('root')}${'deck'.padEnd(idWidth)}  cards  type        title\n`)
  for (const deck of decks) {
    const count = String(counts.get(deck.sourcePath) ?? 0).padStart(5)
    process.stdout.write(
      `${rootColumn(contractHome(deck.rootDir))}${deck.id.padEnd(idWidth)}  ${count}  ${(
        deck.type ?? '—'
      ).padEnd(10)}  ${deck.title}\n`,
    )
  }
  process.stdout.write(`\n${decks.length} decks, ${cards.length} cards\n`)
}

/**
 * One line per card: its reference and its title. Deck-level counts are `list`'s
 * job; this is the card-level listing, and it exists so a card can be named —
 * found here, pasted into a conversation, handed back as an argument.
 *
 * Deliberately reads no state file. Which cards are due is a scheduling question
 * and `stats` answers it; addressing a card is not.
 */
export async function runCards(options: CliOptions): Promise<void> {
  const parsed = await parseDirectories(options.sourceDirs)
  printWarnings(parsed)

  const cards = filterCards(parsed.cards, options)

  // Same reasoning as `list`: a reference is only unique inside its own source
  // directory, so the root earns a column as soon as there are two.
  const roots = options.sourceDirs.length > 1 ? options.sourceDirs.map(contractHome) : []
  const rootWidth = Math.max(4, ...roots.map((root) => root.length))
  const rootColumn = (root: string) => (roots.length === 0 ? '' : `${root.padEnd(rootWidth)}  `)

  const refWidth = Math.max(4, ...cards.map((card) => card.ref.length))
  process.stdout.write(`${rootColumn('root')}${'card'.padEnd(refWidth)}  title\n`)
  for (const card of cards) {
    process.stdout.write(
      `${rootColumn(contractHome(card.rootDir))}${card.ref.padEnd(refWidth)}  ${card.title}\n`,
    )
  }
  process.stdout.write(`\n${cards.length} cards\n`)
}

/** A card and its notes live in the same root; the pair is the lookup key. */
function noteKey(rootDir: string, ref: string): string {
  return `${rootDir}\u0000${ref}`
}

function candidateList(cards: Flashcard[]): string {
  return cards.map((card) => `  ${card.ref}  ${card.title}`).join('\n')
}

/**
 * Add a note to a card, list what it already has, or drop one by number.
 *
 * The card is named by reference, so this is where a reference stops being
 * something to read and becomes something to hand back. A reference that no
 * longer resolves is still addressable here — that is what makes removing an
 * orphaned note an explicit act rather than a cleanup nobody asked for.
 */
export async function runNote(options: CliOptions): Promise<void> {
  const query = (options.cardRef ?? '').trim()
  const parsed = await parseDirectories(options.sourceDirs)
  printWarnings(parsed)

  const resolved = resolveRef(parsed.cards, query)
  if (resolved.kind === 'ambiguous') {
    throw new Error(
      `${query} matches ${resolved.matches.length} cards:\n${candidateList(resolved.matches)}\n` +
        'Name one of them exactly.',
    )
  }

  let rootDir: string
  let ref: string
  let card: Flashcard | undefined
  if (resolved.kind === 'found') {
    card = resolved.card
    rootDir = card.rootDir
    ref = card.ref
  } else {
    // No card answers to it, but a sidecar still might: the card was renamed or
    // moved out from under notes that are still worth reading and removing.
    ref = query.toLowerCase()
    const files = await loadAllNotes(options.sourceDirs)
    const holding = [...files].filter(([, file]) => notesFor(file, ref).length > 0)
    const first = holding[0]
    if (first === undefined) {
      throw new Error(`no card matches ${query}; run "leitner cards" to see every reference`)
    }
    if (holding.length > 1) {
      throw new Error(
        `${query} is an orphaned note in ${holding.length} source directories:\n` +
          `${holding.map(([dir]) => `  ${dir}`).join('\n')}`,
      )
    }
    rootDir = first[0]
  }

  const file = await loadNotes(rootDir)
  const existing = notesFor(file, ref)

  if (options.removeAt !== undefined) {
    const doomed = existing[options.removeAt - 1]
    if (doomed === undefined) {
      throw new Error(
        `${ref} has ${existing.length} notes, so there is no note ${options.removeAt}`,
      )
    }
    await saveNotes(rootDir, removeNote(file, ref, options.removeAt - 1))
    process.stdout.write(`removed note ${options.removeAt} from ${ref}: ${doomed.text}\n`)
    return
  }

  if (options.noteText !== undefined) {
    if (card === undefined) {
      throw new Error(`${query} matches no card, so there is nothing to note it against`)
    }
    const note: Note = {
      text: options.noteText,
      createdAt: new Date().toISOString(),
      // As the card is now: what keeps the note readable once the reference breaks.
      cardTitle: card.title,
      sourcePath: path.relative(card.rootDir, card.sourcePath),
    }
    await saveNotes(rootDir, addNote(file, ref, note))
    process.stdout.write(`noted on ${ref}: ${note.text}\n`)
    // Which file it went into is not obvious once a collection has two roots.
    if (options.sourceDirs.length > 1) process.stdout.write(`wrote ${notesPath(rootDir)}\n`)
    return
  }

  if (existing.length === 0) {
    process.stdout.write(`${ref} has no notes\n`)
    return
  }
  process.stdout.write(`${ref}  ${card?.title ?? '(no card; orphaned notes)'}\n`)
  existing.forEach((note, index) => {
    process.stdout.write(`  ${index + 1}  ${note.createdAt.slice(0, 10)}  ${note.text}\n`)
  })
}

/**
 * Every note in the collection, orphans included and marked as such. A note
 * nobody can find is the failure this feature has to make visible, so an orphan
 * is listed rather than pruned, carrying the card as it was when it was written.
 */
export async function runNotes(options: CliOptions): Promise<void> {
  const parsed = await parseDirectories(options.sourceDirs)
  printWarnings(parsed)

  const live = new Map<string, Flashcard>()
  for (const card of parsed.cards) live.set(noteKey(card.rootDir, card.ref), card)
  const selected = new Set(
    filterCards(parsed.cards, options).map((card) => noteKey(card.rootDir, card.ref)),
  )
  // An orphan matches no card, so a filter over cards cannot include it.
  const narrowed = options.deck !== undefined || options.type !== undefined || options.untyped

  const files = await loadAllNotes(options.sourceDirs)
  const rows: { rootDir: string; ref: string; note: Note; position: number; orphan: boolean }[] = []
  for (const [rootDir, file] of files) {
    for (const ref of Object.keys(file.notes).sort()) {
      const key = noteKey(rootDir, ref)
      const orphan = !live.has(key)
      if (orphan ? narrowed : !selected.has(key)) continue
      if (options.orphansOnly && !orphan) continue
      notesFor(file, ref).forEach((note, index) => {
        rows.push({ rootDir, ref, note, position: index + 1, orphan })
      })
    }
  }

  const roots = options.sourceDirs.length > 1 ? options.sourceDirs.map(contractHome) : []
  const rootWidth = Math.max(4, ...roots.map((root) => root.length))
  const rootColumn = (root: string) => (roots.length === 0 ? '' : `${root.padEnd(rootWidth)}  `)
  const refWidth = Math.max(4, ...rows.map((row) => row.ref.length))

  process.stdout.write(`${rootColumn('root')}${'card'.padEnd(refWidth)}   n  note\n`)
  for (const row of rows) {
    const provenance = row.orphan
      ? ` — orphaned; was "${row.note.cardTitle}" in ${row.note.sourcePath}`
      : ''
    process.stdout.write(
      `${rootColumn(contractHome(row.rootDir))}${row.ref.padEnd(refWidth)}  ${String(
        row.position,
      ).padStart(2)}  ${row.note.text}${provenance}\n`,
    )
  }
  const orphaned = rows.filter((row) => row.orphan).length
  process.stdout.write(`\n${rows.length} notes, ${orphaned} orphaned\n`)
}

export async function runStats(options: CliOptions): Promise<void> {
  const parsed = await parseDirectories(options.sourceDirs)
  printWarnings(parsed)

  const cards = filterCards(parsed.cards, options)
  const state = await loadState(options.statePath)
  const summaries = summarizeDecks(cards, state)

  /* Unfiltered, like the warning count below: a note whose card the filter hid is
     still in the file, and the orphan count is the number this block exists for. */
  const live = new Set(parsed.cards.map((card) => noteKey(card.rootDir, card.ref)))
  let notes = 0
  let orphanedNotes = 0
  for (const [rootDir, file] of await loadAllNotes(options.sourceDirs)) {
    for (const [ref, list] of Object.entries(file.notes)) {
      notes += list.length
      if (!live.has(noteKey(rootDir, ref))) orphanedNotes += list.length
    }
  }

  let due = 0
  let fresh = 0
  let suspended = 0
  for (const summary of summaries.values()) {
    due += summary.due
    fresh += summary.fresh
    suspended += summary.suspended
  }

  options.sourceDirs.forEach((sourceDir, index) => {
    process.stdout.write(`${(index === 0 ? 'source:' : '').padEnd(17)}${sourceDir}\n`)
  })
  process.stdout.write(`state:           ${options.statePath}\n`)
  // Count the decks the filter left, the way `list` does. `parsed.decks` is
  // every deck on disk, so an unfiltered count next to a filtered card total
  // reads as "decks: 5, total cards: 1" under `--deck`.
  process.stdout.write(`decks:           ${summaries.size}\n`)
  process.stdout.write(`total cards:     ${cards.length}\n`)
  process.stdout.write(`due cards:       ${due}\n`)
  process.stdout.write(`new cards:       ${fresh}\n`)
  process.stdout.write(`suspended cards: ${suspended}\n`)
  process.stdout.write(`notes:           ${notes}\n`)
  process.stdout.write(`orphaned notes:  ${orphanedNotes}\n`)
  process.stdout.write(`parse warnings:  ${parsed.warnings.length}\n`)
}

export async function runExport(options: CliOptions): Promise<void> {
  let state = await loadState(options.statePath)
  let removed = 0

  if (options.prune) {
    const parsed = await parseDirectories(options.sourceDirs)
    const pruned = pruneToCards(
      state,
      parsed.cards.map((card) => card.id),
    )
    state = pruned.state
    removed = pruned.removed
  }

  const bundle = toBundle(state)
  const json = JSON.stringify(bundle, null, 2) + '\n'

  if (options.out === undefined) {
    process.stdout.write(json)
  } else {
    await fs.mkdir(path.dirname(options.out), { recursive: true })
    await fs.writeFile(options.out, json, 'utf8')
    process.stderr.write(`exported ${bundle.recordCount} records to ${options.out}\n`)
  }
  if (removed > 0) {
    process.stderr.write(`pruned ${removed} records with no matching card\n`)
  }
}

export async function runImport(options: CliOptions): Promise<void> {
  if (options.bundlePath === undefined) throw new Error('import needs a bundle path')

  let raw: string
  try {
    raw = await fs.readFile(options.bundlePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`no such bundle: ${options.bundlePath}`)
    }
    throw error
  }

  let incoming
  try {
    incoming = parseBundle(raw)
  } catch (error) {
    throw new Error(
      `${options.bundlePath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const current = await loadState(options.statePath)
  const result = mergeRecords(current, incoming, options.merge)

  process.stdout.write(`bundle:   ${options.bundlePath}\n`)
  process.stdout.write(`strategy: ${options.merge}\n`)
  process.stdout.write(`incoming: ${incoming.length} records\n`)
  process.stdout.write(`added:    ${result.added}\n`)
  process.stdout.write(`updated:  ${result.updated}\n`)
  process.stdout.write(`kept:     ${result.kept}\n`)

  if (options.dryRun) {
    process.stdout.write('dry run — state not written\n')
    return
  }
  await saveState(options.statePath, result.state)
  process.stdout.write(`wrote:    ${options.statePath}\n`)
}

export async function runReview(options: CliOptions): Promise<void> {
  const parsed = await parseDirectories(options.sourceDirs)
  printWarnings(parsed)

  // The deck filter is applied inside the TUI so the picker can still show
  // every deck; only the type filter narrows the card pool up front.
  const cards = filterCards(parsed.cards, { type: options.type, untyped: options.untyped })
  const state = await loadState(options.statePath)

  /* Cheap pre-check so `review` exits cleanly instead of opening a deck picker
     with nothing behind it. It asks about cards, not about the queue: a
     collection with nothing due still opens, because the picker offers a
     practice pass over any deck and refusing here is what would leave no way in. */
  if (cards.length === 0) {
    process.stdout.write('No cards found.\n')
    return
  }

  const support = detectImageSupport()
  const displayablePngs = new Set<string>()
  if (options.images) {
    if (!support.enabled) {
      process.stderr.write(`note: --images requested but ${support.reason}\n`)
    } else {
      if (support.tmux && (await tmuxPassthroughEnabled()) === false) {
        process.stderr.write(
          'note: tmux allow-passthrough is off, so image previews will not render.\n' +
            '      enable it with: tmux set -g allow-passthrough on\n',
        )
      }
      const candidates = new Set(cards.flatMap((card) => card.images.map((image) => image.path)))
      await Promise.all(
        [...candidates].map(async (imagePath) => {
          if (await isDisplayablePng(imagePath)) displayablePngs.add(imagePath)
        }),
      )
      /* §7: previews were asked for, so an image that cannot be displayed is a
         resolution failure and gets named. It still shows as an attachment line, so
         nothing is lost — but the reason it is not pixels would otherwise be silent. */
      for (const imagePath of candidates) {
        if (displayablePngs.has(imagePath)) continue
        process.stderr.write(
          `warning: [unresolved-image] ${imagePath}: not a displayable PNG; ` +
            'showing it as an attachment line instead\n',
        )
      }
    }
  }

  // Imported lazily so list/stats work in non-interactive environments.
  const { startReview } = await import('./tui/review.js')
  await startReview({
    cards,
    decks: parsed.decks,
    state,
    statePath: options.statePath,
    queueOptions: { dueOnly: options.dueOnly, newOnly: options.newOnly, limit: options.limit },
    deckFilter: options.deck,
    hiddenDecks: options.hiddenDecks,
    images: options.images
      ? support
      : { ...support, enabled: false, reason: 'pass --images to enable previews' },
    displayablePngs,
    editor: options.editor,
  })
}

/**
 * First run: nothing on disk says where the flashcards are, so ask before the
 * command runs rather than letting it work against a directory nobody chose.
 */
async function ensureSourceDirs(options: CliOptions): Promise<CliOptions> {
  // `import` reads a bundle and never touches the notes tree.
  if (options.sourceDirOrigin !== 'default' || options.command === 'import') return options
  if (!isInteractive()) {
    throw new Error(
      'no flashcard directory configured, and no terminal to ask on.\n' +
        `Pass one as an argument, or run: leitner init <dir>`,
    )
  }
  const config = await runInit()
  return { ...options, sourceDirs: config.sourceDirs, sourceDirOrigin: 'config' }
}

export async function main(argv: string[]): Promise<void> {
  const parsed = await parseCli(argv)
  if (!parsed) return
  if (parsed.command === 'init') {
    await runInit({
      ...(parsed.sourceDirOrigin === 'argument' ? { dirs: parsed.sourceDirs } : {}),
      add: parsed.add,
    })
    return
  }
  const options = await ensureSourceDirs(parsed)
  switch (options.command) {
    case 'list':
      return runList(options)
    case 'cards':
      return runCards(options)
    case 'note':
      return runNote(options)
    case 'notes':
      return runNotes(options)
    case 'stats':
      return runStats(options)
    case 'export':
      return runExport(options)
    case 'import':
      return runImport(options)
    case 'review':
      return runReview(options)
    case 'init':
      return
  }
}

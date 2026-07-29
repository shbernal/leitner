import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { expandHome, loadConfig } from './config.js'
import { detectImageSupport, isDisplayablePng, tmuxPassthroughEnabled } from './images.js'
import { parseDirectory } from './parser.js'
import { buildQueue, summarizeDecks } from './queue.js'
import { defaultStatePath, loadState, saveState } from './state.js'
import {
  isMergeStrategy,
  mergeRecords,
  parseBundle,
  pruneToCards,
  toBundle,
  type MergeStrategy,
} from './transfer.js'
import type { CardType, Flashcard, ParseResult } from './types.js'

const USAGE = `Usage: flashcards-tui <command> [source-dir] [options]

Commands:
  review [dir]     Interactive terminal review session
  list [dir]       Print decks and card counts
  stats [dir]      Print card/due/suspended counts and parse warnings
  export [dir]     Write review state as a portable JSON bundle
  import <file>    Merge a review-state bundle into the local state

Options:
  --deck <slug-or-path>   Only include decks matching slug or source path
  --type <type>           Only include content|film|vocabulary|unknown cards
  --due                   Only due cards
  --new                   Only new (never reviewed) cards
  --limit <n>             Cap the review queue size
  --state <path>          Review state file (default: ~/.local/share/flashcards-tui/review-state.json)
  --images                Enable inline image previews (kitty graphics protocol)
  --out <path>            export: write here instead of stdout
  --prune                 export: drop records whose cards no longer exist
  --merge <strategy>      import: newer (default) | theirs | ours
  --dry-run               import: report what would change without writing
  -h, --help              Show this help

Review keys:
  space/enter reveal · 1-4 grade · j/k scroll · s suspend · u undo
  / search · i image preview · q quit
`

export type Command = 'review' | 'list' | 'stats' | 'export' | 'import'

export type CliOptions = {
  command: Command
  sourceDir: string
  statePath: string
  deck?: string
  type?: CardType
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
}

export async function parseCli(argv: string[]): Promise<CliOptions | null> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      deck: { type: 'string' },
      type: { type: 'string' },
      due: { type: 'boolean', default: false },
      new: { type: 'boolean', default: false },
      limit: { type: 'string' },
      state: { type: 'string' },
      images: { type: 'boolean', default: false },
      out: { type: 'string' },
      prune: { type: 'boolean', default: false },
      merge: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  const command = positionals[0]
  if (values.help || command === undefined) {
    process.stdout.write(USAGE)
    return null
  }
  if (!['review', 'list', 'stats', 'export', 'import'].includes(command)) {
    throw new Error(`unknown command: ${command}\n\n${USAGE}`)
  }
  if (values.type && !['content', 'film', 'vocabulary', 'unknown'].includes(values.type)) {
    throw new Error(`invalid --type: ${values.type}`)
  }
  if (values.merge !== undefined && !isMergeStrategy(values.merge)) {
    throw new Error(`invalid --merge: ${values.merge} (expected newer, theirs, or ours)`)
  }
  const limit = values.limit === undefined ? undefined : Number.parseInt(values.limit, 10)
  if (limit !== undefined && (Number.isNaN(limit) || limit < 0)) {
    throw new Error(`invalid --limit: ${values.limit}`)
  }
  if (command === 'import' && positionals[1] === undefined) {
    throw new Error('import needs a bundle path: flashcards-tui import <file>')
  }

  const config = await loadConfig()
  return {
    command: command as Command,
    // `import` takes a bundle path where the other commands take a source dir.
    sourceDir: expandHome(command === 'import' ? config.sourceDir : (positionals[1] ?? config.sourceDir)),
    statePath: values.state ? expandHome(values.state) : defaultStatePath(),
    deck: values.deck ?? config.defaultDeckFilter ?? undefined,
    type: values.type as CardType | undefined,
    dueOnly: values.due,
    newOnly: values.new,
    limit: limit ?? (command === 'review' ? config.dailyLimit : undefined),
    images: values.images,
    out: values.out ? expandHome(values.out) : undefined,
    prune: values.prune,
    merge: (values.merge ?? 'newer') as MergeStrategy,
    dryRun: values['dry-run'],
    bundlePath: positionals[1] === undefined ? undefined : expandHome(positionals[1]),
  }
}

export function filterCards(cards: Flashcard[], options: Pick<CliOptions, 'deck' | 'type'>): Flashcard[] {
  return cards.filter((card) => {
    if (options.type && card.type !== options.type) return false
    if (options.deck && card.deckId !== options.deck && !card.sourcePath.includes(options.deck)) {
      return false
    }
    return true
  })
}

function printWarnings(parsed: ParseResult): void {
  for (const warning of parsed.warnings) {
    process.stderr.write(`warning: ${warning.sourcePath}: ${warning.message}\n`)
  }
}

export async function runList(options: CliOptions): Promise<void> {
  const parsed = await parseDirectory(options.sourceDir)
  printWarnings(parsed)

  const cards = filterCards(parsed.cards, options)
  const counts = new Map<string, number>()
  for (const card of cards) {
    counts.set(card.deckId, (counts.get(card.deckId) ?? 0) + 1)
  }
  const decks = parsed.decks.filter((deck) => counts.has(deck.id))

  const idWidth = Math.max(4, ...decks.map((d) => d.id.length))
  process.stdout.write(`${'deck'.padEnd(idWidth)}  cards  type        title\n`)
  for (const deck of decks) {
    const count = String(counts.get(deck.id) ?? 0).padStart(5)
    process.stdout.write(`${deck.id.padEnd(idWidth)}  ${count}  ${deck.type.padEnd(10)}  ${deck.title}\n`)
  }
  process.stdout.write(`\n${decks.length} decks, ${cards.length} cards\n`)
}

export async function runStats(options: CliOptions): Promise<void> {
  const parsed = await parseDirectory(options.sourceDir)
  printWarnings(parsed)

  const cards = filterCards(parsed.cards, options)
  const state = await loadState(options.statePath)
  const summaries = summarizeDecks(cards, state)

  let due = 0
  let fresh = 0
  let suspended = 0
  for (const summary of summaries.values()) {
    due += summary.due
    fresh += summary.fresh
    suspended += summary.suspended
  }

  process.stdout.write(`source:          ${options.sourceDir}\n`)
  process.stdout.write(`state:           ${options.statePath}\n`)
  process.stdout.write(`decks:           ${parsed.decks.length}\n`)
  process.stdout.write(`total cards:     ${cards.length}\n`)
  process.stdout.write(`due cards:       ${due}\n`)
  process.stdout.write(`new cards:       ${fresh}\n`)
  process.stdout.write(`suspended cards: ${suspended}\n`)
  process.stdout.write(`parse warnings:  ${parsed.warnings.length}\n`)
}

export async function runExport(options: CliOptions): Promise<void> {
  let state = await loadState(options.statePath)
  let removed = 0

  if (options.prune) {
    const parsed = await parseDirectory(options.sourceDir)
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
    throw new Error(`${options.bundlePath}: ${error instanceof Error ? error.message : String(error)}`)
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
  const parsed = await parseDirectory(options.sourceDir)
  printWarnings(parsed)

  // The deck filter is applied inside the TUI so the picker can still show
  // every deck; only the type filter narrows the card pool up front.
  const cards = filterCards(parsed.cards, { type: options.type })
  const state = await loadState(options.statePath)

  // Cheap pre-check so `review` exits cleanly on an exhausted collection
  // instead of opening a deck picker with nothing behind it.
  const anything = buildQueue(cards, state, { dueOnly: options.dueOnly, newOnly: options.newOnly })
  if (anything.length === 0) {
    process.stdout.write('No cards to review. 🎉\n')
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
    images: options.images ? support : { ...support, enabled: false, reason: 'pass --images to enable previews' },
    displayablePngs,
  })
}

export async function main(argv: string[]): Promise<void> {
  const options = await parseCli(argv)
  if (!options) return
  switch (options.command) {
    case 'list':
      return runList(options)
    case 'stats':
      return runStats(options)
    case 'export':
      return runExport(options)
    case 'import':
      return runImport(options)
    case 'review':
      return runReview(options)
  }
}

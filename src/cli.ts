import { parseArgs } from 'node:util'
import { expandHome, loadConfig } from './config.js'
import { parseDirectory } from './parser.js'
import { buildQueue } from './queue.js'
import { defaultStatePath, loadState } from './state.js'
import type { CardType, Flashcard, ParseResult } from './types.js'

const USAGE = `Usage: flashcards-tui <command> [source-dir] [options]

Commands:
  review [dir]   Interactive terminal review session
  list [dir]     Print decks and card counts
  stats [dir]    Print card/due/suspended counts and parse warnings

Options:
  --deck <slug-or-path>   Only include decks matching slug or source path
  --type <type>           Only include content|film|vocabulary|unknown cards
  --due                   Only due cards
  --new                   Only new (never reviewed) cards
  --limit <n>             Cap the review queue size
  --state <path>          Review state file (default: ~/.local/share/flashcards-tui/review-state.json)
  -h, --help              Show this help
`

export type CliOptions = {
  command: 'review' | 'list' | 'stats'
  sourceDir: string
  statePath: string
  deck?: string
  type?: CardType
  dueOnly: boolean
  newOnly: boolean
  limit?: number
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
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  const command = positionals[0]
  if (values.help || command === undefined) {
    process.stdout.write(USAGE)
    return null
  }
  if (command !== 'review' && command !== 'list' && command !== 'stats') {
    throw new Error(`unknown command: ${command}\n\n${USAGE}`)
  }
  if (values.type && !['content', 'film', 'vocabulary', 'unknown'].includes(values.type)) {
    throw new Error(`invalid --type: ${values.type}`)
  }
  const limit = values.limit === undefined ? undefined : Number.parseInt(values.limit, 10)
  if (limit !== undefined && (Number.isNaN(limit) || limit < 0)) {
    throw new Error(`invalid --limit: ${values.limit}`)
  }

  const config = await loadConfig()
  return {
    command,
    sourceDir: expandHome(positionals[1] ?? config.sourceDir),
    statePath: values.state ? expandHome(values.state) : defaultStatePath(),
    deck: values.deck,
    type: values.type as CardType | undefined,
    dueOnly: values.due,
    newOnly: values.new,
    limit: limit ?? (command === 'review' ? config.dailyLimit : undefined),
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
  const now = new Date()

  let due = 0
  let fresh = 0
  let suspended = 0
  for (const card of cards) {
    const record = state.records[card.id]
    if (!record) fresh++
    else if (record.suspended) suspended++
    else if (new Date(record.dueAt).getTime() <= now.getTime()) due++
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

export async function runReview(options: CliOptions): Promise<void> {
  const parsed = await parseDirectory(options.sourceDir)
  printWarnings(parsed)

  const cards = filterCards(parsed.cards, options)
  const state = await loadState(options.statePath)
  const queue = buildQueue(cards, state, {
    dueOnly: options.dueOnly,
    newOnly: options.newOnly,
    limit: options.limit,
  })

  if (queue.length === 0) {
    process.stdout.write('No cards to review. 🎉\n')
    return
  }

  // Imported lazily so list/stats work in non-interactive environments.
  const { startReview } = await import('./tui/review.js')
  await startReview({ queue, state, statePath: options.statePath })
}

export async function main(argv: string[]): Promise<void> {
  const options = await parseCli(argv)
  if (!options) return
  switch (options.command) {
    case 'list':
      return runList(options)
    case 'stats':
      return runStats(options)
    case 'review':
      return runReview(options)
  }
}

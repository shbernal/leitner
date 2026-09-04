import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  filterCards,
  parseCli,
  runExport,
  runImport,
  runCards,
  runList,
  runNote,
  runNotes,
  runStats,
  type CliOptions,
} from '../src/cli.js'
import { emptyNotes, loadNotes, notesPath } from '../src/notes.js'
import { parseDirectory } from '../src/parser.js'
import { loadState, saveState } from '../src/state.js'
import type { ReviewRecord } from '../src/types.js'

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

let dir: string
let stdout: string
let stderr: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leitner-cli-'))
  stdout = ''
  stderr = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk)
    return true
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(dir, { recursive: true, force: true })
})

function options(command: CliOptions['command'], extra: Partial<CliOptions> = {}): CliOptions {
  return {
    command,
    sourceDirs: [fixtures],
    sourceDirOrigin: 'argument',
    statePath: path.join(dir, 'review-state.json'),
    untyped: false,
    dueOnly: false,
    newOnly: false,
    images: false,
    prune: false,
    orphansOnly: false,
    merge: 'newer',
    hiddenDecks: [],
    dryRun: false,
    add: false,
    ...extra,
  }
}

function record(cardId: string, overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    cardId,
    sourcePath: `/notes/${cardId}.md`,
    sourceMtimeMs: 0,
    suspended: false,
    dueAt: '2026-08-01T00:00:00.000Z',
    intervalDays: 1,
    ease: 2.5,
    reps: 1,
    lapses: 0,
    ...overrides,
  }
}

describe('parseCli', () => {
  /* parseCli calls loadConfig() with no argument, so the only lever on the config it
     reads is where defaultConfigPath() looks. Point XDG_CONFIG_HOME at the temp dir
     rather than opening an injection point in production code for the tests' sake. */
  let previousXdg: string | undefined

  beforeEach(() => {
    previousXdg = process.env['XDG_CONFIG_HOME']
    process.env['XDG_CONFIG_HOME'] = dir
  })

  afterEach(() => {
    if (previousXdg === undefined) delete process.env['XDG_CONFIG_HOME']
    else process.env['XDG_CONFIG_HOME'] = previousXdg
  })

  async function writeConfig(config: Record<string, unknown>): Promise<void> {
    await fs.mkdir(path.join(dir, 'leitner'), { recursive: true })
    await fs.writeFile(path.join(dir, 'leitner', 'config.json'), JSON.stringify(config))
  }

  it('prints usage and parses nothing for --help', async () => {
    expect(await parseCli(['--help'])).toBeNull()
    expect(stdout).toContain('Usage: leitner')
  })

  it('prints usage when no command is given', async () => {
    expect(await parseCli([])).toBeNull()
    expect(stdout).toContain('Usage: leitner')
  })

  it('accepts the card listing as a command', async () => {
    await writeConfig({ sourceDirs: ['/decks'] })
    const parsed = await parseCli(['cards'])
    expect(parsed?.command).toBe('cards')
    expect(parsed?.sourceDirs).toEqual(['/decks'])
  })

  it('takes the positional after `note` as a card reference, not a directory', async () => {
    await writeConfig({ sourceDirs: ['/decks'] })
    const parsed = await parseCli(['note', 'spanish#hola', 'the', 'back', 'is', 'thin'])
    expect(parsed?.cardRef).toBe('spanish#hola')
    expect(parsed?.noteText).toBe('the back is thin')
    expect(parsed?.sourceDirs).toEqual(['/decks'])
  })

  it('requires a card reference for note', async () => {
    await expect(parseCli(['note'])).rejects.toThrow(/card reference/)
  })

  it('parses --rm and rejects a non-number or a position below one', async () => {
    expect((await parseCli(['note', 'a#b', '--rm', '2']))?.removeAt).toBe(2)
    await expect(parseCli(['note', 'a#b', '--rm', 'first'])).rejects.toThrow('invalid --rm')
    await expect(parseCli(['note', 'a#b', '--rm', '0'])).rejects.toThrow('invalid --rm')
  })

  it('rejects an unknown command', async () => {
    await expect(parseCli(['study'])).rejects.toThrow('unknown command: study')
  })

  it('rejects --type together with --untyped', async () => {
    await expect(parseCli(['list', '--type', 'film', '--untyped'])).rejects.toThrow(/disjoint/)
  })

  it('rejects an unknown --merge strategy', async () => {
    await expect(parseCli(['import', 'b.json', '--merge', 'mine'])).rejects.toThrow(
      'invalid --merge',
    )
  })

  it('accepts every documented --merge strategy', async () => {
    for (const merge of ['newer', 'theirs', 'ours']) {
      expect((await parseCli(['import', 'b.json', '--merge', merge]))?.merge).toBe(merge)
    }
  })

  it('parses --limit and rejects a non-number or a negative', async () => {
    expect((await parseCli(['review', '--limit', '7']))?.limit).toBe(7)
    await expect(parseCli(['review', '--limit', 'lots'])).rejects.toThrow('invalid --limit')
    await expect(parseCli(['review', '--limit=-1'])).rejects.toThrow('invalid --limit')
  })

  it('requires a bundle path for import', async () => {
    await expect(parseCli(['import'])).rejects.toThrow(/bundle path/)
  })

  it('falls back to dailyLimit for review only, and lets --limit win', async () => {
    await writeConfig({ dailyLimit: 12 })
    expect((await parseCli(['review']))?.limit).toBe(12)
    expect((await parseCli(['list']))?.limit).toBeUndefined()
    expect((await parseCli(['review', '--limit', '3']))?.limit).toBe(3)
  })

  it('takes sourceDirs and defaultDeckFilter from the config unless a flag overrides', async () => {
    await writeConfig({ sourceDirs: ['/decks'], defaultDeckFilter: 'vocabulary-words' })
    const fromConfig = await parseCli(['review'])
    expect(fromConfig?.sourceDirs).toEqual(['/decks'])
    expect(fromConfig?.sourceDirOrigin).toBe('config')
    expect(fromConfig?.deck).toBe('vocabulary-words')
    expect((await parseCli(['review', '--deck', 'other']))?.deck).toBe('other')
  })

  /* There is no flag for it: the deck picker is the only thing it narrows, so the
     way to study a hidden deck is `.` in the picker or `--deck` naming it. */
  it('carries hiddenDecks through from the config, defaulting to none', async () => {
    expect((await parseCli(['review']))?.hiddenDecks).toEqual([])
    await writeConfig({ hiddenDecks: ['scratch'] })
    expect((await parseCli(['review']))?.hiddenDecks).toEqual(['scratch'])
  })

  it('carries the configured editor through to the review session', async () => {
    await writeConfig({ editor: 'code --wait' })
    expect((await parseCli(['review']))?.editor).toBe('code --wait')
    expect((await parseCli(['list']))?.editor).toBe('code --wait')
  })

  it('reads every positional after the command as a source directory', async () => {
    const parsed = await parseCli(['list', '/decks', '/work/cards'])
    expect(parsed?.sourceDirs).toEqual(['/decks', '/work/cards'])
    expect(parsed?.sourceDirOrigin).toBe('argument')
  })

  it('replaces the configured directories rather than adding to them', async () => {
    await writeConfig({ sourceDirs: ['/decks', '/work/cards'] })
    expect((await parseCli(['list', '/elsewhere']))?.sourceDirs).toEqual(['/elsewhere'])
  })

  it('refuses source directories that contain one another', async () => {
    await expect(parseCli(['list', '/decks', '/decks/spanish'])).rejects.toThrow(
      'must not contain one another',
    )
  })

  // `import` spends its positional on the bundle, so there is none left to be a
  // source directory, and the configured ones are what any later read would use.
  it('keeps the bundle positional for import', async () => {
    await writeConfig({ sourceDirs: ['/decks'] })
    const parsed = await parseCli(['import', '/tmp/bundle.json'])
    expect(parsed?.bundlePath).toBe('/tmp/bundle.json')
    expect(parsed?.sourceDirs).toEqual(['/decks'])
  })

  it('reports a config with no directories as unconfigured, so onboarding fires', async () => {
    await writeConfig({ dailyLimit: 7 })
    expect((await parseCli(['list']))?.sourceDirOrigin).toBe('default')
  })
})

describe('list command', () => {
  it('prints decks with card counts and warnings on stderr', async () => {
    await runList(options('list'))
    expect(stdout).toContain('with-frontmatter')
    expect(stdout).toContain('Sample Deck')
    expect(stdout).toContain('5 decks, 8 cards')
    expect(stderr).toContain('empty.md')
    expect(stderr).toContain('no-cards.md')
  })

  it('filters by deck', async () => {
    await runList(options('list', { deck: 'vocabulary-words' }))
    expect(stdout).toContain('1 decks, 1 cards')
  })

  it('names the root of every deck once a second one is in play', async () => {
    const other = path.join(dir, 'work')
    await fs.mkdir(other, { recursive: true })
    await fs.writeFile(path.join(other, 'spanish.md'), '# Spanish\n\n## Hola\n\n***\n\nhi\n')

    await runList(options('list', { sourceDirs: [fixtures, other] }))
    expect(stdout).toContain('root')
    expect(stdout).toContain(other)
    expect(stdout).toContain('6 decks, 9 cards')
  })

  // The column would be noise when there is nothing to disambiguate against.
  it('leaves the root out with a single source directory', async () => {
    await runList(options('list'))
    expect(stdout).not.toContain(fixtures)
  })
})

describe('cards command', () => {
  it('prints one line per card, with the reference a card is addressed by', async () => {
    await runCards(options('cards'))
    expect(stdout).toContain('vocabulary-words#coax')
    expect(stdout).toContain('coax')
    expect(stdout).toContain('8 cards')
    expect(stderr).toContain('empty.md')
  })

  it('filters by deck', async () => {
    await runCards(options('cards', { deck: 'vocabulary-words' }))
    expect(stdout).toContain('vocabulary-words#coax')
    expect(stdout).not.toContain('with-frontmatter#first-card')
    expect(stdout).toContain('1 cards')
  })

  it('names the root of every card once a second source directory is in play', async () => {
    const other = path.join(dir, 'work')
    await fs.mkdir(other, { recursive: true })
    await fs.writeFile(path.join(other, 'spanish.md'), '# Spanish\n\n## Hola\n\n***\n\nhi\n')

    await runCards(options('cards', { sourceDirs: [fixtures, other] }))
    expect(stdout).toContain('spanish#hola')
    expect(stdout).toContain(other)
    expect(stdout).toContain('9 cards')
  })
})

describe('note command', () => {
  /* A note is written into the root the card came from, so these run against a
     temp deck: `tests/fixtures` is checked in and would gain a sidecar. */
  async function writeDeck(...headings: string[]): Promise<string> {
    const root = path.join(dir, 'notes')
    await fs.mkdir(root, { recursive: true })
    const body = headings.map((heading) => `## ${heading}\n\n***\n\nfact\n`).join('\n')
    await fs.writeFile(path.join(root, 'spanish.md'), `# Spanish\n\n${body}`)
    return root
  }

  function noteOptions(root: string, extra: Partial<CliOptions> = {}): CliOptions {
    return options('note', { sourceDirs: [root], ...extra })
  }

  it('adds a note to a card named by reference, and reads it back', async () => {
    const root = await writeDeck('Ser vs estar')
    await runNote(noteOptions(root, { cardRef: 'spanish#ser-vs-estar', noteText: 'two rules' }))
    expect(stdout).toContain('noted on spanish#ser-vs-estar')

    const file = await loadNotes(root)
    expect(file.notes['spanish#ser-vs-estar']?.[0]?.text).toBe('two rules')
    // Denormalized so the note stays readable once its reference stops resolving.
    expect(file.notes['spanish#ser-vs-estar']?.[0]?.cardTitle).toBe('Ser vs estar')
    expect(file.notes['spanish#ser-vs-estar']?.[0]?.sourcePath).toBe('spanish.md')

    stdout = ''
    await runNote(noteOptions(root, { cardRef: 'spanish#ser-vs-estar' }))
    expect(stdout).toContain('1  ')
    expect(stdout).toContain('two rules')
  })

  it('resolves a prefix, so the whole heading need not be typed', async () => {
    const root = await writeDeck('Ser vs estar')
    await runNote(noteOptions(root, { cardRef: 'spanish#ser', noteText: 'short form' }))

    const file = await loadNotes(root)
    // Filed under the card's full reference, not under what was typed.
    expect(Object.keys(file.notes)).toEqual(['spanish#ser-vs-estar'])
  })

  it('removes a note by its number', async () => {
    const root = await writeDeck('Ser vs estar')
    await runNote(noteOptions(root, { cardRef: 'spanish#ser-vs-estar', noteText: 'first' }))
    await runNote(noteOptions(root, { cardRef: 'spanish#ser-vs-estar', noteText: 'second' }))
    await runNote(noteOptions(root, { cardRef: 'spanish#ser-vs-estar', removeAt: 1 }))

    const file = await loadNotes(root)
    expect(file.notes['spanish#ser-vs-estar']?.map((note) => note.text)).toEqual(['second'])
  })

  it('refuses a number no note has, saying how many there are', async () => {
    const root = await writeDeck('Ser vs estar')
    await runNote(noteOptions(root, { cardRef: 'spanish#ser-vs-estar', noteText: 'only' }))
    await expect(
      runNote(noteOptions(root, { cardRef: 'spanish#ser-vs-estar', removeAt: 4 })),
    ).rejects.toThrow('no note 4')
  })

  it('names the candidates for an ambiguous reference, and writes nothing', async () => {
    const root = await writeDeck('Ser vs estar', 'Ser conjugation')
    await expect(
      runNote(noteOptions(root, { cardRef: 'spanish#ser', noteText: 'which one?' })),
    ).rejects.toThrow('spanish#ser-vs-estar')
    expect(await loadNotes(root)).toEqual(emptyNotes())
  })

  it('refuses a reference that matches nothing, pointing at the card listing', async () => {
    const root = await writeDeck('Ser vs estar')
    await expect(
      runNote(noteOptions(root, { cardRef: 'spanish#haber', noteText: 'nowhere' })),
    ).rejects.toThrow('leitner cards')
    expect(await loadNotes(root)).toEqual(emptyNotes())
  })

  /* An orphaned reference resolves to no card, but its notes are still worth
     reading and removing — which is the only way an orphan ever goes away. */
  it('still lists and removes the notes of a reference whose card is gone', async () => {
    const root = await writeDeck('Ser vs estar')
    await runNote(noteOptions(root, { cardRef: 'spanish#ser-vs-estar', noteText: 'stranded' }))
    await fs.writeFile(path.join(root, 'spanish.md'), '# Spanish\n\n## Estar\n\n***\n\nfact\n')

    await runNote(noteOptions(root, { cardRef: 'spanish#ser-vs-estar' }))
    expect(stdout).toContain('stranded')

    await runNote(noteOptions(root, { cardRef: 'spanish#ser-vs-estar', removeAt: 1 }))
    expect(await loadNotes(root)).toEqual(emptyNotes())
  })

  it('refuses to file a new note against a reference that matches no card', async () => {
    const root = await writeDeck('Ser vs estar')
    await expect(
      runNote(noteOptions(root, { cardRef: 'spanish#gone', noteText: 'orphan by birth' })),
    ).rejects.toThrow(/matches/)
  })
})

describe('notes command', () => {
  async function withOrphan(): Promise<string> {
    const root = path.join(dir, 'notes')
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, 'spanish.md'), '# Spanish\n\n## Hola\n\n***\n\nhi\n')
    await fs.writeFile(
      notesPath(root),
      JSON.stringify({
        version: 1,
        notes: {
          'spanish#hola': [
            {
              text: 'too easy',
              createdAt: '2026-09-01T00:00:00.000Z',
              cardTitle: 'Hola',
              sourcePath: 'spanish.md',
            },
          ],
          'spanish#adios': [
            {
              text: 'left behind',
              createdAt: '2026-09-02T00:00:00.000Z',
              cardTitle: 'Adios',
              sourcePath: 'spanish.md',
            },
          ],
        },
      }),
    )
    return root
  }

  it('lists every note, marking the ones whose card is gone', async () => {
    const root = await withOrphan()
    await runNotes(options('notes', { sourceDirs: [root] }))
    expect(stdout).toContain('too easy')
    expect(stdout).toContain('left behind')
    expect(stdout).toContain('orphaned; was "Adios" in spanish.md')
    expect(stdout).toContain('2 notes, 1 orphaned')
  })

  it('narrows to the orphans on request', async () => {
    const root = await withOrphan()
    await runNotes(options('notes', { sourceDirs: [root], orphansOnly: true }))
    expect(stdout).toContain('left behind')
    expect(stdout).not.toContain('too easy')
    expect(stdout).toContain('1 notes, 1 orphaned')
  })

  // An orphan belongs to no card, so a filter over cards has nothing to match it on.
  it('drops orphans when a card filter is in play', async () => {
    const root = await withOrphan()
    await runNotes(options('notes', { sourceDirs: [root], deck: 'spanish' }))
    expect(stdout).toContain('too easy')
    expect(stdout).toContain('1 notes, 0 orphaned')
  })
})

describe('stats command', () => {
  it('reports totals, due/new/suspended counts and warning count', async () => {
    await runStats(options('stats'))
    expect(stdout).toContain('decks:           5')
    expect(stdout).toContain('total cards:     8')
    expect(stdout).toContain('new cards:       8')
    expect(stdout).toContain('due cards:       0')
    expect(stdout).toContain('suspended cards: 0')
    expect(stdout).toContain('parse warnings:  3')
    expect(stdout).toContain('notes:           0')
    expect(stdout).toContain('orphaned notes:  0')
  })

  // The count nobody can get to by reading the file: a note pointing at no card.
  it('counts notes and the orphans among them', async () => {
    const root = path.join(dir, 'notes')
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, 'spanish.md'), '# Spanish\n\n## Hola\n\n***\n\nhi\n')
    await runNote(
      options('note', { sourceDirs: [root], cardRef: 'spanish#hola', noteText: 'too easy' }),
    )
    await fs.writeFile(path.join(root, 'spanish.md'), '# Spanish\n\n## Adios\n\n***\n\nbye\n')

    await runStats(options('stats', { sourceDirs: [root] }))
    expect(stdout).toContain('notes:           1')
    expect(stdout).toContain('orphaned notes:  1')
  })

  it('lists every source directory', async () => {
    const other = path.join(dir, 'work')
    await fs.mkdir(other, { recursive: true })

    await runStats(options('stats', { sourceDirs: [fixtures, other] }))
    expect(stdout).toContain(`source:          ${fixtures}`)
    expect(stdout).toContain(`                 ${other}`)
  })

  it('counts the decks the filter left, not every deck on disk', async () => {
    await runStats(options('stats', { deck: 'vocabulary-words' }))
    expect(stdout).toContain('decks:           1')
    expect(stdout).toContain('total cards:     1')
  })
})

describe('export command', () => {
  it('writes a bundle to stdout by default', async () => {
    const statePath = path.join(dir, 'review-state.json')
    await saveState(statePath, { version: 1, records: { a: record('a') } })

    await runExport(options('export', { statePath }))
    const bundle = JSON.parse(stdout) as { recordCount: number; records: ReviewRecord[] }
    expect(bundle.recordCount).toBe(1)
    expect(bundle.records[0]?.cardId).toBe('a')
  })

  it('writes to --out and reports on stderr', async () => {
    const statePath = path.join(dir, 'review-state.json')
    const out = path.join(dir, 'nested', 'bundle.json')
    await saveState(statePath, { version: 1, records: { a: record('a') } })

    await runExport(options('export', { statePath, out }))
    expect(stdout).toBe('')
    expect(stderr).toContain('exported 1 records')
    expect(JSON.parse(await fs.readFile(out, 'utf8')).recordCount).toBe(1)
  })

  it('prunes records with no matching card', async () => {
    const statePath = path.join(dir, 'review-state.json')
    await saveState(statePath, { version: 1, records: { ghost: record('ghost') } })

    await runExport(options('export', { statePath, prune: true }))
    expect(JSON.parse(stdout).recordCount).toBe(0)
    expect(stderr).toContain('pruned 1 records')
  })
})

describe('import command', () => {
  it('merges a bundle into local state', async () => {
    const statePath = path.join(dir, 'review-state.json')
    const bundlePath = path.join(dir, 'bundle.json')
    await saveState(statePath, { version: 1, records: { a: record('a', { reps: 1 }) } })
    await fs.writeFile(
      bundlePath,
      JSON.stringify({
        version: 1,
        records: [
          record('a', { reps: 9, lastReviewedAt: '2027-01-01T00:00:00.000Z' }),
          record('b'),
        ],
      }),
    )

    await runImport(options('import', { statePath, bundlePath }))
    expect(stdout).toContain('added:    1')
    expect(stdout).toContain('updated:  1')

    const merged = await loadState(statePath)
    expect(merged.records['a']?.reps).toBe(9)
    expect(merged.records['b']).toBeDefined()
  })

  it('leaves state untouched on --dry-run', async () => {
    const statePath = path.join(dir, 'review-state.json')
    const bundlePath = path.join(dir, 'bundle.json')
    await saveState(statePath, { version: 1, records: {} })
    await fs.writeFile(bundlePath, JSON.stringify({ version: 1, records: [record('a')] }))

    await runImport(options('import', { statePath, bundlePath, dryRun: true }))
    expect(stdout).toContain('dry run')
    expect(Object.keys((await loadState(statePath)).records)).toHaveLength(0)
  })

  it('reports a missing or malformed bundle by path', async () => {
    const statePath = path.join(dir, 'review-state.json')
    const missing = path.join(dir, 'nope.json')
    await expect(runImport(options('import', { statePath, bundlePath: missing }))).rejects.toThrow(
      /no such bundle/,
    )

    const bad = path.join(dir, 'bad.json')
    await fs.writeFile(bad, '{"records":[{"cardId":"a"}]}')
    await expect(runImport(options('import', { statePath, bundlePath: bad }))).rejects.toThrow(
      /missing required fields/,
    )
  })
})

describe('filterCards', () => {
  it('filters by type', async () => {
    const parsed = await parseDirectory(fixtures)
    const vocab = filterCards(parsed.cards, { type: 'vocabulary' })
    expect(vocab).toHaveLength(1)
    expect(vocab[0]?.title).toBe('coax')
  })

  it('filters an unrecognized type the same way, since the format defines no set', async () => {
    const parsed = await parseDirectory(fixtures)
    expect(filterCards(parsed.cards, { type: 'grammar' })).toHaveLength(2)
  })

  it('selects files that declared no type with --untyped, not with a magic value', async () => {
    const parsed = await parseDirectory(fixtures)
    const untyped = filterCards(parsed.cards, { untyped: true })
    expect(untyped.map((card) => card.deckId)).toEqual(['no-frontmatter', 'no-frontmatter'])
  })
})

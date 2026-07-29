import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { filterCards, runExport, runImport, runList, runStats, type CliOptions } from '../src/cli.js'
import { parseDirectory } from '../src/parser.js'
import { loadState, saveState } from '../src/state.js'
import type { ReviewRecord } from '../src/types.js'

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

let dir: string
let stdout: string
let stderr: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flashcards-tui-cli-'))
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
    sourceDir: fixtures,
    statePath: path.join(dir, 'review-state.json'),
    dueOnly: false,
    newOnly: false,
    images: false,
    prune: false,
    merge: 'newer',
    dryRun: false,
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

describe('list command', () => {
  it('prints decks with card counts and warnings on stderr', async () => {
    await runList(options('list'))
    expect(stdout).toContain('with-frontmatter')
    expect(stdout).toContain('Sample Deck')
    expect(stdout).toContain('4 decks, 6 cards')
    expect(stderr).toContain('empty.md')
    expect(stderr).toContain('no-cards.md')
  })

  it('filters by deck', async () => {
    await runList(options('list', { deck: 'vocabulary-words' }))
    expect(stdout).toContain('1 decks, 1 cards')
  })
})

describe('stats command', () => {
  it('reports totals, due/new/suspended counts and warning count', async () => {
    await runStats(options('stats'))
    expect(stdout).toContain('total cards:     6')
    expect(stdout).toContain('new cards:       6')
    expect(stdout).toContain('due cards:       0')
    expect(stdout).toContain('suspended cards: 0')
    expect(stdout).toContain('parse warnings:  2')
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
      JSON.stringify({ version: 1, records: [record('a', { reps: 9, lastReviewedAt: '2027-01-01T00:00:00.000Z' }), record('b')] }),
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
    await expect(runImport(options('import', { statePath, bundlePath: missing }))).rejects.toThrow(/no such bundle/)

    const bad = path.join(dir, 'bad.json')
    await fs.writeFile(bad, '{"records":[{"cardId":"a"}]}')
    await expect(runImport(options('import', { statePath, bundlePath: bad }))).rejects.toThrow(/missing required fields/)
  })
})

describe('filterCards', () => {
  it('filters by type', async () => {
    const parsed = await parseDirectory(fixtures)
    const vocab = filterCards(parsed.cards, { type: 'vocabulary' })
    expect(vocab).toHaveLength(1)
    expect(vocab[0]?.title).toBe('coax')
  })
})

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { filterCards, runList, runStats, type CliOptions } from '../src/cli.js'
import { parseDirectory } from '../src/parser.js'

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

let dir: string
let stdout: string
let stderr: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flashcard-tui-cli-'))
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
    ...extra,
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

describe('filterCards', () => {
  it('filters by type', async () => {
    const parsed = await parseDirectory(fixtures)
    const vocab = filterCards(parsed.cards, { type: 'vocabulary' })
    expect(vocab).toHaveLength(1)
    expect(vocab[0]?.title).toBe('coax')
  })
})

import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDeck } from '../src/deck.js'
import type { DiagnosticCode } from '../src/diagnostics.js'
import { parseFile } from '../src/parser.js'

/*
 * The Flashcard Markdown conformance corpus, run as this project's own suite.
 * `flashcards-tui` conforms as a **consumer** (§3.1): it MUST parse anything canonical
 * or valid correctly, and it MUST NOT refuse a file because one card in it is
 * malformed.
 *
 * The corpus asserts verbatim source slices rather than an AST, which is what lets a
 * line scanner, this mdast pipeline and an HTML emitter all check themselves against
 * one thing. The adapter below is the whole of the mapping — `parseDeck` was given the
 * corpus's field names deliberately — and nothing in the TUI knows the corpus exists.
 */

const require = createRequire(import.meta.url)
const FIXTURES = path.dirname(require.resolve('@shbernal/flashcard-md-spec/manifest.json'))

/** The spec version this suite conforms to, pinned rather than tracked. */
const SPEC_VERSION = '1.0'

type ManifestCase = {
  id: string
  tier: 'canonical' | 'valid' | 'invalid'
  description: string
  diagnostics: DiagnosticCode[]
}

type ExpectedDiagnostic = {
  code: DiagnosticCode
  cardIndex: number | null
}

type Expected = {
  deck: unknown
  cards: unknown[]
  diagnostics: ExpectedDiagnostic[]
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T
}

const manifest = await readJson<{ specVersion: string; cases: ManifestCase[] }>(
  path.join(FIXTURES, 'manifest.json'),
)

function byCode(a: ExpectedDiagnostic, b: ExpectedDiagnostic): number {
  return a.code.localeCompare(b.code) || (a.cardIndex ?? -1) - (b.cardIndex ?? -1)
}

/** The test-only adapter from this project's model to the corpus shape. */
function adapt(source: string) {
  const parsed = parseDeck(source)
  return {
    deck: {
      title: parsed.title,
      titleSource: parsed.titleSource,
      frontmatter: parsed.frontmatter,
      fileTags: parsed.fileTags,
      preamble: parsed.preamble,
    },
    cards: parsed.cards.map(({ headingText, frontBody, back, cardTags, tags, images }) => ({
      headingText,
      frontBody,
      back,
      cardTags,
      tags,
      images,
    })),
    diagnostics: parsed.diagnostics
      .map(({ code, cardIndex }) => ({ code, cardIndex }))
      .sort(byCode),
  }
}

/*
 * `unresolved-image` is the one code in the corpus that no parse can raise: whether an
 * image resolves is a fact about the filesystem, not about the markdown. It is asserted
 * below against a real read instead, and held out here — otherwise this loop would be
 * demanding a diagnostic from a function that cannot know.
 */
const PARSE_CANNOT_RAISE: DiagnosticCode[] = ['unresolved-image']

describe('Flashcard Markdown conformance corpus', () => {
  it('pins the spec version rather than tracking whatever is installed', () => {
    expect(manifest.specVersion).toBe(SPEC_VERSION)
  })

  it('runs every case in the manifest', () => {
    expect(manifest.cases.length).toBeGreaterThan(0)
  })

  for (const testCase of manifest.cases) {
    it(`${testCase.id} — ${testCase.description}`, async () => {
      const dir = path.join(FIXTURES, testCase.id)
      const input = await fs.readFile(path.join(dir, 'input.md'), 'utf8')
      const expected = await readJson<Expected>(path.join(dir, 'expected.json'))

      const actual = adapt(input)

      expect(actual.deck).toEqual(expected.deck)
      expect(actual.cards).toEqual(expected.cards)
      expect(actual.diagnostics).toEqual(
        expected.diagnostics.filter(({ code }) => !PARSE_CANNOT_RAISE.includes(code)).sort(byCode),
      )
    })
  }
})

describe('consumer obligations the corpus states but cannot assert', () => {
  /* §3.1: a consumer MUST NOT refuse a file because one card is malformed. Every
     invalid case is a file with something wrong in it, and every one still has to come
     back with the cards around the damage. */
  for (const testCase of manifest.cases.filter(({ tier }) => tier === 'invalid')) {
    it(`${testCase.id} still loads`, async () => {
      const input = await fs.readFile(path.join(FIXTURES, testCase.id, 'input.md'), 'utf8')

      expect(() => parseDeck(input)).not.toThrow()
      expect(parseDeck(input).cards.length).toBeGreaterThan(0)
    })
  }

  /* §7, asserted through a real read because resolution is I/O. The fixture's image
     does not exist beside it, and the card must survive anyway. */
  it('invalid/unresolved-image reports the image and keeps the card', async () => {
    const dir = path.join(FIXTURES, 'invalid/unresolved-image')
    const result = await parseFile(path.join(dir, 'input.md'), dir)

    expect(result.cards).toHaveLength(1)
    expect(result.cards[0]?.back).toContain('mercator.png')
    expect(result.warnings.map(({ code, cardIndex }) => ({ code, cardIndex }))).toEqual([
      { code: 'unresolved-image', cardIndex: 0 },
    ])
  })
})

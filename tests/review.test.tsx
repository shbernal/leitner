import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorRunner } from '../src/editor.js'
import { buildKittyClearSequence, buildKittyImageSequence } from '../src/images.js'
import { parseFile } from '../src/parser.js'
import { emptyState, type ReviewState } from '../src/state.js'
import { ReviewApp } from '../src/tui/review.js'
import type { Flashcard, ReviewRecord } from '../src/types.js'
import { KEY, renderTui, type TuiHarness } from './helpers/tui.js'

function makeCard(id: string, title: string, body: string): Flashcard {
  return {
    id,
    deckId: 'algebra',
    deckTitle: 'Algebra',
    sourcePath: '/notes/algebra.md',
    rootDir: '/notes',
    sourceMtimeMs: 0,
    sourceLine: 1,
    type: 'content',
    title,
    frontBody: '',
    back: body,
    plainText: body,
    images: [],
    cardTags: [],
    tags: [],
  }
}

const cards = [
  makeCard('a', 'What is a group?', 'A set with an associative operation.'),
  makeCard('b', 'What is a ring?', 'A group with a second operation.'),
]

let dir: string
let statePath: string
let state: ReviewState
let ui: TuiHarness | undefined

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leitner-review-'))
  statePath = path.join(dir, 'state.json')
  state = emptyState()
})

afterEach(async () => {
  ui?.unmount()
  ui = undefined
  await fs.rm(dir, { recursive: true, force: true })
})

/**
 * The review state as it reached disk.
 *
 * `persist` in review.tsx fires `saveState` without awaiting it, so a keypress never
 * blocks on I/O — which means the frame can already show the result while the file
 * is still unwritten. Reading it once therefore races the write, so every assertion
 * about the file polls instead. CI caught this as a flake on the rename test; the
 * 30ms each `press` spends was enough to hide it locally.
 */
function writtenState(check: (written: ReviewState) => void) {
  return vi.waitFor(
    async () => {
      check(JSON.parse(await fs.readFile(statePath, 'utf8')) as ReviewState)
    },
    { timeout: 2000, interval: 20 },
  )
}

type Overrides = Partial<React.ComponentProps<typeof ReviewApp>>

async function open(size?: { columns?: number; rows?: number }, overrides: Overrides = {}) {
  ui = await renderTui(
    <ReviewApp
      cards={cards}
      decks={[]}
      state={state}
      statePath={statePath}
      rootDir="/notes"
      queueOptions={{}}
      deckFilter="algebra"
      images={{ enabled: false, tmux: false, reason: 'not a kitty terminal' }}
      displayablePngs={new Set()}
      {...overrides}
    />,
    size,
  )
  return ui
}

const PNG = '/notes/attachments/diagram.png'

/** Same deck, but the first card carries a previewable PNG. */
function openWithImage(tmux = false) {
  const withImage: Flashcard = {
    ...makeCard('a', 'What is a group?', 'A set with an associative operation.'),
    images: [{ alt: 'Cayley table', src: PNG, path: PNG }],
  }
  return open(undefined, {
    cards: [withImage, cards[1] as Flashcard],
    images: { enabled: true, tmux, reason: '' },
    displayablePngs: new Set([PNG]),
  })
}

describe('ReviewApp', () => {
  it('opens on the first card with the answer hidden', async () => {
    const ui = await open()
    const frame = ui.frame()
    expect(frame).toContain('Algebra')
    expect(frame).toContain('card 1/2')
    expect(frame).toContain('2 new')
    expect(frame).toContain('What is a group?')
    expect(frame).toContain('[press space or enter to reveal]')
    expect(frame).not.toContain('associative')
  })

  it('reveals the body on space and offers the grade keys', async () => {
    const ui = await open()
    await ui.press(KEY.space)
    const frame = ui.frame()
    expect(frame).toContain('A set with an associative operation.')
    expect(frame).toContain('grade: 1 again · 2 hard · 3 good · 4 easy')
  })

  it('shows front content below the heading, and still holds the back back', async () => {
    // The front is the `##` heading plus everything above the `***`, so a card can
    // ask its question in more than a heading. Showing the back with it would defeat
    // the session.
    const rich: Flashcard = {
      ...(cards[0] as Flashcard),
      frontBody: 'Give the definition, then an example.',
    }
    const ui = await open(undefined, { cards: [rich] })

    expect(ui.frame()).toContain('Give the definition, then an example.')
    expect(ui.frame()).not.toContain('associative')

    await ui.press(KEY.space)
    const frame = ui.frame()
    expect(frame).toContain('Give the definition, then an example.')
    expect(frame).toContain('A set with an associative operation.')
  })

  it('ignores grade keys until the card is revealed', async () => {
    const ui = await open()
    await ui.press('3')
    expect(ui.frame()).toContain('card 1/2')
    expect(state.records['a']).toBeUndefined()
  })

  it('grades the revealed card, records it and advances', async () => {
    const ui = await open()
    await ui.press(KEY.space)
    await ui.press('3')

    const frame = ui.frame()
    expect(frame).toContain('card 2/2')
    expect(frame).toContain('graded "What is a group?": good')
    expect(frame).toContain('[press space or enter to reveal]')

    const record = state.records['a']
    expect(record).toBeDefined()
    expect(record?.reps).toBe(1)
    expect(record?.ease).toBe(2.5)
  })

  it('persists graded cards to the state file', async () => {
    const ui = await open()
    await ui.press(KEY.space)
    await ui.press('3')
    await ui.press(KEY.space)
    await ui.press('2')

    await writtenState((written) => {
      expect(Object.keys(written.records).sort()).toEqual(['a', 'b'])
      expect(written.records['a']?.ease).toBe(2.5)
      expect(written.records['b']?.ease).toBe(2.35)
    })
  })

  it('ends the session after the last card', async () => {
    const ui = await open()
    for (let i = 0; i < cards.length; i++) {
      await ui.press(KEY.space)
      await ui.press('3')
    }
    expect(ui.frame()).toContain('Session complete — 2 cards reviewed.')
  })

  it('undoes the last grade and restores the card', async () => {
    const ui = await open()
    await ui.press(KEY.space)
    await ui.press('3')
    expect(state.records['a']).toBeDefined()

    await ui.press('u')
    const frame = ui.frame()
    expect(frame).toContain('undid good')
    expect(frame).toContain('card 1/2')
    expect(state.records['a']).toBeUndefined()
  })

  it('undo restores the record a previously reviewed card already had', async () => {
    const seeded: ReviewRecord = {
      cardId: 'a',
      sourcePath: '/notes/algebra.md',
      sourceMtimeMs: 0,
      suspended: false,
      dueAt: '2020-01-01T00:00:00.000Z',
      intervalDays: 4,
      ease: 2.1,
      reps: 3,
      lapses: 1,
    }
    state.records['a'] = { ...seeded }

    const ui = await open()
    await ui.press(KEY.space)
    await ui.press('3')
    expect(state.records['a']).not.toEqual(seeded)

    await ui.press('u')
    expect(state.records['a']).toEqual(seeded)
  })

  it('reports when there is nothing to undo', async () => {
    const ui = await open()
    await ui.press('u')
    expect(ui.frame()).toContain('nothing to undo')
  })

  it('suspends a card without needing a reveal', async () => {
    const ui = await open()
    await ui.press('s')
    expect(ui.frame()).toContain('suspended "What is a group?"')
    expect(state.records['a']?.suspended).toBe(true)
  })

  it('narrows the queue to search matches', async () => {
    const ui = await open()
    await ui.press('/')
    await ui.type('ring')
    expect(ui.frame()).toContain('/ring')

    await ui.press(KEY.enter)
    const frame = ui.frame()
    expect(frame).toContain('1 card matching "ring" · esc to clear')
    expect(frame).toContain('What is a ring?')
    expect(frame).toContain('card 1/1')
  })

  it('clears a committed search on escape, as its hint promises', async () => {
    const ui = await open()
    await ui.press('/')
    await ui.type('ring')
    await ui.press(KEY.enter)
    expect(ui.frame()).toContain('esc to clear')

    await ui.press(KEY.escape)
    const frame = ui.frame()
    expect(frame).toContain('search cleared')
    expect(frame).toContain('card 1/2')
    expect(frame).toContain('What is a group?')
    expect(frame).toContain('[press space or enter to reveal]')
  })

  it('leaves escape inert when no search is active', async () => {
    const ui = await open()
    await ui.press(KEY.space)
    await ui.press(KEY.escape)

    const frame = ui.frame()
    expect(frame).toContain('A set with an associative operation.')
    expect(frame).not.toContain('search cleared')
  })

  it('abandons an unconfirmed search on escape', async () => {
    const ui = await open()
    await ui.press('/')
    await ui.type('ring')
    await ui.press(KEY.escape)

    const frame = ui.frame()
    expect(frame).toContain('search cleared')
    expect(frame).toContain('card 1/2')
    expect(frame).toContain('What is a group?')
  })

  it('edits the search with backspace instead of quitting', async () => {
    const ui = await open()
    await ui.press('/')
    await ui.type('ringx')
    await ui.press(KEY.backspace)
    expect(ui.frame()).toContain('/ring')

    await ui.press(KEY.enter)
    expect(ui.frame()).toContain('1 card matching "ring"')
  })

  it('reports a search that matches nothing without changing the queue', async () => {
    const ui = await open()
    await ui.press('/')
    await ui.type('zzz')
    await ui.press(KEY.enter)

    const frame = ui.frame()
    expect(frame).toContain('no cards match "zzz"')
    expect(frame).toContain('card 1/2')
  })

  it('reflows the viewport when the terminal is resized', async () => {
    const ui = await open({ columns: 100, rows: 40 })
    const tall = ui.frame().split('\n').length

    await ui.resize(100, 20)
    const short = ui.frame().split('\n').length
    expect(short).toBeLessThan(tall)
    expect(tall - short).toBe(20)

    await ui.resize(100, 40)
    expect(ui.frame().split('\n').length).toBe(tall)
  })

  it('rewraps the card body at the new width when the terminal is resized', async () => {
    const ui = await open({ columns: 100, rows: 40 })
    await ui.press(KEY.space)
    expect(ui.frame()).toContain('A set with an associative operation.')

    await ui.resize(30, 40)
    const frame = ui.frame()
    expect(frame).not.toContain('A set with an associative operation.')
    expect(frame).toContain('A set with an')
    expect(Math.max(...frame.split('\n').map((line) => line.length))).toBeLessThanOrEqual(30)
  })

  it('explains why the image preview is unavailable', async () => {
    const ui = await open()
    await ui.press('i')
    expect(ui.frame()).toContain('image previews unavailable: not a kitty terminal')
  })

  it('advertises the image key only for cards with a previewable PNG', async () => {
    const ui = await openWithImage()
    expect(ui.frame()).toContain('i image')

    await ui.press(KEY.space)
    expect(ui.frame()).toContain('📎 Cayley table → ' + PNG)

    await ui.press('3')
    expect(ui.frame()).not.toContain('i image')
  })

  it('transmits the image only after the bare frame has been flushed', async () => {
    const ui = await openWithImage()
    const before = ui.output().length

    await ui.press('i')
    const emitted = ui.output().slice(before)
    const image = emitted.indexOf(buildKittyImageSequence(PNG, { cols: 96, rows: 36, tmux: false }))
    expect(image).toBeGreaterThan(-1)
    // The bare frame — title plus the return hint, and nothing else — precedes it.
    expect(emitted.slice(0, image)).toContain('any key to return')
    expect(emitted.slice(0, image)).not.toContain('space reveal')
  })

  it('clears the placed image when the preview is dismissed', async () => {
    const ui = await openWithImage()
    await ui.press('i')
    const before = ui.output().length

    await ui.press('x')
    const emitted = ui.output().slice(before)
    expect(emitted).toContain(buildKittyClearSequence(false))
    expect(emitted).toContain('closed image preview')
  })

  it('wraps the graphics escapes for tmux passthrough when needed', async () => {
    const ui = await openWithImage(true)
    await ui.press('i')
    expect(ui.output()).toContain(buildKittyImageSequence(PNG, { cols: 96, rows: 36, tmux: true }))
  })
})

const DECK = `---
type: content
---

# Algebra

## What is a group?
A set with an associative operation.

## What is a ring?
A group with a second operation.
`

describe('ReviewApp editing', () => {
  let deckPath: string

  /** An `$EDITOR` stand-in that rewrites the file it is handed. */
  function rewriter(rewrite: (current: string) => string): EditorRunner {
    return async (file) => {
      await fs.writeFile(file, rewrite(await fs.readFile(file, 'utf8')), 'utf8')
    }
  }

  /** Render against a real file on disk, with `openEditor` standing in for $EDITOR. */
  async function openDeck(runner: EditorRunner) {
    deckPath = path.join(dir, 'algebra.md')
    await fs.writeFile(deckPath, DECK, 'utf8')
    const parsed = await parseFile(deckPath, dir)

    const openEditor = vi.fn<EditorRunner>(runner)
    const rendered = await renderTui(
      <ReviewApp
        cards={parsed.cards}
        decks={parsed.deck ? [parsed.deck] : []}
        state={state}
        statePath={statePath}
        rootDir={dir}
        queueOptions={{}}
        deckFilter={parsed.deck?.id}
        images={{ enabled: false, tmux: false, reason: 'not a kitty terminal' }}
        displayablePngs={new Set()}
        openEditor={openEditor}
      />,
    )
    ui = rendered
    return { ui: rendered, openEditor, cards: parsed.cards }
  }

  /** The edit runs off the keypress, so give its file I/O a chance to land. */
  function settled(check: () => void) {
    return vi.waitFor(check, { timeout: 2000, interval: 20 })
  }

  it('opens the editor on the current card and shows the edited body', async () => {
    const { ui, openEditor, cards } = await openDeck(
      rewriter((current) =>
        current.replace('A set with an associative operation.', 'A set plus an associative binop.'),
      ),
    )
    await ui.press(KEY.space)
    await ui.press('e')

    expect(openEditor).toHaveBeenCalledWith(deckPath, cards[0]?.sourceLine)
    await settled(() => {
      expect(ui.frame()).toContain('A set plus an associative binop.')
    })
    expect(ui.frame()).toContain('card 1/2')
  })

  it('keeps the review record when the edit renames the heading', async () => {
    const seeded: ReviewRecord = {
      cardId: 'placeholder',
      sourcePath: '',
      sourceMtimeMs: 0,
      suspended: false,
      dueAt: '2020-01-01T00:00:00.000Z',
      intervalDays: 4,
      ease: 2.1,
      reps: 3,
      lapses: 1,
    }

    const { ui, cards } = await openDeck(
      rewriter((current) => current.replace('## What is a group?', '## What is a group, really?')),
    )
    const originalId = cards[0]?.id as string
    state.records[originalId] = { ...seeded, cardId: originalId, sourcePath: deckPath }

    await ui.press('e')
    await settled(() => {
      expect(ui.frame()).toContain('What is a group, really?')
    })

    const renamed = (await parseFile(deckPath, dir)).cards[0]?.id as string
    expect(renamed).not.toBe(originalId)
    expect(state.records[originalId]).toBeUndefined()
    expect(state.records[renamed]).toMatchObject({ cardId: renamed, reps: 3, ease: 2.1 })
    expect(ui.frame()).toContain('1 record followed the edit')

    await writtenState((written) => {
      expect(written.records[renamed]?.reps).toBe(3)
    })
  })

  it('drops a card deleted in the editor and moves on', async () => {
    const { ui } = await openDeck(
      rewriter((current) =>
        current.replace('## What is a group?\nA set with an associative operation.\n\n', ''),
      ),
    )
    await ui.press('e')

    await settled(() => {
      expect(ui.frame()).toContain('that card is gone')
    })
    const frame = ui.frame()
    expect(frame).toContain('card 1/1')
    expect(frame).toContain('What is a ring?')
  })

  it('reports an editor that would not launch and stays on the card', async () => {
    const { ui } = await openDeck(() =>
      Promise.reject(new Error('editor not found: nope (set $EDITOR)')),
    )
    await ui.press('e')
    await settled(() => {
      expect(ui.frame()).toContain('edit failed')
    })
    const frame = ui.frame()
    expect(frame).toContain('editor not found: nope')
    expect(frame).toContain('card 1/2')
    expect(frame).toContain('What is a group?')
  })
})

import path from 'node:path'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeckSummary } from '../src/queue.js'
import { DeckPicker } from '../src/tui/DeckPicker.js'
import type { Deck } from '../src/types.js'
import { KEY, renderTui, type TuiHarness } from './helpers/tui.js'

function makeDeck(id: string, title: string, sourcePath = `/notes/${id}.md`): Deck {
  return {
    id,
    title,
    sourcePath,
    rootDir: path.dirname(sourcePath),
    type: 'content',
    cardCount: 1,
  }
}

const decks = [
  makeDeck('algebra', 'Algebra'),
  makeDeck('botany', 'Botany'),
  makeDeck('chemistry', 'Chemistry'),
]

const summaries = new Map<string, DeckSummary>([
  ['/notes/algebra.md', { total: 10, due: 3, fresh: 2, suspended: 0 }],
  ['/notes/botany.md', { total: 5, due: 1, fresh: 4, suspended: 1 }],
  ['/notes/chemistry.md', { total: 7, due: 0, fresh: 7, suspended: 0 }],
])

/* A fourth deck under a second source directory, so that one `hiddenDecks` entry
   can be tried as a slug and another as a path covering a whole directory. */
const withArchive = [...decks, makeDeck('scratch', 'Scratch', '/archive/scratch.md')]
const archiveSummaries = new Map<string, DeckSummary>([
  ...summaries,
  ['/archive/scratch.md', { total: 4, due: 2, fresh: 1, suspended: 0 }],
])

let ui: TuiHarness | undefined

afterEach(() => {
  ui?.unmount()
  ui = undefined
})

async function open(overrides: Partial<React.ComponentProps<typeof DeckPicker>> = {}) {
  const onSelect = vi.fn<(sourcePaths: string[]) => void>()
  const onPractice = vi.fn<(sourcePaths: string[]) => void>()
  const onQuit = vi.fn<() => void>()
  const onToggleHidden = vi.fn<(sourcePath: string, hide: boolean) => Promise<void>>(() =>
    Promise.resolve(),
  )
  ui = await renderTui(
    <DeckPicker
      decks={decks}
      summaries={summaries}
      height={10}
      hiddenDecks={[]}
      onSelect={onSelect}
      onPractice={onPractice}
      onQuit={onQuit}
      onToggleHidden={onToggleHidden}
      {...overrides}
    />,
  )
  return { ui, onSelect, onPractice, onQuit, onToggleHidden }
}

/** The cursor row is the one prefixed with the selection marker. */
function selectedLabel(frame: string): string {
  const line = frame.split('\n').find((l) => l.includes('❯'))
  return (
    line
      ?.replace(/.*❯\s*/, '')
      .split(/\s{2,}/)[0]
      ?.trim() ?? ''
  )
}

describe('DeckPicker', () => {
  it('lists decks with due, new and total counts', async () => {
    const { ui } = await open()
    const frame = ui.frame()
    expect(frame).toContain('Select a deck')
    expect(frame).toContain('3 decks')
    expect(frame).toContain('All decks')
    for (const title of ['Algebra', 'Botany', 'Chemistry']) {
      expect(frame).toContain(title)
    }
    // "All decks" aggregates every listed deck: 4 due, 13 new, 22 total.
    expect(frame).toMatch(/All decks\s+4 due\s+13 new\s+22 total/)
  })

  it('starts on "All decks" and moves the cursor with j/k and arrows', async () => {
    const { ui } = await open()
    expect(selectedLabel(ui.frame())).toBe('All decks')

    await ui.press('j')
    expect(selectedLabel(ui.frame())).toBe('Algebra')

    await ui.press(KEY.down)
    expect(selectedLabel(ui.frame())).toBe('Botany')

    await ui.press('k')
    expect(selectedLabel(ui.frame())).toBe('Algebra')

    await ui.press(KEY.up)
    expect(selectedLabel(ui.frame())).toBe('All decks')
  })

  it('selects the deck under the cursor with enter', async () => {
    const { ui, onSelect } = await open()
    await ui.press('j')
    await ui.press(KEY.enter)
    expect(onSelect).toHaveBeenCalledWith(['/notes/algebra.md'])
  })

  it('selects every deck when "All decks" is chosen', async () => {
    const { ui, onSelect } = await open()
    await ui.press(KEY.space)
    expect(onSelect).toHaveBeenCalledWith([
      '/notes/algebra.md',
      '/notes/botany.md',
      '/notes/chemistry.md',
    ])
  })

  it('opens the deck under the cursor as a practice pass with p', async () => {
    const { ui, onSelect, onPractice } = await open()
    await ui.press('j')
    await ui.press('j')
    await ui.press('p')
    expect(onPractice).toHaveBeenCalledWith(['/notes/botany.md'])
    expect(onSelect).not.toHaveBeenCalled()
  })

  /* Chemistry has nothing due, which is the case the key exists for: the row is
     still selectable and p is the way past a schedule that says "not yet". */
  it('practises a deck with nothing due', async () => {
    const { ui, onPractice } = await open()
    await ui.press('/')
    await ui.type('chem')
    await ui.press(KEY.enter) // commits the filter
    expect(ui.frame()).toMatch(/Chemistry\s+0 due/)
    await ui.press('p')
    expect(onPractice).toHaveBeenCalledWith(['/notes/chemistry.md'])
  })

  it('practises every listed deck from "All decks"', async () => {
    const { ui, onPractice } = await open()
    await ui.press('p')
    expect(onPractice).toHaveBeenCalledWith([
      '/notes/algebra.md',
      '/notes/botany.md',
      '/notes/chemistry.md',
    ])
  })

  // `p` is a filter character before it is a command.
  it('types p into the filter instead of practising', async () => {
    const { ui, onPractice } = await open()
    await ui.press('/')
    await ui.type('p')
    expect(ui.frame()).toContain('/p')
    expect(onPractice).not.toHaveBeenCalled()
  })

  it('limits "All decks" to the decks left by the filter', async () => {
    const { ui, onSelect } = await open()
    await ui.press('/')
    await ui.type('a')
    await ui.press(KEY.enter) // commits the filter

    // "a" matches Algebra and Botany, so chemistry stays out of the session.
    expect(ui.frame()).toMatch(/All decks\s+4 due\s+6 new\s+15 total/)
    await ui.press(KEY.enter)
    expect(onSelect).toHaveBeenCalledWith(['/notes/algebra.md', '/notes/botany.md'])
  })

  it('quits on q and on escape', async () => {
    const first = await open()
    await first.ui.press('q')
    expect(first.onQuit).toHaveBeenCalledTimes(1)
    first.ui.unmount()

    const second = await open()
    await second.ui.press(KEY.escape)
    expect(second.onQuit).toHaveBeenCalledTimes(1)
  })

  it('filters the list while typing and drops the filter on escape', async () => {
    const { ui } = await open()
    await ui.press('/')
    await ui.type('bot')

    let frame = ui.frame()
    expect(frame).toContain('/bot')
    expect(frame).toContain('Botany')
    expect(frame).not.toContain('Algebra')
    expect(frame).toContain('1 decks matching "bot"')

    await ui.press(KEY.escape)
    frame = ui.frame()
    expect(frame).toContain('Algebra')
    expect(frame).toContain('enter select · p practice · j/k move · / filter · H hide · q quit')
  })

  it('edits the filter with backspace instead of quitting', async () => {
    const { ui, onQuit } = await open()
    await ui.press('/')
    await ui.type('bota')
    await ui.press(KEY.backspace)
    await ui.press(KEY.backspace)

    const frame = ui.frame()
    expect(frame).toContain('/bo')
    expect(frame).toContain('Botany')
    expect(onQuit).not.toHaveBeenCalled()
  })

  it('shows an empty state when nothing matches the filter', async () => {
    const { ui, onSelect } = await open()
    await ui.press('/')
    await ui.type('zzz')

    const frame = ui.frame()
    expect(frame).toContain('0 decks matching "zzz"')
    expect(frame).toContain('no decks match')
    expect(frame).not.toContain('All decks')
    for (const title of ['Algebra', 'Botany', 'Chemistry']) {
      expect(frame).not.toContain(title)
    }

    // Nothing to select, so enter must not start a session over every card.
    await ui.press(KEY.enter) // commits the filter
    await ui.press(KEY.enter) // would select the cursor row
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('shows an empty state when no deck has any cards', async () => {
    const { ui } = await open({ summaries: new Map<string, DeckSummary>() })
    const frame = ui.frame()
    expect(frame).toContain('0 decks')
    expect(frame).toContain('no decks match')
    expect(frame).not.toContain('All decks')
  })

  /* Two source directories can hold the same relative path, so the slug is not
     an identity. Keyed on it, these two files would be one row. */
  it('lists two decks that share a slug as two rows', async () => {
    const mine = { ...makeDeck('spanish', 'Spanish'), sourcePath: '/notes/spanish.md' }
    const theirs = {
      ...makeDeck('spanish', 'Spanish'),
      sourcePath: '/work/spanish.md',
      rootDir: '/work',
    }
    const { ui, onSelect } = await open({
      decks: [mine, theirs],
      summaries: new Map<string, DeckSummary>([
        ['/notes/spanish.md', { total: 10, due: 3, fresh: 2, suspended: 0 }],
        ['/work/spanish.md', { total: 4, due: 1, fresh: 3, suspended: 0 }],
      ]),
    })
    expect(ui.frame()).toContain('2 decks')

    // The path is what tells them apart, so it is what the filter has to match.
    await ui.press('/')
    await ui.type('work')
    await ui.press(KEY.enter)
    await ui.press(KEY.enter)
    expect(onSelect).toHaveBeenCalledWith(['/work/spanish.md'])
  })

  it('hides decks that have no cards', async () => {
    const { ui } = await open({
      summaries: new Map<string, DeckSummary>([
        ['/notes/algebra.md', { total: 10, due: 3, fresh: 2, suspended: 0 }],
      ]),
    })
    const frame = ui.frame()
    expect(frame).toContain('Algebra')
    expect(frame).not.toContain('Botany')
    expect(frame).toContain('1 decks')
  })

  /* `hiddenDecks` is the config's answer and this key is only whether the list
     shows it, so nothing here writes anything: the toggle is per session. The
     grey a revealed row is drawn in is not asserted: the harness' stdout is not a
     terminal, so Ink's chalk emits no SGR codes and there is nothing to match. */
  describe('hidden decks', () => {
    async function openWithHidden(hiddenDecks: string[]) {
      return open({ decks: withArchive, summaries: archiveSummaries, hiddenDecks })
    }

    it('keeps a hidden deck out of the list, and says how many are out', async () => {
      const { ui } = await openWithHidden(['scratch'])
      const frame = ui.frame()
      expect(frame).not.toContain('Scratch')
      expect(frame).toContain('3 decks · +1 hidden')
    })

    /* The rule the picker already had: "All decks" is the decks on screen. A
       hidden deck is off it, so it is out of the session and out of the totals —
       counting it would offer cards the list gives no way to see. */
    it('leaves a hidden deck out of "All decks" as well as out of the list', async () => {
      const { ui, onSelect } = await openWithHidden(['scratch'])
      expect(ui.frame()).toMatch(/All decks\s+4 due\s+13 new\s+22 total/)
      await ui.press(KEY.enter)
      expect(onSelect).toHaveBeenCalledWith([
        '/notes/algebra.md',
        '/notes/botany.md',
        '/notes/chemistry.md',
      ])
    })

    it('reveals hidden decks on "." and hides them again', async () => {
      const { ui } = await openWithHidden(['scratch'])
      await ui.press('.')
      let frame = ui.frame()
      expect(frame).toContain('Scratch')
      expect(frame).toContain('4 decks · 1 hidden')

      await ui.press('.')
      frame = ui.frame()
      expect(frame).not.toContain('Scratch')
      expect(frame).toContain('3 decks · +1 hidden')
    })

    it('studies a revealed deck, alone and as part of "All decks"', async () => {
      const { ui, onSelect } = await openWithHidden(['scratch'])
      await ui.press('.')
      expect(ui.frame()).toMatch(/All decks\s+6 due\s+14 new\s+26 total/)

      // Four rows plus "All decks", so the last one is the revealed deck.
      for (let i = 0; i < 4; i += 1) await ui.press('j')
      expect(selectedLabel(ui.frame())).toBe('Scratch')
      await ui.press(KEY.enter)
      expect(onSelect).toHaveBeenCalledWith(['/archive/scratch.md'])
    })

    it('practises a revealed deck', async () => {
      const { ui, onPractice } = await openWithHidden(['scratch'])
      await ui.press('.')
      for (let i = 0; i < 4; i += 1) await ui.press('j')
      await ui.press('p')
      expect(onPractice).toHaveBeenCalledWith(['/archive/scratch.md'])
    })

    // The `--deck` rule: a slug matches exactly, a path by substring, which is
    // what lets one entry stand for a whole source directory.
    it('hides every deck under a source directory named by path', async () => {
      const { ui } = await openWithHidden(['/archive'])
      expect(ui.frame()).not.toContain('Scratch')
      expect(ui.frame()).toContain('+1 hidden')
    })

    /* The same breadth `--deck` has, and the same cost: a path substring matches,
       so a short entry catches more decks than it names. */
    it('matches part of a path, so a partial name hides the deck too', async () => {
      const { ui } = await openWithHidden(['scr'])
      expect(ui.frame()).not.toContain('Scratch')
    })

    it('leaves the whole list alone when an entry matches nothing', async () => {
      const { ui } = await openWithHidden(['algebra-ii'])
      const frame = ui.frame()
      expect(frame).toContain('4 decks')
      expect(frame).not.toContain('hidden')
    })

    // `.` is a filter character before it is a command, the way `p` is.
    it('types "." into the filter instead of revealing', async () => {
      const { ui } = await openWithHidden(['scratch'])
      await ui.press('/')
      await ui.type('.')
      const frame = ui.frame()
      expect(frame).toContain('/.')
      expect(frame).not.toContain('Scratch')
    })

    /* The rows under the cursor change, so the cursor goes home — the same thing
       editing the filter does, and for the same reason. */
    it('sends the cursor back to "All decks" when the list changes under it', async () => {
      const { ui } = await openWithHidden(['scratch'])
      await ui.press('j')
      await ui.press('j')
      expect(selectedLabel(ui.frame())).toBe('Botany')
      await ui.press('.')
      expect(selectedLabel(ui.frame())).toBe('All decks')
    })

    // Advertising a key that would do nothing is how a footer stops being read.
    it('names the key only when there is something hidden', async () => {
      const { ui } = await openWithHidden(['scratch'])
      expect(ui.frame()).toContain('H hide · . show hidden · q quit')
      await ui.press('.')
      expect(ui.frame()).toContain('H hide · . hide hidden · q quit')

      // Unmounted before the second render, since `open` overwrites the handle
      // that afterEach cleans up.
      ui.unmount()
      const plain = await open()
      expect(plain.ui.frame()).toContain('H hide · q quit')
    })

    /* `H` marks; `.` looks. The picker does not edit its own list — the parent
       writes the config and hands the new list back — so these assert the call
       and the message, and `tests/review.test.tsx` closes the loop. */
    it('hides the deck under the cursor, naming what it did', async () => {
      const { ui, onToggleHidden } = await open({ decks: withArchive, summaries: archiveSummaries })
      await ui.press('j')
      await ui.press('j')
      expect(selectedLabel(ui.frame())).toBe('Botany')
      await ui.press('H')

      expect(onToggleHidden).toHaveBeenCalledWith('/notes/botany.md', true)
      expect(ui.frame()).toContain('hiding Botany')
    })

    /* The path, not the slug: two source directories can hold the same relative
       path, and hiding both would be a second deck leaving on one keypress. */
    it('writes the source path of a deck whose slug is shared', async () => {
      const mine = makeDeck('spanish', 'Spanish')
      const theirs = makeDeck('spanish', 'Spanish', '/work/spanish.md')
      const { ui, onToggleHidden } = await open({
        decks: [mine, theirs],
        summaries: new Map<string, DeckSummary>([
          ['/notes/spanish.md', { total: 10, due: 3, fresh: 2, suspended: 0 }],
          ['/work/spanish.md', { total: 4, due: 1, fresh: 3, suspended: 0 }],
        ]),
      })
      await ui.press('j')
      await ui.press('j')
      await ui.press('H')
      expect(onToggleHidden).toHaveBeenCalledWith('/work/spanish.md', true)
    })

    it('shows a hidden deck again when its own path is the entry', async () => {
      const { ui, onToggleHidden } = await openWithHidden(['/archive/scratch.md'])
      await ui.press('.')
      for (let i = 0; i < 4; i += 1) await ui.press('j')
      expect(selectedLabel(ui.frame())).toBe('Scratch')
      await ui.press('H')

      expect(onToggleHidden).toHaveBeenCalledWith('/archive/scratch.md', false)
      expect(ui.frame()).toContain('showing Scratch')
    })

    /* Dropping a directory entry would show every other deck under it, which is
       not what a key pressed on one row asks for. */
    it('refuses to show a deck hidden by a broader entry, naming the entry', async () => {
      const { ui, onToggleHidden } = await openWithHidden(['/archive'])
      await ui.press('.')
      for (let i = 0; i < 4; i += 1) await ui.press('j')
      await ui.press('H')

      expect(onToggleHidden).not.toHaveBeenCalled()
      expect(ui.frame()).toContain('hidden by "/archive" in the config')
    })

    it('refuses to hide "All decks"', async () => {
      const { ui, onToggleHidden } = await open()
      await ui.press('H')
      expect(onToggleHidden).not.toHaveBeenCalled()
      expect(ui.frame()).toContain('H hides one deck; move to a row first')
    })

    // A config that could not be written must not read as one that was.
    it('reports a write that failed', async () => {
      const onToggleHidden = vi.fn<(sourcePath: string, hide: boolean) => Promise<void>>(() =>
        Promise.reject(new Error('EACCES: permission denied')),
      )
      const { ui } = await open({ onToggleHidden })
      await ui.press('j')
      await ui.press('H')

      expect(ui.frame()).toContain('could not write the config')
      expect(ui.frame()).toContain('EACCES')
    })

    it('clears the message on the next key', async () => {
      const { ui } = await open()
      await ui.press('H')
      expect(ui.frame()).toContain('move to a row first')
      await ui.press('j')
      expect(ui.frame()).not.toContain('move to a row first')
    })

    // `H` is a filter character before it is a command, the way `p` and `.` are.
    it('types "H" into the filter instead of hiding', async () => {
      const { ui, onToggleHidden } = await open()
      await ui.press('/')
      await ui.type('H')
      expect(ui.frame()).toContain('/H')
      expect(onToggleHidden).not.toHaveBeenCalled()
    })
  })
})

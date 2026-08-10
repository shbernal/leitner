import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeckSummary } from '../src/queue.js'
import { DeckPicker } from '../src/tui/DeckPicker.js'
import type { Deck } from '../src/types.js'
import { KEY, renderTui, type TuiHarness } from './helpers/tui.js'

function makeDeck(id: string, title: string): Deck {
  return { id, title, sourcePath: `/notes/${id}.md`, type: 'content', cardCount: 1 }
}

const decks = [
  makeDeck('algebra', 'Algebra'),
  makeDeck('botany', 'Botany'),
  makeDeck('chemistry', 'Chemistry'),
]

const summaries = new Map<string, DeckSummary>([
  ['algebra', { total: 10, due: 3, fresh: 2, suspended: 0 }],
  ['botany', { total: 5, due: 1, fresh: 4, suspended: 1 }],
  ['chemistry', { total: 7, due: 0, fresh: 7, suspended: 0 }],
])

let ui: TuiHarness | undefined

afterEach(() => {
  ui?.unmount()
  ui = undefined
})

async function open(overrides: Partial<React.ComponentProps<typeof DeckPicker>> = {}) {
  const onSelect = vi.fn<(deckIds: string[]) => void>()
  const onQuit = vi.fn<() => void>()
  ui = await renderTui(
    <DeckPicker
      decks={decks}
      summaries={summaries}
      height={10}
      onSelect={onSelect}
      onQuit={onQuit}
      {...overrides}
    />,
  )
  return { ui, onSelect, onQuit }
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
    expect(onSelect).toHaveBeenCalledWith(['algebra'])
  })

  it('selects every deck when "All decks" is chosen', async () => {
    const { ui, onSelect } = await open()
    await ui.press(KEY.space)
    expect(onSelect).toHaveBeenCalledWith(['algebra', 'botany', 'chemistry'])
  })

  it('limits "All decks" to the decks left by the filter', async () => {
    const { ui, onSelect } = await open()
    await ui.press('/')
    await ui.type('a')
    await ui.press(KEY.enter) // commits the filter

    // "a" matches Algebra and Botany, so chemistry stays out of the session.
    expect(ui.frame()).toMatch(/All decks\s+4 due\s+6 new\s+15 total/)
    await ui.press(KEY.enter)
    expect(onSelect).toHaveBeenCalledWith(['algebra', 'botany'])
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
    expect(frame).toContain('enter select · j/k move · / filter · q quit')
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

  it('hides decks that have no cards', async () => {
    const { ui } = await open({
      summaries: new Map<string, DeckSummary>([
        ['algebra', { total: 10, due: 3, fresh: 2, suspended: 0 }],
      ]),
    })
    const frame = ui.frame()
    expect(frame).toContain('Algebra')
    expect(frame).not.toContain('Botany')
    expect(frame).toContain('1 decks')
  })
})

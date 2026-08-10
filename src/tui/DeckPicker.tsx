import React, { useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { DeckSummary } from '../queue.js'
import type { Deck } from '../types.js'

const ALL_DECKS = '__all__'

export type DeckPickerProps = {
  decks: Deck[]
  summaries: Map<string, DeckSummary>
  height: number
  /** The decks to review: every listed deck for "All decks", otherwise just one. */
  onSelect: (deckIds: string[]) => void
  onQuit: () => void
}

type Row = {
  id: string
  label: string
  type: string
  summary: DeckSummary
}

function totals(summaries: Iterable<DeckSummary>): DeckSummary {
  const all: DeckSummary = { total: 0, due: 0, fresh: 0, suspended: 0 }
  for (const s of summaries) {
    all.total += s.total
    all.due += s.due
    all.fresh += s.fresh
    all.suspended += s.suspended
  }
  return all
}

export function DeckPicker({
  decks,
  summaries,
  height,
  onSelect,
  onQuit,
}: DeckPickerProps): React.ReactElement {
  const [cursor, setCursor] = useState(0)
  const [filter, setFilter] = useState('')
  const [filtering, setFiltering] = useState(false)

  const rows = useMemo<Row[]>(() => {
    const deckRows: Row[] = decks
      .map((deck) => ({
        id: deck.id,
        label: deck.title,
        type: deck.type,
        summary: summaries.get(deck.id) ?? { total: 0, due: 0, fresh: 0, suspended: 0 },
      }))
      .filter((row) => row.summary.total > 0)

    const needle = filter.trim().toLowerCase()
    const matched =
      needle === ''
        ? deckRows
        : deckRows.filter(
            (row) =>
              row.id.toLowerCase().includes(needle) || row.label.toLowerCase().includes(needle),
          )

    // An "All decks" row over nothing would offer an empty session, so drop it too.
    if (matched.length === 0) return []

    return [
      {
        id: ALL_DECKS,
        label: 'All decks',
        type: '',
        summary: totals(matched.map((r) => r.summary)),
      },
      ...matched,
    ]
  }, [decks, summaries, filter])

  const deckCount = Math.max(0, rows.length - 1)

  const clampedCursor = Math.min(cursor, Math.max(0, rows.length - 1))

  useInput((input, key) => {
    if (filtering) {
      if (key.escape) {
        setFiltering(false)
        setFilter('')
        return
      }
      if (key.return) {
        setFiltering(false)
        return
      }
      if (key.backspace || key.delete) {
        setFilter((f) => f.slice(0, -1))
        setCursor(0)
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setFilter((f) => f + input)
        setCursor(0)
      }
      return
    }

    if (input === 'q' || key.escape || (key.ctrl && input === 'c')) {
      onQuit()
      return
    }
    if (input === '/') {
      setFiltering(true)
      return
    }
    if (input === 'j' || key.downArrow) {
      setCursor((c) => Math.min(rows.length - 1, c + 1))
      return
    }
    if (input === 'k' || key.upArrow) {
      setCursor((c) => Math.max(0, c - 1))
      return
    }
    if (key.return || input === ' ') {
      const row = rows[clampedCursor]
      if (!row) return
      // "All decks" means the decks on screen, so it honours the active filter.
      onSelect(row.id === ALL_DECKS ? rows.slice(1).map((r) => r.id) : [row.id])
    }
  })

  // Keep the cursor inside the visible window as it moves through a long list.
  const viewport = Math.max(3, height)
  const start = Math.max(
    0,
    Math.min(clampedCursor - Math.floor(viewport / 2), Math.max(0, rows.length - viewport)),
  )
  const visible = rows.slice(start, start + viewport)
  const labelWidth = Math.max(12, ...rows.map((r) => r.label.length))

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          Select a deck
        </Text>
        <Text dimColor>
          {deckCount} decks{filter === '' ? '' : ` matching "${filter}"`}
        </Text>
      </Box>
      <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1}>
        {visible.length === 0 ? (
          <Text dimColor italic>
            no decks match
          </Text>
        ) : (
          visible.map((row) => {
            const selected = rows.indexOf(row) === clampedCursor
            return (
              <Text key={row.id} inverse={selected}>
                {selected ? '❯ ' : '  '}
                <Text bold={row.id === ALL_DECKS}>{row.label.padEnd(labelWidth)}</Text>
                {'  '}
                <Text color="green">{String(row.summary.due).padStart(5)} due</Text>
                {'  '}
                <Text color="blue">{String(row.summary.fresh).padStart(5)} new</Text>
                {'  '}
                <Text dimColor>{String(row.summary.total).padStart(5)} total</Text>
              </Text>
            )
          })
        )}
      </Box>
      {filtering ? (
        <Text color="yellow">/{filter}▏</Text>
      ) : (
        <Text dimColor>enter select · j/k move · / filter · q quit</Text>
      )}
    </Box>
  )
}

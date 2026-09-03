import React, { useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { DeckSummary } from '../queue.js'
import type { Deck } from '../types.js'

const ALL_DECKS = '__all__'

export type DeckPickerProps = {
  decks: Deck[]
  summaries: Map<string, DeckSummary>
  height: number
  /** The config's `hiddenDecks`: slugs, or substrings of a source path. */
  hiddenDecks: string[]
  /**
   * The decks to review, by source path: every listed deck for "All decks",
   * otherwise just one. Paths rather than slugs, because two source directories
   * can hold the same relative path and so name two files with one slug.
   */
  onSelect: (sourcePaths: string[]) => void
  /** The same decks, opened as a practice pass instead of a graded session. */
  onPractice: (sourcePaths: string[]) => void
  onQuit: () => void
  /**
   * `H`: add this deck's source path to `hiddenDecks`, or take it out again.
   * Rejecting leaves the list as it was and the reason on screen, so a config
   * that could not be written never shows as one that was.
   */
  onToggleHidden: (sourcePath: string, hide: boolean) => Promise<void>
}

type Row = {
  id: string
  /** The deck slug, and the path it came from: both are what `/` searches. */
  slug: string
  path: string
  label: string
  type: string
  summary: DeckSummary
  /**
   * The `hiddenDecks` entry that hides this deck, or undefined when none does.
   * The entry rather than a flag, because `H` can only take back an entry that
   * is this deck's own path: naming which other one is in the way is the whole
   * difference between a refusal and a key that looks broken.
   */
  hiddenBy: string | undefined
}

/**
 * The `--deck` rule, applied to a deck rather than a card: the slug exactly, or
 * any substring of the source path — which is what lets one entry hide a whole
 * source directory. Duplicated from `filterCards` rather than shared, because
 * that one answers about a card and this one about the row on screen.
 */
function hiddenBy(slug: string, sourcePath: string, patterns: string[]): string | undefined {
  return patterns.find((pattern) => slug === pattern || sourcePath.includes(pattern))
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

type RowList = { rows: Row[]; hiddenCount: number }

/**
 * The listed rows and how many decks are held back. A function rather than a
 * memo body, because `.` has to know what the list becomes before it changes it:
 * the cursor is an index, and an index means a different deck once rows come and
 * go.
 */
function buildRows(
  decks: Deck[],
  summaries: Map<string, DeckSummary>,
  hiddenDecks: string[],
  filter: string,
  showHidden: boolean,
): RowList {
  const deckRows: Row[] = decks
    .map((deck) => ({
      id: deck.sourcePath,
      slug: deck.id,
      path: deck.sourcePath,
      label: deck.title,
      type: deck.type ?? '',
      summary: summaries.get(deck.sourcePath) ?? { total: 0, due: 0, fresh: 0, suspended: 0 },
      hiddenBy: hiddenBy(deck.id, deck.sourcePath, hiddenDecks),
    }))
    .filter((row) => row.summary.total > 0)

  const hiddenCount = deckRows.filter((row) => row.hiddenBy !== undefined).length
  // Hidden rows leave the list, and so leave "All decks" with it — the rule
  // below is that a session is what is on screen, and this is the same rule.
  const listed = showHidden ? deckRows : deckRows.filter((row) => row.hiddenBy === undefined)

  const needle = filter.trim().toLowerCase()
  // The path is searchable so that one source directory can be picked out of
  // several by typing part of it.
  const matched =
    needle === ''
      ? listed
      : listed.filter(
          (row) =>
            row.slug.toLowerCase().includes(needle) ||
            row.label.toLowerCase().includes(needle) ||
            row.path.toLowerCase().includes(needle),
        )

  // An "All decks" row over nothing would offer an empty session, so drop it too.
  if (matched.length === 0) return { rows: [], hiddenCount }

  return {
    rows: [
      {
        id: ALL_DECKS,
        slug: ALL_DECKS,
        path: '',
        label: 'All decks',
        type: '',
        summary: totals(matched.map((r) => r.summary)),
        hiddenBy: undefined,
      },
      ...matched,
    ],
    hiddenCount,
  }
}

export function DeckPicker({
  decks,
  summaries,
  height,
  onSelect,
  onPractice,
  onQuit,
  hiddenDecks,
  onToggleHidden,
}: DeckPickerProps): React.ReactElement {
  const [cursor, setCursor] = useState(0)
  const [filter, setFilter] = useState('')
  const [filtering, setFiltering] = useState(false)
  /* Per session and never written, the way yazi's `.` is: revealing a deck is a
     look at the collection, not a change to it. */
  const [showHidden, setShowHidden] = useState(false)
  /** What the last `H` did, or why it did nothing. Cleared by the next key. */
  const [message, setMessage] = useState('')

  const { rows, hiddenCount } = useMemo(
    () => buildRows(decks, summaries, hiddenDecks, filter, showHidden),
    [decks, summaries, hiddenDecks, filter, showHidden],
  )

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

    // Whatever the last `H` had to say is about the list as it was before this key.
    setMessage('')

    if (input === 'q' || key.escape || (key.ctrl && input === 'c')) {
      onQuit()
      return
    }
    if (input === '/') {
      setFiltering(true)
      return
    }
    /* Reveals the hidden decks rather than marking one hidden: what is hidden is
       the config's answer, and this is only whether the list shows it. Rows come
       and go around the cursor, so it follows the deck it was on rather than the
       index — a key for looking at the list should not also move you down it.
       A deck that leaves the list leaves the cursor where it was, to be clamped
       onto whatever now occupies the row. */
    if (input === '.') {
      const selected = rows[clampedCursor]?.id
      const next = buildRows(decks, summaries, hiddenDecks, filter, !showHidden)
      const index = next.rows.findIndex((row) => row.id === selected)
      setShowHidden((s) => !s)
      if (index >= 0) setCursor(index)
      return
    }
    /* Marks the deck under the cursor, where `.` only looks. It writes the source
       path rather than the slug: two source directories can hold the same relative
       path, so a slug would hide both files, and this key was pressed on one row. */
    if (input === 'H') {
      const row = rows[clampedCursor]
      if (!row) return
      if (row.id === ALL_DECKS) {
        setMessage('H hides one deck; move to a row first')
        return
      }
      if (row.hiddenBy === undefined) {
        setMessage(`hiding ${row.label}`)
        void onToggleHidden(row.path, true).catch((error: unknown) => {
          setMessage(`could not write the config: ${String(error)}`)
        })
        return
      }
      /* An entry naming a directory hides every deck under it, so dropping it
         here would show decks the cursor was never on. The config said it, and
         the config is where it gets unsaid; this names which entry that is. */
      if (row.hiddenBy !== row.path) {
        setMessage(`hidden by "${row.hiddenBy}" in the config, so H cannot show it`)
        return
      }
      setMessage(`showing ${row.label}`)
      void onToggleHidden(row.path, false).catch((error: unknown) => {
        setMessage(`could not write the config: ${String(error)}`)
      })
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
    // "All decks" means the decks on screen, so it honours the active filter.
    const chosen = (): string[] | undefined => {
      const row = rows[clampedCursor]
      if (!row) return undefined
      return row.id === ALL_DECKS ? rows.slice(1).map((r) => r.id) : [row.id]
    }

    if (input === 'p') {
      const paths = chosen()
      if (paths) onPractice(paths)
      return
    }
    if (key.return || input === ' ') {
      const paths = chosen()
      if (paths) onSelect(paths)
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

  // `.` is named only where it would do something; `H` always would.
  const hints = [
    'enter select',
    'p practice',
    'j/k move',
    '/ filter',
    'H hide',
    ...(hiddenCount === 0 ? [] : [`. ${showHidden ? 'hide' : 'show'} hidden`]),
    'q quit',
  ].join(' · ')

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          Select a deck
        </Text>
        <Text dimColor>
          {deckCount} decks{filter === '' ? '' : ` matching "${filter}"`}
          {/* A hidden deck missing from the list without a word is how a user
              concludes their collection lost a file. */}
          {hiddenCount === 0
            ? ''
            : showHidden
              ? ` · ${hiddenCount} hidden`
              : ` · +${hiddenCount} hidden`}
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
              // Grey, not absent: a revealed deck is still one you set aside.
              <Text key={row.id} inverse={selected} dimColor={row.hiddenBy !== undefined}>
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
      {filtering ? <Text color="yellow">/{filter}▏</Text> : <Text dimColor>{hints}</Text>}
      {message === '' ? null : <Text color="yellow">{message}</Text>}
    </Box>
  )
}

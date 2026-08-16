import type { DiagnosticCode } from './diagnostics.js'

export type CardImage = {
  alt: string
  /** The link destination as written. */
  src: string
  /** Resolved against the deck file's directory; a URI scheme is left untouched. */
  path: string
}

export type Flashcard = {
  id: string
  deckId: string
  deckTitle: string
  sourcePath: string
  sourceMtimeMs: number
  /** 1-based line of the card's `##` heading in the source file, for `$EDITOR`. */
  sourceLine: number
  /**
   * The frontmatter `type`, verbatim, or undefined when the file declared none.
   * The format leaves this key to the user, so there is no closed set to check it
   * against and no value that stands for "declared nothing" — `--untyped` does.
   */
  type?: string
  /** The `##` heading. The card's identity, and the front's first part. */
  title: string
  /** Front content below the heading, above the `***`; empty when there is none. */
  frontBody: string
  /** Back content: below the `***`, or the whole body when the card has no `***`. */
  back: string
  plainText: string
  images: CardImage[]
  /** Tags written in the card itself. */
  cardTags: string[]
  /** The effective set: file tags ∪ card tags. */
  tags: string[]
}

export type Deck = {
  id: string
  title: string
  sourcePath: string
  type?: string
  cardCount: number
}

export type ParseWarning = {
  sourcePath: string
  message: string
  /**
   * The conformance diagnostic this warning is, or null when it is one of ours.
   * Consumer-class severity is always a warning, so the code adds a name, not a
   * consequence.
   */
  code: DiagnosticCode | null
  /** The card the diagnostic belongs to, or null when it is file-level. */
  cardIndex: number | null
}

export type ParseResult = {
  decks: Deck[]
  cards: Flashcard[]
  warnings: ParseWarning[]
}

export type Grade = 'again' | 'hard' | 'good' | 'easy'

export type ReviewRecord = {
  cardId: string
  sourcePath: string
  sourceMtimeMs: number
  suspended: boolean
  dueAt: string
  intervalDays: number
  ease: number
  reps: number
  lapses: number
  lastReviewedAt?: string
}

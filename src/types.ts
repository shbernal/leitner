export type CardType = 'content' | 'film' | 'vocabulary' | 'unknown'

export type CardImage = {
  alt: string
  path: string
}

export type Flashcard = {
  id: string
  deckId: string
  deckTitle: string
  sourcePath: string
  sourceMtimeMs: number
  type: CardType
  title: string
  bodyMarkdown: string
  plainText: string
  images: CardImage[]
  tags: string[]
}

export type Deck = {
  id: string
  title: string
  sourcePath: string
  type: CardType
  cardCount: number
}

export type ParseWarning = {
  sourcePath: string
  message: string
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

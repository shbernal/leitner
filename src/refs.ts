/**
 * A card's *reference*: `deckSlug#headingSlug`, for example
 * `spanish-verbs#ser-vs-estar`.
 *
 * It is the name a person uses — readable, pasteable into a conversation, and
 * accepted back as a command argument. It is not `Flashcard.id`, which is the
 * sha1 review-state key and is never shown or accepted as input.
 *
 * Both halves are already computed by the parser, from the same `slugify` that
 * feeds the sha1. A reference drops the heading index the sha1 carries, so it
 * survives a card being inserted above it; it breaks on a heading rename or a
 * file move, exactly as the sha1 does.
 *
 * Pure: no I/O, and nothing here reads the filesystem or the state file.
 */

import type { Flashcard } from './types.js'

/** `ordinal` undefined renders no suffix; see `assignRefs` for when one applies. */
export function cardRef(deckId: string, headingSlug: string, ordinal?: number): string {
  const base = `${deckId}#${headingSlug}`
  return ordinal === undefined ? base : `${base}~${ordinal}`
}

export type AssignedRefs = {
  /** One reference per heading slug given, in the same order. */
  refs: string[]
  /** The slugs that occurred more than once, in first-seen order. */
  duplicated: string[]
}

/**
 * References for one file's cards, given their heading slugs in source order.
 *
 * When two headings slugify identically, **every** occurrence takes a 1-based
 * ordinal — none is left bare. A bare first occurrence would mean deleting that
 * card promotes the second into its reference, and with it into anything filed
 * against that reference. An ordinal instead makes the collision visible in the
 * reference itself, which is the thing actually worth fixing.
 */
export function assignRefs(deckId: string, headingSlugs: string[]): AssignedRefs {
  const counts = new Map<string, number>()
  for (const slug of headingSlugs) counts.set(slug, (counts.get(slug) ?? 0) + 1)

  const duplicated = [...counts].filter(([, count]) => count > 1).map(([slug]) => slug)

  const seen = new Map<string, number>()
  const refs = headingSlugs.map((slug) => {
    if ((counts.get(slug) ?? 0) < 2) return cardRef(deckId, slug)
    const ordinal = (seen.get(slug) ?? 0) + 1
    seen.set(slug, ordinal)
    return cardRef(deckId, slug, ordinal)
  })

  return { refs, duplicated }
}

export type ResolveResult =
  | { kind: 'found'; card: Flashcard }
  | { kind: 'none' }
  /** More than one card answers to the query; the caller lists these. */
  | { kind: 'ambiguous'; matches: Flashcard[] }

/**
 * The card a query names, or why it names none or several.
 *
 * An exact reference wins outright. Failing that the query is a prefix, so
 * `spanish-verbs#ser` finds `spanish-verbs#ser-vs-estar` and a query with no `#`
 * reaches every card of a deck. Two source roots holding the same relative path
 * produce one reference for two cards — the collision `parseDirectories` already
 * warns about — and that arrives here as ambiguity rather than a second warning.
 */
export function resolveRef(cards: Flashcard[], query: string): ResolveResult {
  const wanted = query.trim().toLowerCase()
  if (wanted === '') return { kind: 'none' }

  const exact = cards.filter((card) => card.ref === wanted)
  const matches = exact.length > 0 ? exact : cards.filter((card) => card.ref.startsWith(wanted))

  const only = matches[0]
  if (only === undefined) return { kind: 'none' }
  if (matches.length > 1) return { kind: 'ambiguous', matches }
  return { kind: 'found', card: only }
}

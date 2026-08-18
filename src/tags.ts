/**
 * Tags, per Flashcard Markdown §6.2–§6.3.
 *
 * The grammar is Obsidian's, adopted verbatim rather than invented: a deck usually
 * lives in a vault, and a tag the vault does not see is a tag the user did not write.
 * Alphanumerics (Unicode included), `_`, `-` and `/`, with at least one non-numeric
 * character, and `/` nests.
 */

const TAG_TOKEN = /^[\p{L}\p{N}_\-/]+$/u
const ALL_NUMERIC = /^\p{N}+$/u

/* The `#` has to open the token, so `C#` is not a tag and neither is the fragment of
   a URL. Anchoring on start-of-line or whitespace is what enforces that. */
const TAG_IN_TEXT = /(?:^|\s)#([\p{L}\p{N}_\-/]+)/gu

/* Backtick runs, so a tag inside a code span is not a tag (§6.2, and Obsidian). */
const CODE_SPAN = /(`+)(?:(?!\1)[\s\S])*?\1/g

const FENCE = /^\s*(```|~~~)/

function isTagToken(token: string): boolean {
  return TAG_TOKEN.test(token) && !ALL_NUMERIC.test(token)
}

/** Blanks out code spans while keeping every offset, so positions still line up. */
function maskCodeSpans(line: string): string {
  return line.replace(CODE_SPAN, (match) => ' '.repeat(match.length))
}

function tagsInLine(line: string): string[] {
  const found: string[] = []
  for (const match of maskCodeSpans(line).matchAll(TAG_IN_TEXT)) {
    const token = match[1]
    if (token !== undefined && isTagToken(token)) found.push(token)
  }
  return found
}

/**
 * True when the line carries nothing but tags. §6.3 makes rendering line-based
 * rather than token-based: such a line is metadata and is hidden, while a tag
 * written inside a sentence stays visible, because hiding it would render
 * "The #verbs group" as "The group".
 */
export function isTagsOnlyLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed === '') return false
  return trimmed.split(/\s+/).every((token) => token.startsWith('#') && isTagToken(token.slice(1)))
}

/**
 * Every tag in a block of markdown, in source order, deduplicated. Fenced code is
 * skipped wholesale — a `#comment` in a shell snippet is not a tag.
 */
export function scanTags(markdown: string): string[] {
  const found: string[] = []
  let inFence = false

  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    found.push(...tagsInLine(line))
  }

  return unique(found)
}

export function unique(tags: string[]): string[] {
  return [...new Set(tags)]
}

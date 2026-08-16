/**
 * The diagnostic codes of Flashcard Markdown §8. The list is closed in version 1:
 * a code that is not here is not a conformance signal, and adding one is a change
 * made in the spec repository, not here.
 *
 * Severity is a function of conformance class, not of the code. `leitner`
 * conforms as a **consumer** (§3.1), so every one of these is a warning — it never
 * refuses a file because one card in it is malformed.
 */

export const DIAGNOSTIC_CODES = [
  'stray-h1',
  'frontmatter-tags-not-a-sequence',
  'preamble-tag',
  'tag-sanitized',
  'unresolved-image',
  'malformed-card-skipped',
  'unrepresentable-content',
] as const

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number]

export type Diagnostic = {
  /** Conformance is asserted against this, never against the message. */
  code: DiagnosticCode
  /** The card it belongs to, or null when the diagnostic is file-level. */
  cardIndex: number | null
  /** Free-form and ours to word; no test anywhere may depend on it. */
  message: string
}

export function diagnostic(
  code: DiagnosticCode,
  message: string,
  cardIndex: number | null = null,
): Diagnostic {
  return { code, cardIndex, message }
}

import React from 'react'
import { Text } from 'ink'
import type { RenderedLine, Span } from '../render.js'

function SpanText({ span }: { span: Span }): React.ReactElement {
  return (
    <Text
      bold={span.bold ?? false}
      italic={span.italic ?? false}
      underline={span.underline ?? false}
      dimColor={span.dim ?? false}
      {...(span.color === undefined ? {} : { color: span.color })}
    >
      {span.text}
    </Text>
  )
}

/**
 * One rendered markdown line. Ink collapses an empty Text node, so blank lines
 * carry a single space to keep vertical rhythm inside the card box.
 */
export function MarkdownLine({ line }: { line: RenderedLine }): React.ReactElement {
  if (line.spans.length === 0) return <Text> </Text>
  return (
    <Text>
      {line.spans.map((span, i) => (
        <SpanText key={i} span={span} />
      ))}
    </Text>
  )
}

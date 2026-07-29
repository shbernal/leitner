/**
 * Kitty graphics protocol support for image previews.
 *
 * Only PNG is transmitted as pixels: the protocol's direct file transmission
 * (`f=100,t=f`) is defined for PNG, and anything else would mean decoding to
 * raw RGB in-process. Other formats fall back to the text attachment line.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

const ESC = '\u001b'
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export type ImageSupport = {
  /** Whether pixel previews can be emitted at all. */
  enabled: boolean
  /** Escape sequences need tmux passthrough wrapping. */
  tmux: boolean
  /** Human-readable explanation, shown when previews are unavailable. */
  reason: string
}

export function detectImageSupport(env: NodeJS.ProcessEnv = process.env): ImageSupport {
  const tmux = Boolean(env['TMUX'])
  const term = env['TERM'] ?? ''
  const termProgram = (env['TERM_PROGRAM'] ?? '').toLowerCase()

  const kitty =
    Boolean(env['KITTY_WINDOW_ID']) ||
    term.includes('kitty') ||
    termProgram === 'kitty' ||
    termProgram === 'ghostty' ||
    Boolean(env['GHOSTTY_RESOURCES_DIR']) ||
    Boolean(env['GHOSTTY_BIN_DIR'])

  if (!kitty) {
    return {
      enabled: false,
      tmux,
      reason: `terminal does not advertise the kitty graphics protocol (TERM=${term || 'unset'})`,
    }
  }
  return {
    enabled: true,
    tmux,
    reason: tmux ? 'kitty graphics via tmux passthrough' : 'kitty graphics',
  }
}

/** Wrap an escape sequence so tmux forwards it to the outer terminal. */
export function wrapForTmux(sequence: string): string {
  return `${ESC}Ptmux;${sequence.replaceAll(ESC, ESC + ESC)}${ESC}\\`
}

export type KittyPlacement = {
  /** Cell columns the image should occupy. */
  cols: number
  /** Cell rows the image should occupy. */
  rows: number
  tmux?: boolean
}

/**
 * Build the escape sequence that transmits and displays `absPath`.
 * Pure so the wire format can be asserted in tests.
 */
export function buildKittyImageSequence(absPath: string, placement: KittyPlacement): string {
  const payload = Buffer.from(absPath, 'utf8').toString('base64')
  const controls = [
    'a=T', // transmit and display in one go
    'f=100', // payload is a PNG
    't=f', // ...referenced by file path
    `c=${Math.max(1, Math.floor(placement.cols))}`,
    `r=${Math.max(1, Math.floor(placement.rows))}`,
    'C=1', // do not move the cursor
  ].join(',')
  const sequence = `${ESC}_G${controls};${payload}${ESC}\\`
  return placement.tmux ? wrapForTmux(sequence) : sequence
}

/** Sequence that removes every image currently placed on the screen. */
export function buildKittyClearSequence(tmux = false): string {
  const sequence = `${ESC}_Ga=d${ESC}\\`
  return tmux ? wrapForTmux(sequence) : sequence
}

export function hasPngExtension(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.png'
}

/** True when the file exists and really is a PNG, not just named like one. */
export async function isDisplayablePng(absPath: string): Promise<boolean> {
  if (!hasPngExtension(absPath)) return false
  let handle
  try {
    handle = await fs.open(absPath, 'r')
    const buffer = Buffer.alloc(PNG_MAGIC.length)
    const { bytesRead } = await handle.read(buffer, 0, PNG_MAGIC.length, 0)
    return bytesRead === PNG_MAGIC.length && buffer.equals(PNG_MAGIC)
  } catch {
    return false
  } finally {
    await handle?.close()
  }
}

/**
 * Whether tmux will forward graphics escapes. Returns null when tmux is not
 * running or the setting cannot be read.
 */
export async function tmuxPassthroughEnabled(): Promise<boolean | null> {
  if (!process.env['TMUX']) return null
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  try {
    const { stdout } = await promisify(execFile)('tmux', ['show', '-gv', 'allow-passthrough'])
    return stdout.trim() === 'on'
  } catch {
    return null
  }
}

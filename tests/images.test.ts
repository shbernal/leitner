import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildKittyClearSequence,
  buildKittyImageSequence,
  detectImageSupport,
  hasPngExtension,
  isDisplayablePng,
  wrapForTmux,
} from '../src/images.js'

const ESC = '\u001b'

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leitner-img-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('detectImageSupport', () => {
  it('enables previews under kitty', () => {
    const support = detectImageSupport({ TERM: 'xterm-kitty' })
    expect(support.enabled).toBe(true)
    expect(support.tmux).toBe(false)
  })

  it('enables previews under ghostty', () => {
    expect(detectImageSupport({ TERM_PROGRAM: 'ghostty' }).enabled).toBe(true)
    expect(detectImageSupport({ GHOSTTY_RESOURCES_DIR: '/usr/share/ghostty' }).enabled).toBe(true)
  })

  it('flags tmux so escapes get wrapped', () => {
    const support = detectImageSupport({
      TERM: 'tmux-256color',
      TMUX: '/tmp/tmux-1000/default,1,0',
      KITTY_WINDOW_ID: '1',
    })
    expect(support.enabled).toBe(true)
    expect(support.tmux).toBe(true)
  })

  it('reports why an ordinary terminal cannot preview', () => {
    const support = detectImageSupport({ TERM: 'xterm-256color' })
    expect(support.enabled).toBe(false)
    expect(support.reason).toContain('xterm-256color')
  })
})

describe('buildKittyImageSequence', () => {
  it('transmits the path as base64 with cell dimensions', () => {
    const sequence = buildKittyImageSequence('/tmp/a.png', { cols: 40, rows: 20 })
    expect(sequence.startsWith(`${ESC}_G`)).toBe(true)
    expect(sequence.endsWith(`${ESC}\\`)).toBe(true)
    expect(sequence).toContain('a=T')
    expect(sequence).toContain('f=100')
    expect(sequence).toContain('t=f')
    expect(sequence).toContain('c=40,r=20')
    const payload = sequence.slice(sequence.indexOf(';') + 1, -2)
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe('/tmp/a.png')
  })

  it('clamps dimensions to at least one cell', () => {
    expect(buildKittyImageSequence('/tmp/a.png', { cols: 0, rows: -3 })).toContain('c=1,r=1')
  })

  it('doubles escapes when wrapped for tmux', () => {
    const bare = buildKittyImageSequence('/tmp/a.png', { cols: 10, rows: 5 })
    const wrapped = buildKittyImageSequence('/tmp/a.png', { cols: 10, rows: 5, tmux: true })
    expect(wrapped).toBe(wrapForTmux(bare))
    expect(wrapped.startsWith(`${ESC}Ptmux;`)).toBe(true)
    expect(wrapped).toContain(`${ESC}${ESC}_G`)
  })
})

describe('buildKittyClearSequence', () => {
  it('deletes all placements', () => {
    expect(buildKittyClearSequence()).toBe(`${ESC}_Ga=d${ESC}\\`)
    expect(buildKittyClearSequence(true).startsWith(`${ESC}Ptmux;`)).toBe(true)
  })
})

describe('isDisplayablePng', () => {
  it('accepts a real PNG', async () => {
    const file = path.join(dir, 'real.png')
    await fs.writeFile(file, Buffer.concat([PNG_HEADER, Buffer.alloc(8)]))
    expect(await isDisplayablePng(file)).toBe(true)
  })

  it('rejects a file that only looks like a PNG', async () => {
    const file = path.join(dir, 'fake.png')
    await fs.writeFile(file, 'not actually a png')
    expect(await isDisplayablePng(file)).toBe(false)
  })

  it('rejects other formats and missing files', async () => {
    const jpg = path.join(dir, 'photo.jpg')
    await fs.writeFile(jpg, Buffer.from([0xff, 0xd8, 0xff]))
    expect(await isDisplayablePng(jpg)).toBe(false)
    expect(await isDisplayablePng(path.join(dir, 'gone.png'))).toBe(false)
    expect(hasPngExtension('a.PNG')).toBe(true)
    expect(hasPngExtension('a.jpg')).toBe(false)
  })
})

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultConfigPath, expandHome, readConfigFile, withDefaults } from '../src/config.js'

/*
 * Everything asserted here is a claim `docs/scheduling.md` makes in prose — the
 * defaults table and the sentence about missing files and unknown keys. Nothing else
 * pins them, so a change to the defaults should fail here before it reaches a user.
 */

let dir: string
let previousXdg: string | undefined

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leitner-config-'))
  previousXdg = process.env['XDG_CONFIG_HOME']
  process.env['XDG_CONFIG_HOME'] = dir
})

afterEach(async () => {
  if (previousXdg === undefined) delete process.env['XDG_CONFIG_HOME']
  else process.env['XDG_CONFIG_HOME'] = previousXdg
  await fs.rm(dir, { recursive: true, force: true })
})

async function writeConfig(config: unknown): Promise<void> {
  await fs.mkdir(path.join(dir, 'leitner'), { recursive: true })
  await fs.writeFile(path.join(dir, 'leitner', 'config.json'), JSON.stringify(config))
}

describe('defaultConfigPath', () => {
  it('honours XDG_CONFIG_HOME', () => {
    expect(defaultConfigPath()).toBe(path.join(dir, 'leitner', 'config.json'))
  })

  it('falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
    delete process.env['XDG_CONFIG_HOME']
    expect(defaultConfigPath()).toBe(path.join(os.homedir(), '.config', 'leitner', 'config.json'))
  })
})

describe('expandHome', () => {
  it('expands a bare ~ and a ~/ prefix', () => {
    expect(expandHome('~')).toBe(os.homedir())
    expect(expandHome('~/notes/flashcards')).toBe(path.join(os.homedir(), 'notes', 'flashcards'))
  })

  it('leaves everything else alone', () => {
    expect(expandHome('/absolute/decks')).toBe('/absolute/decks')
    expect(expandHome('relative/decks')).toBe('relative/decks')
    // Not a home reference: only `~` alone and a `~/` prefix are.
    expect(expandHome('~other/decks')).toBe('~other/decks')
  })
})

describe('readConfigFile and withDefaults', () => {
  it('reports an absent file as null, so onboarding can tell it from an empty one', async () => {
    expect(await readConfigFile()).toBeNull()
    await writeConfig({})
    expect(await readConfigFile()).toEqual({})
  })

  it('returns the documented defaults when there is no file', async () => {
    expect(withDefaults(await readConfigFile())).toEqual({
      sourceDir: path.join(os.homedir(), 'notes', 'flashcards'),
      dailyLimit: 50,
      defaultDeckFilter: null,
    })
  })

  it('reads the file XDG_CONFIG_HOME points at', async () => {
    await writeConfig({ sourceDir: '/decks', dailyLimit: 7, defaultDeckFilter: 'vocabulary' })
    expect(withDefaults(await readConfigFile())).toEqual({
      sourceDir: '/decks',
      dailyLimit: 7,
      defaultDeckFilter: 'vocabulary',
    })
  })

  it('expands ~ in sourceDir', async () => {
    await writeConfig({ sourceDir: '~/cards' })
    expect(withDefaults(await readConfigFile()).sourceDir).toBe(path.join(os.homedir(), 'cards'))
  })

  it('fills every absent key from the defaults', async () => {
    await writeConfig({ dailyLimit: 7 })
    expect(withDefaults(await readConfigFile())).toEqual({
      sourceDir: path.join(os.homedir(), 'notes', 'flashcards'),
      dailyLimit: 7,
      defaultDeckFilter: null,
    })
  })

  it('ignores unknown keys', async () => {
    await writeConfig({ dailyLimit: 7, theme: 'dark', scheduler: { ease: 9 } })
    expect(withDefaults(await readConfigFile())).toEqual({
      sourceDir: path.join(os.homedir(), 'notes', 'flashcards'),
      dailyLimit: 7,
      defaultDeckFilter: null,
    })
  })

  it('reads an explicit path over the default one', async () => {
    const explicit = path.join(dir, 'elsewhere.json')
    await fs.writeFile(explicit, JSON.stringify({ dailyLimit: 3 }))
    await writeConfig({ dailyLimit: 99 })
    expect(withDefaults(await readConfigFile(explicit)).dailyLimit).toBe(3)
  })
})

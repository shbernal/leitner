import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readConfigFile } from '../src/config.js'
import { main } from '../src/cli.js'
import { type Ask, runInit } from '../src/onboard.js'

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

let dir: string
let configPath: string
let lines: string[]

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leitner-onboard-'))
  configPath = path.join(dir, 'config', 'leitner', 'config.json')
  lines = []
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(dir, { recursive: true, force: true })
})

const out = (text: string): void => void lines.push(text)

/** Answers in order; running out is a failure rather than a hang. */
function answers(...queued: string[]): Ask {
  const remaining = [...queued]
  return (question) => {
    const answer = remaining.shift()
    if (answer === undefined) throw new Error(`unexpected question: ${question}`)
    return Promise.resolve(answer)
  }
}

describe('runInit', () => {
  it('writes every key, not only the answered one', async () => {
    const config = await runInit({ configPath, ask: answers(fixtures), out })

    expect(config.sourceDir).toBe(fixtures)
    expect(JSON.parse(await fs.readFile(configPath, 'utf8'))).toEqual({
      sourceDir: fixtures,
      dailyLimit: 50,
      defaultDeckFilter: null,
    })
  })

  it('reports what it found, which is what catches a wrong-but-real path', async () => {
    await runInit({ configPath, ask: answers(fixtures), out })
    expect(lines).toContainEqual(expect.stringContaining('Found 8 cards in 5 decks'))
  })

  it('accepts a directory with no cards in it yet', async () => {
    const empty = path.join(dir, 'empty')
    await fs.mkdir(empty)
    await runInit({ configPath, ask: answers(empty), out })
    expect((await readConfigFile(configPath))?.sourceDir).toBe(empty)
  })

  it('asks again after a path that is not there', async () => {
    const missing = path.join(dir, 'nope')
    await runInit({ configPath, ask: answers(missing, '', fixtures), out })

    expect(lines).toContainEqual(`no such directory: ${missing}`)
    expect((await readConfigFile(configPath))?.sourceDir).toBe(fixtures)
  })

  it('asks again after a path that is a file', async () => {
    const file = path.join(fixtures, 'with-frontmatter.md')
    await runInit({ configPath, ask: answers(file, fixtures), out })
    expect(lines).toContainEqual(`not a directory: ${file}`)
  })

  it('resolves ~ and a relative answer against a path that will outlive the shell', async () => {
    const relative = path.relative(process.cwd(), fixtures)
    await runInit({ configPath, ask: answers(relative), out })
    expect((await readConfigFile(configPath))?.sourceDir).toBe(fixtures)
  })

  it('keeps the other keys of an existing config when the directory moves', async () => {
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, JSON.stringify({ sourceDir: '/gone', dailyLimit: 7 }))

    await runInit({ configPath, ask: answers(fixtures), out })
    expect(await readConfigFile(configPath)).toEqual({
      sourceDir: fixtures,
      dailyLimit: 7,
      defaultDeckFilter: null,
    })
    // Re-running `init` is an edit, and saying "no configuration yet" would be a lie.
    expect(lines[0]).toBe(`leitner will update ${configPath}.`)
  })

  it('takes a directory instead of asking, and never prompts for it', async () => {
    const ask: Ask = () => Promise.reject(new Error('should not have asked'))
    await runInit({ configPath, dir: fixtures, ask, out })
    expect((await readConfigFile(configPath))?.sourceDir).toBe(fixtures)
  })

  it('rejects a given directory rather than falling back to the prompt', async () => {
    await expect(runInit({ configPath, dir: path.join(dir, 'nope'), out })).rejects.toThrow(
      'no such directory',
    )
    expect(await readConfigFile(configPath)).toBeNull()
  })
})

/*
 * The trigger, not the flow: onboarding must stay out of the way of every run
 * that already knows where to look, and must never block a pipe.
 */
describe('first run', () => {
  let previousXdg: string | undefined

  beforeEach(() => {
    previousXdg = process.env['XDG_CONFIG_HOME']
    process.env['XDG_CONFIG_HOME'] = path.join(dir, 'config')
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  })

  afterEach(() => {
    if (previousXdg === undefined) delete process.env['XDG_CONFIG_HOME']
    else process.env['XDG_CONFIG_HOME'] = previousXdg
  })

  // stdin is not a tty under vitest, so this is the real non-interactive path.
  it('refuses instead of prompting when there is no terminal to ask on', async () => {
    await expect(main(['list'])).rejects.toThrow('leitner init <dir>')
  })

  it('does not trigger when the directory came from the command line', async () => {
    await expect(main(['list', fixtures])).resolves.toBeUndefined()
  })

  it('does not trigger when a config already names one', async () => {
    await fs.mkdir(path.join(dir, 'config', 'leitner'), { recursive: true })
    await fs.writeFile(
      path.join(dir, 'config', 'leitner', 'config.json'),
      JSON.stringify({ sourceDir: fixtures }),
    )
    await expect(main(['list'])).resolves.toBeUndefined()
  })

  // `import` reads a bundle; the notes tree is not involved either way.
  it('does not trigger for import', async () => {
    await expect(main(['import', path.join(dir, 'absent.json')])).rejects.toThrow('no such bundle')
  })

  it('is what `init <dir>` runs directly', async () => {
    await main(['init', fixtures])
    expect(
      JSON.parse(
        await fs.readFile(path.join(dir, 'config', 'leitner', 'config.json'), 'utf8'),
      ) as unknown,
    ).toMatchObject({ sourceDir: fixtures })
  })
})

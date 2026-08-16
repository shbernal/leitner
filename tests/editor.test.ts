import { describe, expect, it } from 'vitest'
import { editorFromEnv, resolveEditorCommand } from '../src/editor.js'

const FILE = '/notes/algebra.md'

describe('editorFromEnv', () => {
  it('prefers $VISUAL over $EDITOR', () => {
    expect(editorFromEnv({ VISUAL: 'nvim', EDITOR: 'nano' })).toBe('nvim')
  })

  it('falls back to $EDITOR, then to vi', () => {
    expect(editorFromEnv({ EDITOR: 'nano' })).toBe('nano')
    expect(editorFromEnv({})).toBe('vi')
    expect(editorFromEnv({ EDITOR: '   ' })).toBe('vi')
  })
})

describe('resolveEditorCommand', () => {
  it('jumps to the line with +N for the vi and emacs families', () => {
    expect(resolveEditorCommand('nvim', FILE, 12)).toEqual({
      command: 'nvim',
      args: ['+12', FILE],
    })
    expect(resolveEditorCommand('nano', FILE, 3)).toEqual({ command: 'nano', args: ['+3', FILE] })
  })

  it('keeps the flags already in $EDITOR', () => {
    expect(resolveEditorCommand('emacsclient -nw', FILE, 7)).toEqual({
      command: 'emacsclient',
      args: ['-nw', '+7', FILE],
    })
  })

  it('recognises the editor behind an absolute path', () => {
    expect(resolveEditorCommand('/usr/local/bin/vim', FILE, 9)).toEqual({
      command: '/usr/local/bin/vim',
      args: ['+9', FILE],
    })
  })

  it('uses path:line syntax for helix', () => {
    expect(resolveEditorCommand('hx', FILE, 5)).toEqual({
      command: 'hx',
      args: [`${FILE}:5`],
    })
  })

  it('adds --wait for editors that would otherwise return immediately', () => {
    expect(resolveEditorCommand('code', FILE, 5)).toEqual({
      command: 'code',
      args: ['--wait', '--goto', `${FILE}:5`],
    })
    expect(resolveEditorCommand('subl', FILE, 5)).toEqual({
      command: 'subl',
      args: ['--wait', `${FILE}:5`],
    })
  })

  it('does not double up a wait flag the user already set', () => {
    expect(resolveEditorCommand('code -w', FILE, 5)).toEqual({
      command: 'code',
      args: ['-w', '--goto', `${FILE}:5`],
    })
  })

  it('passes only the path to an editor whose line syntax is unknown', () => {
    expect(resolveEditorCommand('acme', FILE, 5)).toEqual({ command: 'acme', args: [FILE] })
  })

  it('omits the line argument when there is no usable line', () => {
    expect(resolveEditorCommand('vim', FILE)).toEqual({ command: 'vim', args: [FILE] })
    expect(resolveEditorCommand('vim', FILE, 0)).toEqual({ command: 'vim', args: [FILE] })
  })
})

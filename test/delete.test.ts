import { afterAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const home = mkdtempSync(path.join(tmpdir(), 'af-home-'))
vi.mock('electron', () => ({ app: { getPath: () => home } }))
const { addWorktree, removeWorktree, worktreePath } = await import('../src/main/git')

const dirs: string[] = [home]
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim()
function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'af-del-'))
  dirs.push(dir)
  g(dir, 'init', '-q', '-b', 'master')
  writeFileSync(path.join(dir, 'a.txt'), 'a\n'); g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'base')
  return dir
}
const branches = (d: string) => g(d, 'branch', '--list', 'af/*')
const wtList = (d: string) => g(d, 'worktree', 'list', '--porcelain')
const STRICT = { force: false, strict: true }

describe('task deletion (no force)', () => {
  it('removes a clean unmerged worktree and its branch', async () => {
    const r = repo()
    await addWorktree(r, 'aaaaaaa1')
    writeFileSync(path.join(worktreePath('aaaaaaa1'), 'x.txt'), 'x'); g(worktreePath('aaaaaaa1'), 'add', '-A'); g(worktreePath('aaaaaaa1'), 'commit', '-q', '-m', 'work')
    await removeWorktree(r, 'aaaaaaa1', true, { ...STRICT, branchForce: true })
    expect(existsSync(worktreePath('aaaaaaa1'))).toBe(false)
    expect(wtList(r)).not.toContain('aaaaaaa1')
    expect(branches(r)).toBe('')
  })
  it('merged task: cleans up with branch -d and leaves master history untouched', async () => {
    const r = repo()
    await addWorktree(r, 'aaaaaaa2')
    const wt = worktreePath('aaaaaaa2')
    writeFileSync(path.join(wt, 'x.txt'), 'x'); g(wt, 'add', '-A'); g(wt, 'commit', '-q', '-m', 'work')
    g(r, 'merge', '--no-ff', '--no-edit', 'af/aaaaaaa2')
    const before = g(r, 'rev-parse', 'master')
    await removeWorktree(r, 'aaaaaaa2', true, { ...STRICT, branchForce: false })
    expect(branches(r)).toBe('')
    expect(g(r, 'rev-parse', 'master')).toBe(before)
    expect(g(r, 'log', '--oneline').split('\n').length).toBe(3)
  })
  it('refuses a dirty worktree: clear error, nothing deleted', async () => {
    const r = repo()
    await addWorktree(r, 'aaaaaaa3')
    writeFileSync(path.join(worktreePath('aaaaaaa3'), 'untracked.txt'), 'wip')
    await expect(removeWorktree(r, 'aaaaaaa3', true, { ...STRICT, branchForce: true })).rejects.toThrow(/git worktree remove failed/)
    expect(existsSync(worktreePath('aaaaaaa3'))).toBe(true)
    expect(branches(r)).toContain('af/aaaaaaa3')
  })
  it('unmerged branch is refused by -d (strict) instead of silently kept', async () => {
    const r = repo()
    await addWorktree(r, 'aaaaaaa4')
    const wt = worktreePath('aaaaaaa4')
    writeFileSync(path.join(wt, 'x.txt'), 'x'); g(wt, 'add', '-A'); g(wt, 'commit', '-q', '-m', 'work')
    await expect(removeWorktree(r, 'aaaaaaa4', true, { ...STRICT, branchForce: false })).rejects.toThrow(/branch delete failed/)
  })
  it('already-discarded task (no worktree, no branch) is a clean no-op', async () => {
    const r = repo()
    await expect(removeWorktree(r, 'aaaaaaa5', true, { ...STRICT, branchForce: true })).resolves.toBeUndefined()
  })
  it('worktree directory deleted by hand is pruned, then branch removed', async () => {
    const r = repo()
    await addWorktree(r, 'aaaaaaa6')
    rmSync(worktreePath('aaaaaaa6'), { recursive: true, force: true })
    await removeWorktree(r, 'aaaaaaa6', true, { ...STRICT, branchForce: true })
    expect(wtList(r)).not.toContain('aaaaaaa6')
    expect(branches(r)).toBe('')
  })
  it('rejects malformed ids', async () => {
    await expect(removeWorktree(repo(), '../evil', true, STRICT)).rejects.toThrow(/bad task id/)
  })
})

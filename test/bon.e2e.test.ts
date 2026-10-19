import { afterAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Task } from '../src/shared/types'

// Real-agent run: only with AF_E2E=1 (spends tokens, takes minutes).
const home = mkdtempSync(path.join(tmpdir(), 'af-home-'))
vi.mock('electron', () => ({ app: { getPath: () => home } }))
const { createSlots, runSlots, removeSlots } = await import('../src/main/bestofn')
const { mergeBranch, removeWorktree, worktreePath, fullDiff } = await import('../src/main/git')
import { DEFAULT_SETTINGS } from '../src/shared/types'

const dirs = [home]
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim()

describe.skipIf(!process.env.AF_E2E)('best-of-n end to end (N=2: claude + codex)', () => {
  it('runs both slots in parallel, tests them, merges the pick and cleans up the other', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'af-e2e-'))
    dirs.push(repo)
    g(repo, 'init', '-q', '-b', 'master')
    writeFileSync(path.join(repo, 'README.md'), '# demo\n')
    g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', 'base')

    const { slots, base } = await createSlots(repo, ['claude', 'codex'])
    const task: Task = {
      id: 'e2e00001', projectId: 'p', title: 'add function', status: 'created', branch: '', baseCommit: base, dirtyAtCreate: false, stages: [], mode: 'best-of-n', slots, createdAt: Date.now(),
      prompt: 'Create math.js exporting a CommonJS function add(a, b) that returns a+b, and math.test.js using node:test + node:assert that tests it. Nothing else.'
    }
    const seen = new Set<string>()
    const t0 = Date.now()
    await runSlots({ task, repo, settings: { ...DEFAULT_SETTINGS, stageTimeoutMin: 8 }, emit: (id) => seen.add(id), onChange: () => undefined })
    console.log('elapsed s', Math.round((Date.now() - t0) / 1000))
    for (const s of task.slots!) console.log(s.agent, s.status, s.testResult?.status, s.testResult?.passed + '/' + s.testResult?.total, s.output.slice(0, 120).replace(/\n/g, ' '))

    expect(seen.size).toBe(2) // both slots streamed logs
    expect(task.status).toBe('awaiting-approval')
    const done = task.slots!.filter((s) => s.status === 'done')
    expect(done.length).toBeGreaterThan(0)
    for (const s of done) {
      expect(s.head).toBeTruthy()
      expect(await fullDiff(worktreePath(s.id), base)).toContain('math')
    }

    // same sequence as the bon:select handler
    const pick = done[0]!
    await mergeBranch(repo, pick.id, pick.head!)
    for (const s of task.slots!) await removeWorktree(repo, s.id, true)
    expect(existsSync(path.join(repo, 'math.js'))).toBe(true)
    expect(g(repo, 'branch', '--list', 'af/*')).toBe('')
    expect(g(repo, 'worktree', 'list', '--porcelain')).not.toContain(slots[0]!.id)
    expect(readFileSync(path.join(repo, 'math.js'), 'utf8')).toMatch(/add/)
    await removeSlots(repo, []) // no-op sanity
  }, 600_000)
})

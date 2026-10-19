import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Slot, Task } from '../src/shared/types'

// Per-slot controls against fake claude.exe/codex.exe (see fixtures/fake-agent.cs). Windows-only: needs csc.exe.
const home = mkdtempSync(path.join(tmpdir(), 'af-home-'))
vi.mock('electron', () => ({ app: { getPath: () => home } }))
const { createSlots, runSlots, cancelSlot, isBonRunning, slotLogFile } = await import('../src/main/bestofn')
const { worktreePath } = await import('../src/main/git')
import { DEFAULT_SETTINGS } from '../src/shared/types'

const csc = ['v4.0.30319', 'v3.5'].map((v) => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', v, 'csc.exe')).find(existsSync)
const canRun = process.platform === 'win32' && !!csc

const bin = path.join(home, 'bin')
const dirs = [home]
const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (fn: () => boolean, ms = 8000) => {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition')
    await sleep(25)
  }
}
const work = (s: Slot) => readFileSync(path.join(worktreePath(s.id), `work_${s.agent}.txt`), 'utf8').trim().split('\n')

let repo = ''
let task: Task
let ctx: Parameters<typeof runSlots>[0]
const run = (opts?: Parameters<typeof runSlots>[1]) => runSlots(ctx, opts)
const [A, B] = [0, 1].map((i) => () => task.slots![i]!)

beforeAll(async () => {
  if (!canRun) return
  mkdirSync(bin, { recursive: true })
  execFileSync(csc!, ['/nologo', `/out:${path.join(bin, 'claude.exe')}`, path.join(__dirname, 'fixtures', 'fake-agent.cs')])
  copyFileSync(path.join(bin, 'claude.exe'), path.join(bin, 'codex.exe'))
  process.env.PATH = bin + path.delimiter + process.env.PATH

  repo = mkdtempSync(path.join(tmpdir(), 'af-ctl-'))
  dirs.push(repo)
  g(repo, 'init', '-q', '-b', 'master')
  g(repo, 'config', 'user.name', 't'); g(repo, 'config', 'user.email', 't@t')
  writeFileSync(path.join(repo, 'README.md'), '# demo\n')
  g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', 'base')
  const { slots, base } = await createSlots(repo, ['claude', 'codex'])
  task = { id: 'c0ffee01', projectId: 'p', title: 'ctl', prompt: 'do it', status: 'created', branch: '', baseCommit: base, dirtyAtCreate: false, stages: [], mode: 'best-of-n', slots, createdAt: Date.now() }
  ctx = { task, repo, settings: { ...DEFAULT_SETTINGS }, emit: () => undefined, onChange: () => undefined }
})
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

describe.skipIf(!canRun)('per-slot controls', () => {
  it('stops one running slot while the other finishes', async () => {
    task.prompt = 'do it SLEEP=3000'
    const p = run()
    await until(() => A().status === 'running' && B().status === 'running')
    await sleep(300) // let both processes start
    expect(cancelSlot(task, A().id)).toBe(true)
    await p
    expect(A().status).toBe('cancelled')
    expect(existsSync(path.join(worktreePath(A().id), 'work_claude.txt'))).toBe(false) // the process was really killed, not just flagged
    expect(B().status).toBe('done')
    expect(B().testResult?.status).toBe('none')
    expect(task.status).toBe('awaiting-approval') // one slot is pickable
    expect(isBonRunning(task.id)).toBe(false)
    expect(cancelSlot(task, A().id)).toBe(false) // nothing running anymore
  }, 30_000)

  it('refuses to stop a slot that is not running', () => {
    expect(cancelSlot(task, B().id)).toBe(false)
  })

  it('re-runs only the chosen slot and leaves the finished one untouched', async () => {
    const before = { head: B().head, output: B().output, work: work(B()) }
    task.prompt = 'do it SLEEP=100'
    await run({ only: [A().id] })
    expect(A().status).toBe('done')
    expect(A().head).toBeTruthy()
    expect(B().head).toBe(before.head)
    expect(B().output).toBe(before.output)
    expect(work(B())).toEqual(before.work)
  }, 30_000)

  it('continues a finished slot in the same worktree with a follow-up instruction', async () => {
    const oldHead = B().head
    await run({ only: [B().id], note: 'also add logging' })
    expect(B().status).toBe('done')
    expect(B().head).not.toBe(oldHead) // a new commit on top of the previous one
    expect(work(B())).toEqual(['initial', 'follow:also add logging'])
    const log = readFileSync(slotLogFile(task.id, B().id), 'utf8')
    expect(log).toContain('[user] also add logging')
    expect(B().output).toContain('follow-up')
  }, 30_000)

  it('applies an instruction queued while the slot runs, right after the current run', async () => {
    task.prompt = 'do it SLEEP=1500'
    const p = run({ only: [A().id] })
    await until(() => A().status === 'running')
    A().queued = 'second pass SLEEP=100'
    await p
    expect(A().status).toBe('done')
    expect(A().queued).toBeUndefined()
    expect(work(A()).slice(-2)).toEqual(['initial', 'follow:second pass SLEEP=100'])
  }, 30_000)

  it('drops a queued instruction when the slot is stopped', async () => {
    task.prompt = 'do it SLEEP=3000'
    const linesBefore = work(A()).length
    const p = run({ only: [A().id] })
    await until(() => A().status === 'running')
    await sleep(300)
    A().queued = 'never applied'
    expect(cancelSlot(task, A().id)).toBe(true)
    expect(A().queued).toBeUndefined()
    await p
    expect(A().status).toBe('cancelled')
    expect(work(A()).length).toBe(linesBefore) // neither the killed run nor the queued one wrote anything
  }, 30_000)
})

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AgentKind, PlanMessage, PlanThread } from '../src/shared/types'

// The planner runner against fake claude.exe/codex.exe (fixtures/fake-agent.cs). Windows-only: needs csc.exe.
const home = mkdtempSync(path.join(tmpdir(), 'af-home-'))
vi.mock('electron', () => ({ app: { getPath: () => home } }))
const { runPlanner, cancelPlanner, isPlannerRunning } = await import('../src/main/planner')
import { DEFAULT_SETTINGS } from '../src/shared/types'

const csc = ['v4.0.30319', 'v3.5'].map((v) => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', v, 'csc.exe')).find(existsSync)
const canRun = process.platform === 'win32' && !!csc
const dirs = [home]
const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let repo = ''
let seq = 0
const mkThread = (agent: AgentKind): PlanThread => ({
  id: `0000000${++seq}`, projectId: 'aaaaaaaa', title: 't', agent, conversation: 'continue', createdAt: 1, messages: [],
  contexts: [{ id: 'c1', label: '슬롯 1 요약', kind: 'paste', text: '결과 텍스트' }]
})
const mkReply = (agent: AgentKind): PlanMessage => ({ id: `m${++seq}`, role: 'agent', agent, text: '', status: 'running', createdTaskIds: [], createdAt: 2 })
async function ask(agent: AgentKind, goal: string, history: PlanMessage[] = [], thread = mkThread(agent)) {
  const message = mkReply(agent)
  thread.messages.push(message)
  const lines: string[] = []
  await runPlanner({ thread, message, goal, history, projectPath: repo, projectName: 'demo', settings: { ...DEFAULT_SETTINGS }, emit: (l) => lines.push(l), onChange: () => undefined })
  return { message, lines, thread }
}

beforeAll(() => {
  if (!canRun) return
  const bin = path.join(home, 'bin')
  mkdirSync(bin, { recursive: true })
  execFileSync(csc!, ['/nologo', `/out:${path.join(bin, 'claude.exe')}`, path.join(__dirname, 'fixtures', 'fake-agent.cs')])
  copyFileSync(path.join(bin, 'claude.exe'), path.join(bin, 'codex.exe'))
  process.env.PATH = bin + path.delimiter + process.env.PATH
  repo = mkdtempSync(path.join(tmpdir(), 'af-plan-'))
  dirs.push(repo)
  g(repo, 'init', '-q', '-b', 'master')
  writeFileSync(path.join(repo, 'README.md'), '# demo\n')
  g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', 'base')
})
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

describe.skipIf(!canRun)('planner runner', () => {
  it('claude: returns a parsed proposal and runs with read-only tools only', async () => {
    const { message, lines } = await ask('claude', '다음 작업을 설계해줘')
    expect(message.status).toBe('done')
    expect(message.proposal).toMatchObject({ title: 'fake proposal', mode: 'best-of-n', modeReason: 'fake reason', slotAgents: ['claude', 'codex'], risks: ['fake risk'], questions: ['fake question'] })
    expect(message.proposalError).toBeUndefined()
    expect(message.text).toContain('plan from claude')
    expect(message.text).toContain('ctx=yes') // the context item reached the prompt
    expect(message.text).toContain('--tools Read,Grep,Glob')
    expect(message.text).not.toMatch(/acceptEdits|--allowed-tools|Edit|Write/)
    expect(lines.length).toBeGreaterThan(0) // progress lines are streamed
  }, 30_000)

  it('codex: runs in a read-only sandbox rooted at the project', async () => {
    const { message } = await ask('codex', '다음 작업을 설계해줘')
    expect(message.status).toBe('done')
    expect(message.proposal?.title).toBe('fake proposal')
    expect(message.text).toContain('--sandbox read-only')
    expect(message.text).toContain('--ephemeral')
    expect(message.text).toContain(`-C ${repo}`)
    expect(message.text).not.toContain('workspace-write')
  }, 30_000)

  it('does not touch the project checkout or create worktrees', async () => {
    await ask('claude', '확인')
    expect(g(repo, 'status', '--porcelain')).toBe('')
    expect(readdirSync(repo).filter((f) => f.startsWith('work_'))).toEqual([])
    expect(g(repo, 'branch', '--list', 'af/*')).toBe('')
    expect(existsSync(path.join(home, 'worktrees'))).toBe(false)
  }, 30_000)

  it('keeps the recommended mode the agent chose', async () => {
    expect((await ask('claude', 'PROPOSE_PIPELINE 큰 작업')).message.proposal?.mode).toBe('pipeline')
    expect((await ask('codex', '작은 작업')).message.proposal?.mode).toBe('best-of-n')
  }, 30_000)

  it('a reply without a proposal block is still shown, with an explanation', async () => {
    const { message } = await ask('claude', 'NO_PROPOSAL')
    expect(message.status).toBe('done')
    expect(message.proposal).toBeUndefined()
    expect(message.proposalError).toMatch(/af-proposal 블록이 없습니다/)
    expect(message.text).toContain('plan from claude')
  }, 30_000)

  it('a broken proposal block becomes an error, not a crash', async () => {
    const { message } = await ask('codex', 'BAD_PROPOSAL')
    expect(message.status).toBe('done')
    expect(message.proposal).toBeUndefined()
    expect(message.proposalError).toMatch(/JSON/)
  }, 30_000)

  it('marks the message failed when the agent exits non-zero', async () => {
    const { message } = await ask('claude', 'FAIL=1')
    expect(message.status).toBe('failed')
    expect(message.proposal).toBeUndefined()
  }, 30_000)

  it('sends earlier turns again only when the caller passes them (continue vs fresh)', async () => {
    const prior: PlanMessage[] = [
      { id: 'u1', role: 'user', agent: 'claude', text: '첫 질문', status: 'done', createdTaskIds: [], createdAt: 1 },
      { id: 'a1', role: 'agent', agent: 'claude', text: '첫 답변', status: 'done', createdTaskIds: [], createdAt: 1 }
    ]
    expect((await ask('claude', '이어서', prior)).message.text).toContain('turns=2')
    expect((await ask('claude', '새로', [])).message.text).toContain('turns=0')
  }, 30_000)

  it('can be cancelled mid-run, kills the process and reports cancelled', async () => {
    const thread = mkThread('claude')
    const message = mkReply('claude')
    thread.messages.push(message)
    const t0 = Date.now()
    const p = runPlanner({ thread, message, goal: 'SLEEP=5000', history: [], projectPath: repo, projectName: 'demo', settings: { ...DEFAULT_SETTINGS }, emit: () => undefined, onChange: () => undefined })
    expect(isPlannerRunning(thread.id)).toBe(true)
    await sleep(500)
    cancelPlanner(thread.id)
    await p
    expect(message.status).toBe('cancelled')
    expect(isPlannerRunning(thread.id)).toBe(false)
    expect(Date.now() - t0).toBeLessThan(4_500) // did not wait for the 5s sleep
    expect(message.proposal).toBeUndefined()
  }, 30_000)

  it('fails cleanly when the agent executable is missing', async () => {
    const saved = process.env.PATH
    process.env.PATH = path.dirname(process.execPath) // node only: no claude.exe / codex.exe
    try {
      const { message } = await ask('claude', 'x')
      expect(message.status).toBe('failed')
      expect(message.text).toMatch(/not found on PATH/)
    } finally {
      process.env.PATH = saved
    }
  }, 30_000)
})

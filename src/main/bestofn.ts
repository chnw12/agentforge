import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AgentKind, Settings, Slot, Task } from '../shared/types'
import { killTree, resolveExe, runProcess } from './proc'
import { addWorktree, changedFiles, commitAll, removeWorktree, withRepoLock, worktreePath } from './git'
import { runTests, summarizeTests } from './testrun'
import { analyzeTestCoverage } from './coverage'
import { claudeArgs, logDir } from './pipeline'
import { parseEvent } from './parse'
import { redact } from './redact'

export const MIN_SLOTS = 2
export const MAX_SLOTS = 3

const LANG = 'Respond in Korean. Keep code, identifiers, paths and commands in their original form.'

export const QUEUE_NOTE_MAX = 4000

// one running batch per task; pids are tracked per slot so a single slot (or the whole fan-out) can be killed
type Active = { pids: Map<string, Set<number>>; cancelled: boolean; slotCancelled: Set<string> }
const active = new Map<string, Active>()
export const isBonRunning = (taskId: string) => active.has(taskId)
const stopped = (a: Active, slotId: string) => a.cancelled || a.slotCancelled.has(slotId)
const track = (a: Active, slotId: string) => (pid: number) => {
  let set = a.pids.get(slotId)
  if (!set) a.pids.set(slotId, (set = new Set()))
  set.add(pid)
  if (stopped(a, slotId)) killTree(pid) // the stop request may land before the process id is known
}
export function cancelBon(taskId: string): void {
  const a = active.get(taskId)
  if (!a) return
  a.cancelled = true
  for (const set of a.pids.values()) for (const p of set) killTree(p)
}
/** Stops one running slot; the other slots keep going. False when that slot is not running. */
export function cancelSlot(task: Task, slotId: string): boolean {
  const a = active.get(task.id)
  const s = task.slots?.find((x) => x.id === slotId)
  if (!a || !s || s.status !== 'running') return false
  a.slotCancelled.add(slotId)
  s.queued = undefined // an explicit stop also drops any instruction waiting behind the run
  for (const p of a.pids.get(slotId) ?? []) killTree(p)
  return true
}
export function killAllBon(): void {
  for (const id of [...active.keys()]) cancelBon(id)
}

export const slotLogFile = (taskId: string, slotId: string) => path.join(logDir(taskId), `slot-${slotId}.log`)

/**
 * Create every slot worktree up front, from the same base commit, under one repo lock.
 * If any step fails (or HEAD moved between slots) the ones already made are removed again.
 */
export async function createSlots(repo: string, agents: AgentKind[]): Promise<{ slots: Slot[]; base: string }> {
  if (agents.length < MIN_SLOTS || agents.length > MAX_SLOTS) throw new Error(`슬롯은 ${MIN_SLOTS}~${MAX_SLOTS}개여야 합니다`)
  return withRepoLock(repo, async () => {
    const made: Slot[] = []
    let base = ''
    try {
      for (const agent of agents) {
        const id = randomBytes(4).toString('hex')
        const w = await addWorktree(repo, id)
        made.push({ id, agent, branch: w.branch, status: 'pending', output: '' })
        base ||= w.base
        if (w.base !== base) throw new Error('슬롯 생성 중 저장소 HEAD가 바뀌었습니다. 다시 시도하세요')
      }
    } catch (e) {
      for (const s of made) await removeWorktree(repo, s.id, true).catch(() => undefined)
      throw e
    }
    return { slots: made, base }
  })
}

/** Remove every slot's worktree + branch. `strict` surfaces git refusals (used for task deletion). */
export async function removeSlots(repo: string, slots: Slot[], opts: { force?: boolean; branchForce?: boolean; strict?: boolean } = {}): Promise<void> {
  await withRepoLock(repo, async () => {
    for (const s of slots) await removeWorktree(repo, s.id, true, opts)
  })
}

function slotPrompt(t: Task, n: number, note?: string): string {
  const follow = note
    ? `
# Follow-up instruction from the user
This worktree already holds your previous attempt (changes may be committed or only partly applied). Continue from the current state of the files instead of starting over, unless the instruction says otherwise.
${note}
`
    : ''
  return `# Task\n${t.title}\n\n${t.prompt}\n
# Your job
You are one of ${n} independent BUILD agents attempting this same task in parallel, each in its own isolated git worktree. Implement the task directly in the current directory; there is no separate design step. Add or update tests for new behaviour. Do not run git commit/branch/checkout/merge/reset (the host handles git). Do not touch files outside this directory. Finish with a short summary of what changed and what is untested.
${follow}${LANG}`
}

export interface BonCtx {
  task: Task
  repo: string
  settings: Settings
  emit: (slotId: string, line: string) => void
  onChange: () => void
}

class Cancelled extends Error {}

function slotLogger(c: BonCtx, s: Slot) {
  let chain: Promise<unknown> = Promise.resolve()
  return {
    log(line: string) {
      const l = redact(line)
      chain = chain.then(() => fs.appendFile(slotLogFile(c.task.id, s.id), l + '\n', 'utf8')).catch(() => undefined)
      c.emit(s.id, l)
    },
    flush: () => chain
  }
}

/** Never rejects: every outcome is written into the slot. `note` = follow-up instruction continuing the worktree's previous state. */
async function runAgent(c: BonCtx, s: Slot, a: Active, note?: string): Promise<void> {
  const { task, settings } = c
  const wt = worktreePath(s.id)
  const { log, flush } = slotLogger(c, s)
  Object.assign(s, { status: 'running', startedAt: Date.now(), endedAt: undefined, exitCode: undefined, output: '', head: undefined, testResult: undefined, coverage: undefined })
  c.onChange()
  try {
    if (note) {
      log('--- 추가 지시로 이어서 실행 ---')
      log('[user] ' + note)
    }
    else await fs.writeFile(slotLogFile(task.id, s.id), '', 'utf8')
    const exe = resolveExe(s.agent)
    if (!exe) throw new Error(`${s.agent}.exe not found on PATH (.cmd shims are not supported)`)
    if (stopped(a, s.id)) throw new Cancelled()
    let args: string[]
    let outFile = ''
    if (s.agent === 'claude') args = claudeArgs('build', settings)
    else {
      outFile = path.join(logDir(task.id), `slot-${s.id}.last.txt`)
      args = ['exec', '--json', '--ephemeral', '--sandbox', 'workspace-write', '-C', wt, '-o', outFile]
      if (settings.codexModel) args.push('-m', settings.codexModel)
      args.push('-')
    }
    let final = ''
    const shown: string[] = []
    const res = await runProcess(exe, args, {
      cwd: wt,
      stdin: slotPrompt(task, task.slots?.length ?? 1, note),
      timeoutMs: settings.stageTimeoutMin * 60_000,
      onPid: track(a, s.id),
      onLine: (line, stream) => {
        if (stream === 'err') return log('[stderr] ' + line)
        const ev = parseEvent(s.agent, line)
        if (ev.show) {
          log(ev.show)
          shown.push(ev.show)
        }
        if (ev.final !== undefined) final = ev.final
      }
    })
    if (s.agent === 'codex') {
      const f = await fs.readFile(outFile, 'utf8').catch(() => '')
      if (f.trim()) final = f
    }
    s.output = redact(final || shown.join('\n')).slice(0, 200_000)
    s.exitCode = res.code
    if (stopped(a, s.id)) s.status = 'cancelled'
    else if (res.timedOut) {
      s.status = 'failed'
      log('[timeout] slot exceeded limit')
    } else if (res.truncated) s.status = 'failed'
    else s.status = res.code === 0 && s.output.trim() ? 'done' : 'failed'

    if (s.status === 'done') {
      const head = await commitAll(wt, `AgentForge best-of-n (${s.agent}): ${task.title}`.slice(0, 100))
      if (head === task.baseCommit) {
        s.status = 'failed'
        s.output += '\n\n[host] 이 슬롯은 변경사항을 만들지 않았습니다.'
        log('[host] no changes produced')
      } else {
        s.head = head
        log(`[host] committed worktree changes at ${head.slice(0, 10)}`)
      }
    }
  } catch (e) {
    if (e instanceof Cancelled || stopped(a, s.id)) s.status = 'cancelled'
    else {
      s.status = 'failed'
      s.output = String((e as Error).message)
      log('[error] ' + s.output)
    }
  } finally {
    await flush()
    s.endedAt = Date.now()
    c.onChange()
  }
}

async function testSlot(c: BonCtx, s: Slot, a: Active): Promise<void> {
  const wt = worktreePath(s.id)
  const { log, flush } = slotLogger(c, s)
  try {
    log('[tests] 프로젝트 테스트 명령 감지 중...')
    s.testResult = await runTests(wt, s.head!, (l) => log('[tests] ' + l), track(a, s.id))
    log(`[tests] ${summarizeTests(s.testResult)}`)
    try {
      s.coverage = analyzeTestCoverage(await changedFiles(wt, c.task.baseCommit))
    } catch (e) {
      s.coverage = { status: 'missing', reason: '변경 파일 분석 실패: ' + (e as Error).message, newSymbols: [], testFiles: [] }
    }
    log(`[coverage] ${s.coverage.status === 'ok' ? 'OK' : 'MISSING'} - ${s.coverage.reason}`)
  } catch (e) {
    log('[error] tests: ' + (e as Error).message)
  } finally {
    await flush()
    c.onChange()
  }
}

/** Runs a slot, then keeps applying instructions queued while it ran (unless it was stopped). */
async function runWithQueue(c: BonCtx, s: Slot, a: Active, first?: string): Promise<void> {
  let note = first
  for (;;) {
    await runAgent(c, s, a, note)
    note = s.queued
    s.queued = undefined
    if (!note || stopped(a, s.id)) return
  }
}

/**
 * Fan out the unfinished slots in parallel (agents), then test them one after another so
 * test runs in sibling worktrees never compete for ports/CPU. Done slots keep their result.
 */
export async function runSlots(c: BonCtx, opts: { only?: string[]; note?: string } = {}): Promise<void> {
  const { task } = c
  const a: Active = { pids: new Map(), cancelled: false, slotCancelled: new Set() }
  active.set(task.id, a) // synchronous: callers rely on isBonRunning() right after this call
  try {
    task.status = 'running'
    await fs.mkdir(logDir(task.id), { recursive: true })
    // `only` re-runs just those slots (even finished ones); otherwise every unfinished slot runs
    const todo = (task.slots ?? []).filter((s) => (opts.only ? opts.only.includes(s.id) : s.status !== 'done'))
    for (const s of todo) s.status = 'pending'
    c.onChange()
    await Promise.all(todo.map((s) => runWithQueue(c, s, a, opts.note)))
    for (const s of todo) if (s.status === 'done' && !stopped(a, s.id)) await testSlot(c, s, a)
  } finally {
    active.delete(task.id)
    task.status = task.slots?.some((s) => s.status === 'done') ? 'awaiting-approval' : 'failed'
    c.onChange()
  }
}

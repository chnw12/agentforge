import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { PlanMessage, PlanThread, Settings } from '../shared/types'
import { buildPlannerPrompt, parseProposal } from '../shared/planner'
import { killTree, resolveExe, runProcess } from './proc'
import { claudeArgs } from './pipeline'
import { withSkills } from './skills'
import { t as tr } from '../shared/i18n'
import { parseEvent } from './parse'
import { redact } from './redact'

// one running request per thread; pid kept so [cancel] and app quit can stop it
const active = new Map<string, { pid?: number; cancelled: boolean }>()
export const isPlannerRunning = (threadId: string) => active.has(threadId)

export function cancelPlanner(threadId: string): void {
  const a = active.get(threadId)
  if (!a) return
  a.cancelled = true
  if (a.pid) killTree(a.pid)
}
export function killAllPlanner(): void {
  for (const id of [...active.keys()]) cancelPlanner(id)
}

export const plannerDir = (threadId: string) => path.join(app.getPath('userData'), 'planner', threadId)

export interface PlannerCtx {
  thread: PlanThread
  message: PlanMessage // the agent message to fill in (status 'running')
  goal: string
  history: PlanMessage[] // earlier turns to send again (empty = fresh conversation)
  projectPath: string
  projectName: string
  settings: Settings
  emit: (line: string) => void
  onChange: () => void
}

/**
 * Asks the chosen agent for a next-task proposal. Read-only by construction: Claude gets only Read/Grep/Glob,
 * Codex runs in a read-only sandbox. Never rejects: every outcome is written into the message.
 */
export async function runPlanner(c: PlannerCtx): Promise<void> {
  const { thread, message: m, settings } = c
  const a: { pid?: number; cancelled: boolean } = { cancelled: false }
  active.set(thread.id, a) // synchronous: callers rely on isPlannerRunning() right after this call
  try {
    const exe = resolveExe(m.agent)
    if (!exe) throw new Error(`${m.agent}.exe not found on PATH (.cmd shims are not supported)`)
    const prompt = buildPlannerPrompt({ goal: c.goal, contexts: thread.contexts, history: c.history, projectName: c.projectName })
    let args: string[]
    let outFile = ''
    if (m.agent === 'claude') args = claudeArgs('design', settings)
    else {
      await fs.mkdir(plannerDir(thread.id), { recursive: true })
      outFile = path.join(plannerDir(thread.id), `${m.id}.last.txt`)
      args = ['exec', '--json', '--ephemeral', '--sandbox', 'read-only', '-C', c.projectPath, '-o', outFile]
      if (settings.codexModel) args.push('-m', settings.codexModel)
      args.push('-')
    }
    if (a.cancelled) throw new Error('cancelled')
    let final = ''
    const shown: string[] = []
    const stdin = await withSkills(prompt, m.agent, settings)
    const res = await runProcess(exe, args, {
      cwd: c.projectPath,
      stdin,
      timeoutMs: settings.stageTimeoutMin * 60_000,
      onPid: (p) => {
        a.pid = p
        if (a.cancelled) killTree(p)
      },
      onLine: (line, stream) => {
        if (stream === 'err') return c.emit('[stderr] ' + line)
        const ev = parseEvent(m.agent, line)
        if (ev.show) {
          c.emit(ev.show)
          shown.push(ev.show)
        }
        if (ev.final !== undefined) final = ev.final
      }
    })
    if (m.agent === 'codex') {
      const f = await fs.readFile(outFile, 'utf8').catch(() => '')
      if (f.trim()) final = f
    }
    m.text = redact(final || shown.join('\n')).slice(0, 200_000)
    if (a.cancelled) m.status = 'cancelled'
    else if (res.timedOut) {
      m.status = 'failed'
      m.text ||= '[timeout] ' + tr('에이전트가 제한 시간 안에 끝나지 않았습니다')
    } else if (res.truncated) m.status = 'failed'
    else m.status = res.code === 0 && m.text.trim() ? 'done' : 'failed'
    if (m.status === 'done') {
      const r = parseProposal(m.text)
      m.proposal = r.proposal
      m.proposalError = r.error
    }
  } catch (e) {
    if (a.cancelled) m.status = 'cancelled'
    else {
      m.status = 'failed'
      m.text = String((e as Error).message)
    }
  } finally {
    active.delete(thread.id)
    c.onChange()
  }
}

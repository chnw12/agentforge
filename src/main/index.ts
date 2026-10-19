import { app, BrowserWindow, dialog, ipcMain, Notification, session, shell, type IpcMainInvokeEvent } from 'electron'
import { transitions, type NotifyEvent } from './notify'
import { cancelPlanner, isPlannerRunning, killAllPlanner, runPlanner } from './planner'
import { PLAN_LIMITS, countRedactions, pickHistory, sanitizeText, truncateText } from '../shared/planner'
import { redact } from './redact'
import { listSkills } from './skills'
import { SKILL_LIMITS, parseSkillMd, sanitizeSkills } from '../shared/skills'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { DEFAULT_SETTINGS, type AgentKind, type AppState, type CliInfo, type Settings, type StageKind, type Task, type TaskMode, type PlanContextItem, type PlanMessage, type PlanThread, type TaskOrigin, type PlanConversationMode } from '../shared/types'
import { slotWarning } from '../shared/slot'
import { getState, loadState, saveState, saveStateSync } from './store'
import { capture, resolveExe } from './proc'
import { ID_RE, addWorktree, fullDiff, headOid, isDirty, isGitRepo, mergeBranch, removeWorktree, withRepoLock, worktreePath } from './git'
import { verdictOf } from './parse'
import { testsBlockMerge } from './testrun'
import { coverageBlocksMerge } from './coverage'
import { cancelTask, isRunning as isPipelineRunning, killAll as killAllPipeline, logFile, newId, newTaskStages, runStage } from './pipeline'
import { MAX_SLOTS, MIN_SLOTS, QUEUE_NOTE_MAX, cancelBon, cancelSlot, createSlots, isBonRunning, killAllBon, removeSlots, runSlots, slotLogFile } from './bestofn'

let win: BrowserWindow | null = null
const DEV_URL = process.env['ELECTRON_RENDERER_URL']
const STAGE_KINDS: StageKind[] = ['design', 'review', 'build', 'verify']
const isRunning = (id: string) => isPipelineRunning(id) || isBonRunning(id)
const killAll = () => { killAllPipeline(); killAllBon(); killAllPlanner() }
const isBon = (t: Task) => t.mode === 'best-of-n'

let lastStatuses: Map<string, string> | null = null

function broadcast(): void {
  win?.webContents.send('state', getState())
  void saveState()
  const { next, events } = transitions(lastStatuses, getState().tasks)
  lastStatuses = next
  if (getState().settings.notifications) for (const e of events) notifyUser(e)
}

// Toast + taskbar flash only while the window is in the background; when it is focused the sidebar already shows it.
function notifyUser(e: NotifyEvent): void {
  if (!win || win.isDestroyed() || win.isFocused()) return
  win.flashFrame(true)
  if (!Notification.isSupported()) return
  const n = new Notification({ title: `AgentForge · ${e.attention.label}`, body: e.title })
  n.on('click', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('focus-task', e.taskId)
  })
  n.show()
}

function notifyPlanner(threadId: string, title: string, body: string): void {
  if (!getState().settings.notifications || !win || win.isDestroyed() || win.isFocused()) return
  win.flashFrame(true)
  if (!Notification.isSupported()) return
  const n = new Notification({ title: `AgentForge · ${title}`, body })
  n.on('click', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('focus-planner', threadId)
  })
  n.show()
}

// Only our own renderer document may use the API: exact origin in dev, exact file in production.
function isAppUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (DEV_URL) return u.origin === new URL(DEV_URL).origin
    return u.protocol === 'file:' && u.pathname === new URL(pathToFileURL(path.join(__dirname, '../renderer/index.html')).href).pathname
  } catch {
    return false
  }
}

function trustedSender(e: IpcMainInvokeEvent): boolean {
  return !!win && e.senderFrame === win.webContents.mainFrame && isAppUrl(e.senderFrame.url)
}

// One mutating operation per task at a time (merge vs discard vs run races).
const taskBusy = new Set<string>()
async function exclusive<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
  if (taskBusy.has(id)) throw new Error('이 태스크에서 다른 작업이 진행 중입니다')
  taskBusy.add(id)
  try {
    return await fn()
  } finally {
    taskBusy.delete(id)
  }
}

function findThread(id: unknown): PlanThread {
  const th = typeof id === 'string' && ID_RE.test(id) ? getState().planners.find((x) => x.id === id) : undefined
  if (!th) throw new Error('unknown planner thread')
  return th
}

/** An origin is only accepted when it points at a real proposal the user can see in the planner. */
function checkOrigin(o: unknown): TaskOrigin {
  const v = o as Partial<TaskOrigin> | null
  const th = findThread(v?.threadId)
  const m = th.messages.find((x) => x.id === v?.messageId)
  if (!m || !m.proposal) throw new Error('invalid origin: 제안이 없는 메시지입니다')
  return { threadId: th.id, messageId: m.id }
}
function linkOrigin(taskId: string, origin: TaskOrigin | undefined): void {
  if (!origin) return
  const m = getState().planners.find((x) => x.id === origin.threadId)?.messages.find((x) => x.id === origin.messageId)
  if (m && !m.createdTaskIds.includes(taskId)) m.createdTaskIds.push(taskId)
}

function findTask(id: unknown): Task {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('invalid task id')
  const t = getState().tasks.find((x) => x.id === id)
  if (!t) throw new Error('unknown task')
  return t
}
function repoOf(t: Task): string {
  const p = getState().projects.find((x) => x.id === t.projectId)
  if (!p) throw new Error('project missing')
  return p.path
}
const str = (v: unknown, max: number, name: string): string => {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new Error(`invalid ${name}`)
  return v
}

function handle<A extends unknown[], R>(channel: string, fn: (...a: A) => Promise<R> | R): void {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!trustedSender(e)) throw new Error('untrusted sender')
    return fn(...(args as A))
  })
}

async function cliInfo(): Promise<CliInfo[]> {
  const out: CliInfo[] = []
  for (const name of ['claude', 'codex']) {
    const p = resolveExe(name)
    if (!p) {
      out.push({ name, path: null, version: null, error: 'not found (.exe on PATH required)' })
      continue
    }
    const r = await capture(p, ['--version'], app.getPath('home'), 20_000)
    out.push({ name, path: p, version: r.stdout.trim().split(/\r?\n/)[0] ?? null, error: r.code === 0 ? undefined : r.stderr.slice(0, 200) })
  }
  const g = await capture('git', ['--version'], app.getPath('home'), 10_000)
  out.push({ name: 'git', path: 'git', version: g.stdout.trim(), error: g.code === 0 ? undefined : 'git missing' })
  return out
}

async function cleanupTask(t: Task): Promise<void> {
  // merged/discarded tasks normally have nothing left; removeWorktree skips what is already gone. Main-branch merge commits are never touched.
  const repo = repoOf(t)
  if (isBon(t)) {
    await removeSlots(repo, t.slots ?? [], { force: false, branchForce: t.status !== 'merged', strict: true })
    return
  }
  // merged branches are fully contained in the main history -> plain `-d` is enough; unmerged work needs `-D` (the UI warns about it)
  await withRepoLock(repo, () => removeWorktree(repo, t.id, true, { force: false, branchForce: t.status !== 'merged', strict: true }))
}

async function dropTask(t: Task): Promise<void> {
  const st = getState()
  st.tasks = st.tasks.filter((x) => x.id !== t.id)
  await fs.rm(path.dirname(logFile(t.id, 'design')), { recursive: true, force: true }).catch(() => undefined)
}

function registerIpc(): void {
  handle('state:get', () => getState())
  handle('cli:info', () => cliInfo())
  handle('skills:list', () => listSkills())
  // a skill file picked by the user; only its text is returned (the renderer stores it in settings)
  handle('skills:pickFile', async (): Promise<{ name: string; text: string } | null> => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: '스킬 / 지침 파일', extensions: ['md', 'txt'] }] })
    const file = r.filePaths[0]
    if (r.canceled || !file) return null
    if ((await fs.stat(file)).size > 200_000) throw new Error('파일이 너무 큽니다 (200KB 이하만 가져올 수 있습니다)')
    const p = parseSkillMd(await fs.readFile(file, 'utf8'))
    const base = path.basename(file).toLowerCase() === 'skill.md' ? path.basename(path.dirname(file)) : path.basename(file, path.extname(file))
    return { name: (p.name || base).slice(0, SKILL_LIMITS.name), text: p.body.trim().slice(0, SKILL_LIMITS.text) }
  })

  handle('project:pick', async (): Promise<AppState> => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    const dir = r.filePaths[0]
    if (r.canceled || !dir) return getState()
    if (!(await isGitRepo(dir))) throw new Error('선택한 폴더는 git 저장소가 아닙니다')
    const id = createHash('sha1').update(dir.toLowerCase()).digest('hex').slice(0, 8)
    if (!getState().projects.some((p) => p.id === id)) getState().projects.push({ id, path: dir, name: path.basename(dir) })
    broadcast()
    return getState()
  })

  handle('task:create', async (input: { projectId: string; title: string; prompt: string; reTarget?: string; mode?: TaskMode; slotAgents?: AgentKind[]; origin?: TaskOrigin }) => {
    const project = getState().projects.find((p) => p.id === input?.projectId)
    if (!project) throw new Error('unknown project')
    const title = str(input.title, 120, 'title')
    const prompt = str(input.prompt, 20_000, 'prompt')
    let reTarget: string | undefined
    if (input.reTarget) {
      const rt = str(input.reTarget, 1000, 'reTarget')
      if (!path.isAbsolute(rt) || !existsSync(rt)) throw new Error('RE 대상은 존재하는 절대경로여야 합니다')
      reTarget = rt
    }
    const origin = input.origin === undefined ? undefined : checkOrigin(input.origin)
    const id = newId()
    const dirty = await isDirty(project.path)
    if (input.mode === 'best-of-n') {
      const agents = input.slotAgents
      if (!Array.isArray(agents) || agents.length < MIN_SLOTS || agents.length > MAX_SLOTS || !agents.every((a) => a === 'claude' || a === 'codex')) {
        throw new Error(`Best-of-N 슬롯은 ${MIN_SLOTS}~${MAX_SLOTS}개(claude/codex)여야 합니다`)
      }
      const { slots, base } = await createSlots(project.path, agents)
      getState().tasks.unshift({
        id, projectId: project.id, title, prompt, status: 'created', branch: '', baseCommit: base,
        dirtyAtCreate: dirty, stages: [], mode: 'best-of-n', slots, origin, createdAt: Date.now()
      })
      linkOrigin(id, origin)
      broadcast()
      return getState()
    }
    const { branch, base } = await withRepoLock(project.path, () => addWorktree(project.path, id))
    getState().tasks.unshift({
      id, projectId: project.id, title, prompt, reTarget, status: 'created', branch, baseCommit: base,
      dirtyAtCreate: dirty, stages: newTaskStages(), origin, createdAt: Date.now()
    })
    linkOrigin(id, origin)
    broadcast()
    return getState()
  })

  // Each click = one human approval gate. Stage runs in background; UI follows via 'state'/'log' events.
  handle('task:runNext', (id: string) => {
    const t = findTask(id)
    return exclusive(t.id, () => {
      if (isRunning(t.id)) throw new Error('이미 실행 중입니다')
      if (!['created', 'failed'].includes(t.status)) throw new Error(`현재 상태(${t.status})에서는 실행할 수 없습니다`)
      if (isBon(t)) {
        void runSlots({ task: t, repo: repoOf(t), settings: getState().settings, emit: (slot, line) => win?.webContents.send('log', { taskId: t.id, stage: 'build', line, slot }), onChange: broadcast })
        return getState()
      }
      const stage = t.stages.find((s) => s.status !== 'done')
      if (!stage) throw new Error('모든 단계가 완료되었습니다')
      void runStage(
        { task: t, settings: getState().settings, emit: (kind, line) => win?.webContents.send('log', { taskId: t.id, stage: kind, line }), onChange: broadcast },
        stage
      )
      return getState()
    })
  })

  handle('task:cancel', (id: string) => {
    const t = findTask(id)
    if (isBon(t)) cancelBon(t.id)
    else cancelTask(t.id)
    return getState()
  })

  handle('task:diff', async (id: string) => {
    const t = findTask(id)
    return fullDiff(worktreePath(t.id), t.baseCommit, 400_000)
  })

  handle('task:log', async (id: string, kind: StageKind) => {
    const t = findTask(id)
    if (!STAGE_KINDS.includes(kind)) throw new Error('invalid stage')
    return fs.readFile(logFile(t.id, kind), 'utf8').catch(() => '')
  })

  const findSlot = (t: Task, slotId: unknown) => {
    const s = isBon(t) ? t.slots?.find((x) => x.id === slotId) : undefined
    if (!s) throw new Error('unknown slot')
    return s
  }
  handle('bon:diff', async (id: string, slotId: string) => {
    const t = findTask(id)
    const s = findSlot(t, slotId)
    return fullDiff(worktreePath(s.id), t.baseCommit, 400_000)
  })
  handle('bon:log', async (id: string, slotId: string) => {
    const t = findTask(id)
    const s = findSlot(t, slotId)
    return fs.readFile(slotLogFile(t.id, s.id), 'utf8').catch(() => '')
  })

  // ---- planner: paste results -> an agent designs the next task -> the user decides whether to create it ----
  const CONTEXT_KINDS: PlanContextItem['kind'][] = ['paste', 'slot', 'stage', 'task', 'diff']
  const STAGES: StageKind[] = ['design', 'review', 'build', 'verify']
  const MAX_CONTEXTS = 20
  const MAX_THREADS = 100
  const agentOf = (v: unknown): AgentKind => { if (v !== 'claude' && v !== 'codex') throw new Error('에이전트는 claude 또는 codex여야 합니다'); return v }

  handle('planner:create', (projectId: string, title?: string) => {
    const project = getState().projects.find((p) => p.id === projectId)
    if (!project) throw new Error('unknown project')
    if (getState().planners.length >= MAX_THREADS) throw new Error(`계획 스레드는 최대 ${MAX_THREADS}개입니다. 오래된 스레드를 삭제하세요`)
    getState().planners.unshift({ id: newId(), projectId: project.id, title: title === undefined ? '새 계획' : str(title, PLAN_LIMITS.title, 'title'), agent: 'claude', conversation: 'continue', contexts: [], messages: [], createdAt: Date.now() })
    broadcast()
    return getState()
  })
  handle('planner:delete', (threadId: string) => {
    const th = findThread(threadId)
    if (isPlannerRunning(th.id)) throw new Error('실행 중인 스레드는 삭제할 수 없습니다. 먼저 중지하세요')
    getState().planners = getState().planners.filter((x) => x.id !== th.id)
    void fs.rm(path.join(app.getPath('userData'), 'planner', th.id), { recursive: true, force: true }).catch(() => undefined)
    broadcast()
    return getState()
  })
  handle('planner:setOptions', (threadId: string, opts: { agent?: AgentKind; conversation?: PlanConversationMode; title?: string }) => {
    const th = findThread(threadId)
    if (opts?.title !== undefined) th.title = str(opts.title, PLAN_LIMITS.title, 'title').trim() || th.title
    if (opts?.agent !== undefined || opts?.conversation !== undefined) {
      if (isPlannerRunning(th.id)) throw new Error('실행 중에는 에이전트와 대화 방식을 바꿀 수 없습니다')
      if (opts.agent !== undefined) th.agent = agentOf(opts.agent)
      if (opts.conversation !== undefined) {
        if (opts.conversation !== 'continue' && opts.conversation !== 'fresh') throw new Error('invalid conversation mode')
        th.conversation = opts.conversation
      }
    }
    broadcast()
    return getState()
  })
  handle('planner:addContext', (threadId: string, item: { label: string; kind: PlanContextItem['kind']; text: string; source?: PlanContextItem['source'] }) => {
    const th = findThread(threadId)
    if (th.contexts.length >= MAX_CONTEXTS) throw new Error(`컨텍스트는 최대 ${MAX_CONTEXTS}개입니다. 불필요한 항목을 제거하세요`)
    if (!CONTEXT_KINDS.includes(item?.kind)) throw new Error('invalid context kind')
    const label = str(item.label, 200, 'label')
    if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 2_000_000) throw new Error('invalid context text')
    let source: PlanContextItem['source']
    if (item.source) {
      if (!ID_RE.test(item.source.taskId)) throw new Error('invalid context source')
      if (item.source.slotId !== undefined && !ID_RE.test(item.source.slotId)) throw new Error('invalid context source')
      if (item.source.stage !== undefined && !STAGES.includes(item.source.stage)) throw new Error('invalid context source')
      source = { taskId: item.source.taskId, slotId: item.source.slotId, stage: item.source.stage }
    }
    // secrets are masked before anything is stored or sent to an agent
    const masked = redact(sanitizeText(item.text))
    const { text, truncated } = truncateText(masked.trim(), PLAN_LIMITS.item)
    th.contexts.push({ id: newId(), label, kind: item.kind, text, source, truncated, redacted: countRedactions(masked) - countRedactions(item.text) })
    broadcast()
    return getState()
  })
  handle('planner:removeContext', (threadId: string, itemId: string) => {
    const th = findThread(threadId)
    th.contexts = th.contexts.filter((c) => c.id !== itemId)
    broadcast()
    return getState()
  })
  handle('planner:send', (threadId: string, text: string) => {
    const th = findThread(threadId)
    if (isPlannerRunning(th.id)) throw new Error('이미 실행 중입니다')
    const project = getState().projects.find((p) => p.id === th.projectId)
    if (!project) throw new Error('이 스레드의 프로젝트가 목록에서 제거되었습니다')
    if (typeof text !== 'string' || !text.trim() || text.length > PLAN_LIMITS.goal) throw new Error(`하고 싶은 일은 1~${PLAN_LIMITS.goal}자여야 합니다`)
    if (!resolveExe(th.agent)) throw new Error(`${th.agent}.exe를 찾을 수 없습니다 (PATH의 .exe만 지원)`)
    const goal = redact(sanitizeText(text)).trim()
    const history = th.conversation === 'continue' ? pickHistory(th.messages) : []
    const now = Date.now()
    th.messages.push({ id: newId(), role: 'user', agent: th.agent, text: goal, status: 'done', createdTaskIds: [], createdAt: now })
    const reply: PlanMessage = { id: newId(), role: 'agent', agent: th.agent, text: '', status: 'running', createdTaskIds: [], createdAt: now + 1 }
    th.messages.push(reply)
    void runPlanner({
      thread: th, message: reply, goal, history, projectPath: project.path, projectName: project.name, settings: getState().settings,
      emit: (line) => win?.webContents.send('planner-log', { threadId: th.id, line }),
      onChange: broadcast
    }).then(() => {
      if (reply.status === 'done') notifyPlanner(th.id, reply.proposal ? '계획 제안 도착' : '계획 응답 도착', th.title)
      else if (reply.status === 'failed') notifyPlanner(th.id, '계획 요청 실패', th.title)
    })
    broadcast()
    return getState()
  })
  handle('planner:cancel', (threadId: string) => {
    const th = findThread(threadId)
    cancelPlanner(th.id)
    return getState()
  })

  // Per-slot controls. Agents are one-shot processes, so "steering" means: stop one slot, queue an instruction
  // behind the current run, or re-run one finished slot on top of its worktree with an instruction.
  const noteOf = (v: unknown) => {
    if (v === undefined || v === null) return ''
    if (typeof v !== 'string' || v.length > QUEUE_NOTE_MAX) throw new Error(`추가 지시는 ${QUEUE_NOTE_MAX}자 이하의 텍스트여야 합니다`)
    return v.trim()
  }
  handle('bon:cancelSlot', (id: string, slotId: string) => {
    const t = findTask(id)
    findSlot(t, slotId)
    if (!cancelSlot(t, slotId)) throw new Error('실행 중인 슬롯만 중지할 수 있습니다')
    broadcast()
    return getState()
  })
  handle('bon:queueNote', (id: string, slotId: string, note: unknown) => {
    const t = findTask(id)
    const s = findSlot(t, slotId)
    if (!isBonRunning(t.id) || s.status !== 'running') throw new Error('실행 중인 슬롯에만 지시를 대기열에 넣을 수 있습니다. 끝난 슬롯은 "다시 실행"을 사용하세요')
    s.queued = noteOf(note) || undefined // empty text clears the queue
    broadcast()
    return getState()
  })
  handle('bon:runSlot', (id: string, slotId: string, note: unknown) => {
    const t = findTask(id)
    return exclusive(t.id, () => {
      const s = findSlot(t, slotId)
      const text = noteOf(note) // validate the input before looking at state
      if (isRunning(t.id)) throw new Error('다른 슬롯이 실행 중입니다. 끝난 뒤에 다시 실행하세요')
      if (!['created', 'failed', 'awaiting-approval'].includes(t.status)) throw new Error(`현재 상태(${t.status})에서는 실행할 수 없습니다`)
      void runSlots({ task: t, repo: repoOf(t), settings: getState().settings, emit: (slot, line) => win?.webContents.send('log', { taskId: t.id, stage: 'build', line, slot }), onChange: broadcast }, { only: [s.id], note: text || undefined })
      return getState()
    })
  })

  // The user compares the slots, picks one: merge it, then remove every other slot. Nothing is cleaned if the merge fails.
  handle('bon:select', (id: string, slotId: string, force: boolean) => {
    const t = findTask(id)
    return exclusive(t.id, async () => {
      if (!isBon(t) || t.status !== 'awaiting-approval' || isRunning(t.id)) throw new Error('비교 대기 중인 Best-of-N 태스크만 선택할 수 있습니다')
      const pick = findSlot(t, slotId)
      if (pick.status !== 'done' || !pick.head) throw new Error('완료된 슬롯만 선택할 수 있습니다')
      const warn = slotWarning(pick)
      if (warn && force !== true) throw new Error(`${warn} - 그래도 선택하려면 경고를 확인하고 강제 선택하세요`)
      const repo = repoOf(t)
      await withRepoLock(repo, () => mergeBranch(repo, pick.id, pick.head!))
      t.status = 'merged'
      t.selectedSlot = pick.id
      broadcast()
      const leftovers = (t.slots ?? []).filter((x) => x.id !== pick.id)
      const failed: string[] = []
      await withRepoLock(repo, async () => {
        for (const x of [pick, ...leftovers]) await removeWorktree(repo, x.id, true).catch((e) => failed.push(`${x.branch}: ${(e as Error).message}`))
      })
      if (failed.length) throw new Error('머지는 완료되었지만 일부 정리에 실패했습니다 (태스크 삭제로 다시 시도 가능):\n' + failed.join('\n'))
      return getState()
    })
  })

  handle('task:approve', (id: string) => {
    const t = findTask(id)
    return exclusive(t.id, async () => {
      if (t.status !== 'awaiting-approval') throw new Error('검증(PASS)이 끝난 태스크만 승인할 수 있습니다')
      // defence in depth: even if status was reached some other way, a failed test run or a moved head blocks approval
      const v = t.stages.find((s) => s.kind === 'verify')
      const head = await headOid(worktreePath(t.id))
      if (!v || v.status !== 'done' || verdictOf(v.output) !== 'PASS') throw new Error('2차검증이 PASS가 아닙니다 - 승인 불가')
      if (testsBlockMerge(v.testResult)) throw new Error('실제 테스트 실행이 통과하지 못했습니다 - 승인 불가')
      if (coverageBlocksMerge(v.coverage)) throw new Error('새 기능에 대한 테스트 변경이 없습니다 - 승인 불가')
      if (v.testResult && v.testResult.head !== head) throw new Error('테스트 실행 이후 브랜치가 변경되었습니다 - 2차검증을 다시 실행하세요')
      t.approvedHead = head
      t.status = 'ready-to-merge'
      broadcast()
      return getState()
    })
  })

  handle('task:merge', (id: string) => {
    const t = findTask(id)
    return exclusive(t.id, async () => {
      if (t.status !== 'ready-to-merge' || !t.approvedHead) throw new Error('승인된 태스크만 머지할 수 있습니다')
      const repo = repoOf(t)
      await withRepoLock(repo, async () => {
        await mergeBranch(repo, t.id, t.approvedHead!)
        await removeWorktree(repo, t.id, true)
      })
      t.status = 'merged'
      broadcast()
      return getState()
    })
  })

  handle('task:discard', (id: string) => {
    const t = findTask(id)
    return exclusive(t.id, async () => {
      if (isRunning(t.id)) throw new Error('실행 중에는 폐기할 수 없습니다')
      if (t.status === 'merged' || t.status === 'discarded') throw new Error('이미 종료된 태스크입니다')
      const repo = repoOf(t)
      if (isBon(t)) await removeSlots(repo, t.slots ?? [])
      else await withRepoLock(repo, () => removeWorktree(repo, t.id, true))
      t.status = 'discarded'
      broadcast()
      return getState()
    })
  })

  // Delete a task: non-forced worktree removal + branch delete, then drop it from state. Any git refusal aborts and keeps the task.
  handle('task:delete', (id: string) => {
    const t = findTask(id)
    return exclusive(t.id, async () => {
      if (isRunning(t.id) || t.status === 'running') throw new Error('실행 중인 태스크는 삭제할 수 없습니다. 먼저 중지하세요')
      await cleanupTask(t)
      await dropTask(t)
      broadcast()
      return getState()
    })
  })

  // Remove a project from the AgentForge list only (the folder / git repo is never touched). cleanup=true also deletes its tasks' worktrees+branches first.
  handle('project:remove', async (projectId: string, cleanup: boolean) => {
    const p = getState().projects.find((x) => x.id === projectId)
    if (!p) throw new Error('unknown project')
    const tasks = getState().tasks.filter((t) => t.projectId === p.id)
    if (tasks.some((t) => isRunning(t.id) || t.status === 'running')) throw new Error('실행 중인 태스크가 있습니다. 먼저 중지하세요')
    const busy = tasks.find((t) => taskBusy.has(t.id))
    if (busy) throw new Error('이 프로젝트의 태스크에서 다른 작업이 진행 중입니다')
    for (const t of tasks) taskBusy.add(t.id)
    try {
      if (cleanup) {
        // all-or-nothing is not possible with git, so stop at the first refusal; tasks already cleaned stay removed
        for (const t of tasks) {
          await cleanupTask(t)
          await dropTask(t)
        }
      } else {
        for (const t of tasks) await dropTask(t)
      }
      getState().projects = getState().projects.filter((x) => x.id !== p.id)
      broadcast()
      return getState()
    } catch (e) {
      broadcast()
      throw e
    } finally {
      for (const t of tasks) taskBusy.delete(t.id)
    }
  })

  handle('settings:save', async (s: Settings) => {
    const next: Settings = {
      claudeSafeMode: s.claudeSafeMode === true,
      skills: sanitizeSkills(s.skills),
      claudeModel: typeof s.claudeModel === 'string' && /^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,59}$|^$/.test(s.claudeModel) ? s.claudeModel : DEFAULT_SETTINGS.claudeModel,
      codexModel: typeof s.codexModel === 'string' && /^[A-Za-z0-9._-]{0,60}$/.test(s.codexModel) ? s.codexModel : DEFAULT_SETTINGS.codexModel,
      stageTimeoutMin: Math.min(120, Math.max(1, Math.floor(Number(s.stageTimeoutMin)) || DEFAULT_SETTINGS.stageTimeoutMin)),
      reCommand: '',
      buildAllowedTools: str(s.buildAllowedTools, 500, 'buildAllowedTools'),
      notifications: s.notifications !== false
    }
    if (s.reCommand) {
      const rc = str(s.reCommand, 1000, 'reCommand')
      if (!path.isAbsolute(rc) || !/\.exe$/i.test(rc) || !existsSync(rc)) throw new Error('rea 경로는 존재하는 절대경로 .exe여야 합니다')
      next.reCommand = rc
    }
    getState().settings = next
    broadcast()
    return getState()
  })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 960, minHeight: 600, backgroundColor: '#14161a', title: 'AgentForge',
    webPreferences: { preload: path.join(__dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true }
  })
  win.on('focus', () => win?.flashFrame(false))
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault()
  })
  if (DEV_URL) void win.loadURL(DEV_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  // deny everything except writing plain text to the clipboard (BonView copy button); reading stays denied
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'clipboard-sanitized-write'))
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'clipboard-sanitized-write')
  await loadState()
  lastStatuses = transitions(null, getState().tasks).next // baseline: tasks restored from disk never notify
  app.setAppUserModelId('dev.leecw.agentforge') // Windows toasts need an app id
  registerIpc()
  createWindow()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})

app.on('before-quit', () => {
  killAll()
  saveStateSync() // pending async saves must not be lost on quit
})
app.on('window-all-closed', () => {
  killAll()
  app.quit()
})

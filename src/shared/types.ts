export type AgentKind = 'claude' | 'codex'
export type StageKind = 'design' | 'review' | 'build' | 'verify'
export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled'
export type TaskStatus = 'created' | 'running' | 'awaiting-approval' | 'ready-to-merge' | 'merged' | 'discarded' | 'failed'

/** Result of the host-run test command that precedes the verifier. 'none' = no test command detected (review-only fallback). */
export type TestStatus = 'pass' | 'fail' | 'timeout' | 'error' | 'none'
export interface TestResult {
  status: TestStatus
  command: string // human-readable, e.g. "node --test" or "npm test"
  head: string // commit the tests ran against; approval requires it to still be the branch head
  durationMs: number
  exitCode?: number | null
  total?: number
  passed?: number
  failed?: number
  failures: string[] // failing test names + first reason lines
  output: string // redacted, bounded tail of combined stdout/stderr
}

/** Deterministic "new public function without any test change" rule. Only 'missing' blocks. */
export interface CoverageResult {
  status: 'ok' | 'missing'
  reason: string
  newSymbols: string[]
  testFiles: string[]
}

export interface Stage {
  kind: StageKind
  agent: AgentKind
  status: StageStatus
  startedAt?: number
  endedAt?: number
  exitCode?: number | null
  output: string // final answer text (bounded)
  testResult?: TestResult // verify stage only
  coverage?: CoverageResult // verify stage only
}

export type TaskMode = 'pipeline' | 'best-of-n'

/** One independent attempt of a Best-of-N task. Each slot owns a worktree `af/<id>` (its id is a valid worktree id). */
export interface Slot {
  id: string
  agent: AgentKind
  branch: string
  status: StageStatus
  startedAt?: number
  endedAt?: number
  exitCode?: number | null
  output: string // final answer text (bounded) or failure reason
  head?: string // commit the slot's work was committed at; merge requires the branch to still be here
  testResult?: TestResult
  coverage?: CoverageResult
  queued?: string // follow-up instruction typed while the slot runs; applied right after the current run ends
}

export interface Task {
  id: string
  projectId: string
  title: string
  prompt: string
  reTarget?: string // absolute path analysed by rea (RE mode)
  status: TaskStatus
  branch: string
  baseCommit: string
  dirtyAtCreate: boolean
  stages: Stage[]
  approvedHead?: string // head OID pinned at approval time
  mode?: TaskMode // absent = 'pipeline' (tasks created before Best-of-N existed)
  slots?: Slot[] // best-of-n only; stages is empty and branch is '' for these tasks
  selectedSlot?: string // best-of-n only: slot merged by the user
  origin?: TaskOrigin // set when the task was created from a planner proposal
  createdAt: number
}

/** Where a task came from: the planner thread/message whose proposal the user turned into this task. */
export interface TaskOrigin { threadId: string; messageId: string }

/** One piece of context the user gave the planner (a pasted result or a digest of a slot/stage/task). Stored as a snapshot. */
export interface PlanContextItem {
  id: string
  label: string
  kind: 'paste' | 'slot' | 'stage' | 'task' | 'diff'
  text: string
  source?: { taskId: string; slotId?: string; stage?: StageKind }
  truncated?: boolean
  redacted?: number // how many secret-looking strings were masked before it was stored
}

/** The structured next-task suggestion an agent returns. Only a proposal: a task exists only after the user creates it. */
export interface PlanProposal {
  title: string
  prompt: string // self-contained request for the new task
  mode: TaskMode // the agent's recommendation; the card preselects it and the user may change it
  modeReason?: string
  slotAgents: AgentKind[] // used when mode is best-of-n (2..3)
  rationale?: string
  risks: string[]
  questions: string[]
}

export type PlanMessageStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'
export interface PlanMessage {
  id: string
  role: 'user' | 'agent'
  agent: AgentKind
  text: string
  status: PlanMessageStatus
  proposal?: PlanProposal
  proposalError?: string
  createdTaskIds: string[]
  createdAt: number
}

/** continue = earlier turns are sent again with each request; fresh = every request starts from the contexts only. */
export type PlanConversationMode = 'continue' | 'fresh'
export interface PlanThread {
  id: string
  projectId: string
  title: string
  agent: AgentKind
  conversation: PlanConversationMode
  contexts: PlanContextItem[]
  messages: PlanMessage[]
  createdAt: number
}

export interface Project { id: string; path: string; name: string }

/** A skill the user wrote or imported inside AgentForge; its text is sent to the agents it is switched on for. */
export interface PersonalSkill { id: string; name: string; text: string; claude: boolean; codex: boolean }
export interface SkillSettings {
  enabled: string[] // ids of installed skills switched on: `claude:<folder>` / `codex:<folder>`
  personal: PersonalSkill[]
}
/** A skill found in a CLI's own skills folder (SKILL.md). */
export interface SkillInfo { id: string; agent: AgentKind; name: string; description: string; chars: number }

export interface Settings {
  claudeSafeMode: boolean
  skills: SkillSettings
  claudeModel: string // passed as --model; empty = Claude Code's own default
  codexModel: string
  stageTimeoutMin: number
  reCommand: string // absolute path to rea executable, empty = disabled
  buildAllowedTools: string
  notifications: boolean // OS notification + taskbar flash when a task starts waiting for the user
}

export interface CliInfo { name: string; path: string | null; version: string | null; error?: string }

export interface AppState { projects: Project[]; tasks: Task[]; settings: Settings; planners: PlanThread[] }

export interface PlannerLogEvent { threadId: string; line: string }

export const DEFAULT_SETTINGS: Settings = {
  claudeSafeMode: true,
  skills: { enabled: [], personal: [] },
  claudeModel: '',
  codexModel: 'gpt-5.6-sol',
  stageTimeoutMin: 20,
  reCommand: '',
  buildAllowedTools: 'Read,Grep,Glob,Edit,Write,Bash(git status:*),Bash(git diff:*)',
  notifications: true
}

export const STAGE_PLAN: { kind: StageKind; agent: AgentKind }[] = [
  { kind: 'design', agent: 'claude' },
  { kind: 'review', agent: 'codex' },
  { kind: 'build', agent: 'claude' },
  { kind: 'verify', agent: 'codex' }
]

export interface StageLogEvent { taskId: string; stage: StageKind; line: string; slot?: string }

export interface Api {
  getState(): Promise<AppState>
  cliInfo(): Promise<CliInfo[]>
  pickProject(): Promise<AppState>
  listSkills(): Promise<SkillInfo[]>
  pickSkillFile(): Promise<{ name: string; text: string } | null>
  createTask(input: { projectId: string; title: string; prompt: string; reTarget?: string; mode?: TaskMode; slotAgents?: AgentKind[]; origin?: TaskOrigin }): Promise<AppState>
  plannerCreate(projectId: string, title?: string): Promise<AppState>
  plannerDelete(threadId: string): Promise<AppState>
  plannerSetOptions(threadId: string, opts: { agent?: AgentKind; conversation?: PlanConversationMode; title?: string }): Promise<AppState>
  plannerAddContext(threadId: string, item: { label: string; kind: PlanContextItem['kind']; text: string; source?: PlanContextItem['source'] }): Promise<AppState>
  plannerRemoveContext(threadId: string, itemId: string): Promise<AppState>
  plannerSend(threadId: string, text: string): Promise<AppState>
  plannerCancel(threadId: string): Promise<AppState>
  onPlannerLog(cb: (e: PlannerLogEvent) => void): () => void
  onFocusPlanner(cb: (threadId: string) => void): () => void
  runNext(taskId: string): Promise<AppState> // runs the next pending stage (approval gate = user click)
  cancel(taskId: string): Promise<AppState>
  getDiff(taskId: string): Promise<string>
  getLog(taskId: string, stage: StageKind): Promise<string>
  getSlotDiff(taskId: string, slotId: string): Promise<string>
  getSlotLog(taskId: string, slotId: string): Promise<string>
  selectSlot(taskId: string, slotId: string, force: boolean): Promise<AppState>
  cancelSlot(taskId: string, slotId: string): Promise<AppState>
  runSlot(taskId: string, slotId: string, note?: string): Promise<AppState>
  queueSlotNote(taskId: string, slotId: string, note: string): Promise<AppState>
  approveMerge(taskId: string): Promise<AppState>
  merge(taskId: string): Promise<AppState>
  discard(taskId: string): Promise<AppState>
  deleteTask(taskId: string): Promise<AppState>
  removeProject(projectId: string, cleanup: boolean): Promise<AppState>
  saveSettings(s: Settings): Promise<AppState>
  onLog(cb: (e: StageLogEvent) => void): () => void
  onState(cb: (s: AppState) => void): () => void
  onFocusTask(cb: (taskId: string) => void): () => void
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentKind, Api, AppState, CliInfo, PlanContextItem, Settings, Stage, StageKind, Task, TaskMode, TaskOrigin } from '../shared/types'
import { BonView } from './BonView'
import { DiffView } from './DiffView'
import { Palette, ShortcutHelp, type PaletteItem } from './Palette'
import { PlannerPanel, type ProposalDraft } from './PlannerPanel'
import { SkillsDlg } from './SkillsDlg'
import { stageDigest, taskDigest } from '../shared/planner'
import { attention, attentionKey, progress } from '../shared/attention'
import { t as tr, resolveLang, setLang } from '../shared/i18n'
import { stageLabel, statusLabel, testLabel } from '../shared/labels'

declare global {
  interface Window { api: Api }
}
const api = () => window.api

const AGENT_LABEL = { claude: 'Claude Code', codex: 'Codex' } as const
const MAX_LIVE_LINES = 2000
const NL = String.fromCharCode(10)

function runningSince(t: Task, now: number): number {
  const u = t.mode === 'best-of-n' ? t.slots ?? [] : t.stages
  const starts = u.filter((x) => x.status === 'running' && x.startedAt).map((x) => x.startedAt!)
  return starts.length ? Math.min(...starts) : now
}
const fmtElapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s >= 3600 ? tr('{h}시간 {m}분', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) }) : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function App() {
  const [state, setState] = useState<AppState | null>(null)
  setLang(resolveLang(state?.settings.language ?? 'auto', navigator.language)) // idempotent; children render after this in the same pass
  const [cli, setCli] = useState<CliInfo[]>([])
  const [selTask, setSelTask] = useState<string | null>(null)
  const [selStage, setSelStage] = useState<StageKind>('design')
  const [tab, setTab] = useState<'output' | 'log' | 'diff'>('output')
  const [err, setErr] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showSkills, setShowSkills] = useState(false)
  const [showPal, setShowPal] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [showPlanner, setShowPlanner] = useState(false)
  const [planThreadId, setPlanThreadId] = useState<string | null>(null)
  const [plannerLive, setPlannerLive] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState<ProposalDraft | null>(null)
  const [draftKey, setDraftKey] = useState(0)
  const [live, setLive] = useState<Record<string, string[]>>({})
  const [stored, setStored] = useState('')
  const [diff, setDiff] = useState('')

  useEffect(() => {
    void api().getState().then(setState)
    void api().cliInfo().then(setCli)
    const off1 = api().onState(setState)
    const off3 = api().onFocusTask(setSelTask)
    const off4 = api().onPlannerLog((e) => setPlannerLive((m) => ({ ...m, [e.threadId]: e.line })))
    const off5 = api().onFocusPlanner((id) => { setPlanThreadId(id); setShowPlanner(true) })
    const off2 = api().onLog((e) => {
      const k = `${e.taskId}:${e.slot ?? e.stage}`
      setLive((m) => {
        const arr = [...(m[k] ?? []), e.line]
        return { ...m, [k]: arr.length > MAX_LIVE_LINES ? arr.slice(-MAX_LIVE_LINES) : arr }
      })
    })
    return () => { off1(); off2(); off3(); off4(); off5() }
  }, [])

  const task = useMemo(() => state?.tasks.find((t) => t.id === selTask) ?? null, [state, selTask])

  // a failure is "seen" once its task is opened; approval/selection waits stay until the user acts
  const [seen, setSeen] = useState<Set<string>>(() => new Set())
  const needs = useMemo(() => {
    const m = new Map<string, ReturnType<typeof attention>>()
    for (const t of state?.tasks ?? []) {
      const a = attention(t)
      if (a && !(a.kind === 'failed' && seen.has(attentionKey(t, a)))) m.set(t.id, a)
    }
    return m
  }, [state, seen])
  useEffect(() => {
    if (!task) return
    const a = attention(task)
    if (a?.kind === 'failed') setSeen((s) => (s.has(attentionKey(task, a)) ? s : new Set(s).add(attentionKey(task, a))))
  }, [task])
  useEffect(() => { document.title = needs.size ? `(${needs.size}) AgentForge` : 'AgentForge' }, [needs.size])

  const openNew = useCallback(() => {
    if (!state?.projects.length) { setErr(tr('git 저장소 폴더를 먼저 추가하세요')); return }
    setDraft(null)
    setDraftKey((k) => k + 1)
    setNewProject(task?.projectId ?? state.projects[0]!.id)
    setShowNew(true)
  }, [state, task?.projectId])

  const orderedTasks = useMemo(() => (state?.projects ?? []).flatMap((p) => state!.tasks.filter((t) => t.projectId === p.id)), [state])
  const paletteItems = useMemo<PaletteItem[]>(() => {
    const tasks = orderedTasks.map((t): PaletteItem => {
      const a = needs.get(t.id)
      const proj = state!.projects.find((p) => p.id === t.projectId)?.name ?? ''
      return {
        id: t.id, kind: 'task', title: t.title, sub: [proj, t.mode === 'best-of-n' ? 'Best-of-N' : tr('파이프라인'), progress(t)].filter(Boolean).join(' · '),
        tag: a?.label ?? statusLabel(t.status), tagClass: a ? (a.kind === 'failed' ? 'bad' : 'need') : 'muted',
        text: [t.title, proj, statusLabel(t.status), a?.label, t.mode === 'best-of-n' ? 'best-of-n' : 'pipeline 파이프라인'].filter(Boolean).join(' ')
      }
    })
    const actions: PaletteItem[] = [
      { id: 'action:new', kind: 'action', title: tr('새 태스크'), text: '새 태스크 new task 만들기' },
      { id: 'action:settings', kind: 'action', title: tr('설정'), text: '설정 settings' },
      { id: 'action:skills', kind: 'action', title: tr('스킬'), text: '스킬 skills 지침 skill' },
      { id: 'action:planner', kind: 'action', title: tr('계획 도우미 열기/닫기'), text: '계획 도우미 planner 설계 다음 작업 plan' },
      { id: 'action:help', kind: 'action', title: tr('단축키 도움말'), text: '단축키 도움말 shortcuts help keyboard' }
    ]
    return [...tasks, ...actions]
  }, [orderedTasks, needs, state])
  const pickPalette = (it: PaletteItem) => {
    setShowPal(false)
    if (it.id === 'action:new') openNew()
    else if (it.id === 'action:settings') setShowSettings(true)
    else if (it.id === 'action:skills') setShowSkills(true)
    else if (it.id === 'action:help') setShowHelp(true)
    else if (it.id === 'action:planner') setShowPlanner((v) => !v)
    else setSelTask(it.id)
  }

  // global shortcuts (see SHORTCUTS in Palette.tsx)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      // physical keys (e.code), not characters: under a Korean IME e.key is a jamo or 'Process' and would never match
      const anyModal = showNew || showSettings || showSkills || showPal || showHelp
      if (e.key === 'Escape') {
        if (anyModal) { setShowNew(false); setShowSettings(false); setShowSkills(false); setShowPal(false); setShowHelp(false) }
        return
      }
      if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyK') { e.preventDefault(); setShowHelp(false); setShowPal((v) => !v); return }
      if (anyModal) return
      if (mod && !e.altKey && e.code === 'KeyN') { e.preventDefault(); openNew(); return }
      if (mod && !e.altKey && e.code === 'KeyJ') { e.preventDefault(); setShowPlanner((v) => !v); return }
      if (mod && e.code === 'Comma') { e.preventDefault(); setShowSettings(true); return }
      if (mod && e.code === 'Slash') { e.preventDefault(); setShowHelp(true); return }
      if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        if (orderedTasks.length === 0) return
        const i = orderedTasks.findIndex((t) => t.id === selTask)
        const next = e.key === 'ArrowDown' ? (i < 0 ? 0 : Math.min(i + 1, orderedTasks.length - 1)) : i < 0 ? orderedTasks.length - 1 : Math.max(i - 1, 0)
        setSelTask(orderedTasks[next]!.id)
        return
      }
      if (e.altKey && !mod && /^Digit[1-4]$/.test(e.code) && task) {
        e.preventDefault()
        const n = Number(e.code.slice(5))
        if (task.mode === 'best-of-n') window.dispatchEvent(new CustomEvent('af:tab', { detail: (['diff', 'tests', 'result', 'log'] as const)[n - 1] }))
        else if (n <= 3) setTab((['output', 'log', 'diff'] as const)[n - 1]!)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [showNew, showSettings, showSkills, showPal, showHelp, orderedTasks, selTask, task, openNew])

  // re-render once a second only while something runs, so the elapsed time ticks
  const anyRunning = !!state?.tasks.some((t) => t.status === 'running')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!anyRunning) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [anyRunning])
  // runOk tells the caller whether the call succeeded (the planner keeps its input when it failed)
  const runOk = useCallback(async (fn: () => Promise<AppState>): Promise<boolean> => {
    setErr('')
    try { setState(await fn()); return true } catch (e) { setErr(cleanErr(e)); return false }
  }, [])
  const run = useCallback(async (fn: () => Promise<AppState>) => { await runOk(fn) }, [runOk])

  // Sends a digest to the planner thread of that project (creating one if needed) and opens the panel.
  const addToPlanner = useCallback(async (item: Omit<PlanContextItem, 'id'>, projectId: string) => {
    setErr('')
    try {
      let s = await api().getState()
      let th = s.planners.find((t) => t.id === planThreadId && t.projectId === projectId) ?? s.planners.find((t) => t.projectId === projectId)
      if (!th) { s = await api().plannerCreate(projectId); th = s.planners[0] }
      if (!th) throw new Error(tr('계획 스레드를 만들지 못했습니다'))
      setState(await api().plannerAddContext(th.id, { label: item.label, kind: item.kind, text: item.text, source: item.source }))
      setPlanThreadId(th.id)
      setShowPlanner(true)
    } catch (e) { setErr(cleanErr(e)) }
  }, [planThreadId])

  const openDraft = useCallback((d: ProposalDraft) => {
    setNewProject(d.projectId)
    setDraft(d)
    setDraftKey((k) => k + 1)
    setShowNew(true)
  }, [])

  useEffect(() => {
    if (!task || task.mode === 'best-of-n') return
    // `stale` drops late responses from a previously selected task/stage so a diff never shows under the wrong task
    let stale = false
    if (tab === 'log') {
      setStored('')
      void api().getLog(task.id, selStage).then((v) => !stale && setStored(v))
    }
    if (tab === 'diff') {
      setDiff('')
      void api().getDiff(task.id).then((v) => !stale && setDiff(v)).catch((e) => !stale && setDiff(cleanErr(e)))
    }
    return () => { stale = true }
  }, [task?.id, tab, selStage, task?.status])

  const deleteTask = (t: Task) => {
    const warn = t.status === 'merged'
      ? tr('이미 머지된 태스크입니다. worktree와 브랜치 정리만 하며 메인 브랜치의 커밋 이력은 건드리지 않습니다.')
      : t.status === 'discarded' ? tr('이미 폐기된 태스크입니다. 목록과 로그에서만 제거됩니다.')
      : tr('⚠ 머지되지 않은 작업입니다. {what}와 worktree가 삭제되어 구현 결과를 복구할 수 없습니다.', { what: t.mode === 'best-of-n' ? tr('슬롯 {n}개의 브랜치', { n: t.slots?.length ?? 0 }) : t.branch })
    if (!confirm(tr('정말 삭제하시겠습니까?\n\n"{title}"\n{warn}\n\n삭제는 되돌릴 수 없습니다.\n(git이 변경사항 때문에 거부하면 강제 삭제 없이 중단됩니다.)', { title: t.title, warn }))) return
    void run(async () => {
      const s = await api().deleteTask(t.id)
      if (selTask === t.id) setSelTask(null)
      return s
    })
  }

  const removeProject = (projectId: string) => {
    const p = state?.projects.find((x) => x.id === projectId)
    if (!p) return
    const tasks = state!.tasks.filter((t) => t.projectId === projectId)
    const leftover = tasks.filter((t) => !['merged', 'discarded'].includes(t.status))
    if (tasks.some((t) => t.status === 'running')) { setErr(tr('실행 중인 태스크가 있습니다. 먼저 중지하세요')); return }
    if (!confirm(tr('"{name}"을(를) AgentForge 목록에서 제거합니다.\n원본 폴더와 git 저장소는 건드리지 않습니다.\n태스크 {n}개가 목록에서 사라집니다. 계속할까요?', { name: p.name, n: tasks.length }))) return
    let cleanup = false
    if (leftover.length > 0) {
      cleanup = confirm(tr('⚠ 남아있는 worktree/브랜치가 있는 태스크가 {n}개 있습니다:\n{list}\n\n[확인] 이 worktree와 브랜치도 함께 삭제 (되돌릴 수 없음, 머지 안 된 작업은 사라짐, 강제 삭제 안 함)\n[취소] 정리하지 않고 목록에서만 제거 (worktree/브랜치는 저장소에 남음)', { n: leftover.length, list: leftover.map((t) => '- ' + (t.branch || 'best-of-n') + ' ' + t.title).join(NL) }))
    }
    void run(async () => {
      const s = await api().removeProject(projectId, cleanup)
      if (task && task.projectId === projectId) setSelTask(null)
      return s
    })
  }

  const stage: Stage | undefined = task?.stages.find((s) => s.kind === selStage)
  const liveLines = task ? live[`${task.id}:${selStage}`] : undefined
  const busy = task?.status === 'running'
  const verifyStage = task?.stages.find((s) => s.kind === 'verify')
  const testRes = verifyStage?.testResult
  const testsFailed = !!testRes && testRes.status !== 'pass' && testRes.status !== 'none'
  const covMissing = verifyStage?.coverage?.status === 'missing'
  const blocked = testsFailed || covMissing
  const verifyFailed = verifyStage?.status === 'failed' && !blocked

  return (
    <div className={'app' + (showPlanner ? ' with-planner' : '')}>
      <aside className="side">
        <div className="brand">AgentForge</div>
        <button className="btn" onClick={() => run(() => api().pickProject())}>{tr('+ 프로젝트 추가')}</button>
        <div className="scroll">
          {state?.projects.map((p) => (
            <div key={p.id} className="proj">
              <div className="proj-h">
                <span title={p.path}>{p.name}</span>
                <span className="proj-act">
                  <button className="link" onClick={() => { setShowNew(true); setNewProject(p.id) }}>{tr('+ 태스크')}</button>
                  <button className="link bad" title={tr('AgentForge 목록에서만 제거 (원본 폴더/저장소는 그대로)')} onClick={() => removeProject(p.id)}>{tr('목록에서 제거')}</button>
                </span>
              </div>
              {state.tasks.filter((t) => t.projectId === p.id).map((t) => (
                <div key={t.id} className={'task-row' + (t.id === selTask ? ' sel' : '')}>
                  <button className={'task' + (t.id === selTask ? ' sel' : '')} onClick={() => { setSelTask(t.id); setLive((m) => m) }}>
                    <span className="t-main">
                      <span className="t-top">
                        {needs.has(t.id) && <span className={'dot ' + needs.get(t.id)!.kind} aria-hidden="true" />}
                        <span className="t-title">{t.title}</span>
                        <span className={'badge ' + t.status}>{statusLabel(t.status)}</span>
                      </span>
                      <span className={'t-sub small' + (needs.has(t.id) ? ' need ' + needs.get(t.id)!.kind : ' muted')}>
                        {needs.get(t.id)?.label ?? progress(t) ?? ''}
                        {t.status === 'running' && ` · ${fmtElapsed(now - runningSince(t, now))}`}
                      </span>
                    </span>
                  </button>
                  <button
                    className="task-del"
                    aria-label={tr('태스크 삭제: {title}', { title: t.title })}
                    title={t.status === 'running' ? tr('실행 중에는 삭제할 수 없습니다. 먼저 중지하세요') : tr('태스크 삭제')}
                    disabled={t.status === 'running'}
                    onClick={() => deleteTask(t)}
                  >🗑</button>
                </div>
              ))}
            </div>
          ))}
          {state && state.projects.length === 0 && <p className="muted pad">{tr('git 저장소 폴더를 추가하세요.')}</p>}
        </div>
        <div className="cli">
          {cli.map((c) => (
            <div key={c.name} className={c.error ? 'bad' : 'ok'} title={c.path ?? ''}>
              {c.name}: {c.error ? c.error : c.version}
            </div>
          ))}
          <button className="link" onClick={() => setShowPal(true)} title={tr('태스크 검색 (Ctrl+K)')}>{tr('검색')} <kbd>Ctrl+K</kbd></button>
          <button className="link" onClick={() => setShowSkills(true)}>{tr('스킬')}</button>
          <button className="link" onClick={() => setShowSettings(true)}>{tr('설정')}</button>
        </div>
      </aside>

      <main className="main">
        {err && <div className="err" role="alert" onClick={() => setErr('')}>{err}</div>}
        {!task && <div className="empty">{tr('왼쪽에서 태스크를 선택하거나 새로 만드세요.')}</div>}
        {task && state && (
          <>
            <header className="head">
              <div>
                <h1>{task.title}</h1>
                <div className="muted small">{task.mode === 'best-of-n' ? tr('Best-of-N {n}슬롯', { n: task.slots?.length ?? 0 }) : tr('브랜치 {branch}', { branch: task.branch })} · base {task.baseCommit.slice(0, 8)}{task.dirtyAtCreate ? ' · ' + tr('⚠ 생성 시 작업트리에 미커밋 변경이 있었고 worktree에는 포함되지 않음') : ''}{task.reTarget ? ` · ${tr('RE 대상')} ${task.reTarget}` : ''}</div>
              </div>
              <div className="head-right">
                {task.origin && (() => { const th = state.planners.find((x) => x.id === task.origin!.threadId); return th ? <button className="link" title={tr('이 태스크를 만든 계획 도우미 스레드 열기')} onClick={() => { setPlanThreadId(th.id); setShowPlanner(true) }}>{tr('계획 출처:')} {th.title} ↗</button> : <span className="muted small">{tr('계획 출처:')} {tr('(삭제된 스레드)')}</span> })()}
                <button className="btn sm" title={tr('이 태스크의 요청과 상태를 계획 도우미 컨텍스트에 추가')} onClick={() => void addToPlanner(taskDigest(task), task.projectId)}>{tr('계획 도우미로 보내기')}</button>
                <span className={'badge big ' + task.status}>{statusLabel(task.status)}</span>
              </div>
            </header>

            {task.mode === 'best-of-n' ? <BonView task={task} live={live} run={run} onPlan={(item) => addToPlanner(item, task.projectId)} /> : <>
            <div className="stages">
              {task.stages.map((s) => (
                <button key={s.kind} className={'stage' + (s.kind === selStage ? ' sel' : '')} onClick={() => setSelStage(s.kind)}>
                  <div className="s-name">{stageLabel(s.kind, true)}</div>
                  <div className="muted small">{AGENT_LABEL[s.agent]}</div>
                  <span className={'badge ' + s.status}>{statusLabel(s.status)}</span>
                </button>
              ))}
            </div>

            <div className="actions">
              {(task.status === 'created' || task.status === 'failed') && (
                <button className="btn primary" onClick={() => run(() => api().runNext(task.id))}>
                  {nextLabel(task)}
                </button>
              )}
              {busy && <button className="btn" onClick={() => run(() => api().cancel(task.id))}>{tr('중지')}</button>}
              {task.status === 'awaiting-approval' && (
                <button className="btn primary" disabled={blocked} title={blocked ? tr('테스트 실패 또는 새 기능의 테스트 누락으로 승인할 수 없습니다') : undefined} onClick={() => run(() => api().approveMerge(task.id))}>{tr('diff 확인 완료 · 머지 승인')}</button>
              )}
              {task.status === 'ready-to-merge' && (
                <button className="btn primary" onClick={() => confirm(tr('{branch}를 현재 브랜치로 머지합니다. 계속할까요?', { branch: task.branch })) && run(() => api().merge(task.id))}>{tr('머지 실행')}</button>
              )}
              {!['merged', 'discarded'].includes(task.status) && !busy && (
                <button className="btn danger" onClick={() => confirm(tr('worktree와 브랜치를 삭제합니다. 되돌릴 수 없습니다.')) && run(() => api().discard(task.id))}>{tr('폐기')}</button>
              )}
              {stage && <button className="btn" title={tr('선택한 단계의 결과를 계획 도우미 컨텍스트에 추가')} onClick={() => void addToPlanner(stageDigest(task, stage), task.projectId)}>{tr('선택한 단계를 계획 도우미에 추가')}</button>}
            </div>

            {(blocked || verifyFailed) && (
              <div className="warnbar" role="alert">
                ⚠ {testsFailed ? tr('실제 테스트 실행 결과가 {status}입니다', { status: testStatusLabel(testRes!.status) }) : covMissing ? verifyStage!.coverage!.reason : tr('2차검증이 FAIL입니다')} - {tr('머지 승인이 차단됩니다. 폐기하거나 새 태스크로 수정하세요.')}
              </div>
            )}

            <div className="tabs">
              {(['output', 'log', 'diff'] as const).map((k) => (
                <button key={k} className={tab === k ? 'tab sel' : 'tab'} onClick={() => setTab(k)}>
                  {{ output: tr('결과'), log: tr('실시간 로그'), diff: tr('변경 diff') }[k]}
                </button>
              ))}
            </div>
            <div className="pane">
              {tab === 'output' && (
                <>
                  {stage?.kind === 'verify' && <TestPanel stage={stage} />}
                  <pre>{stage?.output || tr('(아직 결과가 없습니다)')}</pre>
                </>
              )}
              {tab === 'log' && <LogView lines={liveLines && liveLines.length ? liveLines : stored.split('\n')} />}
              {tab === 'diff' && <DiffView text={diff} />}
            </div>
            </>}
          </>
        )}
      </main>

      {showPlanner && state && (
        <PlannerPanel
          state={state} cli={cli} threadId={planThreadId} onSelectThread={setPlanThreadId} live={plannerLive}
          currentProjectId={task?.projectId ?? state.projects[0]?.id ?? ''} currentTask={task}
          run={runOk} onClose={() => setShowPlanner(false)} onDraft={openDraft} onOpenTask={setSelTask}
        />
      )}

      {showNew && state && (
        <NewTask
          key={draftKey} state={state} projectId={newProject} initial={draft ?? undefined}
          onClose={() => { setShowNew(false); setDraft(null) }}
          onCreate={async (i) => {
            // a task made from a planner proposal is opened right away so the user can continue there
            const made = await runOk(async () => {
              const s = await api().createTask(i)
              if (i.origin && s.tasks[0]) setSelTask(s.tasks[0].id)
              return s
            })
            if (made) { setShowNew(false); setDraft(null) }
          }}
        />
      )}
      {showPal && <Palette items={paletteItems} onPick={pickPalette} onClose={() => setShowPal(false)} />}
      {showHelp && <ShortcutHelp onClose={() => setShowHelp(false)} />}
      {showSkills && state && <SkillsDlg api={api} s={state.settings} onClose={() => setShowSkills(false)} onSave={async (s) => { await run(() => api().saveSettings(s)); setShowSkills(false) }} />}
      {showSettings && state && <SettingsDlg s={state.settings} onClose={() => setShowSettings(false)} onSave={async (s) => { await run(() => api().saveSettings(s)); setShowSettings(false) }} />}
    </div>
  )
}

let newProject = ''
function setNewProject(id: string) { newProject = id }

function cleanErr(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function nextLabel(t: Task): string {
  const next = t.stages.find((s) => s.status !== 'done')
  if (!next) return tr('완료')
  const retry = next.status === 'failed' || next.status === 'interrupted' || next.status === 'cancelled'
  return `${retry ? tr('다시 실행') : tr('실행 승인')}: ${stageLabel(next.kind, true)} (${AGENT_LABEL[next.agent]})`
}

const testStatusLabel = testLabel

function CoverageLine({ stage }: { stage: Stage }) {
  const c = stage.coverage
  if (!c) return null
  return <div className={'testbox ' + (c.status === 'ok' ? 'pass' : 'fail')}><h3>{tr('새 기능 테스트 규칙:')} {c.status === 'ok' ? 'OK' : tr('위반 (FAIL)')}</h3><div className="small">{c.reason}</div>{c.testFiles.length > 0 && <div className="muted small">{tr('변경된 테스트:')} {c.testFiles.join(', ')}</div>}</div>
}

function TestPanel({ stage }: { stage: Stage }) {
  return <><TestRun stage={stage} /><CoverageLine stage={stage} /></>
}

function TestRun({ stage }: { stage: Stage }) {
  const r = stage.testResult
  if (!r) return stage.status === 'running' ? <div className="testbox"><h3>{tr('실제 테스트 실행 중...')}</h3></div> : null
  if (r.status === 'none') return <div className="testbox"><h3>{tr('자동 테스트 없음, 코드 리뷰만 수행')}</h3><span className="muted small">{tr('package.json의 scripts.test 또는 *.test.js 파일이 없어 Codex 코드 리뷰만 수행되었습니다.')}</span></div>
  const counts = r.total !== undefined ? tr('총 {total} · 통과 {passed} · 실패 {failed} · ', { total: r.total, passed: r.passed ?? '?', failed: r.failed ?? '?' }) : ''
  return (
    <div className={'testbox ' + r.status}>
      <h3>{tr('실제 테스트 실행:')} {testStatusLabel(r.status)}</h3>
      <div className="small">{r.command} · {counts}{tr('소요')} {tr('{n}초', { n: (r.durationMs / 1000).toFixed(1) })} · exit {String(r.exitCode ?? '-')} · {tr('커밋')} {r.head.slice(0, 8)}</div>
      {r.failures.length > 0 && <ul>{r.failures.map((f, i) => <li key={i}>{f}</li>)}</ul>}
      {r.output && <details open={r.status !== 'pass'}><summary className="small">{tr('테스트 출력')}</summary><pre>{r.output}</pre></details>}
    </div>
  )
}

function LogView({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => { ref.current?.scrollTo(0, ref.current.scrollHeight) }, [lines.length])
  return <pre ref={ref} className="log">{lines.join('\n') || tr('(로그 없음)')}</pre>
}

function NewTask(p: { state: AppState; projectId: string; initial?: ProposalDraft; onClose: () => void; onCreate: (i: { projectId: string; title: string; prompt: string; reTarget?: string; mode?: TaskMode; slotAgents?: AgentKind[]; origin?: TaskOrigin }) => Promise<void> }) {
  const [projectId, setProjectId] = useState(p.initial?.projectId ?? (p.projectId || p.state.projects[0]?.id || ''))
  const [title, setTitle] = useState(p.initial?.title ?? '')
  const [prompt, setPrompt] = useState(p.initial?.prompt ?? '')
  const [re, setRe] = useState(false)
  const [target, setTarget] = useState('')
  const [mode, setMode] = useState<TaskMode>(p.initial?.mode ?? 'pipeline')
  const [agents, setAgents] = useState<AgentKind[]>(p.initial?.slotAgents ?? ['claude', 'codex'])
  const origin = p.initial?.origin
  const ok = projectId && title.trim() && prompt.trim() && (mode === 'best-of-n' || !re || target.trim())
  return (
    <div className="modal-bg" onClick={p.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{tr('새 태스크')}</h2>
        {p.initial && <div className="warnbar small" role="note" style={{ borderColor: 'var(--accent)', background: '#1d2736', color: 'var(--text)' }}>{tr('계획 도우미의 제안으로 미리 채웠습니다. 내용과 모드를 확인하고 [생성]을 눌러야 태스크가 만들어집니다.')}</div>}
        <label>{tr('프로젝트')}<select value={projectId} disabled={!!origin} onChange={(e) => setProjectId(e.target.value)}>{p.state.projects.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>{tr('제목')}<input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></label>
        <label>{tr('요청 내용')}<textarea rows={7} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></label>
        <div className="radio-row">
          <label className="chk"><input type="radio" name="mode" checked={mode === 'pipeline'} onChange={() => setMode('pipeline')} /> {tr('파이프라인 (설계→교차검토→구현→2차검증)')}</label>
          <label className="chk"><input type="radio" name="mode" checked={mode === 'best-of-n'} onChange={() => setMode('best-of-n')} /> {tr('Best-of-N (병렬 구현 후 비교·선택)')}</label>
        </div>
        {mode === 'best-of-n' && (
          <>
            <label>{tr('슬롯 수')}<select value={agents.length} onChange={(e) => { const n = Number(e.target.value); setAgents((a) => Array.from({ length: n }, (_, i) => a[i] ?? 'claude')) }}><option value={2}>2</option><option value={3}>3</option></select></label>
            {agents.map((a, i) => (
              <label key={i}>{tr('슬롯 {n} 에이전트', { n: i + 1 })}<select value={a} onChange={(e) => setAgents((cur) => cur.map((x, j) => (j === i ? (e.target.value as AgentKind) : x)))}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>
            ))}
            <p className="muted small">{tr('같은 요청을 각 슬롯이 독립된 worktree에서 설계 단계 없이 바로 구현합니다. 모두 끝나면 diff·테스트를 비교해 하나를 직접 고릅니다.')}</p>
          </>
        )}
        {mode === 'pipeline' && <label className="chk"><input type="checkbox" checked={re} onChange={(e) => setRe(e.target.checked)} /> {tr('리버스 엔지니어링 모드 (rea 분석 결과를 설계 단계에 주입)')}</label>}
        {mode === 'pipeline' && re && <label>{tr('분석 대상 절대경로')}<input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={'C:\\path\\to\\app.asar ' + tr('또는 폴더')} /></label>}
        <div className="row"><button className="btn" onClick={p.onClose}>{tr('취소')}</button><button className="btn primary" disabled={!ok} onClick={() => p.onCreate(mode === 'best-of-n' ? { projectId, title: title.trim(), prompt: prompt.trim(), mode, slotAgents: agents, origin } : { projectId, title: title.trim(), prompt: prompt.trim(), reTarget: re ? target.trim() : undefined, origin })}>{tr('생성')}</button></div>
      </div>
    </div>
  )
}

const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
const CODEX_MODELS = ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']

// a <select> shows every choice at once (a <datalist> filters by the current value); "직접 입력" keeps free text possible
function ModelPick(p: { label: string; emptyLabel: string; options: string[]; value: string; onChange: (v: string) => void }) {
  const [custom, setCustom] = useState(p.value !== '' && !p.options.includes(p.value))
  return (
    <label>{p.label}
      <select value={custom ? '__custom' : p.value} onChange={(e) => { if (e.target.value === '__custom') setCustom(true); else { setCustom(false); p.onChange(e.target.value) } }}>
        <option value="">{p.emptyLabel}</option>
        {p.options.map((o) => <option key={o} value={o}>{o}</option>)}
        <option value="__custom">{tr('직접 입력…')}</option>
      </select>
      {custom && <input aria-label={tr('{label} 직접 입력', { label: p.label })} placeholder={tr('모델 이름')} value={p.value} onChange={(e) => p.onChange(e.target.value.trim())} />}
    </label>
  )
}

function SettingsDlg(p: { s: Settings; onClose: () => void; onSave: (s: Settings) => Promise<void> }) {
  const [s, setS] = useState(p.s)
  return (
    <div className="modal-bg" onClick={p.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{tr('설정')}</h2>
        <label>{tr('언어')}<select value={s.language} onChange={(e) => setS({ ...s, language: e.target.value as Settings['language'] })}><option value="auto">{tr('자동 (운영체제 설정)')}</option><option value="ko">한국어</option><option value="en">English</option></select></label>
        <label className="chk"><input type="checkbox" checked={s.claudeSafeMode} onChange={(e) => setS({ ...s, claudeSafeMode: e.target.checked })} /> Claude <code>--safe-mode</code> ({tr('프로젝트 CLAUDE.md/hook/MCP 자동 신뢰 방지, 권장')})</label>
        <ModelPick label={tr('Claude 모델')} emptyLabel={tr('기본값 (Claude Code 설정)')} options={CLAUDE_MODELS} value={s.claudeModel} onChange={(v) => setS({ ...s, claudeModel: v })} />
        <ModelPick label={tr('Codex 모델')} emptyLabel={tr('기본값 (Codex 설정)')} options={CODEX_MODELS} value={s.codexModel} onChange={(v) => setS({ ...s, codexModel: v })} />
        <p className="muted small">{tr('모델은 파이프라인, Best-of-N, 계획 도우미에 모두 적용됩니다. 실행 중인 작업에는 영향이 없고 다음 실행부터 바뀝니다. 잘못된 이름이면 해당 CLI가 오류를 냅니다.')}</p>
        <label>{tr('단계 타임아웃(분)')}<input type="number" min={1} max={120} value={s.stageTimeoutMin} onChange={(e) => setS({ ...s, stageTimeoutMin: Number(e.target.value) })} /></label>
        <label>{tr('구현 단계 허용 도구 (--allowed-tools)')}<input value={s.buildAllowedTools} onChange={(e) => setS({ ...s, buildAllowedTools: e.target.value })} /></label>
        <label className="chk"><input type="checkbox" checked={s.notifications} onChange={(e) => setS({ ...s, notifications: e.target.checked })} /> {tr('작업이 내 확인을 기다리면 알림 (창이 백그라운드일 때 Windows 알림 + 작업표시줄 깜빡임)')}</label>
        <label>{tr('rea 실행파일 경로 (.exe, 비우면 RE 주입 비활성)')}<input value={s.reCommand} onChange={(e) => setS({ ...s, reCommand: e.target.value })} /></label>
        <p className="muted small">{tr('주의: worktree와 권한 모드는 보안 샌드박스가 아닙니다. 신뢰할 수 있는 저장소에서만 사용하세요.')}</p>
        <div className="row"><button className="btn" onClick={p.onClose}>{tr('취소')}</button><button className="btn primary" onClick={() => p.onSave(s)}>{tr('저장')}</button></div>
      </div>
    </div>
  )
}

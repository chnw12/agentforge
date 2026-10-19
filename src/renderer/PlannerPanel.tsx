import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentKind, Api, AppState, CliInfo, PlanContextItem, PlanMessage, PlanThread, Task, TaskMode, TaskOrigin } from '../shared/types'
import { t as tr } from '../shared/i18n'
import { PLAN_LIMITS, stripProposalBlock, taskDigest } from '../shared/planner'

const api = (): Api => (window as unknown as { api: Api }).api
const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex' }
const AGENTS: AgentKind[] = ['claude', 'codex']
const WARN_KEY = 'af.planner.warn.dismissed'
const cleanErr = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** What the "create task" modal is pre-filled with. Nothing is created until the user confirms there. */
export interface ProposalDraft {
  projectId: string
  title: string
  prompt: string
  mode: TaskMode
  slotAgents: AgentKind[]
  origin?: TaskOrigin
}

export type RunOk = (fn: () => Promise<AppState>) => Promise<boolean>

export function PlannerPanel(p: {
  state: AppState
  cli: CliInfo[]
  threadId: string | null
  onSelectThread: (id: string | null) => void
  live: Record<string, string>
  currentProjectId: string
  currentTask: Task | null
  run: RunOk
  onClose: () => void
  onDraft: (d: ProposalDraft) => void
  onOpenTask: (id: string) => void
}) {
  const { state } = p
  const threads = state.planners
  const thread = threads.find((t) => t.id === p.threadId) ?? threads.find((t) => t.projectId === p.currentProjectId) ?? threads[0] ?? null
  const project = thread ? state.projects.find((x) => x.id === thread.projectId) : undefined
  const running = !!thread?.messages.some((m) => m.status === 'running')
  const [goal, setGoal] = useState('')
  const [err, setErr] = useState('')
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pasteLabel, setPasteLabel] = useState('')
  const [warnOff, setWarnOff] = useState(() => { try { return localStorage.getItem(WARN_KEY) === '1' } catch { return false } })
  const goalRef = useRef<HTMLTextAreaElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const lastId = thread?.messages[thread.messages.length - 1]?.id
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }) }, [lastId, thread?.messages.length, running])

  const ok = (name: string) => { const c = p.cli.find((x) => x.name === name); return !!c && !c.error && !!c.path }
  const guard = async (fn: () => Promise<boolean | void>) => { setErr(''); try { await fn() } catch (e) { setErr(cleanErr(e)) } }

  const newThread = () => guard(async () => {
    const projectId = p.currentProjectId || state.projects[0]?.id
    if (!projectId) { setErr(tr('먼저 프로젝트를 추가하세요')); return }
    const s = await api().plannerCreate(projectId)
    await p.run(async () => s)
    p.onSelectThread(s.planners[0]?.id ?? null)
  })
  const removeThread = () => guard(async () => {
    if (!thread || !confirm(tr('계획 스레드 "{title}"를 삭제합니다. 대화와 참고 자료가 사라지며 만들어진 태스크는 그대로 남습니다.', { title: thread.title }))) return
    if (await p.run(() => api().plannerDelete(thread.id))) p.onSelectThread(null)
  })
  const send = () => guard(async () => {
    if (!thread || !goal.trim()) return
    if (await p.run(() => api().plannerSend(thread.id, goal.trim()))) setGoal('')
  })
  const addPaste = () => guard(async () => {
    if (!thread || !pasteText.trim()) return
    const ok2 = await p.run(() => api().plannerAddContext(thread.id, { label: pasteLabel.trim() || tr('붙여넣은 텍스트'), kind: 'paste', text: pasteText }))
    if (ok2) { setPasteText(''); setPasteLabel(''); setPasteOpen(false) }
  })
  const addDiff = (c: PlanContextItem) => guard(async () => {
    if (!thread || !c.source) return
    const diff = c.source.slotId ? await api().getSlotDiff(c.source.taskId, c.source.slotId) : await api().getDiff(c.source.taskId)
    await p.run(() => api().plannerAddContext(thread.id, { label: `${c.label} · diff`, kind: 'diff', text: diff.trim() || tr('(변경 없음)'), source: c.source }))
  })

  if (!thread) {
    return (
      <aside className="planner" aria-label={tr('계획 도우미')}>
        <div className="planner-head"><strong>{tr('계획 도우미')}</strong><button className="icon-btn" aria-label={tr('닫기')} onClick={p.onClose}>✕</button></div>
        <p className="muted small">{tr('작업 결과를 붙여 넣으면 Claude Code나 Codex가 다음에 할 일을 설계해 제안합니다. 새 태스크는 제안을 확인하고 직접 만들 때만 생깁니다.')}</p>
        <button className="btn primary" onClick={newThread} disabled={state.projects.length === 0}>{tr('+ 새 계획 스레드')}</button>
        {state.projects.length === 0 && <p className="muted small">{tr('먼저 프로젝트를 추가하세요.')}</p>}
        {err && <div className="err" role="alert" onClick={() => setErr('')}>{err}</div>}
      </aside>
    )
  }

  return (
    <aside className="planner" aria-label={tr('계획 도우미')}>
      <div className="planner-head">
        <strong>{tr('계획 도우미')}</strong>
        <span className="planner-head-act">
          <button className="link" onClick={newThread}>{tr('+ 새 스레드')}</button>
          <button className="icon-btn" aria-label={tr('닫기')} title={tr('닫기 (Ctrl+J)')} onClick={p.onClose}>✕</button>
        </span>
      </div>

      <div className="planner-row">
        <select aria-label={tr('스레드')} value={thread.id} onChange={(e) => p.onSelectThread(e.target.value)}>
          {threads.map((t) => <option key={t.id} value={t.id}>{t.title} · {state.projects.find((x) => x.id === t.projectId)?.name ?? tr('(제거된 프로젝트)')}</option>)}
        </select>
        <button className="task-del" aria-label={tr('스레드 삭제')} title={running ? tr('실행 중에는 삭제할 수 없습니다') : tr('스레드 삭제')} disabled={running} onClick={removeThread}>🗑</button>
      </div>
      <input
        className="planner-title" aria-label={tr('스레드 제목')} defaultValue={thread.title} key={thread.id + thread.title} maxLength={PLAN_LIMITS.title}
        onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== thread.title) void guard(async () => { await p.run(() => api().plannerSetOptions(thread.id, { title: v })) }) }}
      />
      {!project && <div className="warnbar small">{tr('이 스레드의 프로젝트가 목록에서 제거되어 새 요청을 보낼 수 없습니다.')}</div>}

      {!warnOff && (
        <div className="warnbar small" role="note">
          ⚠ {tr('붙여넣은 내용과 저장소 일부가 외부 AI 업체(Anthropic/OpenAI)로 전송됩니다. 개인정보와 기밀은 넣지 마세요.')}{' '}
          <button className="link" onClick={() => { setWarnOff(true); try { localStorage.setItem(WARN_KEY, '1') } catch { /* private window */ } }}>{tr('확인')}</button>
        </div>
      )}

      <div className="planner-opts">
        <div className="seg" role="group" aria-label={tr('에이전트')}>
          {AGENTS.map((a) => (
            <button key={a} className={'seg-btn' + (thread.agent === a ? ' on' : '')} disabled={running || !ok(a)} aria-pressed={thread.agent === a}
              title={ok(a) ? undefined : tr('{agent}를 사용할 수 없습니다', { agent: a })} onClick={() => guard(async () => { await p.run(() => api().plannerSetOptions(thread.id, { agent: a })) })}>{AGENT_LABEL[a]}</button>
          ))}
        </div>
        <div className="seg" role="group" aria-label={tr('대화 방식')} title={tr('이어서 논의: 이전 대화를 매번 다시 보냅니다. 매번 새로: 이전 결과(참고 자료)만 보냅니다.')}>
          {([['continue', tr('이어서 논의')], ['fresh', tr('매번 새로')]] as const).map(([k, label]) => (
            <button key={k} className={'seg-btn' + (thread.conversation === k ? ' on' : '')} disabled={running} aria-pressed={thread.conversation === k}
              onClick={() => guard(async () => { await p.run(() => api().plannerSetOptions(thread.id, { conversation: k })) })}>{label}</button>
          ))}
        </div>
      </div>

      <section className="planner-ctx" aria-label={tr('이전 결과 (참고 자료)')}>
        <div className="planner-sec-h small"><strong>{tr('이전 결과 · 참고 자료')} ({thread.contexts.length})</strong><span className="muted"> · {tr('diff는 기본 제외')}</span></div>
        {thread.contexts.length === 0 && <div className="muted small">{tr('이미 끝난 작업의 결과를 여기에 넣으세요. 직접 붙여 넣거나, 슬롯·단계 화면의 "계획 도우미에 추가"를 누르면 됩니다.')}</div>}
        {thread.contexts.map((c) => (
          <details key={c.id} className="ctx-item">
            <summary>
              <span className="ctx-label" title={c.label}>{c.label}</span>
              <span className="muted small">{tr('{n}자', { n: c.text.length.toLocaleString() })}</span>
              {c.truncated && <span className="tag warn">{tr('잘림')}</span>}
              {!!c.redacted && c.redacted > 0 && <span className="tag warn" title={tr('비밀 정보로 보이는 문자열을 가렸습니다')}>{tr('가림')} {c.redacted}</span>}
              <button className="icon-btn" aria-label={tr('참고 자료 제거: {label}', { label: c.label })} title={tr('제거')} onClick={(e) => { e.preventDefault(); void guard(async () => { await p.run(() => api().plannerRemoveContext(thread.id, c.id)) }) }}>✕</button>
            </summary>
            <pre className="ctx-text">{c.text.slice(0, 3000)}{c.text.length > 3000 ? '\n…' : ''}</pre>
            {(c.kind === 'slot' || c.kind === 'stage' || c.kind === 'task') && c.source && (
              <button className="link" onClick={() => addDiff(c)}>{tr('+ diff 추가')}</button>
            )}
          </details>
        ))}
        {pasteOpen ? (
          <div className="paste-box">
            <input placeholder={tr('제목 (선택)')} value={pasteLabel} maxLength={100} onChange={(e) => setPasteLabel(e.target.value)} aria-label={tr('붙여넣기 제목')} />
            <textarea rows={5} value={pasteText} placeholder={tr('복사한 작업 결과를 붙여 넣으세요')} aria-label={tr('붙여넣을 텍스트')} onChange={(e) => setPasteText(e.target.value)} />
            <div className="row"><button className="btn sm primary" disabled={!pasteText.trim()} onClick={addPaste}>{tr('추가')}</button><button className="btn sm" onClick={() => { setPasteOpen(false); setPasteText('') }}>{tr('취소')}</button></div>
          </div>
        ) : (
          <div className="row">
            <button className="btn sm" onClick={() => setPasteOpen(true)}>{tr('+ 붙여넣기')}</button>
            {p.currentTask && <button className="btn sm" title={tr('지금 선택한 태스크의 요청과 상태')} onClick={() => guard(async () => { const d = taskDigest(p.currentTask!); await p.run(() => api().plannerAddContext(thread.id, d)) })}>{tr('+ 현재 태스크 개요')}</button>}
          </div>
        )}
      </section>

      <section className="planner-ask" aria-label={tr('요청')}>
        <label className="planner-sec-h small" htmlFor="planner-goal"><strong>{tr('새로 시킬 일')}</strong><span className="muted"> · {tr('계획 도우미에게 하는 설계 요청')}</span></label>
        <textarea
          id="planner-goal" ref={goalRef} rows={3} value={goal} maxLength={PLAN_LIMITS.goal} disabled={!project}
          placeholder={tr('위 결과를 바탕으로 다음에 시킬 일을 적으세요. 예: 로그인 에러 처리를 설계해줘 (Ctrl+Enter로 요청)')}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) { e.preventDefault(); if (!running) void send() } }}
        />
        <div className="row">
          {running
            ? <button className="btn danger sm" onClick={() => guard(async () => { await p.run(() => api().plannerCancel(thread.id)) })}>{tr('중지')}</button>
            : <button className="btn primary sm" disabled={!goal.trim() || !project || !ok(thread.agent)} onClick={send} title={ok(thread.agent) ? undefined : tr('{agent}를 사용할 수 없습니다', { agent: thread.agent })}>{tr('설계 요청')}</button>}
          {running && <span className="muted small planner-live" role="status">{tr('{agent} 분석 중…', { agent: AGENT_LABEL[thread.agent] })} {p.live[thread.id] ? `· ${p.live[thread.id]!.slice(0, 80)}` : ''}</span>}
        </div>
      </section>

      {err && <div className="err" role="alert" onClick={() => setErr('')}>{err}</div>}

      <section className="planner-msgs" aria-label={tr('대화')}>
        {thread.messages.map((m) => (
          <MessageView key={m.id} m={m} thread={thread} state={state} onDraft={p.onDraft} onOpenTask={p.onOpenTask} onContinue={() => goalRef.current?.focus()} />
        ))}
        <div ref={endRef} />
      </section>
    </aside>
  )
}

function MessageView(p: { m: PlanMessage; thread: PlanThread; state: AppState; onDraft: (d: ProposalDraft) => void; onOpenTask: (id: string) => void; onContinue: () => void }) {
  const { m } = p
  if (m.role === 'user') return <div className="msg user"><div className="msg-h small muted">{tr('나')}</div><div className="msg-b">{m.text}</div></div>
  const shown = stripProposalBlock(m.text)
  const label = { running: tr('분석 중'), done: tr('완료'), failed: tr('실패'), cancelled: tr('중지됨'), interrupted: tr('중단됨') }[m.status]
  return (
    <div className="msg agent">
      <div className="msg-h small muted">{AGENT_LABEL[m.agent]} <span className={'badge ' + (m.status === 'done' ? 'done' : m.status === 'running' ? 'running' : 'failed')}>{label}</span></div>
      {shown && <pre className="msg-b">{shown}</pre>}
      {m.status === 'done' && m.proposal && <ProposalCard m={m} thread={p.thread} state={p.state} onDraft={p.onDraft} onOpenTask={p.onOpenTask} onContinue={p.onContinue} />}
      {m.status === 'done' && !m.proposal && m.proposalError && (
        <div className="warnbar small">
          {tr('제안 카드를 만들 수 없습니다:')} {m.proposalError}
          <div><button className="link" onClick={() => p.onDraft({ projectId: p.thread.projectId, title: '', prompt: shown, mode: 'pipeline', slotAgents: ['claude', 'codex'], origin: undefined })}>{tr('이 텍스트를 새 태스크 요청으로 가져오기')}</button></div>
        </div>
      )}
    </div>
  )
}

function ProposalCard(p: { m: PlanMessage; thread: PlanThread; state: AppState; onDraft: (d: ProposalDraft) => void; onOpenTask: (id: string) => void; onContinue: () => void }) {
  const pr = p.m.proposal!
  const [title, setTitle] = useState(pr.title)
  const [prompt, setPrompt] = useState(pr.prompt)
  const [mode, setMode] = useState<TaskMode>(pr.mode) // preselected with the agent's recommendation
  const created = useMemo(() => p.m.createdTaskIds.map((id) => ({ id, task: p.state.tasks.find((t) => t.id === id) })), [p.m.createdTaskIds, p.state.tasks])
  const modeLabel = (k: TaskMode) => (k === 'best-of-n' ? 'Best-of-N' : tr('파이프라인'))
  return (
    <div className="proposal" role="group" aria-label={tr('제안')}>
      <div className="small muted"><strong>{tr('제안')}</strong> · {tr('아직 태스크가 아닙니다. 아래에서 확인하고 직접 만드세요.')}</div>
      <label>{tr('제목')}<input value={title} maxLength={PLAN_LIMITS.title} onChange={(e) => setTitle(e.target.value)} aria-label={tr('제안 제목')} /></label>
      <div className="small">
        <div className="radio-row">
          {(['pipeline', 'best-of-n'] as const).map((k) => (
            <label key={k} className="chk"><input type="radio" name={'mode-' + p.m.id} checked={mode === k} onChange={() => setMode(k)} /> {modeLabel(k)}{pr.mode === k && <span className="tag ok" title={tr('에이전트 추천')}>{tr('추천')}</span>}</label>
          ))}
        </div>
        {pr.modeReason && <div className="muted">{tr('{mode} 추천 이유:', { mode: modeLabel(pr.mode) })} {pr.modeReason}</div>}
        {mode === 'best-of-n' && <div className="muted">{tr('슬롯:')} {pr.slotAgents.map((a) => AGENT_LABEL[a]).join(', ')} {tr('(새 태스크 창에서 바꿀 수 있음)')}</div>}
      </div>
      <label>{tr('새 태스크에 들어갈 요청 내용')}<textarea rows={8} value={prompt} maxLength={PLAN_LIMITS.prompt} onChange={(e) => setPrompt(e.target.value)} aria-label={tr('제안 요청 내용')} /></label>
      {pr.rationale && <details className="small"><summary>{tr('근거')}</summary><div>{pr.rationale}</div></details>}
      {pr.risks.length > 0 && <details className="small"><summary>{tr('위험')} ({pr.risks.length})</summary><ul>{pr.risks.map((r, i) => <li key={i}>{r}</li>)}</ul></details>}
      {pr.questions.length > 0 && <details className="small" open><summary>{tr('확인할 점')} ({pr.questions.length})</summary><ul>{pr.questions.map((r, i) => <li key={i}>{r}</li>)}</ul></details>}
      <div className="row">
        <button className="btn primary sm" disabled={!title.trim() || !prompt.trim()}
          onClick={() => p.onDraft({ projectId: p.thread.projectId, title: title.trim(), prompt, mode, slotAgents: pr.slotAgents, origin: { threadId: p.thread.id, messageId: p.m.id } })}>
          {created.length ? tr('새 태스크 또 만들기') : tr('새 태스크 만들기')}
        </button>
        <button className="btn sm" onClick={p.onContinue}>{tr('계속 논의')}</button>
      </div>
      {created.length > 0 && (
        <div className="small">{tr('이 제안으로 만든 태스크:')}{' '}
          {created.map(({ id, task }) => task ? <button key={id} className="link" onClick={() => p.onOpenTask(id)}>{task.title} ↗</button> : <span key={id} className="muted">{tr('(삭제된 태스크)')}</span>)}
        </div>
      )}
    </div>
  )
}

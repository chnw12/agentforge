import { useEffect, useMemo, useRef, useState } from 'react'
import type { Api, AppState, PlanContextItem, Slot, Task } from '../shared/types'
import { slotDigest } from '../shared/planner'
import { slotWarning } from '../shared/slot'
import { diffTotals, parseDiff } from '../shared/diff'
import { DiffView } from './DiffView'

const api = (): Api => (window as unknown as { api: Api }).api
const AGENT_LABEL = { claude: 'Claude Code', codex: 'Codex' } as const
const STATUS_LABEL: Record<string, string> = {
  pending: '대기', running: '실행 중', done: '완료', failed: '실패', interrupted: '중단됨', cancelled: '취소됨'
}
const TEST_LABEL: Record<string, string> = { pass: 'PASS', fail: 'FAIL', timeout: '타임아웃(FAIL)', error: '실행 오류(FAIL)', none: '테스트 없음' }

const QUEUE_NOTE_MAX = 4000 // keep in sync with src/main/bestofn.ts
const TAB_LABEL ={ diff: 'diff', tests: '테스트', result: '요약', log: '로그' } as const

type Run =(fn: () => Promise<AppState>) => Promise<void>
const cleanErr = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function BonView({ task, live, run, onPlan }: { task: Task; live: Record<string, string[]>; run: Run; onPlan: (item: Omit<PlanContextItem, 'id'>) => void }) {
  const slots = task.slots ?? []
  const running = task.status === 'running'
  const canRun = task.status === 'created' || task.status === 'failed'
  const canPick = task.status === 'awaiting-approval'
  const diffs = useSlotDiffs(task)
  return (
    <>
      <div className="actions">
        {canRun && (
          <button className="btn primary" onClick={() => run(() => api().runNext(task.id))}>
            {slots.some((s) => s.status !== 'pending') ? '다시 실행' : '실행 승인'}: {slots.length}개 슬롯 동시 구현
          </button>
        )}
        {running && <button className="btn" onClick={() => run(() => api().cancel(task.id))}>모두 중지</button>}
        {!['merged', 'discarded'].includes(task.status) && !running && (
          <button className="btn danger" onClick={() => confirm('모든 슬롯의 worktree와 브랜치를 삭제합니다. 되돌릴 수 없습니다.') && run(() => api().discard(task.id))}>전체 폐기</button>
        )}
      </div>
      {canPick && <div className="muted small">각 슬롯의 diff와 테스트 결과를 비교한 뒤 하나를 선택하세요. 선택한 슬롯이 머지되고 나머지는 삭제됩니다.</div>}
      {task.status === 'merged' && <div className="muted small">선택된 슬롯이 머지되었고 나머지 슬롯은 정리되었습니다.</div>}
      <BonCompare task={task} diffs={diffs} />
      <div className="bon-grid" style={{ gridTemplateColumns: `repeat(${slots.length}, minmax(0, 1fr))` }}>
        {slots.map((s, i) => (
          <SlotPanel key={s.id} task={task} slot={s} index={i} diff={diffs[s.id]} live={live[`${task.id}:${s.id}`]} canPick={canPick} run={run} onPlan={onPlan} />
        ))}
      </div>
    </>
  )
}

const isSettled = (s: Slot) => s.status === 'done' || s.status === 'failed'
const isGone = (t: Task, s: Slot) => (t.status === 'merged' ? t.selectedSlot !== s.id : t.status === 'discarded')

/** Diff text per settled slot, fetched once here so the panels and the comparison table share it. */
function useSlotDiffs(task: Task): Record<string, string> {
  const [diffs, setDiffs] = useState<Record<string, string>>({})
  const slots = task.slots ?? []
  const key = `${task.status}:${task.selectedSlot ?? ''}:` + slots.map((s) => `${s.id}.${s.status}.${s.head ?? ''}`).join('|')
  useEffect(() => {
    // `stale` drops responses that arrive after the slots/status changed
    let stale = false
    const wanted = slots.filter((s) => isSettled(s) && !isGone(task, s))
    setDiffs((d) => Object.fromEntries(Object.entries(d).filter(([id]) => wanted.some((s) => s.id === id))))
    for (const s of wanted) {
      void api().getSlotDiff(task.id, s.id)
        .then((v) => !stale && setDiffs((d) => ({ ...d, [s.id]: v })))
        .catch((e) => !stale && setDiffs((d) => ({ ...d, [s.id]: cleanErr(e) })))
    }
    return () => { stale = true }
  }, [task.id, key])
  return diffs
}

const fmtSec = (s: Slot) => (s.startedAt && s.endedAt ? `${Math.round((s.endedAt - s.startedAt) / 1000)}초` : '-')

/** Side-by-side facts for the slots, plus which slot touched which file, so differences stand out before picking one. */
function BonCompare({ task, diffs }: { task: Task; diffs: Record<string, string> }) {
  const slots = task.slots ?? []
  const rows = slots.map((s, i) => {
    const text = diffs[s.id]
    const parsed = text === undefined ? null : parseDiff(text)
    const ok = !!parsed && (parsed.files.length > 0 || !parsed.notice) // an error message parses to "no files + notice"
    return { s, i, files: ok ? parsed!.files : [], tot: ok ? diffTotals(parsed!.files) : null, loading: isSettled(s) && !isGone(task, s) && text === undefined, error: !!parsed && !ok }
  })
  const visible = rows.filter((r) => isSettled(r.s) && !isGone(task, r.s))
  if (visible.length === 0) return null

  const done = visible.filter((r) => r.s.status === 'done' && r.tot)
  const size = (r: (typeof rows)[number]) => (r.tot ? r.tot.adds + r.tot.dels : Infinity)
  const dur = (r: (typeof rows)[number]) => (r.s.startedAt && r.s.endedAt ? r.s.endedAt - r.s.startedAt : Infinity)
  const only = (f: (r: (typeof rows)[number]) => number) => {
    if (done.length < 2) return null
    const min = Math.min(...done.map(f))
    const hit = done.filter((r) => f(r) === min)
    return Number.isFinite(min) && hit.length === 1 ? hit[0]!.s.id : null // a tie highlights nobody
  }
  const smallest = only(size), fastest = only(dur)

  // file -> slot index -> stats
  const matrix = new Map<string, Map<number, { adds: number; dels: number }>>()
  for (const r of visible) for (const f of r.files) {
    if (!matrix.has(f.path)) matrix.set(f.path, new Map())
    matrix.get(f.path)!.set(r.i, { adds: f.adds, dels: f.dels })
  }
  const paths = [...matrix.keys()].sort((a, b) => matrix.get(b)!.size - matrix.get(a)!.size || a.localeCompare(b))

  return (
    <details className="bon-cmp" open>
      <summary>슬롯 비교</summary>
      <table className="cmp-table">
        <thead><tr><th>슬롯</th><th>상태</th><th>테스트</th><th className="num">파일</th><th className="num">+</th><th className="num">−</th><th className="num">시간</th><th>비고</th></tr></thead>
        <tbody>
          {visible.map((r) => {
            const t = r.s.testResult
            const w = slotWarning(r.s)
            return (
              <tr key={r.s.id} className={task.selectedSlot === r.s.id ? 'chosen' : ''}>
                <td>슬롯 {r.i + 1} <span className="muted">{AGENT_LABEL[r.s.agent]}</span></td>
                <td>{STATUS_LABEL[r.s.status]}</td>
                <td>{t ? <span className={'tres ' + t.status}>{TEST_LABEL[t.status]}{t.total !== undefined ? ` ${t.passed ?? '?'}/${t.total}` : ''}</span> : <span className="muted">미실행</span>}</td>
                <td className="num">{r.tot ? r.tot.files : r.loading ? '…' : '-'}</td>
                <td className="num">{r.tot ? <span className="ok">+{r.tot.adds}</span> : '-'}{smallest === r.s.id && <span className="cmp-best">최소 변경</span>}</td>
                <td className="num">{r.tot ? <span className="bad">−{r.tot.dels}</span> : '-'}</td>
                <td className="num">{fmtSec(r.s)}{fastest === r.s.id && <span className="cmp-best">최단</span>}</td>
                <td className="small">{r.error ? <span className="bad">diff를 읽지 못함</span> : w ? <span className="bad" title={w}>⚠ {w}</span> : ''}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {paths.length > 0 && (
        <details className="cmp-files" open={paths.length <= 8}>
          <summary className="small muted">슬롯별 변경 파일 {paths.length}개</summary>
          <table className="cmp-table">
            <thead><tr><th>파일</th>{visible.map((r) => <th key={r.s.id} className="num">슬롯 {r.i + 1}</th>)}</tr></thead>
            <tbody>
              {paths.map((p) => {
                const m = matrix.get(p)!
                return (
                  <tr key={p}>
                    <td className="path">{p}{visible.length > 1 && m.size === 1 && <span className="cmp-best cmp-only">1개 슬롯만</span>}</td>
                    {visible.map((r) => {
                      const c = m.get(r.i)
                      return <td key={r.s.id} className="num cmp-mark">{c ? <><span className="ok">+{c.adds}</span> <span className="bad">−{c.dels}</span></> : <span className="cmp-none">—</span>}</td>
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </details>
      )}
    </details>
  )
}

function SlotPanel({ task, slot, index, diff, live, canPick, run, onPlan }: { task: Task; slot: Slot; index: number; diff?: string; live?: string[]; canPick: boolean; run: Run; onPlan: (item: Omit<PlanContextItem, 'id'>) => void }) {
  const [tab, setTab] = useState<'diff' | 'tests' | 'result' | 'log'>('diff')
  const [stored, setStored] = useState('')
  const [note, setNote] = useState('')
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const paneRef = useRef<HTMLDivElement>(null)
  const settled = slot.status === 'done' || slot.status === 'failed'
  const chosen = task.selectedSlot === slot.id
  const gone = task.status === 'merged' ? !chosen : task.status === 'discarded'
  const warn = slotWarning(slot)

  useEffect(() => {
    let stale = false
    if (tab !== 'log') return
    void api().getSlotLog(task.id, slot.id).then((v) => !stale && setStored(v))
    return () => { stale = true }
  }, [task.id, slot.id, tab, slot.status])

  const parsedFiles = useMemo(() => parseDiff(diff ?? '').files, [diff])
  const tot = useMemo(() => diffTotals(parsedFiles), [parsedFiles])
  const [planned, setPlanned] = useState(false)
  const plannedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(plannedTimer.current), [])
  // facts only (status, tests, files, final answer); the diff body is not included unless the user adds it in the planner
  const addPlan = () => {
    onPlan(slotDigest(task, slot, index, diff !== undefined && parsedFiles.length ? { ...tot, paths: parsedFiles.map((f) => f.path) } : undefined))
    setPlanned(true)
    clearTimeout(plannedTimer.current)
    plannedTimer.current = setTimeout(() => setPlanned(false), 1500)
  }
  const t = slot.testResult

  // copies the text currently rendered in this slot's pane (whichever tab is selected)
  const copy = async () => {
    // the diff tab is drawn with gutters and markers, so copy the raw diff text instead of the rendered rows
    const text = tab === 'diff' && settled && diff !== undefined ? diff : paneRef.current?.innerText ?? ''
    try {
      await navigator.clipboard.writeText(text)
      setCopied('ok')
    } catch {
      setCopied('fail')
    }
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(null), 1500)
  }
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  // Alt+1..4 switches every slot's tab at once so slots stay comparable
  useEffect(() => {
    const h = (e: Event) => setTab((e as CustomEvent<typeof tab>).detail)
    window.addEventListener('af:tab', h)
    return () => window.removeEventListener('af:tab', h)
  }, [])

  const batchRunning = task.status === 'running'
  const slotRunning = batchRunning && slot.status === 'running'
  const canRerun = !gone && !batchRunning && ['created', 'failed', 'awaiting-approval'].includes(task.status) && ['done', 'failed', 'cancelled', 'interrupted'].includes(slot.status)
  const submitNote = () => {
    const text = note.trim()
    if (slotRunning) {
      if (!text) return
      void run(() => api().queueSlotNote(task.id, slot.id, text))
    } else if (canRerun) {
      if (slot.status === 'done' && !confirm(`슬롯 ${index + 1}은 이미 완료된 결과입니다.\n현재 결과 위에서 이어서 실행하며, 테스트를 다시 돌립니다.\n계속할까요?`)) return
      void run(() => api().runSlot(task.id, slot.id, text || undefined))
    }
    setNote('')
  }

  const pick = () => {
    const base = `슬롯 ${index + 1} (${AGENT_LABEL[slot.agent]})을 선택해 ${slot.branch}를 현재 브랜치로 머지하고, 나머지 슬롯은 삭제합니다.`
    if (warn) {
      if (!confirm(`⚠ ${warn}\n\n${base}\n\n그래도 강제로 선택하시겠습니까?`)) return
      void run(() => api().selectSlot(task.id, slot.id, true))
    } else if (confirm(`${base}\n계속할까요?`)) void run(() => api().selectSlot(task.id, slot.id, false))
  }

  return (
    <section className={'bon-slot' + (chosen ? ' chosen' : '') + (gone ? ' gone' : '')}>
      <div className="bon-head">
        <div>
          <strong>슬롯 {index + 1}</strong> <span className="muted small">{AGENT_LABEL[slot.agent]}</span>
        </div>
        <div className="bon-head-right">
          {slotRunning && <button className="btn sm danger" title="이 슬롯만 중지합니다. 다른 슬롯은 계속 실행됩니다" onClick={() => run(() => api().cancelSlot(task.id, slot.id))}>중지</button>}
          {planned && <span className="copied small" role="status">추가됨</span>}
          {copied && <span className="copied small" role="status">{copied === 'ok' ? '복사됨' : '복사 실패'}</span>}
          {!gone && <button className="icon-btn" title="이 슬롯의 결과 요약을 계획 도우미에 추가 (diff 제외)" aria-label="계획 도우미에 추가" onClick={addPlan}>✚</button>}
          {!gone && <button className="icon-btn" title={`현재 탭(${TAB_LABEL[tab]}) 내용 복사`} aria-label="현재 탭 내용 복사" onClick={copy}>⧉</button>}
          <span className={'badge ' + slot.status}>{chosen ? '선택됨' : gone ? '정리됨' : STATUS_LABEL[slot.status]}</span>
        </div>
      </div>
      {!gone && (
        <>
          <div className="small">
            {t ? <span className={'tres ' + t.status}>{t.status === 'none' ? '' : '테스트 '}{TEST_LABEL[t.status]}{t.total !== undefined ? ` (${t.passed ?? '?'}/${t.total})` : ''}</span> : <span className="muted">테스트 {settled ? '미실행' : '대기'}</span>}
            {settled && tot.files > 0 && <span className="muted"> · 파일 {tot.files} · +{tot.adds} −{tot.dels}</span>}
            {slot.startedAt && slot.endedAt && <span className="muted"> · {Math.round((slot.endedAt - slot.startedAt) / 1000)}초</span>}
          </div>
          {canPick && slot.status === 'done' && (
            <button className={'btn ' + (warn ? 'danger' : 'primary')} title={warn ?? undefined} onClick={pick}>{warn ? '경고 확인 후 선택' : '이 결과 선택 · 머지'}</button>
          )}
          {canPick && warn && slot.status === 'done' && <div className="warnbar small">⚠ {warn}</div>}
          {slot.queued && (
            <div className="queued small">
              <span className="muted">대기 중인 추가 지시 (현재 실행이 끝나면 이어서 실행):</span> {slot.queued}{' '}
              <button className="link" onClick={() => run(() => api().queueSlotNote(task.id, slot.id, ''))}>취소</button>
            </div>
          )}
          {(slotRunning || canRerun) && (
            <details className="steer">
              <summary className="small">{slotRunning ? '추가 지시 (실행 후 이어서)' : '추가 지시 · 이 슬롯만 다시 실행'}</summary>
              <textarea
                value={note}
                rows={3}
                maxLength={QUEUE_NOTE_MAX}
                placeholder={slotRunning ? '지금 실행이 끝나면 이어서 적용할 지시 (Ctrl+Enter로 추가)' : '이어서 시킬 내용. 비워 두면 같은 요청으로 다시 실행 (Ctrl+Enter)'}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitNote() } }}
              />
              <div className="row">
                <button className="btn sm primary" disabled={slotRunning && !note.trim()} onClick={submitNote}>
                  {slotRunning ? '대기열에 추가' : note.trim() ? '추가 지시로 이어서 실행' : '이 슬롯만 다시 실행'}
                </button>
                {!slotRunning && <span className="muted small">현재 worktree 상태 위에서 이어서 실행하며 테스트도 다시 돌립니다.</span>}
              </div>
            </details>
          )}
          {!slotRunning && !canRerun && settled && batchRunning && <div className="muted small">다른 슬롯이 실행 중입니다. 끝난 뒤 이 슬롯에 추가 지시를 줄 수 있습니다.</div>}
          <div className="tabs">
            {(['diff', 'tests', 'result', 'log'] as const).map((k) => (
              <button key={k} className={tab === k ? 'tab sel' : 'tab'} onClick={() => setTab(k)}>{{ diff: 'diff', tests: '테스트', result: '요약', log: '로그' }[k]}</button>
            ))}
          </div>
          <div className="pane bon-pane" ref={paneRef}>
            {tab === 'diff' && (settled
              ? diff === undefined ? <div className="muted small dv-pad">diff 불러오는 중...</div> : <DiffView text={diff} />
              : <pre>(실행 완료 후 표시됩니다)</pre>)}
            {tab === 'tests' && <SlotTests slot={slot} />}
            {tab === 'result' && <pre>{slot.output || '(아직 결과가 없습니다)'}</pre>}
            {tab === 'log' && <LogPre lines={live && live.length ? live : stored.split('\n')} />}
          </div>
        </>
      )}
    </section>
  )
}

function SlotTests({ slot }: { slot: Slot }) {
  const r = slot.testResult
  if (!r) return <div className="muted">{slot.status === 'running' ? '에이전트 실행 중...' : '테스트 결과가 없습니다.'}</div>
  if (r.status === 'none') return <div className="muted">자동 테스트 없음 (package.json의 scripts.test 또는 *.test.js 없음)</div>
  const counts = r.total !== undefined ? `총 ${r.total} · 통과 ${r.passed ?? '?'} · 실패 ${r.failed ?? '?'} · ` : ''
  return (
    <div className={'testbox ' + r.status}>
      <h3>{TEST_LABEL[r.status]}</h3>
      <div className="small">{r.command} · {counts}{(r.durationMs / 1000).toFixed(1)}초 · exit {String(r.exitCode ?? '-')}</div>
      {r.failures.length > 0 && <ul>{r.failures.map((f, i) => <li key={i}>{f}</li>)}</ul>}
      {slot.coverage && <div className="small">새 기능 테스트 규칙: {slot.coverage.status === 'ok' ? 'OK' : '위반'} - {slot.coverage.reason}</div>}
      {r.output && <details open={r.status !== 'pass'}><summary className="small">테스트 출력</summary><pre>{r.output}</pre></details>}
    </div>
  )
}

function LogPre({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => { ref.current?.scrollTo(0, ref.current.scrollHeight) }, [lines.length])
  return <pre ref={ref} className="log">{lines.join('\n') || '(로그 없음)'}</pre>
}

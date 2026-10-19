import type { Task } from './types'

export type AttentionKind = 'select' | 'approve' | 'merge' | 'failed'
export interface Attention {
  kind: AttentionKind
  label: string // short sidebar/notification text
  stamp: number // changes whenever a new attention event happens for this task (used to dismiss 'failed' once viewed)
}

const units = (t: Task) => (t.mode === 'best-of-n' ? t.slots ?? [] : t.stages)
const lastEnd = (t: Task) => Math.max(0, ...units(t).map((u) => u.endedAt ?? 0))

/** The task is waiting for the user (decision, approval or a failure to look at). null = nothing needed right now. */
export function attention(t: Task): Attention | null {
  const stamp = lastEnd(t)
  const bon = t.mode === 'best-of-n'
  switch (t.status) {
    case 'awaiting-approval':
      return bon ? { kind: 'select', label: '결과 선택 대기', stamp } : { kind: 'approve', label: '머지 승인 대기', stamp }
    case 'ready-to-merge':
      return { kind: 'merge', label: '머지 대기', stamp }
    case 'created':
      // pipeline between stages: the next stage needs a human click. A brand-new task is not "waiting".
      return !bon && t.stages.some((s) => s.status === 'done') ? { kind: 'approve', label: '다음 단계 승인 대기', stamp } : null
    case 'failed':
      // a user-cancelled run also ends as 'failed'; only a real failure/interruption is worth interrupting for
      return units(t).some((u) => u.status === 'failed' || u.status === 'interrupted') ? { kind: 'failed', label: '실패', stamp } : null
    default:
      return null
  }
}

/** One-line progress for the sidebar, e.g. "3/4 단계" or "슬롯 2/3 완료". */
export function progress(t: Task): string | null {
  if (t.mode === 'best-of-n') {
    const s = t.slots ?? []
    if (s.length === 0) return null
    const done = s.filter((x) => x.status === 'done' || x.status === 'failed').length
    return `Best-of-N · 슬롯 ${done}/${s.length} 종료`
  }
  const done = t.stages.filter((s) => s.status === 'done').length
  return t.stages.length ? `파이프라인 · ${done}/${t.stages.length} 단계` : null
}

export const attentionKey = (t: Task, a: Attention) => `${t.id}:${a.kind}:${a.stamp}`

import type { Slot } from './types'

/** Reason a slot should not be merged without an explicit override; null = nothing to warn about. */
export function slotWarning(s: Slot): string | null {
  if (s.status !== 'done') return '에이전트 실행이 완료되지 않았습니다'
  const t = s.testResult
  if (!t) return '테스트가 실행되지 않았습니다'
  if (t.status !== 'pass' && t.status !== 'none') return `테스트 결과가 ${t.status.toUpperCase()}입니다`
  if (s.coverage?.status === 'missing') return s.coverage.reason
  return null
}

import type { Slot } from './types'
import { t as tr } from './i18n'

/** Reason a slot should not be merged without an explicit override; null = nothing to warn about. */
export function slotWarning(s: Slot): string | null {
  if (s.status !== 'done') return tr('에이전트 실행이 완료되지 않았습니다')
  const t = s.testResult
  if (!t) return tr('테스트가 실행되지 않았습니다')
  if (t.status !== 'pass' && t.status !== 'none') return tr('테스트 결과가 {status}입니다', { status: t.status.toUpperCase() })
  if (s.coverage?.status === 'missing') return s.coverage.reason
  return null
}

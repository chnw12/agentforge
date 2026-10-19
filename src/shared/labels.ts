import type { StageKind } from './types'
import { t } from './i18n'

// Display names shared by the UI and by the text sent to the planner. Functions, not constants: the language can change at runtime.

export const statusLabel = (s: string): string => ({
  pending: t('대기'), running: t('실행 중'), done: t('완료'), failed: t('실패'), interrupted: t('중단됨'), cancelled: t('취소됨'),
  created: t('준비됨'), 'awaiting-approval': t('승인 대기'), 'ready-to-merge': t('머지 가능'), merged: t('머지됨'), discarded: t('폐기됨')
}[s] ?? s)

const STAGE_ORDER: StageKind[] = ['design', 'review', 'build', 'verify']
export const stageLabel = (k: StageKind, numbered = false): string => {
  const name = { design: t('설계'), review: t('교차검토'), build: t('구현'), verify: t('2차검증') }[k]
  return numbered ? `${STAGE_ORDER.indexOf(k) + 1}. ${name}` : name
}

export const testLabel = (s: string): string => ({
  pass: 'PASS', fail: 'FAIL', timeout: t('타임아웃(FAIL)'), error: t('실행 오류(FAIL)'), none: t('테스트 없음')
}[s] ?? s)

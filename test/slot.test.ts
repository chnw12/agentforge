import { describe, expect, it } from 'vitest'
import { slotWarning } from '../src/shared/slot'
import type { Slot } from '../src/shared/types'

const base: Slot = { id: 'aaaaaaaa', agent: 'claude', branch: 'af/aaaaaaaa', status: 'done', output: 'ok', head: 'h' }
const tr = (status: 'pass' | 'fail' | 'none') => ({ status, command: 'npm test', head: 'h', durationMs: 1, failures: [], output: '' })

describe('slotWarning', () => {
  it('passes a done slot with passing tests', () => expect(slotWarning({ ...base, testResult: tr('pass') })).toBeNull())
  it('accepts a project that has no tests at all', () => expect(slotWarning({ ...base, testResult: tr('none') })).toBeNull())
  it('warns when tests did not run', () => expect(slotWarning(base)).toMatch(/실행되지 않았습니다/))
  it('warns on failing tests', () => expect(slotWarning({ ...base, testResult: tr('fail') })).toMatch(/FAIL/))
  it('warns on missing coverage', () =>
    expect(slotWarning({ ...base, testResult: tr('pass'), coverage: { status: 'missing', reason: 'no tests for new fn', newSymbols: [], testFiles: [] } })).toBe('no tests for new fn'))
  it('warns when the agent did not finish', () => expect(slotWarning({ ...base, status: 'failed' })).toMatch(/완료되지/))
})

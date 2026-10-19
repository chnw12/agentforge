import { describe, expect, it } from 'vitest'
import { claudeArgs } from '../src/main/pipeline'
import { DEFAULT_SETTINGS } from '../src/shared/types'

describe('claudeArgs model setting', () => {
  it('omits --model by default so Claude Code uses its own default', () => {
    expect(claudeArgs('build', DEFAULT_SETTINGS)).not.toContain('--model')
  })

  it('passes the configured model for every stage kind', () => {
    for (const kind of ['design', 'review', 'build', 'verify'] as const) {
      const a = claudeArgs(kind, { ...DEFAULT_SETTINGS, claudeModel: 'claude-sonnet-5-5' })
      expect(a[a.indexOf('--model') + 1]).toBe('claude-sonnet-5-5')
    }
  })
})

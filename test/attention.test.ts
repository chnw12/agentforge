import { describe, expect, it } from 'vitest'
import { attention, progress } from '../src/shared/attention'
import { transitions } from '../src/main/notify'
import type { Slot, Stage, Task } from '../src/shared/types'

const stage = (kind: Stage['kind'], status: Stage['status'], endedAt?: number): Stage => ({ kind, agent: 'claude', status, output: '', endedAt })
const slot = (id: string, status: Slot['status'], endedAt?: number): Slot => ({ id, agent: 'claude', branch: 'af/' + id, status, output: '', endedAt })
const task = (o: Partial<Task>): Task => ({
  id: 'aaaaaaaa', projectId: 'p', title: 't', prompt: 'x', status: 'created', branch: 'b', baseCommit: 'c', dirtyAtCreate: false, stages: [], createdAt: 1, ...o
})

describe('attention', () => {
  it('is null while running', () => expect(attention(task({ status: 'running' }))).toBeNull())
  it('is null for a brand-new pipeline task', () => expect(attention(task({ stages: [stage('design', 'pending')] }))).toBeNull())
  it('waits for approval between pipeline stages', () => {
    expect(attention(task({ stages: [stage('design', 'done', 5), stage('review', 'pending')] }))).toMatchObject({ kind: 'approve', stamp: 5 })
  })
  it('asks to pick a result for best-of-n', () => {
    expect(attention(task({ mode: 'best-of-n', status: 'awaiting-approval', slots: [slot('bbbbbbbb', 'done', 9)] }))).toMatchObject({ kind: 'select', stamp: 9 })
  })
  it('flags a real failure but not a user cancel', () => {
    expect(attention(task({ status: 'failed', stages: [stage('design', 'failed', 3)] }))?.kind).toBe('failed')
    expect(attention(task({ status: 'failed', stages: [stage('design', 'cancelled', 3)] }))).toBeNull()
  })
  it('flags merge-ready work', () => expect(attention(task({ status: 'ready-to-merge' }))?.kind).toBe('merge'))
  it('is null once merged or discarded', () => {
    expect(attention(task({ status: 'merged' }))).toBeNull()
    expect(attention(task({ status: 'discarded' }))).toBeNull()
  })
})

describe('progress', () => {
  it('counts pipeline stages', () => expect(progress(task({ stages: [stage('design', 'done'), stage('review', 'pending')] }))).toBe('파이프라인 · 1/2 단계'))
  it('counts finished best-of-n slots', () => {
    expect(progress(task({ mode: 'best-of-n', slots: [slot('a1111111', 'done'), slot('b2222222', 'running')] }))).toBe('Best-of-N · 슬롯 1/2 종료')
  })
})

describe('transitions', () => {
  const running = task({ status: 'running', stages: [stage('design', 'running')] })
  const done = task({ status: 'created', stages: [stage('design', 'done', 4)] })
  it('records a baseline without notifying on the first call', () => {
    expect(transitions(null, [done]).events).toEqual([])
  })
  it('notifies when a running task starts waiting for the user', () => {
    const { next } = transitions(null, [running])
    const r = transitions(next, [done])
    expect(r.events).toHaveLength(1)
    expect(r.events[0]).toMatchObject({ taskId: 'aaaaaaaa', attention: { kind: 'approve' } })
  })
  it('does not notify again for an unchanged task', () => {
    const { next } = transitions(null, [done])
    expect(transitions(next, [done]).events).toEqual([])
  })
  it('stays quiet when a run is cancelled', () => {
    const { next } = transitions(null, [running])
    expect(transitions(next, [task({ status: 'failed', stages: [stage('design', 'cancelled')] })]).events).toEqual([])
  })
})

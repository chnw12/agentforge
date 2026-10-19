import { describe, expect, it } from 'vitest'
import { redact } from '../src/main/redact'
import { parseEvent } from '../src/main/parse'
import { runProcess, killTree } from '../src/main/proc'

describe('redact', () => {
  it('masks common secrets', () => {
    const s = 'key sk-ant-api03-abcdefghijklmnop and ghp_abcdefghijklmnopqrstuvwx and Bearer abcdefghijklmnopqrstu'
    const r = redact(s)
    expect(r).not.toContain('abcdefghijklmnop')
    expect(r).toContain('[REDACTED]')
  })
  it('masks key=value pairs but keeps the key name', () => {
    expect(redact('api_key = "supersecretvalue1"')).toMatch(/api_key = "\[REDACTED\]/)
  })
})

describe('parseEvent', () => {
  it('claude assistant text and tool_use', () => {
    const l = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Read' }] } })
    expect(parseEvent('claude', l).show).toBe('hi\n[tool] Read')
  })
  it('claude result is the final answer', () => {
    expect(parseEvent('claude', JSON.stringify({ type: 'result', result: 'done' })).final).toBe('done')
  })
  it('codex agent_message is final', () => {
    const l = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })
    expect(parseEvent('codex', l).final).toBe('ok')
  })
  it('non-json lines are shown verbatim', () => {
    expect(parseEvent('codex', 'plain text').show).toBe('plain text')
  })
})

describe('runProcess', () => {
  const node = process.execPath
  it('feeds stdin, splits lines across chunks (CRLF safe)', async () => {
    const lines: string[] = []
    const res = await runProcess(node, ['-e', "process.stdin.on('data',d=>process.stdout.write(d.toString().toUpperCase()))"], {
      cwd: process.cwd(), stdin: 'a\r\nb\nc', timeoutMs: 10_000, onLine: (l) => lines.push(l)
    })
    expect(res.code).toBe(0)
    expect(lines).toEqual(['A', 'B', 'C'])
  })
  it('kills the whole tree on timeout', async () => {
    const res = await runProcess(node, ['-e', 'setInterval(()=>{},1000)'], { cwd: process.cwd(), timeoutMs: 500 })
    expect(res.timedOut).toBe(true)
  })
  it('stops runaway output', async () => {
    const res = await runProcess(node, ['-e', "setInterval(()=>console.log('x'.repeat(1000)),1)"], { cwd: process.cwd(), timeoutMs: 20_000, maxBytes: 20_000 })
    expect(res.truncated).toBe(true)
  })
  it('does not leak non-allowlisted env', async () => {
    process.env.AF_SECRET_TEST = 'leak'
    const out: string[] = []
    await runProcess(node, ['-e', 'console.log(process.env.AF_SECRET_TEST ?? "none")'], { cwd: process.cwd(), timeoutMs: 10_000, onLine: (l) => out.push(l) })
    expect(out).toEqual(['none'])
  })
  void killTree
})

import { verdictOf } from '../src/main/parse'
describe('verdictOf', () => {
  it('requires an explicit verdict; last one wins', () => {
    expect(verdictOf('all good VERDICT: PASS')).toBe('PASS')
    expect(verdictOf('VERDICT: PASS ... later found bug\nVERDICT: FAIL')).toBe('FAIL')
    expect(verdictOf('VERDICT: **PASS**')).toBe('PASS')
    expect(verdictOf('looks fine to me')).toBeNull()
    expect(verdictOf('VERDICT: PASSING')).toBeNull()
  })
})
describe('runProcess raw cap', () => {
  it('stops a newline-free stream', async () => {
    const res = await runProcess(process.execPath, ['-e', "setInterval(()=>process.stdout.write('x'.repeat(100000)),1)"], { cwd: process.cwd(), timeoutMs: 20_000, maxBytes: 200_000 })
    expect(res.truncated).toBe(true)
  })
})

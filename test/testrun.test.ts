import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { detectTests, parseTestOutput, runTests, testsBlockMerge } from '../src/main/testrun'

const dirs: string[] = []
function proj(files: Record<string, string>): string {
  const d = mkdtempSync(path.join(tmpdir(), 'af-testrun-'))
  dirs.push(d)
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(d, f)), { recursive: true })
    writeFileSync(path.join(d, f), c)
  }
  return d
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

const CALC = (mul: string) => `exports.multiply = (a, b) => ${mul}`
const CALC_TEST = `const t=require('node:test'),a=require('node:assert'),{multiply}=require('./calc');
t('multiply',()=>{a.strictEqual(multiply(3,4),12)});t('multiply zero',()=>{a.strictEqual(multiply(0,9),0)})`

describe('detectTests', () => {
  it('returns null when nothing is runnable', async () => {
    expect(await detectTests(proj({ 'a.js': '1' }))).toBeNull()
  })
  it('ignores the npm-init placeholder script', async () => {
    const d = proj({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) })
    expect(await detectTests(d)).toBeNull()
  })
  it('prefers scripts.test, falls back to *.test.js, skips node_modules', async () => {
    expect((await detectTests(proj({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) })))?.kind).toBe('npm')
    expect((await detectTests(proj({ 'x.test.js': '' })))?.kind).toBe('node')
    expect(await detectTests(proj({ 'node_modules/p/x.test.js': '' }))).toBeNull()
  })
})

describe('runTests (fail-closed)', () => {
  it('passes a correct implementation and reports counts', async () => {
    const r = await runTests(proj({ 'calc.js': CALC('a * b'), 'calc.test.js': CALC_TEST }), 'abc')
    expect(r.status).toBe('pass')
    expect([r.total, r.passed, r.failed]).toEqual([2, 2, 0])
    expect(testsBlockMerge(r)).toBe(false)
  })
  it('catches a buggy implementation (a + b) with the failing test name and reason', async () => {
    const r = await runTests(proj({ 'calc.js': CALC('a + b'), 'calc.test.js': CALC_TEST }), 'abc')
    expect(r.status).toBe('fail')
    expect(r.failed).toBe(2)
    expect(r.failures.join('\n')).toMatch(/multiply/)
    expect(r.failures.join('\n')).toMatch(/7 !== 12/)
    expect(testsBlockMerge(r)).toBe(true)
  })
  it('kills a hanging test at the timeout instead of blocking', async () => {
    const t0 = Date.now()
    const r = await runTests(proj({ 'h.test.js': "require('node:test')('hang',()=>new Promise(()=>setInterval(()=>{},1000)))" }), 'abc', undefined, undefined, 2000)
    expect(r.status).toBe('timeout')
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(testsBlockMerge(r)).toBe(true)
  })
  it('treats a failing npm test script as FAIL', async () => {
    const d = proj({ 'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(3)"' } }) })
    const r = await runTests(d, 'abc')
    expect(r.status).toBe('fail')
    expect(r.exitCode).toBe(3)
  })
  it('passes a green npm test script', async () => {
    const r = await runTests(proj({ 'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }) }), 'abc')
    expect(r.status).toBe('pass')
  })
  it('returns none (does not block) when there are no tests', async () => {
    const r = await runTests(proj({ 'a.js': '1' }), 'abc')
    expect(r.status).toBe('none')
    expect(testsBlockMerge(r)).toBe(false)
  })
  it('treats an unknown/absent result as non-blocking only for "none"/undefined', () => {
    expect(testsBlockMerge(undefined)).toBe(false)
    for (const status of ['fail', 'timeout', 'error'] as const) expect(testsBlockMerge({ status, command: '', head: '', durationMs: 0, failures: [], output: '' })).toBe(true)
  })
})

describe('parseTestOutput', () => {
  it('returns no counts for foreign reporters', () => {
    expect(parseTestOutput('Tests 1 failed | 2 passed')).toEqual({ total: undefined, passed: undefined, failed: undefined, failures: [] })
  })
})

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { TestResult } from '../shared/types'
import { resolveExe, runProcess } from './proc'
import { redact } from './redact'

export const TEST_TIMEOUT_MS = 60_000
const OUTPUT_KEEP = 12_000
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'coverage'])

export type TestPlan = { kind: 'npm'; label: string } | { kind: 'node'; label: string } | null

/** Look for a runnable test command in `dir`: package.json "scripts.test" first, else *.test.js files for `node --test`. */
export async function detectTests(dir: string): Promise<TestPlan> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
    const t = pkg.scripts?.test
    // `npm init` leaves a placeholder that always exits 1; it is not a real test command
    if (typeof t === 'string' && t.trim() && !/no test specified/i.test(t)) return { kind: 'npm', label: 'npm test' }
  } catch {
    /* no/invalid package.json - fall through */
  }
  return (await hasTestFile(dir, 0)) ? { kind: 'node', label: 'node --test' } : null
}

async function hasTestFile(dir: string, depth: number): Promise<boolean> {
  if (depth > 4) return false
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const e of entries) if (e.isFile() && /\.test\.js$/.test(e.name)) return true
  for (const e of entries) if (e.isDirectory() && !SKIP_DIRS.has(e.name) && (await hasTestFile(path.join(dir, e.name), depth + 1))) return true
  return false
}

/** Parse node's spec reporter (✔/✖ lines, "ℹ pass N" summary, "failing tests:" block). Other runners just yield no counts. */
export function parseTestOutput(out: string): Pick<TestResult, 'total' | 'passed' | 'failed' | 'failures'> {
  const num = (k: string) => {
    const m = out.match(new RegExp(`^\\s*ℹ ${k} (\\d+)`, 'm'))
    return m ? Number(m[1]) : undefined
  }
  const failures: string[] = []
  const lines = out.split(/\r?\n/)
  const start = lines.findIndex((l) => /^✖ failing tests:/.test(l))
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      const m = lines[i]!.match(/^✖ (.+?) \([\d.]+ms\)\s*$/)
      if (!m) continue
      const reason: string[] = []
      for (let j = i + 1; j < lines.length && reason.length < 3; j++) {
        const l = lines[j]!
        if (/^(test at |✖ )/.test(l) || /^\s+at /.test(l)) break
        if (l.trim()) reason.push(l.trim())
      }
      failures.push(reason.length ? `${m[1]} — ${reason.join(' / ')}` : m[1]!)
    }
  }
  return { total: num('tests'), passed: num('pass'), failed: num('fail'), failures }
}

/**
 * Run the project's tests inside `wt` (never anywhere else) with a hard timeout.
 * Fail-closed: only exit 0 with no reported failures counts as 'pass'; a missing runner, spawn problem or timeout is a failure too.
 * Returns status 'none' only when no test command exists at all.
 */
export async function runTests(
  wt: string,
  head: string,
  onLine: (l: string) => void = () => undefined,
  onPid?: (pid: number) => void,
  timeoutMs = TEST_TIMEOUT_MS
): Promise<TestResult> {
  const plan = await detectTests(wt)
  if (!plan) return { status: 'none', command: '', head, durationMs: 0, failures: [], output: '' }
  const base = { command: plan.label, head, failures: [] as string[] }

  // constant argv only - nothing from the repo is interpolated into the command line
  let exe: string | null
  let args: string[]
  if (plan.kind === 'npm') {
    exe = process.env.ComSpec ?? resolveExe('cmd')
    args = ['/d', '/s', '/c', 'npm test']
  } else {
    exe = resolveExe('node')
    args = ['--test', '--test-reporter=spec']
  }
  if (!exe) return { ...base, status: 'error', durationMs: 0, output: `테스트 실행기를 찾을 수 없습니다 (${plan.kind === 'npm' ? 'cmd.exe' : 'node.exe'})` }

  const lines: string[] = []
  const t0 = Date.now()
  const res = await runProcess(exe, args, {
    cwd: wt,
    timeoutMs,
    maxBytes: 1024 * 1024,
    onPid,
    env: { CI: '1' }, // keep watch-mode runners (vitest/jest) from waiting forever
    onLine: (l) => {
      lines.push(l)
      onLine(l)
    }
  })
  const durationMs = Date.now() - t0
  const full = redact(lines.join('\n'))
  const output = full.length > OUTPUT_KEEP ? '[... 앞부분 생략 ...]\n' + full.slice(-OUTPUT_KEEP) : full
  const parsed = parseTestOutput(full)
  const common = { ...base, durationMs, exitCode: res.code, output, ...parsed }

  if (res.timedOut) return { ...common, status: 'timeout', failures: [`${Math.round(timeoutMs / 1000)}초 타임아웃 - 프로세스 강제 종료됨`, ...parsed.failures] }
  if (res.truncated) return { ...common, status: 'error', failures: ['출력 한도 초과로 중단됨', ...parsed.failures] }
  if (res.code !== 0) return { ...common, status: 'fail' }
  // exit 0 but the reporter says otherwise, or node --test ran nothing: do not trust it
  if ((parsed.failed ?? 0) > 0) return { ...common, status: 'fail' }
  if (plan.kind === 'node' && !parsed.total) return { ...common, status: 'fail', failures: ['실행된 테스트가 0개입니다'] }
  return { ...common, status: 'pass' }
}

/** Anything that must block approval. 'none' (no tests exist) is the only non-pass state that does not. */
export const testsBlockMerge = (r: TestResult | undefined): boolean => !!r && r.status !== 'pass' && r.status !== 'none'

export function summarizeTests(r: TestResult): string {
  if (r.status === 'none') return '자동 테스트 없음, 코드 리뷰만 수행'
  const counts = r.total !== undefined ? ` (총 ${r.total} / 통과 ${r.passed ?? '?'} / 실패 ${r.failed ?? '?'})` : ''
  const label = { pass: 'PASS', fail: 'FAIL', timeout: 'TIMEOUT(=FAIL)', error: 'ERROR(=FAIL)' }[r.status]
  return `${r.command}: ${label}${counts}, ${(r.durationMs / 1000).toFixed(1)}s`
}

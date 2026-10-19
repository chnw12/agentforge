import { afterAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const home = mkdtempSync(path.join(tmpdir(), 'af-home-'))
vi.mock('electron', () => ({ app: { getPath: () => home } }))

const { changedFiles } = await import('../src/main/git')
const { analyzeTestCoverage } = await import('../src/main/coverage')

const repos: string[] = [home]
afterAll(() => repos.forEach((d) => rmSync(d, { recursive: true, force: true })))
const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim()

function repo(files: Record<string, string>): { dir: string; base: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'af-cov-'))
  repos.push(dir)
  g(dir, 'init', '-q')
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    writeFileSync(path.join(dir, f), c)
  }
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'base')
  return { dir, base: g(dir, 'rev-parse', 'HEAD') }
}
const commit = (dir: string) => { g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'work') }

const CALC = 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n'
const CALC_MUL = 'function add(a, b) {\n  return a + b;\n}\nfunction multiply(a, b) {\n  return a + b;\n}\nmodule.exports = { add, multiply };\n'

describe('changedFiles + analyzeTestCoverage on real git diffs', () => {
  it('buggy multiply without tests -> missing', async () => {
    const { dir, base } = repo({ 'calculator.js': CALC, 'calculator.test.js': "test('add', () => {});\n" })
    writeFileSync(path.join(dir, 'calculator.js'), CALC_MUL); commit(dir)
    expect(analyzeTestCoverage(await changedFiles(dir, base)).status).toBe('missing')
  })
  it('multiply with a test added -> ok', async () => {
    const { dir, base } = repo({ 'calculator.js': CALC, 'calculator.test.js': "test('add', () => {});\n" })
    writeFileSync(path.join(dir, 'calculator.js'), CALC_MUL)
    writeFileSync(path.join(dir, 'calculator.test.js'), "test('add', () => {});\ntest('multiply', () => {});\n"); commit(dir)
    expect(analyzeTestCoverage(await changedFiles(dir, base)).status).toBe('ok')
  })
  it('docs/config only -> ok', async () => {
    const { dir, base } = repo({ 'calculator.js': CALC, 'README.md': '# x\n', 'package.json': '{}\n' })
    writeFileSync(path.join(dir, 'README.md'), '# x\nmore\n'); writeFileSync(path.join(dir, 'package.json'), '{"a":1}\n'); writeFileSync(path.join(dir, 'NOTES.md'), 'n\n'); commit(dir)
    expect(analyzeTestCoverage(await changedFiles(dir, base)).status).toBe('ok')
  })
  it('git rename of a source file (content identical) is not a new feature', async () => {
    const { dir, base } = repo({ 'calculator.js': CALC })
    renameSync(path.join(dir, 'calculator.js'), path.join(dir, 'math.js')); commit(dir)
    const files = await changedFiles(dir, base)
    expect(files.map((f) => f.path)).toEqual(['math.js'])
    expect(analyzeTestCoverage(files).status).toBe('ok')
  })
  it('deleted file and unusual file names are handled (-z parsing)', async () => {
    const { dir, base } = repo({ 'calculator.js': CALC, 'a b/한글 파일.js': 'function x() {}\nmodule.exports = { x };\n' })
    rmSync(path.join(dir, 'a b/한글 파일.js')); commit(dir)
    const files = await changedFiles(dir, base)
    expect(files).toHaveLength(1)
    expect(files[0]!.path).toBe('a b/한글 파일.js')
    expect(files[0]!.after).toBeUndefined()
    expect(analyzeTestCoverage(files).status).toBe('ok')
  })
})

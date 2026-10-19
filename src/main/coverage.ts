import type { CoverageResult } from '../shared/types'
import { t as tr } from '../shared/i18n'

/** One changed file in base..HEAD. `before`/`after` are full contents (undefined = absent on that side). */
export interface ChangedFile {
  path: string
  before?: string
  after?: string
}

const CODE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/i
const TEST_FILE = /(?:\.|-|_)(?:test|spec)\.[cm]?[jt]sx?$/i
const TEST_DIR = /(?:^|\/)(?:__tests__|tests?)\//i
// not product code: config, typings, generated/vendored output
const NON_SOURCE = /(?:^|\/)(?:node_modules|dist|out|build|coverage|\.git)\/|\.d\.ts$|\.config\.[cm]?[jt]s$|(?:^|\/)\.[\w.-]*rc\.[cm]?js$/i

export const isTestFile = (p: string): boolean => TEST_FILE.test(p) || (TEST_DIR.test(p) && CODE_EXT.test(p))
export const isSourceFile = (p: string): boolean => CODE_EXT.test(p) && !isTestFile(p) && !NON_SOURCE.test(p)

const ID = '[A-Za-z_$][\\w$]*'
const RE_FN = new RegExp(`^(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?function\\s*\\*?\\s*(${ID})`)
const RE_CLASS = new RegExp(`^(?:export\\s+(?:default\\s+)?)?class\\s+(${ID})`)
const RE_VAR_FN = new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+(${ID})\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*(?::[^=]+)?=>|${ID}\\s*=>)`)
const RE_CJS_FN = new RegExp(`^(?:module\\.)?exports\\.(${ID})\\s*=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|${ID}\\s*=>)`)

/** Top-level (column 0) function/class declarations, and which of them the file exports. */
export function symbolsOf(src: string | undefined): { symbols: Set<string>; exported: Set<string>; hasExports: boolean } {
  const symbols = new Set<string>()
  const exported = new Set<string>()
  if (!src) return { symbols, exported, hasExports: false }
  let hasExports = false
  for (const line of src.split(/\r?\n/)) {
    for (const re of [RE_FN, RE_CLASS, RE_VAR_FN, RE_CJS_FN]) {
      const m = line.match(re)
      if (!m) continue
      symbols.add(m[1]!)
      if (/^export\b/.test(line) || /^(?:module\.)?exports\./.test(line)) exported.add(m[1]!)
      break
    }
    if (/^export\b/.test(line) || /^(?:module\.)?exports\b/.test(line)) hasExports = true
  }
  // export { a, b as c }  /  export { a } from './x' is a re-export, not a declaration here (ignored)
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}(?!\s*from)/gm)) {
    for (const part of m[1]!.split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0]!.trim()
      if (name) exported.add(name)
    }
  }
  // module.exports = { a, b: x, c }   /   module.exports = name
  for (const m of src.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(',')) {
      const name = part.trim().split(':')[0]!.trim()
      if (new RegExp(`^${ID}$`).test(name)) exported.add(name)
    }
  }
  for (const m of src.matchAll(new RegExp(`module\\.exports\\s*=\\s*(${ID})\\s*;?\\s*$`, 'gm'))) exported.add(m[1]!)
  return { symbols, exported, hasExports }
}

/** Public surface: exported symbols if the file exports anything, otherwise every top-level symbol (plain script). */
function surface(src: string | undefined): Set<string> {
  const s = symbolsOf(src)
  if (!s.hasExports) return s.symbols
  return new Set([...s.exported].filter((n) => s.symbols.has(n)))
}

/** Did the test file gain at least one line it did not have before? (a pure deletion is not new coverage) */
function testGainedLines(f: ChangedFile): boolean {
  if (f.after === undefined) return false
  if (f.before === undefined) return f.after.trim().length > 0
  const old = new Set(f.before.split(/\r?\n/).map((l) => l.trim()))
  return f.after.split(/\r?\n/).some((l) => l.trim() && !old.has(l.trim()))
}

/**
 * Deterministic "new feature without tests" rule.
 *  - new feature  = net increase of public top-level functions/classes across source files (renames and moves cancel out)
 *  - test change  = some test file was added, or an existing one gained lines
 * Everything else (docs, config, bugfixes, refactors, private helpers, deletions, non-JS/TS languages) is 'ok'/'skipped' and never blocks.
 */
export function analyzeTestCoverage(files: ChangedFile[]): CoverageResult {
  const testFiles = files.filter((f) => isTestFile(f.path) && testGainedLines(f)).map((f) => f.path)
  const added: string[] = []
  const removed: string[] = []
  for (const f of files) {
    if (!isSourceFile(f.path)) continue
    const b = surface(f.before)
    const a = surface(f.after)
    for (const n of a) if (!b.has(n)) added.push(n)
    for (const n of b) if (!a.has(n)) removed.push(n)
  }
  // a name that disappears in one place and appears in another is a move, not a feature
  const movedOrKept = new Set(added.filter((n) => removed.includes(n)))
  const newNames = added.filter((n) => !movedOrKept.has(n))
  const goneNames = removed.filter((n) => !movedOrKept.has(n))
  // renames: only a net increase counts as a new feature
  const netNew = newNames.length - goneNames.length
  if (netNew <= 0) return { status: 'ok', reason: tr('새 공개 함수/클래스 추가 없음 (문서·설정·버그수정·리팩토링 등) - 테스트 필수 규칙 해당 없음'), newSymbols: [], testFiles }
  if (testFiles.length > 0) return { status: 'ok', reason: tr('새 기능과 함께 테스트 파일 변경이 있음'), newSymbols: newNames, testFiles }
  return {
    status: 'missing',
    reason: tr('새 공개 함수/기능({names})이 추가됐지만 테스트 파일(*.test.js 등) 변경이 diff에 없습니다', { names: newNames.join(', ') }),
    newSymbols: newNames,
    testFiles
  }
}

export const coverageBlocksMerge = (c: CoverageResult | undefined): boolean => !!c && c.status === 'missing'

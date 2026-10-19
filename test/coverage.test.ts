import { describe, expect, it } from 'vitest'
import { analyzeTestCoverage, isSourceFile, isTestFile, symbolsOf, type ChangedFile } from '../src/main/coverage'

const CALC = `function add(a, b) {\n  return a + b;\n}\n\nfunction divide(a, b) {\n  return a / b;\n}\n\nmodule.exports = { add, divide };\n`
const CALC_MUL = `function add(a, b) {\n  return a + b;\n}\n\nfunction divide(a, b) {\n  return a / b;\n}\n\nfunction multiply(a, b) {\n  return a * b;\n}\n\nmodule.exports = { add, divide, multiply };\n`
const TEST = `const test = require('node:test');\ntest('add', () => {});\n`
const verdict = (files: ChangedFile[]) => analyzeTestCoverage(files).status

describe('rule fires (true positives)', () => {
  it('new exported function, no test change -> missing', () => {
    const r = analyzeTestCoverage([{ path: 'calculator.js', before: CALC, after: CALC_MUL }])
    expect(r.status).toBe('missing')
    expect(r.newSymbols).toEqual(['multiply'])
  })
  it('new source file with exports, no test -> missing', () => {
    expect(verdict([{ path: 'src/util.ts', after: 'export function slug(s: string) { return s }\n' }])).toBe('missing')
  })
  it('arrow-function and class exports count', () => {
    expect(verdict([{ path: 'a.ts', after: 'export const f = (x: number) => x\n' }])).toBe('missing')
    expect(verdict([{ path: 'a.ts', after: 'export class Foo {}\n' }])).toBe('missing')
    expect(verdict([{ path: 'a.js', after: 'exports.hello = function () {}\n' }])).toBe('missing')
  })
  it('test file touched only by deletions does not count as coverage', () => {
    expect(verdict([
      { path: 'calculator.js', before: CALC, after: CALC_MUL },
      { path: 'calculator.test.js', before: TEST + "test('old', () => {});\n", after: TEST }
    ])).toBe('missing')
  })
})

describe('rule stays quiet (false-positive review)', () => {
  it('new function + added test -> ok', () => {
    expect(verdict([
      { path: 'calculator.js', before: CALC, after: CALC_MUL },
      { path: 'calculator.test.js', before: TEST, after: TEST + "test('multiply', () => {});\n" }
    ])).toBe('ok')
  })
  it('brand new test file counts', () => {
    expect(verdict([{ path: 'calculator.js', before: CALC, after: CALC_MUL }, { path: 'test/mul.js', after: 'x\n' }])).toBe('ok')
  })
  it('docs only', () => {
    expect(verdict([{ path: 'README.md', before: '# a', after: '# a\nmore' }, { path: 'docs/x.md', after: 'new' }])).toBe('ok')
  })
  it('config / non-code files only', () => {
    expect(verdict([
      { path: 'package.json', before: '{}', after: '{"a":1}' },
      { path: 'tsconfig.json', before: '{}', after: '{"a":1}' },
      { path: '.github/ci.yml', after: 'on: push' },
      { path: 'vite.config.ts', before: 'export default {}', after: 'export default { a: 1 }' }
    ])).toBe('ok')
  })
  it('JS config files with function-looking code are not product code', () => {
    expect(isSourceFile('eslint.config.js')).toBe(false)
    expect(isSourceFile('.eslintrc.js')).toBe(false)
    expect(isSourceFile('types/index.d.ts')).toBe(false)
    expect(verdict([{ path: 'jest.config.js', after: 'module.exports = {}\nfunction helper() {}\nmodule.exports.helper = helper\n' }])).toBe('ok')
  })
  it('bugfix inside an existing function body', () => {
    expect(verdict([{ path: 'calculator.js', before: CALC, after: CALC.replace('a / b', 'b === 0 ? NaN : a / b') }])).toBe('ok')
  })
  it('private (unexported) helper added during a bugfix', () => {
    const after = CALC.replace('module.exports', 'function clamp(x) {\n  return x;\n}\n\nmodule.exports')
    expect(verdict([{ path: 'calculator.js', before: CALC, after }])).toBe('ok')
  })
  it('refactor: rename of an exported function (net 0)', () => {
    expect(verdict([{ path: 'calculator.js', before: CALC, after: CALC.replace(/add/g, 'sum') }])).toBe('ok')
  })
  it('refactor: function moved between files', () => {
    expect(verdict([
      { path: 'a.js', before: CALC, after: 'module.exports = {}\n' },
      { path: 'b.js', before: 'module.exports = {}\n', after: CALC }
    ])).toBe('ok')
  })
  it('refactor: split one function into two exported ones is the only borderline case (net +1)', () => {
    const after = CALC.replace('module.exports = { add, divide }', 'function addAll(xs) {\n  return xs;\n}\n\nmodule.exports = { add, divide, addAll }')
    expect(verdict([{ path: 'calculator.js', before: CALC, after }])).toBe('missing') // documented known false positive
  })
  it('deleting code, types-only additions, constants', () => {
    expect(verdict([{ path: 'calculator.js', before: CALC_MUL, after: CALC }])).toBe('ok')
    expect(verdict([{ path: 't.ts', before: '', after: 'export interface A { x: number }\nexport type B = string\nexport const MAX = 5\n' }])).toBe('ok')
  })
  it('test-only change, other languages, empty diff', () => {
    expect(verdict([{ path: 'calculator.test.js', before: TEST, after: TEST + 'x\n' }])).toBe('ok')
    expect(verdict([{ path: 'app.py', after: 'def f():\n    pass\n' }])).toBe('ok')
    expect(verdict([])).toBe('ok')
  })
  it('plain script without exports: its top-level functions are the surface', () => {
    expect(verdict([{ path: 'cli.js', after: 'function main() {}\nmain()\n' }])).toBe('missing')
  })
  it('indented/nested functions and methods are ignored', () => {
    expect(verdict([{ path: 'a.js', before: CALC, after: CALC.replace('return a + b;', 'const inner = () => 1;\n  function nested() {}\n  return a + b;') }])).toBe('ok')
  })
})

describe('classification helpers', () => {
  it('recognises test files', () => {
    for (const p of ['a.test.js', 'a.spec.ts', 'src/__tests__/a.js', 'test/units.ts', 'tests/x.js', 'a-test.js']) expect(isTestFile(p)).toBe(true)
    for (const p of ['src/latest.js', 'contest.js', 'README.md']) expect(isTestFile(p)).toBe(false)
  })
  it('symbolsOf reads CJS and ESM exports', () => {
    expect([...symbolsOf(CALC_MUL).exported].sort()).toEqual(['add', 'divide', 'multiply'])
    expect([...symbolsOf("function a(){}\nfunction b(){}\nexport { a as z }\n").exported]).toEqual(['a'])
  })
})

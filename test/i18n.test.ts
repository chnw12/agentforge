import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { getLang, resolveLang, setLang, t } from '../src/shared/i18n'
import { EN } from '../src/shared/i18n-en'

const SRC = path.join(__dirname, '..', 'src')
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = path.join(d, n)
  return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []
})
const HANGUL = /[가-힣]/
const PLACEHOLDER = /\{(\w+)\}/g
const placeholders = (s: string) => [...s.matchAll(PLACEHOLDER)].map((m) => m[1]).sort().join(',')

// every t('...') / tr('...') call with a string literal that contains Korean text
function usedKeys(): Map<string, string> {
  const keys = new Map<string, string>()
  const re = /\b(?:tr|t)\(\s*(['"`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g
  for (const f of walk(SRC)) {
    if (f.endsWith('i18n-en.ts')) continue
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(re)) {
      const [, q, body] = m
      if (!HANGUL.test(body!)) continue
      if (q === '`' && body!.includes('${')) throw new Error(`template literal with interpolation passed to t(): ${path.relative(SRC, f)}: ${body}`)
      keys.set(new Function(`return ${q}${body}${q}`)() as string, path.relative(SRC, f))
    }
  }
  return keys
}

afterEach(() => setLang('ko'))

describe('i18n', () => {
  it('has an English entry for every Korean key used in the source', () => {
    const missing = [...usedKeys()].filter(([k]) => !(k in EN)).map(([k, f]) => `${f}: ${k}`)
    expect(missing).toEqual([])
  })

  it('has no English entry that nothing uses', () => {
    const used = usedKeys()
    expect(Object.keys(EN).filter((k) => !used.has(k))).toEqual([])
  })

  it('keeps the same placeholders in the key and its English text', () => {
    const bad = Object.entries(EN).filter(([k, v]) => placeholders(k) !== placeholders(v)).map(([k]) => k)
    expect(bad).toEqual([])
  })

  it('translates, fills placeholders and falls back to the Korean text', () => {
    expect(t('설정')).toBe('설정')
    setLang('en')
    expect(t('설정')).toBe('Settings')
    expect(t('{n}초', { n: 5 })).toBe('5s')
    expect(t('번역이 없는 문장')).toBe('번역이 없는 문장')
    expect(t('{x} 그대로', {})).toBe('{x} 그대로')
    expect(getLang()).toBe('en')
  })

  it('resolves auto from the locale and keeps an explicit choice', () => {
    expect(resolveLang('auto', 'ko-KR')).toBe('ko')
    expect(resolveLang('auto', 'ko')).toBe('ko')
    expect(resolveLang('auto', 'en-US')).toBe('en')
    expect(resolveLang('auto', 'ja-JP')).toBe('en')
    expect(resolveLang(undefined, 'en-US')).toBe('en')
    expect(resolveLang('ko', 'en-US')).toBe('ko')
    expect(resolveLang('en', 'ko-KR')).toBe('en')
  })
})

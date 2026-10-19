import { EN } from './i18n-en'

export type Lang = 'ko' | 'en'
export type LangSetting = 'auto' | Lang

// Korean source text is the key: t('설정') is Korean as written and looks up EN['설정'] in English.
// A missing English entry falls back to the Korean text; test/i18n.test.ts fails the build for that.
let current: Lang = 'ko'

export const setLang = (l: Lang): void => { current = l }
export const getLang = (): Lang => current

/** `auto` follows the OS/browser locale: Korean for ko*, English otherwise. */
export function resolveLang(setting: LangSetting | undefined, locale: string): Lang {
  if (setting === 'ko' || setting === 'en') return setting
  return /^ko(\b|-|_)/i.test(locale) ? 'ko' : 'en'
}

/** Placeholders are written `{name}` in the key and filled from `vars`. */
export function t(ko: string, vars?: Record<string, string | number>): string {
  const text = current === 'en' ? EN[ko] ?? ko : ko
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text
}

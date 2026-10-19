import { describe, expect, it } from 'vitest'
import { rankItems } from '../src/shared/search'

const item = (title: string, extra = '') => ({ title, text: `${title} ${extra}` })
const titles = (xs: { title: string }[]) => xs.map((x) => x.title)

describe('rankItems', () => {
  const items = [item('로그인 버그 수정', 'agentforge 실패'), item('결제 모듈', 'shop 승인 대기'), item('버그 리포트 정리', 'docs 머지됨')]

  it('returns everything for an empty query', () => expect(rankItems('  ', items)).toBe(items))
  it('requires every token to match, in any order', () => {
    expect(titles(rankItems('수정 로그인', items))).toEqual(['로그인 버그 수정'])
    expect(rankItems('버그 shop', items)).toEqual([])
  })
  it('matches project and status text, not just the title', () => {
    expect(titles(rankItems('승인', items))).toEqual(['결제 모듈'])
    expect(titles(rankItems('DOCS', items))).toEqual(['버그 리포트 정리'])
  })
  it('ranks title-prefix matches before later ones, keeping input order for ties', () => {
    expect(titles(rankItems('버그', items))).toEqual(['버그 리포트 정리', '로그인 버그 수정'])
  })
  it('is case-insensitive', () => expect(titles(rankItems('AGENTFORGE', items))).toEqual(['로그인 버그 수정']))
})

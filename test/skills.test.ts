import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SKILL_LIMITS, buildSkillsPreamble, parseSkillMd, sanitizeSkills } from '../src/shared/skills'
import { listSkills, skillsPreamble } from '../src/main/skills'
import { DEFAULT_SETTINGS } from '../src/shared/types'

describe('sanitizeSkills', () => {
  it('keeps well-formed entries and drops the rest', () => {
    const r = sanitizeSkills({
      enabled: ['claude:a', 'claude:a', 'codex:b.c', 'bad', 'claude:../x', 5],
      personal: [
        { id: 'abcdef01', name: ' n ', text: 'hello', claude: true, codex: 'yes' },
        { id: 'zz', name: 'x', text: 'y' },
        { id: 'abcdef02', name: '', text: 'y' },
        { id: 'abcdef03', name: 'x', text: '   ' },
        { id: 'abcdef01', name: 'dup', text: 'y' }
      ]
    })
    expect(r.enabled).toEqual(['claude:a', 'codex:b.c'])
    expect(r.personal).toEqual([{ id: 'abcdef01', name: 'n', text: 'hello', claude: true, codex: false }])
  })

  it('survives missing or wrong-typed input and truncates long text', () => {
    expect(sanitizeSkills(undefined)).toEqual({ enabled: [], personal: [] })
    expect(sanitizeSkills('x')).toEqual({ enabled: [], personal: [] })
    const long = 'a'.repeat(SKILL_LIMITS.text + 50)
    expect(sanitizeSkills({ personal: [{ id: 'abcdef01', name: 'n', text: long }] }).personal[0]!.text).toHaveLength(SKILL_LIMITS.text)
  })
})

describe('parseSkillMd / buildSkillsPreamble', () => {
  it('reads frontmatter name and description and returns the body', () => {
    const p = parseSkillMd('---\nname: "my-skill"\ndescription: does things\n---\nBody text\n')
    expect(p).toEqual({ name: 'my-skill', description: 'does things', body: 'Body text\n' })
    expect(parseSkillMd('no frontmatter').body).toBe('no frontmatter')
  })

  it('is empty without skills and states that the task prompt wins', () => {
    expect(buildSkillsPreamble([])).toBe('')
    const out = buildSkillsPreamble([{ name: 'A', text: 'do A' }])
    expect(out).toContain('## 스킬: A')
    expect(out).toContain('항상 우선')
    expect(out.trimEnd().endsWith('# 작업 요청')).toBe(true)
  })

  it('omits skills beyond the total size limit and says so', () => {
    const out = buildSkillsPreamble([{ name: 'big', text: 'x'.repeat(SKILL_LIMITS.total - 10) }, { name: 'late', text: 'y'.repeat(100) }])
    expect(out).toContain('## 스킬: big')
    expect(out).not.toContain('## 스킬: late')
    expect(out).toContain('1개는 전달되지 않았습니다')
  })
})

describe('installed skills on disk', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'af-skills-'))
  const roots = { claude: path.join(root, 'claude'), codex: path.join(root, 'codex') }
  const put = (agent: 'claude' | 'codex', folder: string, md: string) => {
    mkdirSync(path.join(roots[agent], folder), { recursive: true })
    writeFileSync(path.join(roots[agent], folder, 'SKILL.md'), md)
  }
  put('claude', 'alpha', '---\nname: Alpha\ndescription: first\n---\nALPHA BODY')
  put('claude', 'nofm', 'plain body')
  put('codex', 'beta', 'BETA BODY')
  mkdirSync(path.join(roots.codex, '.system'), { recursive: true }) // dot-folders are not listed
  mkdirSync(path.join(roots.claude, 'empty'), { recursive: true }) // no SKILL.md

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('lists SKILL.md folders per CLI and skips dot-folders and empty folders', async () => {
    const l = await listSkills(roots)
    expect(l.map((x) => x.id)).toEqual(['claude:alpha', 'claude:nofm', 'codex:beta'])
    expect(l[0]).toMatchObject({ name: 'Alpha', description: 'first' })
    expect(l[1]!.name).toBe('nofm')
  })

  it('sends enabled installed skills only to their own agent, plus personal ones for that agent', async () => {
    const s = { ...DEFAULT_SETTINGS, skills: { enabled: ['claude:alpha', 'codex:beta', 'claude:gone'], personal: [{ id: 'abcdef01', name: 'mine', text: 'PERSONAL', claude: false, codex: true }] } }
    const c = await skillsPreamble('claude', s, roots)
    expect(c).toContain('ALPHA BODY')
    expect(c).not.toContain('BETA BODY')
    expect(c).not.toContain('PERSONAL')
    const x = await skillsPreamble('codex', s, roots)
    expect(x).toContain('BETA BODY')
    expect(x).toContain('PERSONAL')
    expect(x).not.toContain('ALPHA BODY')
    expect(await skillsPreamble('claude', DEFAULT_SETTINGS, roots)).toBe('')
  })

  it('ignores ids that try to leave the skills folder', async () => {
    const s = { ...DEFAULT_SETTINGS, skills: { enabled: ['claude:../codex/beta'], personal: [] } }
    expect(await skillsPreamble('claude', s, roots)).toBe('')
  })
})

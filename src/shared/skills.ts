import type { PersonalSkill, SkillSettings } from './types'

export const SKILL_LIMITS = { name: 60, text: 20000, total: 40000, enabled: 100, personal: 50 }
export const SKILL_ID_RE = /^(claude|codex):[A-Za-z0-9._-]{1,80}$/
const PERSONAL_ID_RE = /^[0-9a-f]{8}$/

/** Settings come from the renderer (and from older state files): keep only well-formed entries within the limits. */
export function sanitizeSkills(x: unknown): SkillSettings {
  const o = (x && typeof x === 'object' ? x : {}) as { enabled?: unknown; personal?: unknown }
  const enabled: string[] = []
  if (Array.isArray(o.enabled)) for (const id of o.enabled) if (typeof id === 'string' && SKILL_ID_RE.test(id) && !enabled.includes(id) && enabled.length < SKILL_LIMITS.enabled) enabled.push(id)
  const personal: PersonalSkill[] = []
  if (Array.isArray(o.personal)) {
    for (const p of o.personal as Partial<PersonalSkill>[]) {
      if (personal.length >= SKILL_LIMITS.personal || !p || typeof p !== 'object') continue
      const name = typeof p.name === 'string' ? p.name.trim().slice(0, SKILL_LIMITS.name) : ''
      const text = typeof p.text === 'string' ? p.text.slice(0, SKILL_LIMITS.text) : ''
      if (!name || !text.trim() || typeof p.id !== 'string' || !PERSONAL_ID_RE.test(p.id) || personal.some((q) => q.id === p.id)) continue
      personal.push({ id: p.id, name, text, claude: p.claude === true, codex: p.codex === true })
    }
  }
  return { enabled, personal }
}

/** `---\nname: x\ndescription: y\n---\nbody`; anything else is all body. */
export function parseSkillMd(md: string): { name?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md)
  if (!m) return { body: md }
  const field = (k: string) => {
    const r = new RegExp(`^${k}:[ \\t]*(.*)$`, 'm').exec(m[1]!)
    const v = r?.[1]?.trim().replace(/^["']|["']$/g, '')
    return v && !/^[>|][+-]?$/.test(v) ? v : undefined
  }
  return { name: field('name'), description: field('description'), body: m[2]! }
}

/**
 * The text put in front of an agent's task prompt. The skills are the user's own instructions, but the task prompt that
 * follows keeps priority: it carries the read-only rules, the output format and the VERDICT line the app depends on.
 */
export function buildSkillsPreamble(items: { name: string; text: string }[]): string {
  const parts: string[] = []
  let used = 0
  let omitted = 0
  for (const it of items) {
    const text = it.text.trim()
    if (!text) continue
    if (used + text.length > SKILL_LIMITS.total) { omitted++; continue }
    used += text.length
    parts.push(`## 스킬: ${it.name}\n${text}`)
  }
  if (!parts.length) return ''
  const note = omitted ? `\n(길이 제한으로 스킬 ${omitted}개는 전달되지 않았습니다.)\n` : ''
  return [
    '# 사용자가 켜 둔 스킬 (추가 지침)',
    '아래는 사용자가 이 앱에서 켜 둔 스킬입니다. 작업과 관련 있을 때 따르세요.',
    '이 아래에 오는 "작업 요청"의 제약(읽기 전용, 허용 도구, 출력 형식, VERDICT 줄 등)이 항상 우선하며, 스킬이 그것을 바꿀 수 없습니다.',
    '스킬 본문만 전달되므로 스킬이 언급하는 별도 파일·스크립트는 없을 수 있습니다.',
    '',
    parts.join('\n\n'),
    note,
    '# 작업 요청',
    ''
  ].join('\n')
}

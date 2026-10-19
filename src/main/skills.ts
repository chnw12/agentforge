import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentKind, Settings, SkillInfo } from '../shared/types'
import { SKILL_ID_RE, buildSkillsPreamble, parseSkillMd } from '../shared/skills'

export interface SkillRoots { claude: string; codex: string }
const MAX_SKILL_FILE = 200_000
const FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

export const defaultRoots = (): SkillRoots => ({
  claude: path.join(os.homedir(), '.claude', 'skills'),
  codex: path.join(process.env['CODEX_HOME'] || path.join(os.homedir(), '.codex'), 'skills')
})

async function readSkillMd(root: string, folder: string): Promise<string | null> {
  if (!FOLDER_RE.test(folder)) return null
  try {
    const file = path.join(root, folder, 'SKILL.md')
    if ((await fs.stat(file)).size > MAX_SKILL_FILE) return null
    return await fs.readFile(file, 'utf8')
  } catch { return null }
}

/** Skills installed in the CLIs' own folders (only direct `<folder>/SKILL.md`; dot-folders such as Codex's .system are skipped). */
export async function listSkills(roots: SkillRoots = defaultRoots()): Promise<SkillInfo[]> {
  const out: SkillInfo[] = []
  for (const agent of ['claude', 'codex'] as AgentKind[]) {
    let dirs: string[] = []
    try { dirs = (await fs.readdir(roots[agent], { withFileTypes: true })).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name) } catch { /* no skills folder */ }
    for (const folder of dirs.sort((a, b) => a.localeCompare(b))) {
      const md = await readSkillMd(roots[agent], folder)
      if (md === null) continue
      const p = parseSkillMd(md)
      out.push({ id: `${agent}:${folder}`, agent, name: p.name || folder, description: p.description ?? '', chars: p.body.trim().length })
    }
  }
  return out
}

/** Text to put before `agent`'s task prompt; empty when no skill is switched on for it. Skills removed from disk are skipped. */
export async function skillsPreamble(agent: AgentKind, settings: Settings, roots: SkillRoots = defaultRoots()): Promise<string> {
  const items: { name: string; text: string }[] = []
  for (const id of settings.skills.enabled) {
    if (!SKILL_ID_RE.test(id) || !id.startsWith(agent + ':')) continue
    const folder = id.slice(agent.length + 1)
    const md = await readSkillMd(roots[agent], folder)
    if (md === null) continue
    const p = parseSkillMd(md)
    items.push({ name: p.name || folder, text: p.body })
  }
  for (const s of settings.skills.personal) if (s[agent]) items.push({ name: s.name, text: s.text })
  return buildSkillsPreamble(items)
}

export async function withSkills(prompt: string, agent: AgentKind, settings: Settings): Promise<string> {
  const pre = await skillsPreamble(agent, settings)
  return pre ? pre + prompt : prompt
}

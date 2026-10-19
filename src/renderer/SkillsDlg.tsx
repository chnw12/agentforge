import { useEffect, useMemo, useState } from 'react'
import type { AgentKind, Api, PersonalSkill, Settings, SkillInfo } from '../shared/types'
import { SKILL_LIMITS } from '../shared/skills'
import { t as tr } from '../shared/i18n'

const AGENTS: { kind: AgentKind; folder: string }[] = [
  { kind: 'claude', folder: '~/.claude/skills' },
  { kind: 'codex', folder: '~/.codex/skills' }
]

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8)

export function SkillsDlg(p: { api: () => Api; s: Settings; onClose: () => void; onSave: (s: Settings) => Promise<void> }) {
  const [sk, setSk] = useState(p.s.skills)
  const [found, setFound] = useState<SkillInfo[] | null>(null)
  const [err, setErr] = useState('')
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [toClaude, setToClaude] = useState(true)
  const [toCodex, setToCodex] = useState(true)

  useEffect(() => { p.api().listSkills().then(setFound).catch((e) => { setFound([]); setErr(String(e?.message ?? e)) }) }, [p])

  const toggle = (id: string) => setSk((cur) => ({ ...cur, enabled: cur.enabled.includes(id) ? cur.enabled.filter((x) => x !== id) : [...cur.enabled, id] }))
  const setPersonal = (id: string, patch: Partial<PersonalSkill>) => setSk((cur) => ({ ...cur, personal: cur.personal.map((x) => (x.id === id ? { ...x, ...patch } : x)) }))
  const removePersonal = (id: string) => setSk((cur) => ({ ...cur, personal: cur.personal.filter((x) => x.id !== id) }))

  const add = () => {
    const n = name.trim()
    if (!n || !text.trim()) return
    if (sk.personal.length >= SKILL_LIMITS.personal) { setErr(tr('개인 스킬은 {n}개까지 넣을 수 있습니다', { n: SKILL_LIMITS.personal })); return }
    setSk((cur) => ({ ...cur, personal: [...cur.personal, { id: newId(), name: n, text, claude: toClaude, codex: toCodex }] }))
    setName(''); setText(''); setErr('')
  }
  const importFile = async () => {
    try {
      const r = await p.api().pickSkillFile()
      if (!r) return
      setName(r.name); setText(r.text); setErr('')
    } catch (e) { setErr(String((e as Error)?.message ?? e)) }
  }

  // characters that would be sent with every run, per agent
  const size = useMemo(() => {
    const out: Record<AgentKind, number> = { claude: 0, codex: 0 }
    for (const f of found ?? []) if (sk.enabled.includes(f.id)) out[f.agent] += f.chars
    for (const x of sk.personal) { if (x.claude) out.claude += x.text.length; if (x.codex) out.codex += x.text.length }
    return out
  }, [found, sk])

  return (
    <div className="modal-bg" onClick={p.onClose}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-label={tr('스킬')} onClick={(e) => e.stopPropagation()}>
        <h2>{tr('스킬')}</h2>
        <p className="muted small">{tr('켜 둔 스킬의 본문이 파이프라인 · Best-of-N · 계획 도우미 실행 때 작업 요청 앞에 붙어서 전달됩니다. 안전 모드와 상관없이 동작하지만, 스킬이 언급하는 별도 파일·스크립트는 전달되지 않습니다. 길수록 사용량이 늘어납니다.')}</p>

        <div className="skill-cols">
          {AGENTS.map((a) => {
            const list = (found ?? []).filter((f) => f.agent === a.kind)
            const label = a.kind === 'claude' ? tr('Claude 기본') : tr('Codex 기본')
            return (
              <section key={a.kind} className="skill-box" aria-label={label}>
                <div className="skill-h"><strong>{label}</strong><span className="muted small">{tr('{n}자', { n: size[a.kind].toLocaleString() })} / {SKILL_LIMITS.total.toLocaleString()}</span></div>
                {found === null && <div className="muted small">{tr('불러오는 중…')}</div>}
                {found !== null && list.length === 0 && <div className="muted small">{tr('설치된 스킬이 없습니다 ({folder})', { folder: a.folder })}</div>}
                {list.map((f) => (
                  <label key={f.id} className="chk skill-row" title={f.description}>
                    <input type="checkbox" checked={sk.enabled.includes(f.id)} onChange={() => toggle(f.id)} />
                    <span className="skill-name">{f.name}</span>
                    <span className="muted small">{tr('{n}자', { n: f.chars.toLocaleString() })}</span>
                  </label>
                ))}
              </section>
            )
          })}
        </div>

        <section className="skill-box" aria-label={tr('개인 스킬')}>
          <div className="skill-h"><strong>{tr('개인 스킬')}</strong><span className="muted small">{tr('앱 안에 직접 넣어 두는 지침 · {n}개', { n: sk.personal.length })}</span></div>
          {sk.personal.length === 0 && <div className="muted small">{tr('아직 없습니다. 아래에서 추가하세요.')}</div>}
          {sk.personal.map((x) => (
            <div key={x.id} className="skill-row personal">
              <span className="skill-name" title={x.text.slice(0, 400)}>{x.name}</span>
              <span className="muted small">{tr('{n}자', { n: x.text.length.toLocaleString() })}</span>
              <label className="chk"><input type="checkbox" checked={x.claude} onChange={(e) => setPersonal(x.id, { claude: e.target.checked })} /> Claude</label>
              <label className="chk"><input type="checkbox" checked={x.codex} onChange={(e) => setPersonal(x.id, { codex: e.target.checked })} /> Codex</label>
              <button className="icon-btn" aria-label={tr('개인 스킬 삭제: {name}', { name: x.name })} title={tr('빼기')} onClick={() => removePersonal(x.id)}>✕</button>
            </div>
          ))}
          <div className="skill-add">
            <div className="row-start">
              <input aria-label={tr('스킬 이름')} placeholder={tr('스킬 이름')} maxLength={SKILL_LIMITS.name} value={name} onChange={(e) => setName(e.target.value)} />
              <button className="btn sm" onClick={importFile} title={tr('SKILL.md 또는 .md/.txt 파일 내용을 가져옵니다')}>{tr('파일에서 가져오기')}</button>
            </div>
            <textarea aria-label={tr('스킬 내용')} rows={4} placeholder={tr('에이전트에게 따르게 할 지침을 적거나 붙여 넣으세요')} maxLength={SKILL_LIMITS.text} value={text} onChange={(e) => setText(e.target.value)} />
            <div className="row-start">
              <label className="chk"><input type="checkbox" checked={toClaude} onChange={(e) => setToClaude(e.target.checked)} /> Claude</label>
              <label className="chk"><input type="checkbox" checked={toCodex} onChange={(e) => setToCodex(e.target.checked)} /> Codex</label>
              <span className="muted small">{tr('{n}자', { n: `${text.length.toLocaleString()} / ${SKILL_LIMITS.text.toLocaleString()}` })}</span>
              <button className="btn sm primary" disabled={!name.trim() || !text.trim()} onClick={add}>{tr('개인 스킬에 넣기')}</button>
            </div>
          </div>
        </section>

        {err && <div className="warnbar small" role="alert">{err}</div>}
        <div className="row"><button className="btn" onClick={p.onClose}>{tr('취소')}</button><button className="btn primary" onClick={() => p.onSave({ ...p.s, skills: sk })}>{tr('저장')}</button></div>
      </div>
    </div>
  )
}

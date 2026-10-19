import { useEffect, useMemo, useState } from 'react'
import { diffTotals, parseDiff, type DiffFile } from '../shared/diff'

const STATUS_TAG: Record<DiffFile['status'], string | null> = { added: '신규', deleted: '삭제', renamed: '이름 변경', modified: null }
const LINE_CAP = 1500 // rendered lines per file before the "show more" button
const lineCount = (f: DiffFile) => f.hunks.reduce((n, h) => n + h.lines.length + 1, 0)

/** Which files start expanded: everything for a small diff, otherwise only the first file. */
function initialOpen(files: DiffFile[]): Set<string> {
  const small = files.length <= 6 && files.reduce((n, f) => n + lineCount(f), 0) <= 1200
  return new Set(small ? files.map((f) => f.path) : files.slice(0, 1).map((f) => f.path))
}

export function DiffView({ text, empty = '(변경 없음)' }: { text: string; empty?: string }) {
  const parsed = useMemo(() => parseDiff(text), [text])
  const [open, setOpen] = useState<Set<string>>(() => initialOpen(parsed.files))
  useEffect(() => setOpen(initialOpen(parsed.files)), [parsed])

  if (!parsed.files.length && !parsed.notice) return <div className="muted small">{text.trim() || empty}</div>
  const total = diffTotals(parsed.files)
  const toggle = (p: string) => setOpen((s) => { const n = new Set(s); if (!n.delete(p)) n.add(p); return n })

  return (
    <div className="dv">
      {parsed.files.length > 1 && (
        <div className="dv-bar small">
          <span className="muted">파일 {total.files} · <span className="ok">+{total.adds}</span> <span className="bad">−{total.dels}</span></span>
          <span className="dv-ctl">
            <button className="link" onClick={() => setOpen(new Set(parsed.files.map((f) => f.path)))}>모두 펼치기</button>
            <button className="link" onClick={() => setOpen(new Set())}>모두 접기</button>
          </span>
        </div>
      )}
      {parsed.files.map((f) => <FileDiff key={f.path} f={f} open={open.has(f.path)} onToggle={() => toggle(f.path)} />)}
      {parsed.notice && <pre className="dv-notice small">{parsed.notice}</pre>}
    </div>
  )
}

function FileDiff({ f, open, onToggle }: { f: DiffFile; open: boolean; onToggle: () => void }) {
  const [cap, setCap] = useState(LINE_CAP)
  const tag = STATUS_TAG[f.status]
  let budget = cap
  const bodyLines = f.hunks.reduce((n, h) => n + h.lines.length, 0)
  return (
    <section className="dv-file">
      <button className="dv-head" aria-expanded={open} onClick={onToggle}>
        <span className="dv-chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="dv-path" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>{f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}</span>
        {tag && <span className={'dv-tag ' + f.status}>{tag}</span>}
        <span className="dv-stat small"><span className="ok">+{f.adds}</span> <span className="bad">−{f.dels}</span></span>
      </button>
      {open && (
        <div className="dv-body">
          {f.binary && <div className="muted small dv-pad">바이너리 파일 (내용 비교 불가)</div>}
          {f.hunks.map((h, i) => {
            const shown = h.lines.slice(0, Math.max(0, budget))
            budget -= shown.length
            return (
              <div key={i}>
                <div className="dh">{h.header}</div>
                {shown.map((l, j) => (
                  <div key={j} className={'dl ' + l.type} data-o={l.oldNo ?? ''} data-n={l.newNo ?? ''}><span>{l.text || ' '}</span></div>
                ))}
              </div>
            )
          })}
          {bodyLines > cap && (
            <button className="link dv-pad" onClick={() => setCap((c) => c + LINE_CAP)}>더 보기 ({bodyLines - cap}줄 남음)</button>
          )}
        </div>
      )}
    </section>
  )
}

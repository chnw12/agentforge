import { useEffect, useMemo, useRef, useState } from 'react'
import { rankItems } from '../shared/search'

export interface PaletteItem {
  id: string
  kind: 'task' | 'action'
  title: string
  sub?: string
  tag?: string // right-aligned status text
  tagClass?: string
  text: string // what the query is matched against
}

export function Palette({ items, onPick, onClose }: { items: PaletteItem[]; onPick: (i: PaletteItem) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const shown = useMemo(() => rankItems(q, items), [q, items])
  const cur = Math.min(active, Math.max(0, shown.length - 1))

  useEffect(() => { setActive(0) }, [q])
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [cur, shown])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return // Enter that only commits a Korean/IME composition must not pick an item
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(cur + 1, shown.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(cur - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown[cur]) onPick(shown[cur]!) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  return (
    <div className="modal-bg pal-bg" onClick={onClose}>
      <div className="pal" role="dialog" aria-modal="true" aria-label="태스크 검색" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="pal-input"
          placeholder="태스크 검색 · 프로젝트 · 상태 (예: 승인 대기)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          role="combobox"
          aria-expanded="true"
          aria-controls="pal-list"
        />
        <div className="pal-list" id="pal-list" role="listbox" ref={listRef}>
          {shown.length === 0 && <div className="muted small pal-empty">일치하는 항목이 없습니다.</div>}
          {shown.map((it, i) => (
            <div key={it.id} role="option" aria-selected={i === cur} className={'pal-item' + (i === cur ? ' on' : '')} onMouseMove={() => setActive(i)} onClick={() => onPick(it)}>
              <span className="pal-main">
                <span className="pal-title">{it.kind === 'action' ? '⌘ ' : ''}{it.title}</span>
                {it.sub && <span className="muted small">{it.sub}</span>}
              </span>
              {it.tag && <span className={'pal-tag small ' + (it.tagClass ?? 'muted')}>{it.tag}</span>}
            </div>
          ))}
        </div>
        <div className="pal-foot muted small">↑↓ 이동 · Enter 열기 · Esc 닫기</div>
      </div>
    </div>
  )
}

export const SHORTCUTS: [string, string][] = [
  ['Ctrl+K', '태스크 검색 / 명령 팔레트'],
  ['Alt+↑ / Alt+↓', '이전 / 다음 태스크'],
  ['Alt+1 … 4', 'Best-of-N: 모든 슬롯의 탭 전환 (diff · 테스트 · 요약 · 로그) / 파이프라인: 결과 · 로그 · diff'],
  ['Ctrl+N', '새 태스크'],
  ['Ctrl+,', '설정'],
  ['Ctrl+/', '이 도움말'],
  ['Esc', '열려 있는 창 닫기'],
  ['Ctrl+Enter', '추가 지시 입력창에서 전송']
]

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="단축키" onClick={(e) => e.stopPropagation()}>
        <h2>단축키</h2>
        <table className="cmp-table">
          <tbody>{SHORTCUTS.map(([k, d]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{d}</td></tr>)}</tbody>
        </table>
        <div className="row"><button className="btn" onClick={onClose}>닫기</button></div>
      </div>
    </div>
  )
}

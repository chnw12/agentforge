export type DiffLineType = 'add' | 'del' | 'ctx' | 'note'
export interface DiffLine { type: DiffLineType; text: string; oldNo?: number; newNo?: number }
export interface DiffHunk { header: string; lines: DiffLine[] }
export type DiffFileStatus = 'added' | 'deleted' | 'renamed' | 'modified'
export interface DiffFile {
  path: string // new path
  oldPath?: string // set for renames
  status: DiffFileStatus
  binary: boolean
  adds: number
  dels: number
  hunks: DiffHunk[]
}
export interface ParsedDiff {
  files: DiffFile[]
  notice?: string // trailing text that is not part of any file, e.g. the "[... diff truncated ...]" marker
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const stripPrefix = (p: string) => p.replace(/^"?[ab]\//, '').replace(/"$/, '')

/**
 * Parses `git diff --no-color` output. Hunk bodies are read by their declared line counts, so a removed
 * line that happens to start with "-- " is never mistaken for a "---" file header.
 */
export function parseDiff(text: string): ParsedDiff {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const files: DiffFile[] = []
  let cur: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0, newNo = 0, oldLeft = 0, newLeft = 0
  const notice: string[] = []

  for (const line of lines) {
    if (hunk && (oldLeft > 0 || newLeft > 0 || line.startsWith('\\'))) {
      const c = line[0]
      if (c === '\\') hunk.lines.push({ type: 'note', text: line })
      else if (c === '+') { hunk.lines.push({ type: 'add', text: line.slice(1), newNo: newNo++ }); newLeft--; cur!.adds++ }
      else if (c === '-') { hunk.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++ }); oldLeft--; cur!.dels++ }
      else { hunk.lines.push({ type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ }); oldLeft--; newLeft-- }
      continue
    }
    hunk = null
    const g = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (g) {
      cur = { path: g[2]!, status: 'modified', binary: false, adds: 0, dels: 0, hunks: [] }
      files.push(cur)
      continue
    }
    if (!cur) { notice.push(line); continue }
    const h = HUNK_RE.exec(line)
    if (h) {
      oldNo = Number(h[1]); oldLeft = h[2] === undefined ? 1 : Number(h[2])
      newNo = Number(h[3]); newLeft = h[4] === undefined ? 1 : Number(h[4])
      hunk = { header: line, lines: [] }
      cur.hunks.push(hunk)
    } else if (line.startsWith('new file mode')) cur.status = 'added'
    else if (line.startsWith('deleted file mode')) cur.status = 'deleted'
    else if (line.startsWith('rename from ')) { cur.status = 'renamed'; cur.oldPath = line.slice(12) }
    else if (line.startsWith('rename to ')) cur.path = line.slice(10)
    else if (line.startsWith('+++ ') && line !== '+++ /dev/null') cur.path = stripPrefix(line.slice(4))
    else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) cur.binary = true
    else if (/^(index |--- |\+\+\+ |similarity index |dissimilarity index |old mode |new mode |copy from |copy to )/.test(line)) continue
    else notice.push(line) // anything unexpected after a file (e.g. the truncation marker) is kept visible
  }
  return { files, notice: notice.length ? notice.join('\n') : undefined }
}

export const diffTotals = (files: DiffFile[]) => ({
  files: files.length,
  adds: files.reduce((n, f) => n + f.adds, 0),
  dels: files.reduce((n, f) => n + f.dels, 0)
})

import { describe, expect, it } from 'vitest'
import { diffTotals, parseDiff } from '../src/shared/diff'

const sample = [
  'diff --git a/f.txt b/f.txt',
  'index df967b9..4ed8c08 100644',
  '--- a/f.txt',
  '+++ b/f.txt',
  '@@ -1,3 +1,3 @@ fn',
  ' keep',
  '-old',
  '+new',
  ' tail',
  'diff --git a/g.txt b/g.txt',
  'new file mode 100644',
  'index 0000000..9ecae73',
  '--- /dev/null',
  '+++ b/g.txt',
  '@@ -0,0 +1 @@',
  '+extra',
  '\\ No newline at end of file',
  ''
].join('\n')

describe('parseDiff', () => {
  it('splits files, statuses and counts', () => {
    const { files } = parseDiff(sample)
    expect(files.map((f) => [f.path, f.status, f.adds, f.dels])).toEqual([['f.txt', 'modified', 1, 1], ['g.txt', 'added', 1, 0]])
    expect(diffTotals(files)).toEqual({ files: 2, adds: 2, dels: 1 })
  })
  it('numbers lines on both sides', () => {
    const lines = parseDiff(sample).files[0]!.hunks[0]!.lines
    expect(lines.map((l) => [l.type, l.oldNo, l.newNo])).toEqual([['ctx', 1, 1], ['del', 2, undefined], ['add', undefined, 2], ['ctx', 3, 3]])
  })
  it('keeps the no-newline marker as a note, not a change', () => {
    const f = parseDiff(sample).files[1]!
    expect(f.hunks[0]!.lines.at(-1)).toMatchObject({ type: 'note' })
    expect(f.adds).toBe(1)
  })
  it('does not mistake a removed "-- x" line for a file header', () => {
    const d = ['diff --git a/s.sql b/s.sql', '--- a/s.sql', '+++ b/s.sql', '@@ -1,2 +1,1 @@', '--- comment', ' keep'].join('\n')
    const f = parseDiff(d).files[0]!
    expect(f.dels).toBe(1)
    expect(f.hunks[0]!.lines[0]).toMatchObject({ type: 'del', text: '-- comment' })
  })
  it('handles renames and binaries', () => {
    const d = ['diff --git a/a.png b/b.png', 'similarity index 100%', 'rename from a.png', 'rename to b.png', 'Binary files a/a.png and b/b.png differ'].join('\n')
    expect(parseDiff(d).files[0]).toMatchObject({ path: 'b.png', oldPath: 'a.png', status: 'renamed', binary: true })
  })
  it('surfaces the truncation marker as a notice', () => {
    const r = parseDiff(sample.trimEnd() + '\n[... diff truncated ...]')
    expect(r.files).toHaveLength(2)
    expect(r.notice).toBe('[... diff truncated ...]')
  })
  it('returns no files for an empty diff', () => expect(parseDiff('')).toEqual({ files: [] }))
})

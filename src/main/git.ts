import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { capture } from './proc'

const BRANCH_RE = /^af\/[0-9a-f]{8}$/
export const ID_RE = /^[0-9a-f]{8}$/

export const worktreeRoot = () => path.join(app.getPath('userData'), 'worktrees')
export const worktreePath = (id: string) => path.join(worktreeRoot(), id)
const hooksOff = () => path.join(app.getPath('userData'), 'hooks-off')

// per-repo mutex so two tasks never mutate one repo's refs concurrently
const locks = new Map<string, Promise<unknown>>()
export function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(repo) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  locks.set(repo, next.catch(() => undefined))
  return next
}

async function git(cwd: string, args: string[], timeout = 120_000) {
  await fs.mkdir(hooksOff(), { recursive: true })
  const base = ['-c', `core.hooksPath=${hooksOff()}`, '-c', 'core.fsmonitor=false', '-c', 'user.name=AgentForge', '-c', 'user.email=agentforge@localhost']
  return capture('git', [...base, ...args], cwd, timeout)
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const r = await git(dir, ['rev-parse', '--show-toplevel'])
  return r.code === 0
}
export const headOid = async (cwd: string) => (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim()
export const isDirty = async (cwd: string) => (await git(cwd, ['status', '--porcelain=v2'])).stdout.trim().length > 0

export async function addWorktree(repo: string, id: string): Promise<{ branch: string; base: string }> {
  if (!ID_RE.test(id)) throw new Error('bad task id')
  const branch = `af/${id}`
  const base = await headOid(repo)
  if (!base) throw new Error('repository has no commits')
  await fs.mkdir(worktreeRoot(), { recursive: true })
  const r = await git(repo, ['worktree', 'add', '-b', branch, '--', worktreePath(id), base])
  if (r.code !== 0) throw new Error('git worktree add failed: ' + r.stderr)
  return { branch, base }
}

/** Remove only worktrees that git itself lists AND that live under our worktree root. */
export async function removeWorktree(
  repo: string,
  id: string,
  deleteBranch: boolean,
  // default keeps the old discard/merge behaviour; task deletion passes force:false and strict:true
  opts: { force?: boolean; branchForce?: boolean; strict?: boolean } = {}
): Promise<void> {
  const { force = true, branchForce = true, strict = false } = opts
  if (!ID_RE.test(id)) throw new Error('bad task id')
  await git(repo, ['worktree', 'prune']) // forget worktrees whose directory is already gone
  const wt = worktreePath(id)
  const list = await git(repo, ['worktree', 'list', '--porcelain'])
  const known = list.stdout.split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => path.resolve(l.slice(9)).toLowerCase())
  const inRoot = path.resolve(wt).toLowerCase().startsWith(path.resolve(worktreeRoot()).toLowerCase() + path.sep)
  if (inRoot && known.includes(path.resolve(wt).toLowerCase())) {
    const r = await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), '--', wt])
    if (r.code !== 0) throw new Error('git worktree remove failed: ' + (r.stderr || r.stdout).trim())
  }
  if (deleteBranch) {
    const branch = `af/${id}`
    const exists = (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0
    if (exists) {
      const r = await git(repo, ['branch', branchForce ? '-D' : '-d', '--', branch])
      if (r.code !== 0 && strict) throw new Error(`git branch delete failed: ${(r.stderr || r.stdout).trim()}`)
    }
  }
}

export async function commitAll(cwd: string, msg: string): Promise<string> {
  const add = await git(cwd, ['add', '-A'])
  if (add.code !== 0) throw new Error('git add failed: ' + add.stderr)
  const st = await git(cwd, ['status', '--porcelain=v2'])
  if (st.stdout.trim()) {
    const c = await git(cwd, ['commit', '--no-verify', '--no-gpg-sign', '-m', msg])
    if (c.code !== 0) throw new Error('git commit failed: ' + (c.stderr || c.stdout))
    if ((await git(cwd, ['status', '--porcelain=v2'])).stdout.trim()) throw new Error('worktree still dirty after commit')
  }
  return headOid(cwd)
}

export async function facts(cwd: string, base: string): Promise<string> {
  const [st, stat, names] = await Promise.all([
    git(cwd, ['status', '--porcelain=v2']),
    git(cwd, ['diff', '--stat', '--summary', `${base}..HEAD`]),
    git(cwd, ['diff', '--name-status', `${base}..HEAD`])
  ])
  return `# git status --porcelain=v2\n${st.stdout || '(clean)'}\n# diff --name-status ${base.slice(0, 8)}..HEAD\n${names.stdout || '(none)'}\n# diff --stat --summary\n${stat.stdout || '(none)'}`
}

export async function fullDiff(cwd: string, base: string, max = 200_000): Promise<string> {
  const r = await git(cwd, ['diff', '--no-color', `${base}..HEAD`], 60_000)
  return r.stdout.length > max ? r.stdout.slice(0, max) + '\n[... diff truncated ...]' : r.stdout
}

/** Files changed in base..HEAD with full before/after contents (renames keep their new path; before = old path content). */
export async function changedFiles(cwd: string, base: string): Promise<{ path: string; before?: string; after?: string }[]> {
  const r = await git(cwd, ['diff', '--name-status', '-M', '-z', `${base}..HEAD`], 60_000)
  const tok = r.stdout.split('\0').filter((x) => x.length > 0)
  const out: { path: string; before?: string; after?: string }[] = []
  const show = async (rev: string, p: string) => {
    const s = await git(cwd, ['show', `${rev}:${p}`], 60_000)
    return s.code === 0 ? s.stdout : undefined
  }
  for (let i = 0; i < tok.length; ) {
    const st = tok[i++]!
    const oldPath = tok[i++]!
    const newPath = st[0] === 'R' || st[0] === 'C' ? tok[i++]! : oldPath
    out.push({ path: newPath, before: st[0] === 'A' ? undefined : await show(base, oldPath), after: st[0] === 'D' ? undefined : await show('HEAD', newPath) })
  }
  return out
}

export async function mergeBranch(repo: string, id: string, expectedHead: string): Promise<void> {
  const branch = `af/${id}`
  if (!BRANCH_RE.test(branch)) throw new Error('bad branch')
  if (await isDirty(repo)) throw new Error('main checkout has uncommitted changes - commit or stash first')
  const head = (await git(repo, ['rev-parse', branch])).stdout.trim()
  if (head !== expectedHead) throw new Error('branch moved since approval - re-run verification')
  const r = await git(repo, ['merge', '--no-ff', '--no-edit', '-m', `AgentForge: merge ${branch}`, branch])
  if (r.code !== 0) {
    await git(repo, ['merge', '--abort'])
    throw new Error('merge failed (aborted): ' + (r.stderr || r.stdout))
  }
}

import { spawn, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { redact } from './redact'

const ENV_ALLOW = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'TEMP', 'TMP',
  'USERNAME', 'COMPUTERNAME', 'OS', 'LANG', 'TERM', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'
]

export function safeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const k of ENV_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k]
  env.NO_COLOR = '1'
  return env
}

/** Resolve an executable to an absolute .exe path. .cmd/.bat shims are rejected (cannot be spawned safely without a shell). */
export function resolveExe(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const d of dirs) {
    const p = path.join(d, name + '.exe')
    if (existsSync(p)) return p
  }
  return null
}

export function killTree(pid: number): void {
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
}

export interface RunOpts {
  cwd: string
  stdin?: string
  timeoutMs: number
  maxBytes?: number
  env?: Record<string, string> // extra vars merged over the allowlisted env
  onLine?: (line: string, stream: 'out' | 'err') => void
  onPid?: (pid: number) => void
}
export interface RunResult { code: number | null; timedOut: boolean; truncated: boolean }

function lineSplitter(cb: (line: string) => void) {
  let buf = ''
  return {
    push(chunk: string) {
      buf += chunk
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        cb(buf.slice(0, i).replace(/\r$/, ''))
        buf = buf.slice(i + 1)
      }
    },
    flush() { if (buf) cb(buf.replace(/\r$/, '')); buf = '' }
  }
}

export function runProcess(exe: string, args: string[], o: RunOpts): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd: o.cwd, env: { ...safeEnv(), ...o.env }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    if (child.pid) o.onPid?.(child.pid)
    let bytes = 0
    let truncated = false
    let timedOut = false
    const max = o.maxBytes ?? 2 * 1024 * 1024
    const emit = (stream: 'out' | 'err') => (line: string) => {
      if (truncated) return
      bytes += Buffer.byteLength(line) + 1
      if (bytes > max) {
        truncated = true
        o.onLine?.('[output limit reached - stopping agent]', 'err')
        if (child.pid) killTree(child.pid)
        return
      }
      o.onLine?.(redact(line), stream)
    }
    const out = lineSplitter(emit('out'))
    const err = lineSplitter(emit('err'))
    // raw cap too: a stream without newlines must not grow the line buffer without bound
    let raw = 0
    const guard = (d: string): boolean => {
      raw += d.length
      if (raw > max * 2 && !truncated) {
        truncated = true
        o.onLine?.('[output limit reached - stopping agent]', 'err')
        if (child.pid) killTree(child.pid)
      }
      return !truncated
    }
    child.stdout.setEncoding('utf8').on('data', (d: string) => guard(d) && out.push(d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => guard(d) && err.push(d))
    const timer = setTimeout(() => { timedOut = true; if (child.pid) killTree(child.pid) }, o.timeoutMs)
    child.on('error', (e) => { o.onLine?.('spawn error: ' + e.message, 'err') })
    child.on('close', (code) => {
      clearTimeout(timer)
      out.flush(); err.flush()
      resolve({ code, timedOut, truncated })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(o.stdin ?? '', 'utf8')
  })
}

/** Run a short command and collect stdout (used for git, --version). */
export function capture(exe: string, args: string[], cwd: string, timeoutMs = 60_000, maxBuffer = 16 * 1024 * 1024): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(exe, args, { cwd, env: safeEnv(), windowsHide: true, timeout: timeoutMs, maxBuffer, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : 1) : 0
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

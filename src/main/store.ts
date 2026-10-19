import { app } from 'electron'
import { promises as fs, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, type AppState } from '../shared/types'

const file = () => path.join(app.getPath('userData'), 'state.json')
let writeChain: Promise<void> = Promise.resolve()
let state: AppState = { projects: [], tasks: [], settings: { ...DEFAULT_SETTINGS }, planners: [] }

export const getState = (): AppState => state

export async function loadState(): Promise<void> {
  for (const f of [file(), file() + '.bak']) {
    try {
      const raw = JSON.parse(await fs.readFile(f, 'utf8')) as Partial<AppState>
      state = {
        projects: raw.projects ?? [],
        tasks: raw.tasks ?? [],
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
        planners: raw.planners ?? [] // absent in state files written before the planner existed
      }
      // a planner run cannot survive a restart either
      for (const th of state.planners) for (const m of th.messages) if (m.status === 'running') m.status = 'interrupted'
      // crash recovery: nothing can still be running after a restart
      for (const t of state.tasks) {
        for (const s of t.stages) if (s.status === 'running') s.status = 'interrupted'
        for (const sl of t.slots ?? []) {
          if (sl.status === 'running') sl.status = 'interrupted'
          sl.queued = undefined // nothing is running anymore, so a queued instruction would never be applied
        }
        if (t.status === 'running') t.status = 'failed'
      }
      return
    } catch {
      /* try backup */
    }
  }
}

// single writer, tmp -> rename, keep a .bak of the previous good file
export function saveState(): Promise<void> {
  writeChain = writeChain
    .then(async () => {
      const f = file()
      await fs.mkdir(path.dirname(f), { recursive: true })
      const tmp = f + '.tmp'
      await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
      await fs.copyFile(f, f + '.bak').catch(() => undefined)
      await fs.rename(tmp, f)
    })
    .catch((e) => console.error('[store] save failed:', e))
  return writeChain
}

/** Last-chance synchronous save used on quit. */
export function saveStateSync(): void {
  try {
    const f = file()
    mkdirSync(path.dirname(f), { recursive: true })
    writeFileSync(f + '.tmp', JSON.stringify(state, null, 2), 'utf8')
    renameSync(f + '.tmp', f)
  } catch (e) {
    console.error('[store] sync save failed:', e)
  }
}

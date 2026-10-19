import { attention, type Attention } from '../shared/attention'
import type { Task } from '../shared/types'

export interface NotifyEvent { taskId: string; title: string; attention: Attention }

/**
 * Compares the new task list with the previous statuses and returns the tasks that just stopped
 * running and now wait for the user. The first call only records a baseline, so restarting the app
 * never re-notifies old work. The caller stores the returned `next` as the new baseline.
 */
export function transitions(prev: Map<string, string> | null, tasks: Task[]): { next: Map<string, string>; events: NotifyEvent[] } {
  const next = new Map(tasks.map((t) => [t.id, t.status]))
  const events: NotifyEvent[] = []
  if (prev) {
    for (const t of tasks) {
      if (prev.get(t.id) !== 'running') continue
      const a = attention(t)
      if (a) events.push({ taskId: t.id, title: t.title, attention: a })
    }
  }
  return { next, events }
}

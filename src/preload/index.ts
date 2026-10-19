import { contextBridge, ipcRenderer } from 'electron'
import type { Api, AppState, PlannerLogEvent, StageLogEvent } from '../shared/types'

// Explicit allowlist: the renderer can only call these named operations.
const api: Api = {
  getState: () => ipcRenderer.invoke('state:get'),
  cliInfo: () => ipcRenderer.invoke('cli:info'),
  pickProject: () => ipcRenderer.invoke('project:pick'),
  createTask: (i) => ipcRenderer.invoke('task:create', i),
  plannerCreate: (projectId, title) => ipcRenderer.invoke('planner:create', projectId, title),
  plannerDelete: (id) => ipcRenderer.invoke('planner:delete', id),
  plannerSetOptions: (id, opts) => ipcRenderer.invoke('planner:setOptions', id, opts),
  plannerAddContext: (id, item) => ipcRenderer.invoke('planner:addContext', id, item),
  plannerRemoveContext: (id, itemId) => ipcRenderer.invoke('planner:removeContext', id, itemId),
  plannerSend: (id, text) => ipcRenderer.invoke('planner:send', id, text),
  plannerCancel: (id) => ipcRenderer.invoke('planner:cancel', id),
  runNext: (id) => ipcRenderer.invoke('task:runNext', id),
  cancel: (id) => ipcRenderer.invoke('task:cancel', id),
  getDiff: (id) => ipcRenderer.invoke('task:diff', id),
  getLog: (id, k) => ipcRenderer.invoke('task:log', id, k),
  getSlotDiff: (id, slot) => ipcRenderer.invoke('bon:diff', id, slot),
  getSlotLog: (id, slot) => ipcRenderer.invoke('bon:log', id, slot),
  selectSlot: (id, slot, force) => ipcRenderer.invoke('bon:select', id, slot, force),
  cancelSlot: (id, slot) => ipcRenderer.invoke('bon:cancelSlot', id, slot),
  runSlot: (id, slot, note) => ipcRenderer.invoke('bon:runSlot', id, slot, note),
  queueSlotNote: (id, slot, note) => ipcRenderer.invoke('bon:queueNote', id, slot, note),
  approveMerge: (id) => ipcRenderer.invoke('task:approve', id),
  merge: (id) => ipcRenderer.invoke('task:merge', id),
  discard: (id) => ipcRenderer.invoke('task:discard', id),
  deleteTask: (id) => ipcRenderer.invoke('task:delete', id),
  removeProject: (id, cleanup) => ipcRenderer.invoke('project:remove', id, cleanup),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  onLog: (cb) => {
    const h = (_e: unknown, p: StageLogEvent) => cb(p)
    ipcRenderer.on('log', h)
    return () => ipcRenderer.removeListener('log', h)
  },
  onState: (cb) => {
    const h = (_e: unknown, s: AppState) => cb(s)
    ipcRenderer.on('state', h)
    return () => ipcRenderer.removeListener('state', h)
  },
  onPlannerLog: (cb) => {
    const h = (_e: unknown, e: PlannerLogEvent) => cb(e)
    ipcRenderer.on('planner-log', h)
    return () => ipcRenderer.removeListener('planner-log', h)
  },
  onFocusPlanner: (cb) => {
    const h = (_e: unknown, id: string) => cb(id)
    ipcRenderer.on('focus-planner', h)
    return () => ipcRenderer.removeListener('focus-planner', h)
  },
  onFocusTask: (cb) => {
    const h = (_e: unknown, id: string) => cb(id)
    ipcRenderer.on('focus-task', h)
    return () => ipcRenderer.removeListener('focus-task', h)
  }
}
contextBridge.exposeInMainWorld('api', api)

import { contextBridge, ipcRenderer } from 'electron'
import type { UiState, WbBridge, ScheduleState, TodoRow, LockState, CheckinRow } from '../shared/types'
import type { ShiftProfile } from '../shared/schedule/model'

/** 通道白名单：渲染进程只能通过这些通道与主进程通信 */
const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

const bridge: WbBridge = {
  info: () => invoke('app:info'),
  uiGet: () => invoke('ui:get'),
  uiSave: (state: UiState) => invoke('ui:save', state),
  hideWindow: () => invoke('app:hide'),
  quit: () => invoke('app:quit'),
  scheduleGet: () => invoke<ScheduleState>('schedule:get'),
  scheduleSave: (next: ScheduleState) => invoke('schedule:save', next),
  schedulePresets: () => invoke<ShiftProfile[]>('schedule:presets'),
  schedulePreview: (date: string) => invoke('schedule:preview', date),
  onScheduleChanged: (cb) => {
    ipcRenderer.on('schedule:changed', (_e, s: ScheduleState) => cb(s))
  },
  onPersistError: (cb) => {
    const h = (_e: unknown, message: string) => cb(message)
    ipcRenderer.on('store:persistError', h)
    return () => ipcRenderer.removeListener('store:persistError', h)
  },
  setFullscreen: (on: boolean) => invoke('window:fullscreen', on),
  storeStats: () => invoke('store:stats'),
  backupCreate: (p?: string) => invoke('backup:create', p),
  backupPick: () => invoke<string | null>('backup:pick'),
  backupRestore: (file: string) => invoke('backup:restore', file),
  backupList: () => invoke('backup:list'),
  backupAutoNow: () => invoke('backup:autoNow'),
  exportRedacted: (p?: string) => invoke('backup:exportRedacted', p),
  pickDataDir: () => invoke<string | null>('datadir:pick'),
  migrateDataDir: (target: string) => invoke('datadir:migrate', target),
  openDataDir: () => invoke('app:openDataDir'),

  weekReport: () => invoke('report:week'),
  recoveryDiagnose: () => invoke('recovery:diagnose'),
  recoveryAutoFix: () => invoke('recovery:autoFix'),
  recoveryUnlock: (password: string) => invoke('recovery:unlock', password),
  recoveryRestore: (file: string) => invoke('recovery:restore', file),
  recoveryReset: () => invoke('recovery:reset'),
  recoveryOpenDir: () => invoke('recovery:openDir'),
  recoveryFinish: (action: 'retry' | 'quit') => invoke('recovery:finish', action),
  recoveryProtectKey: (password: string) => invoke('recovery:protectKey', password),
  recoveryRemovePwdKey: () => invoke('recovery:removePwdKey'),
  rulesList: (kind?: 'category' | 'time' | 'regex') => invoke('rules:list', kind),
  rulesSave: (input: { kind: 'category' | 'time' | 'regex'; pattern: string; value: string }) => invoke('rules:save', input),
  rulesToggle: (id: string, enabled: boolean) => invoke('rules:toggle', id, enabled),
  rulesDelete: (id: string) => invoke('rules:delete', id),
  rulesStats: () => invoke('rules:stats'),
  rulesTry: (text: string) => invoke('rules:try', text),
  todosList: (scope) => invoke('todos:list', scope),
  todosDone: (limit?: number) => invoke('todos:done', limit),
  todoAdd: (text: string, opts?: { category?: string; priority?: number; dueAt?: string; source?: string }) => invoke('todo:add', text, opts),
  todoComplete: (id: string) => invoke('todo:complete', id),
  todoUncomplete: (id: string) => invoke('todo:uncomplete', id),
  todoUpdate: (id: string, patch: Partial<TodoRow>) => invoke('todo:update', id, patch),
  todoDelete: (id: string) => invoke('todo:delete', id),
  todoReorder: (ids: string[]) => invoke('todo:reorder', ids),

  worklogList: (day?: string) => invoke('worklog:list', day),
  worklogAdd: (text: string, kind?: string) => invoke('worklog:add', text, kind),
  worklogUpdate: (id: string, text: string) => invoke('worklog:update', id, text),
  worklogDays: (limit?: number) => invoke('worklog:days', limit),
  worklogDelete: (id: string) => invoke('worklog:delete', id),
  dailySummary: (day?: string) => invoke('worklog:summary', day),

  knowledgeList: (q?: string) => invoke('knowledge:list', q),
  knowledgeAdd: (k) => invoke('knowledge:add', k),
  knowledgeUpdate: (id: string, patch) => invoke('knowledge:update', id, patch),
  knowledgeScopes: () => invoke('knowledge:scopes'),
  knowledgeDelete: (id: string) => invoke('knowledge:delete', id),

  pasteParse: (raw: string) => invoke('paste:parse', raw),
  pasteApply: (input) => invoke('paste:apply', input),

  checkinGet: (day?: string) => invoke('checkin:get', day),
  checkinMark: (day?: string, opts?: { at?: string; isBackfill?: boolean; note?: string | null }) =>
    invoke('checkin:mark', day, opts),
  checkinUpdate: (day: string, patch: { at?: string; note?: string | null; isBackfill?: boolean }) =>
    invoke('checkin:update', day, patch),
  checkinUndo: (day?: string) => invoke('checkin:undo', day),
  checkinMarkMany: (days: string[], opts?: { at?: string; note?: string | null }) =>
    invoke('checkin:markMany', days, opts),
  checkinStats: () => invoke('checkin:stats'),
  checkinCalendar: (ym: string) => invoke('checkin:calendar', ym),
  checkinMonthSummary: (ym: string) => invoke('checkin:monthSummary', ym),
  checkinRange: (from: string, to: string) => invoke('checkin:range', from, to),
  checkinExport: (ym: string, file?: string) => invoke('checkin:export', ym, file),
  onCheckinChanged: (cb) => {
    ipcRenderer.on('checkin:changed', (_e, row: CheckinRow) => cb(row))
  },

  settingsGet: () => invoke('settings:get'),
  storeInfo: () => invoke('store:info'),
  updateState: () => invoke('update:state'),
  updateCheck: () => invoke('update:check'),
  updateDownload: () => invoke('update:download'),
  updateApply: () => invoke('update:apply'),
  logRecent: (limit?: number) => invoke('log:recent', limit),
  logStats: () => invoke('log:stats'),
  logReport: () => invoke('log:report'),
  logExport: (targetDir?: string) => invoke('log:export', targetDir),
  logOpenDir: () => invoke('log:openDir'),
  logClear: () => invoke('log:clear'),
  logFromRenderer: (level, scope, message) => ipcRenderer.send('log:renderer', level, scope, message),
  onUpdateState: (cb) => {
    const h = (_e: unknown, s: Parameters<typeof cb>[0]) => cb(s)
    ipcRenderer.on('update:state', h)
    return () => ipcRenderer.removeListener('update:state', h)
  },
  settingsSet: (key: string, value: string) => invoke('settings:set', key, value),
  settingsPersistProbe: (key: string, value: string) => invoke('settings:persistProbe', key, value),

  lockState: () => invoke('lock:state'),
  lockSetPassword: (pw: string) => invoke('lock:setPassword', pw),
  lockChangePassword: (oldPw: string, newPw: string) => invoke('lock:changePassword', oldPw, newPw),
  lockDisable: (pw: string) => invoke('lock:disable', pw),
  lockAutoMinutes: (min: number) => invoke('lock:autoMinutes', min),
  lockNow: () => invoke('lock:lock'),
  unlock: (pw: string) => invoke('lock:unlock', pw),
  onLockChanged: (cb) => {
    ipcRenderer.on('lock:changed', (_e, s) => cb(s))
  },
  lockIssueRecovery: (pw: string) => invoke('lock:issueRecovery', pw),
  lockHasRecovery: () => invoke('lock:hasRecovery'),
  lockRecoveryHint: () => invoke('lock:recoveryHint'),
  lockSetRecoveryHint: (text: string) => invoke('lock:setRecoveryHint', text),
  lockResetByRecovery: (code: string, newPw: string) => invoke('lock:resetByRecovery', code, newPw),

  autostart: () => invoke('app:autostart'),
  setAutostart: (on: boolean) => invoke('app:setAutostart', on),
  trayTip: () => invoke('app:trayTip'),
  onOpenSettings: (cb) => {
    ipcRenderer.on('open:settings', (_e, tab: string) => cb(tab))
  },

  notesList: () => invoke('notes:list'),
  notesAdd: (text: string) => invoke('notes:add', text),
  notesUpdate: (id: string, patch) => invoke('notes:update', id, patch),
  notesDelete: (id: string) => invoke('notes:delete', id),
  pomodoroRecord: (kind: 'focus' | 'break', minutes: number, todoId?: string) => invoke('pomodoro:record', kind, minutes, todoId),
  pomodoroToday: () => invoke('pomodoro:today'),
  paletteActions: () => invoke('palette:actions'),

  pluginsList: () => invoke('plugins:list'),
  pluginsSample: () => invoke('plugins:sample')
}

contextBridge.exposeInMainWorld('wb', bridge)




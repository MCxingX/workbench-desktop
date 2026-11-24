/** 主进程与渲染进程共用的契约类型（与 docs/05 模块契约对应） */

import type { ShiftProfile } from './schedule/model'

export type ThemeMode = 'dark' | 'light'

/** Bento 布局项：一个模块卡片的位置与尺寸（单位为网格列/行） */
export interface LayoutItem {
  moduleId: string
  w: number
  h: number
  visible: boolean
  order: number
}

export interface UiState {
  theme: ThemeMode
  layout: LayoutItem[]
  /** 布局锁定，防止误拖 */
  layoutLocked: boolean
  /** 当前启用的班表方案 id（M1 使用，M0 先占位） */
  activeProfileId: string | null
  /** 布局版本：缺省=1（老数据）。只用于"一次性把卡片抬到装得下"的迁移 */
  layoutVersion?: number
}

/** 当前布局版本。改动 LAYOUT_MIN_H 想再迁一次时 +1 */
export const LAYOUT_VERSION = 3

/** 每张卡"内容装得下"的最小行数/列数（算式见 docs/06） */
export const LAYOUT_MIN_H: Record<string, number> = {
  countdown: 3,
  checkin: 4,
  todos: 3,
  pasteparse: 3,
  worklog: 3,
  pomodoro: 3,
  notes: 2,
  knowledge: 3,
  settings: 3
}

export const DEFAULT_UI_STATE: UiState = {
  theme: 'dark',
  layoutLocked: false,
  activeProfileId: null,
  layoutVersion: LAYOUT_VERSION,
  layout: [
    // 四行填满 12 列，行内高度一致（这是"整齐"的全部秘密：不留空洞、同行等高）
    { moduleId: 'countdown', w: 8, h: 4, visible: true, order: 0 },
    { moduleId: 'checkin', w: 4, h: 4, visible: true, order: 1 },
    { moduleId: 'todos', w: 5, h: 3, visible: true, order: 2 },
    { moduleId: 'pasteparse', w: 4, h: 3, visible: true, order: 3 },
    { moduleId: 'worklog', w: 3, h: 3, visible: true, order: 4 },
    { moduleId: 'knowledge', w: 8, h: 3, visible: true, order: 5 },
    { moduleId: 'notes', w: 4, h: 3, visible: true, order: 6 },
    { moduleId: 'pomodoro', w: 4, h: 3, visible: true, order: 7 },
    { moduleId: 'settings', w: 8, h: 3, visible: true, order: 8 }
  ]
}

export interface AppInfo {
  version: string
  dataDir: string
  isPackaged: boolean
  platform: string
}

/** 班表集合（M2 起存于加密库，接口不变） */
export interface ScheduleState {
  activeId: string
  profiles: ShiftProfile[]
}

export interface TodoRow {
  id: string
  text: string
  done_at: string | null
  created_at: string
  due_at: string | null
  category: string | null
  priority: number | null
  source: string | null
  note: string | null
  sort_order: number
  /** 循环规则：daily / weekly:N / monthly:D，null = 一次性 */
  repeat?: string | null
}

export interface WorklogRow {
  id: string
  day: string
  at: string
  text: string
  kind: string
  todo_id: string | null
  created_at: string
}

export interface KnowledgeRow {
  id: string
  title: string
  conclusion: string
  scope: string | null
  source_text: string | null
  day: string | null
  tags: string | null
  created_at: string
  updated_at: string
}

export interface CheckinRow {
  day: string
  marked_at: string | null
  is_backfill: number
  note: string | null
}

export interface CheckinStats {
  monthDone: number
  monthExpected: number
  streak: number
  yearDone: number
  missing: number
}

export interface CalendarCell {
  day: string
  onDuty: boolean
  marked: boolean
  backfill: boolean
  note: string | null
  at: string | null
  missing: boolean
  isToday: boolean
  weekday: number
  holiday: string | null
}

export interface ParsePreview {
  todos: { text: string; score: number; confidence: 'high' | 'low'; entity: string | null; timeHint: string | null; kind: 'self' | 'assigned'; category: string | null }[]
  receipts: { text: string; entity: string | null }[]
  knowledge: { title: string; conclusion: string; scope: string | null }[]
  dropped: number
  jobId: string
}

/** 渲染进程可见的桥接 API（preload 暴露为 window.wb） */

// ── 诊断日志 ──
export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  at: string
  level: LogLevel
  scope: string
  message: string
}

export interface LogStats {
  dir: string
  file: string
  bytes: number
  errors: number
  entries: number
}

// ── 在线更新 ──
export type UpdatePhase = 'idle' | 'probing' | 'downloading' | 'ready' | 'applying' | 'error'

export interface UpdateSourceProbe {
  id: string
  name: string
  ok: boolean
  ms: number
  bps: number
  error: string | null
}

export interface UpdateInfo {
  current: string
  latest: string
  notes: string
  asset: string
  size: number
  sha256: string | null
  publishedAt: string
  url: string
  source: string
}

export interface UpdateState {
  phase: UpdatePhase
  message: string
  pct: number
  bytesPerSec: number
  received: number
  total: number
  probes: UpdateSourceProbe[]
  info: UpdateInfo | null
  canApply: boolean
  file: string | null
}

/** 临时目录现状（portable 的解压目录就落在系统临时目录下） */
export interface TmpDirInfo {
  current: string
  drive: string
  isMoved: boolean
  freeGB: number | null
}

export interface TmpMoveResult {
  ok: boolean
  from: string
  to: string
  files: number
  needRestart: boolean
  message: string
}

import type { LearnedRule, RuleKind } from './parse/rules'

export interface WbBridge {
  info(): Promise<AppInfo>
  uiGet(): Promise<UiState>
  uiSave(state: UiState): Promise<void>
  hideWindow(): Promise<void>
  quit(): Promise<void>
  scheduleGet(): Promise<ScheduleState>
  scheduleSave(next: ScheduleState): Promise<ScheduleState>
  schedulePresets(): Promise<ShiftProfile[]>
  schedulePreview(date: string): Promise<{
    date: string
    onDuty: boolean
    shift: { start: string; end: string; lunch: { start: string; end: string } | null } | null
    lunch: { start: string; end: string } | null
    pieces: { from: number; to: number; kind: string }[]
    trail: string[]
  } | null>
  onScheduleChanged(cb: (s: ScheduleState) => void): void
  checkinMonthSummary(ym: string): Promise<{ done: number; expected: number; missing: number }>
  setFullscreen(on: boolean): Promise<void>
  storeStats(): Promise<{
    count: number
    dirty: boolean
    sizeBytes: number
    isOpen: boolean
    file: string
    counts: Record<string, number>
  }>
  backupCreate(path?: string): Promise<{ file: string; manifest: { files: { name: string; size: number }[]; createdAt: string } }>
  backupPick(): Promise<string | null>
  backupRestore(file: string): Promise<{ restored: string[]; preRestoreDir: string }>
  backupList(): Promise<{ name: string; path: string; size: number; at: string }[]>
  backupAutoNow(): Promise<{ created: boolean; file?: string; pruned: number }>
  exportRedacted(path?: string): Promise<{ file: string; rows: number; tables: string[] }>
  pickDataDir(): Promise<string | null>
  migrateDataDir(target: string): Promise<{ from: string; to: string; files: number; verified: boolean; restartRequired: boolean }>
  openDataDir(): Promise<void>

  // 待办
  weekReport(): Promise<{ text: string; days: number }>
  recoveryDiagnose(): Promise<{
    scan: {
      dataDir: string
      db: { path: string; size: number } | null
      dbBak: { path: string; size: number } | null
      keyFiles: { name: string; path: string; size: number; passwordProtected: boolean }[]
      backups: { name: string; path: string; size: number; mtime: string }[]
    }
    usableKey: string | null
    canOpen: boolean
    pwdAvailable: boolean
    message: string
  }>
  recoveryAutoFix(): Promise<{ ok: boolean; message: string }>
  recoveryUnlock(password: string): Promise<{ ok: boolean; message: string }>
  recoveryRestore(file: string): Promise<{ ok: boolean; message: string; restored: string[] }>
  recoveryReset(): Promise<{ ok: boolean; message: string; kept: string[] }>
  recoveryOpenDir(): Promise<void>
  recoveryFinish(action: 'retry' | 'quit'): Promise<void>
  recoveryProtectKey(password: string): Promise<{ ok: boolean; message: string }>
  recoveryRemovePwdKey(): Promise<{ ok: boolean; message: string }>
  rulesList(kind?: RuleKind): Promise<LearnedRule[]>
  rulesSave(input: { kind: RuleKind; pattern: string; value: string }): Promise<LearnedRule>
  rulesToggle(id: string, enabled: boolean): Promise<void>
  rulesDelete(id: string): Promise<void>
  rulesStats(): Promise<{ total: number; manual: number; learned: number; topHits: number }>
  rulesTry(text: string): Promise<{ text: string; timeHint: string | null; dueAt: string | null; category: string | null; priority: number; repeat: string | null }>
  todosList(scope: 'open' | 'today' | 'all'): Promise<TodoRow[]>
  todosDone(limit?: number): Promise<TodoRow[]>
  todoAdd(text: string, opts?: { category?: string; priority?: number; dueAt?: string; source?: string }): Promise<TodoRow>
  todoComplete(id: string): Promise<{ todo: TodoRow; worklog: WorklogRow | null }>
  todoUncomplete(id: string): Promise<void>
  todoUpdate(id: string, patch: Partial<TodoRow>): Promise<void>
  todoDelete(id: string): Promise<void>
  todoReorder(ids: string[]): Promise<void>

  // 工作记录
  worklogList(day?: string): Promise<WorklogRow[]>
  worklogAdd(text: string, kind?: string): Promise<WorklogRow>
  worklogUpdate(id: string, text: string): Promise<void>
  worklogDays(limit?: number): Promise<{ day: string; count: number }[]>
  worklogDelete(id: string): Promise<void>
  dailySummary(day?: string): Promise<string>

  // 口径库
  knowledgeList(q?: string): Promise<KnowledgeRow[]>
  knowledgeAdd(k: { title: string; conclusion: string; scope?: string | null; tags?: string | null }): Promise<KnowledgeRow>
  knowledgeUpdate(id: string, patch: { title?: string; conclusion?: string; scope?: string | null; tags?: string | null }): Promise<void>
  knowledgeScopes(): Promise<string[]>
  knowledgeDelete(id: string): Promise<void>

  // 粘贴解析
  pasteParse(raw: string): Promise<ParsePreview>
  pasteApply(input: {
    raw: string
    todos: string[]
    knowledge: { title: string; conclusion: string; scope?: string | null }[]
    receipts: string[]
  }): Promise<{ addedTodos: number; addedKnowledge: number; addedWorklog: number; jobId: string }>

  // 到岗
  checkinGet(day?: string): Promise<CheckinRow | null>
  checkinMark(day?: string, opts?: { at?: string; isBackfill?: boolean; note?: string | null }): Promise<CheckinRow>
  checkinUpdate(day: string, patch: { at?: string; note?: string | null; isBackfill?: boolean }): Promise<CheckinRow | null>
  checkinUndo(day?: string): Promise<void>
  /** 批量补卡：一次补多天，返回补了几条、跳过几条 */
  checkinMarkMany(days: string[], opts?: { at?: string; note?: string | null }): Promise<{ done: number; skipped: number }>
  checkinStats(): Promise<CheckinStats>
  checkinCalendar(ym: string): Promise<CalendarCell[]>
  checkinRange(from: string, to: string): Promise<CheckinRow[]>
  checkinExport(ym: string, file?: string): Promise<{ file: string; rows: number }>
  onCheckinChanged(cb: (row: CheckinRow) => void): void

  // 设置
  settingsGet(): Promise<Record<string, string>>
  settingsSet(key: string, value: string): Promise<void>
  /** 库文件状态：写到哪、多大、什么时候写的、有没有没落盘的改动 */
  storeInfo(): Promise<{ file: string; sizeBytes: number; mtime: string | null; lastError: string | null; dirty: boolean }>
  /** 落盘失败时收到一条消息（界面据此显示红条） */
  onPersistError(cb: (message: string) => void): () => void

  /** 在线更新：状态 / 检查 / 下载 / 重启安装 */
  updateState(): Promise<UpdateState>
  updateCheck(): Promise<UpdateState>
  updateDownload(): Promise<UpdateState>
  updateApply(): Promise<void>
  onUpdateState(cb: (s: UpdateState) => void): () => void

  /** 临时目录（portable 的解压目录落在系统临时目录里，C 盘吃紧时挪走） */
  tmpInfo(): Promise<TmpDirInfo & { suggest: string }>
  tmpMove(target?: string): Promise<TmpMoveResult>
  tmpSweep(): Promise<{ dirs: number; freedMB: number }>

  /** 诊断日志 */
  logRecent(limit?: number): Promise<LogEntry[]>
  logStats(): Promise<LogStats>
  logReport(): Promise<string>
  logExport(targetDir?: string): Promise<{ file: string }>
  logOpenDir(): Promise<void>
  logClear(): Promise<LogStats>
  logFromRenderer(level: LogLevel, scope: string, message: string): void
  /** 冒烟专用：写入 → 落盘 → 重开库 → 读回，用来验证「重启后还在」 */
  settingsPersistProbe(key: string, value: string): Promise<string>

  // 应用锁
  lockState(): Promise<LockState>
  lockSetPassword(pw: string): Promise<LockState>
  lockChangePassword(oldPw: string, newPw: string): Promise<LockState>
  lockDisable(pw: string): Promise<LockState>
  lockAutoMinutes(min: number): Promise<LockState>
  lockNow(): Promise<LockState>
  unlock(pw: string): Promise<{ ok: boolean; state: LockState; retryAfterMs: number }>
  onLockChanged(cb: (s: LockState) => void): void
  lockIssueRecovery(pw: string): Promise<{ code: string }>
  lockHasRecovery(): Promise<boolean>
  lockRecoveryHint(): Promise<string | null>
  lockSetRecoveryHint(text: string): Promise<void>
  lockResetByRecovery(code: string, newPw: string): Promise<{ state: LockState; newCode: string }>

  // 系统集成
  autostart(): Promise<boolean>
  setAutostart(on: boolean): Promise<boolean>
  trayTip(): Promise<string>
  onOpenSettings(cb: (tab: string) => void): void

  // 便签 / 番茄钟 / 命令面板
  notesList(): Promise<NoteRow[]>
  notesAdd(text: string): Promise<NoteRow>
  notesUpdate(id: string, patch: { text?: string; pinned?: number }): Promise<void>
  notesDelete(id: string): Promise<void>
  pomodoroRecord(kind: 'focus' | 'break', minutes: number, todoId?: string): Promise<PomodoroRow>
  pomodoroToday(): Promise<{ focus: number; focusMinutes: number }>
  paletteActions(): Promise<{ id: string; title: string; hint: string }[]>

  // 插件清单
  pluginsList(): Promise<{
    plugins: { id: string; name: string; moduleId: string; version?: string; permissions?: string[]; enabled?: boolean }[]
    issues: { file: string; message: string }[]
    dir: string
  }>
  pluginsSample(): Promise<{ file: string }>


}

export interface NoteRow {
  id: string
  text: string
  pinned: number
  created_at: string
  updated_at: string
}

export interface PomodoroRow {
  id: string
  kind: string
  minutes: number
  started_at: string
  ended_at: string | null
  todo_id: string | null
}

export interface LockState {
  enabled: boolean
  autoLockMinutes: number
  locked: boolean
  failures: number
}






import { query, run, audit } from './store'
import { ymd } from '../shared/schedule/time'

const uid = (p: string): string => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

export interface NoteRow {
  id: string
  text: string
  pinned: number
  created_at: string
  updated_at: string
}

export function listNotes(): NoteRow[] {
  return query<NoteRow>('SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC LIMIT 200')
}

export function addNote(text: string): NoteRow {
  const now = new Date().toISOString()
  const row: NoteRow = { id: uid('nt'), text: text.trim(), pinned: 0, created_at: now, updated_at: now }
  run('INSERT INTO notes (id, text, pinned, created_at, updated_at) VALUES (?, ?, 0, ?, ?)', [row.id, row.text, now, now])
  return row
}

export function updateNote(id: string, patch: { text?: string; pinned?: number }): void {
  if (patch.text !== undefined) {
    run('UPDATE notes SET text = ?, updated_at = ? WHERE id = ?', [patch.text, new Date().toISOString(), id])
  }
  if (patch.pinned !== undefined) run('UPDATE notes SET pinned = ? WHERE id = ?', [patch.pinned, id])
}

export function deleteNote(id: string): void {
  run('DELETE FROM notes WHERE id = ?', [id])
}

export interface PomodoroRow {
  id: string
  kind: string
  minutes: number
  started_at: string
  ended_at: string | null
  todo_id: string | null
}

export function recordPomodoro(kind: 'focus' | 'break', minutes: number, todoId: string | null = null): PomodoroRow {
  const now = new Date()
  const row: PomodoroRow = {
    id: uid('pm'),
    kind,
    minutes,
    started_at: now.toISOString(),
    ended_at: new Date(now.getTime() + minutes * 60_000).toISOString(),
    todo_id: todoId
  }
  run('INSERT INTO pomodoros (id, kind, minutes, started_at, ended_at, todo_id) VALUES (?, ?, ?, ?, ?, ?)', [
    row.id,
    row.kind,
    row.minutes,
    row.started_at,
    row.ended_at,
    row.todo_id
  ])
  audit('pomodoro:done', `${kind} ${minutes}m`)
  return row
}

export function pomodoroToday(): { focus: number; focusMinutes: number } {
  const day = ymd(new Date())
  const rows = query<{ c: number; m: number | null }>(
    "SELECT COUNT(*) AS c, SUM(minutes) AS m FROM pomodoros WHERE kind = 'focus' AND substr(started_at, 1, 10) = ?",
    [day]
  )
  return { focus: rows[0]?.c ?? 0, focusMinutes: rows[0]?.m ?? 0 }
}

/** 命令面板可执行的动作清单（壳层与模块解耦：动作只是 wb 调用） */
export interface PaletteAction {
  id: string
  title: string
  hint: string
}

export const PALETTE_ACTIONS: PaletteAction[] = [
  { id: 'checkin', title: '打卡上班', hint: '一次点击，写入今日到岗' },
  { id: 'todo', title: '新增待办', hint: 'focus 待办输入框' },
  { id: 'worklog', title: '记一句工作记录', hint: 'focus 记录输入框' },
  { id: 'paste', title: '粘贴解析聊天记录', hint: 'focus 粘贴框' },
  { id: 'summary', title: '复制今日小结', hint: '有序列表，直接发给领导' },
  { id: 'backup', title: '立即备份', hint: '生成 .wbk 加密备份' },
  { id: 'lock', title: '锁定工作台', hint: 'Ctrl+Alt+L' },
  { id: 'bigscreen', title: '进入大屏模式', hint: 'F 进入 / Esc 退出' },
  { id: 'theme', title: '切换亮/暗主题', hint: 'T' },
  { id: 'datadir', title: '打开数据目录', hint: '加密库与备份所在位置' }
]

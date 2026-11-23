import { query, run, transaction, audit } from './store'
import { parseQuickTodo } from '../shared/parse/quick'
import { parseChat, type ParseResult } from '../shared/parse/parser'
import { ymd } from '../shared/schedule/time'

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

const uid = (p: string): string => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

/** 待办列表：open = 未完成；today = 未完成且今天到期/无期限；all = 全部未完成 */
export function listTodos(scope: 'open' | 'today' | 'all' = 'open'): TodoRow[] {
  const base = 'SELECT * FROM todos WHERE done_at IS NULL'
  if (scope === 'today') {
    return query<TodoRow>(`${base} AND (due_at IS NULL OR substr(due_at, 1, 10) <= ?) ORDER BY priority DESC, sort_order, created_at`, [
      ymd(new Date())
    ])
  }
  return query<TodoRow>(`${base} ORDER BY priority DESC, sort_order, created_at`)
}

export function listDone(limit = 50): TodoRow[] {
  return query<TodoRow>('SELECT * FROM todos WHERE done_at IS NOT NULL ORDER BY done_at DESC LIMIT ?', [limit])
}

export function addTodo(input: string, opts?: { category?: string; priority?: number; dueAt?: string; source?: string }): TodoRow {
  const q = parseQuickTodo(input)
  const row: TodoRow = {
    id: uid('td'),
    text: q.text,
    done_at: null,
    created_at: new Date().toISOString(),
    due_at: opts?.dueAt ?? q.dueAt,
    category: opts?.category ?? q.category,
    priority: opts?.priority ?? q.priority,
    source: opts?.source ?? null,
    note: q.timeHint,
    sort_order: nextOrder()
  }
  run(
    'INSERT INTO todos (id, text, done_at, created_at, due_at, category, priority, source, note, sort_order) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)',
    [row.id, row.text, row.created_at, row.due_at, row.category, row.priority, row.source, row.note, row.sort_order]
  )
  return row
}

function nextOrder(): number {
  const rows = query<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM todos WHERE done_at IS NULL')
  return (rows[0]?.m ?? 0) + 10
}

/** 勾完成：写 done_at + 自动追加一条工作记录（不弹任何确认） */
export function completeTodo(id: string): { todo: TodoRow; worklog: WorklogRow | null } {
  const rows = query<TodoRow>('SELECT * FROM todos WHERE id = ?', [id])
  if (rows.length === 0) throw new Error('待办不存在')
  const todo = rows[0]
  const now = new Date()
  run('UPDATE todos SET done_at = ? WHERE id = ?', [now.toISOString(), id])
  let log: WorklogRow | null = null
  if (getSettingBool('autoWorklog', true)) {
    log = addWorklog(`完成：${todo.text}`, 'done', id)
  }
  audit('todo:done', todo.text)
  return { todo: { ...todo, done_at: now.toISOString() }, worklog: log }
}

export function uncompleteTodo(id: string): void {
  run('UPDATE todos SET done_at = NULL WHERE id = ?', [id])
  run('DELETE FROM worklog WHERE todo_id = ? AND kind = ?', [id, 'done'])
}

export function updateTodo(id: string, patch: Partial<Pick<TodoRow, 'text' | 'due_at' | 'category' | 'priority' | 'note'>>): void {
  const fields: string[] = []
  const params: unknown[] = []
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = ?`)
    params.push(v as unknown)
  }
  if (fields.length === 0) return
  params.push(id)
  if (fields.length === 0) return
  run(`UPDATE todos SET ${fields.join(', ')} WHERE id = ?`, params)
}

export function deleteTodo(id: string): void {
  run('DELETE FROM todos WHERE id = ?', [id])
}

export function reorderTodos(ids: string[]): void {
  transaction(() => {
    ids.forEach((id, i) => run('UPDATE todos SET sort_order = ? WHERE id = ?', [(i + 1) * 10, id]))
  })
}

function getSettingBool(key: string, fallback: boolean): boolean {
  const rows = query<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])
  if (rows.length === 0) return fallback
  return rows[0].value === '1'
}

export function setSettingBool(key: string, on: boolean): void {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, on ? '1' : '0'])
}

// ── 工作记录 ──

export function addWorklog(text: string, kind = 'note', todoId: string | null = null, day?: string): WorklogRow {
  const now = new Date()
  const row: WorklogRow = {
    id: uid('wl'),
    day: day ?? ymd(now),
    at: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    text: text.trim(),
    kind,
    todo_id: todoId,
    created_at: now.toISOString()
  }
  run('INSERT INTO worklog (id, day, at, text, kind, todo_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    row.id,
    row.day,
    row.at,
    row.text,
    row.kind,
    row.todo_id,
    row.created_at
  ])
  return row
}

export function listWorklog(day = ymd(new Date())): WorklogRow[] {
  return query<WorklogRow>('SELECT * FROM worklog WHERE day = ? ORDER BY at, created_at', [day])
}

export function deleteWorklog(id: string): void {
  run('DELETE FROM worklog WHERE id = ?', [id])
}

export function updateWorklog(id: string, text: string): void {
  run('UPDATE worklog SET text = ? WHERE id = ?', [text.trim(), id])
}

/** 有记录的日期（供按日切换） */
export function worklogDays(limit = 60): { day: string; count: number }[] {
  return query<{ day: string; count: number }>(
    'SELECT day, COUNT(*) AS count FROM worklog GROUP BY day ORDER BY day DESC LIMIT ?',
    [limit]
  )
}

/** 复制今日小结：有序列表，可直接粘给领导 */
export function dailySummary(day = ymd(new Date())): string {
  const rows = listWorklog(day)
  if (rows.length === 0) return ''
  return rows.map((r, i) => `${i + 1}. ${r.text}`).join('\n')
}

// ── 口径库 ──

export function listKnowledge(q = '', limit = 100): KnowledgeRow[] {
  if (q.trim().length === 0) {
    return query<KnowledgeRow>('SELECT * FROM knowledge_entries ORDER BY updated_at DESC LIMIT ?', [limit])
  }
  const like = `%${q.trim()}%`
  return query<KnowledgeRow>(
    'SELECT * FROM knowledge_entries WHERE title LIKE ? OR conclusion LIKE ? OR scope LIKE ? OR tags LIKE ? ORDER BY updated_at DESC LIMIT ?',
    [like, like, like, like, limit]
  )
}

export function addKnowledge(k: { title: string; conclusion: string; scope?: string | null; sourceText?: string | null; tags?: string | null }): KnowledgeRow {
  const now = new Date().toISOString()
  const row: KnowledgeRow = {
    id: uid('kn'),
    title: k.title.slice(0, 120),
    conclusion: k.conclusion,
    scope: k.scope ?? null,
    source_text: k.sourceText ?? null,
    day: ymd(new Date()),
    tags: k.tags ?? null,
    created_at: now,
    updated_at: now
  }
  run(
    'INSERT INTO knowledge_entries (id, title, conclusion, scope, source_text, day, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [row.id, row.title, row.conclusion, row.scope, row.source_text, row.day, row.tags, row.created_at, row.updated_at]
  )
  return row
}

export function deleteKnowledge(id: string): void {
  run('DELETE FROM knowledge_entries WHERE id = ?', [id])
}

export function updateKnowledge(
  id: string,
  patch: { title?: string; conclusion?: string; scope?: string | null; tags?: string | null }
): void {
  const fields: string[] = []
  const params: unknown[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    fields.push(`${k} = ?`)
    params.push(v)
  }
  if (fields.length === 0) return
  fields.push('updated_at = ?')
  params.push(new Date().toISOString(), id)
  if (fields.length === 0) return
  run(`UPDATE knowledge_entries SET ${fields.join(', ')} WHERE id = ?`, params)
}

/** 已出现过的适用范围，供筛选 */
export function knowledgeScopes(): string[] {
  const rows = query<{ scope: string }>(
    "SELECT DISTINCT scope FROM knowledge_entries WHERE scope IS NOT NULL AND scope <> '' ORDER BY scope"
  )
  return rows.map((r) => r.scope)
}

// ── 粘贴解析 ──

export interface PasteApplyInput {
  raw: string
  todos: string[]
  knowledge: { title: string; conclusion: string; scope?: string | null }[]
  receipts: string[]
}

export interface PasteApplyReport {
  addedTodos: number
  addedKnowledge: number
  addedWorklog: number
  jobId: string
}

export function parsePaste(raw: string): ParseResult & { jobId: string } {
  const result = parseChat(raw)
  const jobId = uid('pj')
  run('INSERT INTO paste_jobs (id, raw_text, result_json, accepted, created_at) VALUES (?, ?, ?, 0, ?)', [
    jobId,
    raw,
    JSON.stringify(result),
    new Date().toISOString()
  ])
  return { ...result, jobId }
}

/** 一次性落库：Enter 全收 / 手动勾选后落库，都走这里 */
export function applyPaste(input: PasteApplyInput): PasteApplyReport {
  return transaction(() => {
    for (const t of input.todos) addTodo(t, { source: 'paste' })
    for (const k of input.knowledge) addKnowledge({ ...k, sourceText: input.raw.slice(0, 2000) })
    let logs = 0
    for (const r of input.receipts) {
      addWorklog(r, 'receipt')
      logs++
    }
    run('UPDATE paste_jobs SET accepted = 1 WHERE id = (SELECT id FROM paste_jobs ORDER BY created_at DESC LIMIT 1)')
    audit('paste:apply', `todos=${input.todos.length} knowledge=${input.knowledge.length}`)
    return {
      addedTodos: input.todos.length,
      addedKnowledge: input.knowledge.length,
      addedWorklog: logs,
      jobId: ''
    }
  })
}

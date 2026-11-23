import { query, run, transaction, audit } from './store'
import { parseQuickTodo, type TimeAnchors } from '../shared/parse/quick'
import { nextOccurrence, pickDueSoon } from '../shared/parse/repeat'
import { getScheduleState } from './scheduleStore'
import { resolveDay } from '../shared/schedule/resolve'
import { parseChat, type ParseResult } from '../shared/parse/parser'
import { ymd } from '../shared/schedule/time'
import { activeRules, learnCategoryFromEdit, learnTimeFromEdit } from './rules'

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

const uid = (p: string): string => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

/**
 * 学到的规则 → 解析层能吃的形状。读库出错就返回 null（退化成纯内置规则）。
 */
function rulesHint(): { category: { pattern: string; value: string }[]; time: { pattern: string; value: string }[]; regex: { source: string; value: string }[] } | null {
  try {
    const rows = activeRules()
    return {
      category: rows.filter((r) => r.kind === 'category').map((r) => ({ pattern: r.pattern, value: r.value })),
      time: rows.filter((r) => r.kind === 'time').map((r) => ({ pattern: r.pattern, value: r.value })),
      regex: rows.filter((r) => r.kind === 'regex').map((r) => ({ source: r.pattern, value: r.value }))
    }
  } catch {
    return null
  }
}

/**
 * 带规则的解析入口：录入、快速窗、设置里「试一下」全走这里，
 * 保证三处对同一句话给同一个结果（以前 addTodo 与 rules:try 各写一遍，就是这么走偏的）。
 */
export function parseWithRules(input: string, now = new Date()): ReturnType<typeof parseQuickTodo> {
  return parseQuickTodo(input, now, todayAnchors(), rulesHint())
}

/**
 * 今天的时刻锚点来自班表：下班几点就是几点，"下午/下班前"不再写死 18:00。
 * 拿不到班表就返回 null，解析器会退回内置默认值。
 */
export function todayAnchors(): TimeAnchors | null {
  try {
    const st = getScheduleState()
    const p = st.profiles.find((x) => x.id === st.activeId) ?? st.profiles[0]
    if (!p) return null
    const day = resolveDay(p, ymd(new Date()))
    const shift = day.shift ?? p.base
    // 夜班（如 22:00–06:00）的 end 早于 start：这里仍给出原始时刻，
    // 让「下午/下班前」落到次日凌晨那一刻，而不是被错算成今天上午
    return {
      workStart: shift.start,
      workEnd: shift.end,
      lunchStart: day.lunch?.start ?? null,
      lunchEnd: day.lunch?.end ?? null
    }
  } catch {
    return null
  }
}

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
  const q = parseWithRules(input)
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
    'INSERT INTO todos (id, text, done_at, created_at, due_at, category, priority, source, note, sort_order, repeat) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)',
    [row.id, row.text, row.created_at, row.due_at, row.category, row.priority, row.source, row.note, row.sort_order, q.repeat]
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
  // 循环待办：完成这条的同时，下一轮自己长出来，不用每天重新打一遍
  if (todo.repeat) {
    try {
      const anchors = todayAnchors()
      const due = nextOccurrence(todo.repeat, todo.due_at, now, anchors?.workEnd ?? '18:00')
      if (due) {
        run(
          'INSERT INTO todos (id, text, done_at, created_at, due_at, category, priority, source, note, sort_order, repeat) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)',
          [uid('td'), todo.text, now.toISOString(), due, todo.category, todo.priority, 'repeat', todo.note, nextOrder(), todo.repeat]
        )
        audit('todo:repeat', `${todo.text} → 下一轮 ${due.slice(0, 10)}`)
      }
    } catch {
      // 下一轮生成失败不影响完成本身
    }
  }
  audit('todo:done', todo.text)
  return { todo: { ...todo, done_at: now.toISOString() }, worklog: log }
}

export function uncompleteTodo(id: string): void {
  const rows = query<TodoRow>('SELECT * FROM todos WHERE id = ?', [id])
  const todo = rows[0]
  run('UPDATE todos SET done_at = NULL WHERE id = ?', [id])
  run('DELETE FROM worklog WHERE todo_id = ? AND kind = ?', [id, 'done'])
  // 循环待办：撤销完成时，把完成时自动生成的那条下一轮收回，避免同一条出现两份
  if (todo?.repeat && todo.done_at) {
    try {
      const spawned = query<{ id: string }>(
        'SELECT id FROM todos WHERE done_at IS NULL AND source = ? AND text = ? AND repeat = ? AND created_at >= ? ORDER BY created_at LIMIT 1',
        ['repeat', todo.text, todo.repeat, todo.done_at]
      )[0]
      if (spawned) run('DELETE FROM todos WHERE id = ?', [spawned.id])
    } catch {
      // 收回失败不影响撤销本身
    }
  }
}

export function updateTodo(id: string, patch: Partial<Pick<TodoRow, 'text' | 'due_at' | 'category' | 'priority' | 'note'>>): void {
  const before = query<TodoRow>('SELECT * FROM todos WHERE id = ?', [id])[0]

  // 用户改分类 → 记住「这句话里的短语 → 分类」；改到期时间 → 记住「时间短语 → 时刻」
  // 只在真正变了的时候学，重复点同一个值不刷学习次数
  if (before) {
    if ('category' in patch && patch.category && patch.category !== before.category) {
      learnCategoryFromEdit(before.text, patch.category)
    }
    if ('due_at' in patch && patch.due_at && patch.due_at !== before.due_at) {
      learnTimeFromEdit(before.text, patch.due_at)
    }
  }
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

/** 到期前 15 分钟内的未完成待办：主进程定时器拿来弹提醒 */
export function dueSoonTodos(now = new Date()): { id: string; text: string; due_at: string }[] {
  return pickDueSoon(listTodos('open'), now)
}

/** 一键周报：本周到岗 + 完成待办 + 工作记录，拼成可直接粘贴的文本 */
export function weekReport(now = new Date()): { text: string; days: number } {
  const p = (n: number): string => String(n).padStart(2, '0')
  const dstr = (d: Date): string => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const start = new Date(end)
  start.setDate(end.getDate() - ((end.getDay() + 6) % 7))
  const wd = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
  const lines: string[] = []
  let totalTodos = 0
  let totalLogs = 0
  let days = 0
  for (let i = 0; i < 7; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const key = dstr(d)
    const ck = query<{ marked_at: string | null }>('SELECT marked_at FROM checkins WHERE day = ?', [key])[0]
    const todos = query<{ text: string }>('SELECT text FROM todos WHERE done_at IS NOT NULL AND substr(done_at, 1, 10) = ? ORDER BY done_at', [key])
    const logs = query<{ text: string }>('SELECT text FROM worklog WHERE day = ? ORDER BY at', [key])
    if (!ck && todos.length === 0 && logs.length === 0) continue
    days++
    const go = ck?.marked_at ? (ck.marked_at.includes('T') ? ck.marked_at.slice(11, 16) : ck.marked_at.slice(0, 5)) : ''
    lines.push(`■ ${key.slice(5)} ${wd[i]}${go ? ` · 到岗 ${go}` : ''}`)
    if (todos.length) { totalTodos += todos.length; lines.push('  完成：' + todos.map((t) => t.text).join('、')) }
    if (logs.length) { totalLogs += logs.length; lines.push('  记录：' + logs.map((t) => t.text).join('；')) }
  }
  const head = `【周报】${dstr(start).slice(5)} ~ ${dstr(end).slice(5)}`
  lines.push(`合计：完成待办 ${totalTodos} 条 · 工作记录 ${totalLogs} 条 · 有记录 ${days} 天`)
  return { text: head + '\n' + lines.join('\n'), days }
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

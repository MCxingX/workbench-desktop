import { query, run, audit, transaction } from './store'
import { getSetting, setSetting } from './scheduleStore'
import { getScheduleState } from './scheduleStore'
import { resolveAttendance, resolveDay } from '../shared/schedule/resolve'
import { addDays, parseYmd, ymd } from '../shared/schedule/time'
import type { ShiftProfile } from '../shared/schedule/model'

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
  /** 上班日、已过上班时间、还没记录 → 缺卡（中性提示，不做愧疚红点） */
  missing: boolean
  isToday: boolean
  weekday: number
  holiday: string | null
}

export function getSettings(): Record<string, string> {
  const rows = query<{ key: string; value: string }>('SELECT key, value FROM settings')
  const out: Record<string, string> = {}
  for (const r of rows) out[r.key] = r.value
  return out
}

export function settingGet(key: string): string | null {
  return getSetting(key)
}

export function settingSet(key: string, value: string): void {
  setSetting(key, value)
}

export function todayStr(): string {
  return ymd(new Date())
}

export function getCheckin(day: string): CheckinRow | null {
  const rows = query<CheckinRow>('SELECT day, marked_at, is_backfill, note FROM checkins WHERE day = ?', [day])
  return rows.length > 0 ? rows[0] : null
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 日期必须是 YYYY-MM-DD，且不能是未来（补记只补过去和今天） */
function assertDay(day: string): string {
  if (typeof day !== 'string' || !DAY_RE.test(day) || Number.isNaN(new Date(day + 'T00:00:00').getTime())) {
    throw new Error('日期格式不对，应为 YYYY-MM-DD')
  }
  if (day > todayStr()) throw new Error('不能给未来的日期打卡')
  return day
}

function hhmmss(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

export interface MarkOptions {
  /** 到岗时间 HH:mm 或 HH:mm:ss；不给就取当前时刻 */
  at?: string
  isBackfill?: boolean
  note?: string | null
}

/** 打卡 / 补记：一次写入，不弹确认。支持指定任意日期与到岗时间 */
export function markCheckin(day: string, opts: MarkOptions = {}): CheckinRow {
  assertDay(day)
  if (opts.at !== undefined && normalizeAt(opts.at) === null) throw new Error('到岗时间格式不对，应为 HH:mm')
  const at = normalizeAt(opts.at) ?? hhmmss()
  const backfill = opts.isBackfill ?? day !== todayStr()
  run(
    'INSERT INTO checkins (day, marked_at, is_backfill, note) VALUES (?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET marked_at = excluded.marked_at, is_backfill = excluded.is_backfill, note = COALESCE(excluded.note, checkins.note)',
    [day, at, backfill ? 1 : 0, opts.note ?? null]
  )
  audit('checkin:mark', `${day} ${at}${backfill ? ' (补)' : ''}`)
  return getCheckin(day)!
}

/**
 * 批量补卡：一次写多天，全在一个事务里。
 * 手工一天一天点，一个月十几个缺卡要点十几遍 —— 这是纯体力活，不该让人干。
 */
export function markManyCheckins(
  days: string[],
  opts: { at?: string; note?: string | null } = {}
): { done: number; skipped: number } {
  if (!Array.isArray(days) || days.length === 0) throw new Error('没有选中要补的日期')
  if (days.length > 366) throw new Error('一次最多补 366 天')
  const fixed = opts.at !== undefined && opts.at !== '' ? normalizeAt(opts.at) : null
  if (opts.at !== undefined && opts.at !== '' && fixed === null) throw new Error('到岗时间格式不对，应为 HH:mm')
  const today = todayStr()
  const at = fixed ?? hhmmss()
  let done = 0
  let skipped = 0
  transaction(() => {
    for (const raw of days) {
      const day = typeof raw === 'string' ? raw.trim() : ''
      try {
        assertDay(day)
      } catch {
        skipped++
        continue
      }
      run(
        'INSERT INTO checkins (day, marked_at, is_backfill, note) VALUES (?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET marked_at = excluded.marked_at, is_backfill = excluded.is_backfill, note = COALESCE(excluded.note, checkins.note)',
        [day, at, day !== today ? 1 : 0, opts.note ?? null]
      )
      done++
    }
  })
  audit('checkin:mark-many', `${done} 天 @${at}${skipped ? ` 跳过 ${skipped}` : ''}`)
  return { done, skipped }
}
function normalizeAt(at?: string): string | null {
  if (!at) return null
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(at.trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  const s = Number(m[3] ?? 0)
  if (h > 23 || mi > 59 || s > 59) return null
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 改已有记录：时间 / 备注 / 是否补记 */
export function updateCheckin(day: string, patch: { at?: string; note?: string | null; isBackfill?: boolean }): CheckinRow | null {
  const cur = getCheckin(day)
  if (!cur) return null
  if (patch.at !== undefined) {
    const fixed = normalizeAt(patch.at)
    if (fixed === null) throw new Error('到岗时间格式不对，应为 HH:mm')
    patch = { ...patch, at: fixed }
  }
  const at = patch.at !== undefined ? (patch.at as string) : cur.marked_at
  const note = patch.note !== undefined ? patch.note : cur.note
  const backfill = patch.isBackfill !== undefined ? (patch.isBackfill ? 1 : 0) : cur.is_backfill
  run('UPDATE checkins SET marked_at = ?, note = ?, is_backfill = ? WHERE day = ?', [at, note, backfill, day])
  audit('checkin:update', `${day} ${at ?? ''}`)
  return getCheckin(day)
}

/** 这次打卡应该记到哪一天：跨零点夜班在凌晨打卡，归属前一天 */
export function workDayOf(now = new Date()): string {
  const today = ymd(now)
  const p = activeProfileSafe()
  if (!p) return today
  const yesterday = ymd(addDays(now, -1))
  const night = resolveDay(p, yesterday)
  const shift = night.shift
  if (!shift) return today
  const crossesMidnight = Number(shift.end.slice(0, 2)) * 60 + Number(shift.end.slice(3, 5)) <= Number(shift.start.slice(0, 2)) * 60 + Number(shift.start.slice(3, 5))
  if (!crossesMidnight) return today
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const endMin = Number(shift.end.slice(0, 2)) * 60 + Number(shift.end.slice(3, 5))
  return nowMin < endMin ? yesterday : today
}

export function deleteCheckin(day: string): void {
  assertDay(day)
  run('DELETE FROM checkins WHERE day = ?', [day])
  audit('checkin:undo', day)
}

export function setCheckinNote(day: string, note: string): void {
  run('UPDATE checkins SET note = ? WHERE day = ?', [note, day])
}

export function monthCheckins(ym: string): CheckinRow[] {
  return query<CheckinRow>('SELECT day, marked_at, is_backfill, note FROM checkins WHERE day LIKE ? ORDER BY day', [`${ym}%`])
}

export function rangeCheckins(from: string, to: string): CheckinRow[] {
  return query<CheckinRow>('SELECT day, marked_at, is_backfill, note FROM checkins WHERE day >= ? AND day <= ? ORDER BY day', [from, to])
}

function activeProfileSafe(): ShiftProfile | null {
  const s = getScheduleState()
  return s.profiles.find((p) => p.id === s.activeId) ?? s.profiles[0] ?? null
}

/** 统计：本月到岗/应到、连续到岗、本年累计、本月缺卡 */
export function checkinStats(): CheckinStats {
  const p = activeProfileSafe()
  const now = new Date()
  const today = ymd(now)
  const ym = today.slice(0, 7)
  const monthRows = monthCheckins(ym)
  const monthDone = monthRows.length
  const marked = new Set(monthRows.map((r) => r.day))

  let monthExpected = 0
  let missing = 0
  if (p) {
    const first = parseYmd(`${ym}-01`)
    const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
    for (let i = 0; i < days; i++) {
      const ds = ymd(addDays(first, i))
      if (ds > today) break
      if (!resolveAttendance(p, ds).onDuty) continue
      monthExpected++
      if (!marked.has(ds) && ds !== today) missing++
      // 今天：过了上班时间才算缺卡
      if (ds === today && !marked.has(ds)) {
        const shift = resolveDay(p, ds).shift
        const nowMin = now.getHours() * 60 + now.getMinutes()
        const startMin = shift ? Number(shift.start.slice(0, 2)) * 60 + Number(shift.start.slice(3, 5)) : 0
        if (nowMin > startMin + 30) missing++
      }
    }
  }

  // 连续到岗：从今天往前数，休息日跳过不打断，缺卡日打断
  let streak = 0
  if (p) {
    // 一次取回近 400 天的打卡日，循环里不再查库（原来 400 次 prepare+select ≈ 80–150ms）
    const since = ymd(addDays(now, -400))
    const all = new Set(query<{ day: string }>('SELECT day FROM checkins WHERE day >= ? AND day <= ?', [since, today]).map((r) => r.day))
    let cursor = now
    for (let i = 0; i < 400; i++) {
      const ds = ymd(cursor)
      const onDuty = resolveAttendance(p, ds).onDuty
      const has = all.has(ds)
      if (onDuty && !has && ds !== today) break
      if (onDuty && has) streak++
      cursor = addDays(cursor, -1)
    }
  }

  const yearDone = query<{ c: number }>('SELECT COUNT(*) AS c FROM checkins WHERE day LIKE ?', [`${today.slice(0, 4)}%`])[0].c
  return { monthDone, monthExpected, streak, yearDone, missing }
}

/** 月历数据：上班/休息/已到岗/补记/缺卡，含假期名与今日标记 */
export function checkinCalendar(ym: string): CalendarCell[] {
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error('月份格式不对，应为 YYYY-MM')
  const p = activeProfileSafe()
  const [y, m] = ym.split('-').map(Number)
  if (m < 1 || m > 12) throw new Error('月份超出范围')
  const days = new Date(y, m, 0).getDate()
  const marked = new Map(monthCheckins(ym).map((r) => [r.day, r]))
  const today = todayStr()
  const now = new Date()
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const out: CalendarCell[] = []

  for (let i = 1; i <= days; i++) {
    const ds = `${ym}-${String(i).padStart(2, '0')}`
    const row = marked.get(ds)
    const resolved = p ? resolveDay(p, ds) : null
    const onDuty = resolved?.attendance.onDuty ?? false
    const holiday = resolved?.attendance.source === 'holiday' ? resolved.attendance.reason : null
    let missing = false
    if (onDuty && !row && ds < today) missing = true
    if (onDuty && !row && ds === today && resolved?.shift) {
      const startMin = Number(resolved.shift.start.slice(0, 2)) * 60 + Number(resolved.shift.start.slice(3, 5))
      if (nowMin > startMin + 30) missing = true
    }
    out.push({
      day: ds,
      onDuty,
      marked: !!row,
      backfill: !!row && row.is_backfill === 1,
      note: row?.note ?? null,
      at: row?.marked_at ?? null,
      missing,
      isToday: ds === today,
      weekday: new Date(y, m - 1, i).getDay(),
      holiday
    })
  }
  return out
}

/** 某个月的汇总（翻月时分子分母要同月，不能拿本月分母配别的月分子） */
export function monthSummary(ym: string): { done: number; expected: number; missing: number } {
  const cells = checkinCalendar(ym)
  return {
    done: cells.filter((c) => c.marked).length,
    expected: cells.filter((c) => c.onDuty && c.day <= todayStr()).length,
    missing: cells.filter((c) => c.missing).length
  }
}

/** 导出 xlsx：一行一天 */
export async function exportCheckins(ym: string, targetFile: string): Promise<{ file: string; rows: number }> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('到岗记录')
  ws.columns = [
    { header: '日期', key: 'day', width: 14 },
    { header: '星期', key: 'wd', width: 8 },
    { header: '是否到岗', key: 'done', width: 12 },
    { header: '到岗时间', key: 'at', width: 14 },
    { header: '补记', key: 'backfill', width: 10 },
    { header: '备注', key: 'note', width: 36 }
  ]
  const cells = checkinCalendar(ym)
  let rows = 0
  for (const c of cells) {
    ws.addRow({
      day: c.day,
      wd: `周${'日一二三四五六'[c.weekday]}`,
      done: c.marked ? '是' : c.onDuty ? (c.missing ? '缺卡' : '未到点') : '休息',
      at: c.at ?? '—',
      backfill: c.backfill ? '补记' : '',
      note: c.note ?? (c.holiday ?? '')
    })
    rows++
  }
  const total = cells.filter((c) => c.marked).length
  const expect = cells.filter((c) => c.onDuty && c.day <= todayStr()).length
  ws.addRow({})
  ws.addRow({ day: '合计', wd: `到岗 ${total}`, done: `应到 ${expect}`, at: total >= expect ? '全到' : `差 ${Math.max(0, expect - total)}` })
  await wb.xlsx.writeFile(targetFile)
  return { file: targetFile, rows }
}




